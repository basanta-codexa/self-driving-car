// sim/renderer.js -- draws simulation state. It never mutates the simulation.
(function (SIM) {
    "use strict";

    const M = SIM.math;

    class Renderer {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext("2d");
            this.camera = null; // { x, y, zoom } -- created on first render
            this.worldScale = 1;
            this.bounds = null;
        }

        // Convert a screen-space drag into a world-space pan.
        panBy(dxScreen, dyScreen) {
            if (!this.camera) return;
            this.camera.x -= dxScreen / this.worldScale;
            this.camera.y -= dyScreen / this.worldScale;
        }

        zoomBy(factor, screenX, screenY) {
            if (!this.camera) return;
            const before = this.#screenToWorld(screenX, screenY);
            this.camera.zoom = M.clamp(this.camera.zoom * factor, 0.5, 6);
            // Recompute the scale for the new zoom, then keep the point under
            // the cursor fixed.
            const s = this.#baseScale() * this.camera.zoom;
            const after = {
                x: (screenX - this.canvas.width / 2) / s + this.camera.x,
                y: (screenY - this.canvas.height / 2) / s + this.camera.y,
            };
            this.camera.x += before.x - after.x;
            this.camera.y += before.y - after.y;
        }

        #baseScale() {
            const b = this.bounds || { minX: -730, maxX: 730, minY: -730, maxY: 730 };
            return (
                Math.min(
                    this.canvas.width / (b.maxX - b.minX),
                    this.canvas.height / (b.maxY - b.minY)
                ) * 0.94
            );
        }

        #screenToWorld(sx, sy) {
            return {
                x: (sx - this.canvas.width / 2) / this.worldScale + this.camera.x,
                y: (sy - this.canvas.height / 2) / this.worldScale + this.camera.y,
            };
        }

        render(sim) {
            const ctx = this.ctx;
            const w = this.canvas.width;
            const h = this.canvas.height;
            const b = sim.scene.bounds || { minX: -730, maxX: 730, minY: -730, maxY: 730 };
            this.bounds = b;
            const cx = (b.minX + b.maxX) / 2;
            const cy = (b.minY + b.maxY) / 2;
            if (!this.camera) this.camera = { x: cx, y: cy, zoom: 1 };
            const scale = this.#baseScale() * this.camera.zoom;
            this.worldScale = scale;

            ctx.fillStyle = "#1b2a20";
            ctx.fillRect(0, 0, w, h);
            ctx.save();
            ctx.translate(w / 2, h / 2);
            ctx.scale(scale, scale);
            ctx.translate(-this.camera.x, -this.camera.y);

            this.#drawGround(ctx, sim);
            this.#drawLanes(ctx, sim);
            this.#drawControls(ctx, sim);
            if (sim.scenery) SIM.scenery.draw(ctx, sim.scenery);
            this.#drawDestination(ctx, sim);
            this.#drawAgents(ctx, sim);
            this.#drawPerception(ctx, sim);

            ctx.restore();
            this.#drawHud(ctx, sim);
            this.#drawMinimap(ctx, sim);
        }

        #drawGround(ctx, sim) {
            ctx.fillStyle = "#3b463f";
            for (const s of sim.scene.sidewalks) ctx.fillRect(s.x, s.y, s.w, s.h);
            ctx.fillStyle = "#2f3236";
            for (const r of sim.scene.roads) ctx.fillRect(r.x, r.y, r.w, r.h);
        }

        #drawLanes(ctx, sim) {
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.35)";
            ctx.lineWidth = 2;
            ctx.setLineDash([18, 16]);
            for (const lane of sim.graph.lanes.values()) {
                ctx.beginPath();
                lane.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();
        }

        #drawControls(ctx, sim) {
            const states = sim.signals.statesAt(sim.timeMs);
            for (const lane of sim.graph.lanes.values()) {
                for (const c of lane.controls) {
                    const p = sim.graph.pointAt(lane.id, c.s);
                    if (!p) continue;
                    const tangent = p.tangent;
                    const perp = M.perp(tangent);
                    const half = sim.scene.roadWidth / 2;
                    ctx.beginPath();
                    ctx.moveTo(p.x - perp.x * half, p.y - perp.y * half);
                    ctx.lineTo(p.x + perp.x * half, p.y + perp.y * half);
                    ctx.strokeStyle = "rgba(255,255,255,0.85)";
                    ctx.lineWidth = 4;
                    ctx.stroke();
                    const state = states[c.group] || "green";
                    const bulb = state === "green" ? "#2bff5a" : state === "yellow" ? "#ffe14d" : "#ff4d4d";
                    const bx = p.x + tangent.x * 18 + perp.x * (half - 8);
                    const by = p.y + tangent.y * 18 + perp.y * (half - 8);
                    ctx.beginPath();
                    ctx.fillStyle = "#111";
                    ctx.arc(bx, by, 10, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.fillStyle = bulb;
                    ctx.arc(bx, by, 6, 0, Math.PI * 2);
                    ctx.fill();
                }
                for (const cw of lane.crosswalks) {
                    const crossing = sim.scene.crosswalks.find((c) => c.id === cw.id);
                    if (!crossing) continue;
                    const dir = M.normalise(M.sub(crossing.to, crossing.from));
                    const across = M.perp(dir);
                    const span = M.distance(crossing.from, crossing.to);
                    const half = (sim.scene.roadWidth || 80) / 2;
                    // Zebra stripes: parallel to the road, repeated along the
                    // direction the pedestrian walks.
                    ctx.save();
                    ctx.strokeStyle = "rgba(255,255,255,0.7)";
                    ctx.lineWidth = 7;
                    ctx.lineCap = "butt";
                    for (let i = 0; i < 9; i++) {
                        const t = (i + 0.5) / 9;
                        const c = M.add(crossing.from, M.scale(M.sub(crossing.to, crossing.from), t));
                        ctx.beginPath();
                        ctx.moveTo(c.x - across.x * half, c.y - across.y * half);
                        ctx.lineTo(c.x + across.x * half, c.y + across.y * half);
                        ctx.stroke();
                    }
                    ctx.restore();
                }
            }
        }

        #drawDestination(ctx, sim) {
            const dest = sim.scene.destination;
            if (!dest) return;
            const p = sim.graph.pointAt(dest.laneId, dest.s);
            if (!p) return;
            for (const [r, color] of [[26, "#ff6b6b"], [18, "#fff"], [10, "#ff6b6b"]]) {
                ctx.beginPath();
                ctx.fillStyle = color;
                ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        #drawAgents(ctx, sim) {
            for (const p of sim.peds) {
                const color = p.state === "crossing" ? "#ffd43b" : p.jaywalk ? "#ff922b" : "#adb5bd";
                ctx.beginPath();
                ctx.fillStyle = color;
                ctx.arc(p.pos.x, p.pos.y, p.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = "#000";
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            for (const c of sim.traffic) this.#drawCar(ctx, c, "#ff922b");
            const e = sim.ego;
            this.#drawCar(ctx, e, sim.collided.size ? "#ff4d4d" : "#4dabf7");
        }

        #drawCar(ctx, car, color) {
            ctx.save();
            ctx.translate(car.pos.x, car.pos.y);
            ctx.rotate(-car.angle);
            ctx.fillStyle = color;
            ctx.fillRect(-car.width / 2, -car.height / 2, car.width, car.height);
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.fillRect(-car.width / 2 + 2, -car.height / 2 + 3, car.width - 4, 5);
            ctx.restore();
        }

        #drawPerception(ctx, sim) {
            const obs = sim.lastObs;
            const cmd = sim.lastCmd;
            if (!obs || !cmd) return;
            if (obs.lookahead) {
                ctx.beginPath();
                ctx.strokeStyle = "rgba(0,255,255,0.45)";
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.moveTo(obs.pos.x, obs.pos.y);
                ctx.lineTo(obs.lookahead.x, obs.lookahead.y);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            if (obs.ped) {
                const p = sim.peds.find((x) => x.id === obs.ped.id);
                if (p) {
                    ctx.beginPath();
                    ctx.strokeStyle = "#ff4d4d";
                    ctx.lineWidth = 2;
                    ctx.arc(p.pos.x, p.pos.y, p.radius + 5, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
            if (cmd.horn) {
                const e = sim.ego;
                ctx.fillStyle = "#ffe14d";
                ctx.font = "bold 26px sans-serif";
                ctx.fillText("!", e.pos.x + 14, e.pos.y - 18);
            }
        }

        #drawMinimap(ctx, sim) {
            const size = 190;
            const pad = 14;
            const x0 = this.canvas.width - size - pad;
            const y0 = this.canvas.height - size - pad;
            const b = this.bounds;
            const sx = size / (b.maxX - b.minX);
            const sy = size / (b.maxY - b.minY);
            const map = (p) => ({ x: x0 + (p.x - b.minX) * sx, y: y0 + (p.y - b.minY) * sy });

            ctx.save();
            ctx.fillStyle = "rgba(0,0,0,0.72)";
            ctx.fillRect(x0, y0, size, size);
            ctx.strokeStyle = "rgba(255,255,255,0.25)";
            ctx.strokeRect(x0, y0, size, size);

            for (const r of sim.scene.roads) {
                ctx.fillStyle = "#555";
                ctx.fillRect(map({ x: r.x, y: r.y }).x, map({ x: r.x, y: r.y }).y, r.w * sx, r.h * sy);
            }
            for (const c of sim.traffic) {
                const p = map(c.pos);
                ctx.fillStyle = "#ff922b";
                ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
            }
            for (const p of sim.peds) {
                const q = map(p.pos);
                ctx.fillStyle = "#ffd43b";
                ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
            }
            const e = map(sim.ego.pos);
            ctx.fillStyle = "#4dabf7";
            ctx.beginPath();
            ctx.arc(e.x, e.y, 3.5, 0, Math.PI * 2);
            ctx.fill();

            const halfW = this.canvas.width / 2 / this.worldScale;
            const halfH = this.canvas.height / 2 / this.worldScale;
            const tl = map({ x: this.camera.x - halfW, y: this.camera.y - halfH });
            ctx.strokeStyle = "rgba(255,255,255,0.8)";
            ctx.lineWidth = 1;
            ctx.strokeRect(tl.x, tl.y, halfW * 2 * sx, halfH * 2 * sy);
            ctx.restore();
        }

        #drawHud(ctx, sim) {
            const m = sim.metrics;
            const cmd = sim.lastCmd || {};
            const obs = sim.lastObs || {};
            const phase = sim.signals.phaseRemaining(sim.timeMs);
            const lines = [
                "AUTONOMOUS DRIVER  ·  rule-based v1",
                "state      " + (cmd.state || "-"),
                "speed      " + sim.ego.speed.toFixed(1) + "  / target " + (cmd.target || 0).toFixed(1),
                "signal     " + (obs.control ? obs.control.state + " (" + Math.round(obs.control.distance) + "px)" : "none") +
                    "   phase " + (phase.group || "all-red") + ":" + phase.state + " " + (phase.remaining / 1000).toFixed(1) + "s",
                "ped ahead  " + (obs.ped ? Math.round(obs.ped.distance) + "px" : "-") +
                    "    car ahead " + (obs.carAhead ? Math.round(obs.carAhead.distance) + "px" : "-"),
                "horn       " + (cmd.horn ? "ON" : "off"),
                "arrived    " + (m.arrived ? "YES" : "no") + "    t " + m.time.toFixed(1) + "s",
                "collisions " + m.collisions + "   near-misses " + m.nearMisses + "   violations " + m.violations + "   horn " + m.hornEvents,
            ];
            ctx.save();
            ctx.font = "13px ui-monospace, Consolas, monospace";
            const width = 430;
            ctx.fillStyle = "rgba(0,0,0,0.65)";
            ctx.fillRect(12, 12, width, lines.length * 20 + 14);
            ctx.fillStyle = "#e9ecef";
            lines.forEach((line, i) => ctx.fillText(line, 22, 32 + i * 20));
            ctx.restore();
        }
    }

    SIM.Renderer = Renderer;
})(globalThis.SIM = globalThis.SIM || {});
