// sim/simulation.js -- authoritative fixed-timestep simulation.
// Rendering never writes here; headless and browser run exactly this code.
(function (SIM) {
    "use strict";

    const M = SIM.math;

    class Simulation {
        constructor(scene, config = {}) {
            this.scene = scene;
            this.config = config;
            this.dt = config.dt || 1 / 60;
            this.graph = new SIM.LaneGraph(scene.lanes);
            this.signals = new SIM.SignalController(scene.signalGroups, scene.allRed);
            this.junctions = SIM.rightOfWay.buildJunctions(this.graph);
            this.peds = SIM.agents.createPedestrians(scene);
            this.traffic = SIM.agents.createTrafficCars(scene, this.graph);
            // Decorative only: no physics, no sensing, deterministic layout.
            this.scenery = SIM.scenery ? SIM.scenery.generate(scene, config) : null;

            const def = scene.ego;
            const at = this.graph.pointAt(def.laneId, def.s);
            const angle = at
                ? M.angleTo(at, this.graph.lookahead(def.laneId, def.s, 30) || at)
                : 0;
            this.ego = {
                id: "ego",
                kind: "ego",
                laneId: def.laneId,
                s: def.s,
                pos: at ? { x: at.x, y: at.y } : { x: 0, y: 0 },
                angle,
                speed: def.speed || 0,
                maxSpeed: def.maxSpeed || 100,
                radius: 16,
                width: 18,
                height: 32,
                vel: { x: 0, y: 0 },
                polygon: M.orientedBox(at ? at.x : 0, at ? at.y : 0, angle, 18, 32),
                lateral: 0,
            };

            // The driver is injectable so a learned policy can be benchmarked
            // against the rule-based baseline on the exact same scenario.
            this.driver = config.driver || new SIM.AutonomousDriver();
            this.timeMs = 0;
            this.events = [];
            this.lastObs = null;
            this.lastCmd = null;
            this.hornPrev = false;
            this.arrivedMs = 0;
            this.collided = new Set();
            this.nearMissed = new Set();
            this.metrics = {
                time: 0,
                distance: 0,
                collisions: 0,
                nearMisses: 0,
                violations: 0,
                hornEvents: 0,
                arrived: false,
                maxSpeed: 0,
                maxLateral: 0,
                states: {},
            };
        }

        emit(type, data) {
            this.events.push(Object.assign({ type, t: this.timeMs }, data));
        }

        step() {
            const dt = this.dt;
            const dtMs = dt * 1000;
            this.timeMs += dtMs;

            SIM.agents.updatePedestrians(this.peds, this.signals, this.timeMs, dt);
            SIM.agents.updateTrafficCars(this.traffic, {
                graph: this.graph,
                signals: this.signals,
                timeMs: this.timeMs,
                ego: this.ego,
                peds: this.peds,
                dt,
                junctions: this.junctions,
                roadWidth: this.scene.roadWidth,
                agents: this.traffic.concat([this.ego]),
                emit: (type, data) => {
                    this.emit(type, data);
                    if (type === "violation") this.metrics.violations++;
                },
            });

            const obs = SIM.perceive(this);
            const cmd = this.driver.decide(obs, dtMs);
            const prevS = this.ego.s;
            const prevControl = this.lastObs ? this.lastObs.control : null;

            this.#applyEgo(cmd, dt);
            this.#checkSafety(obs);
            this.#checkRules(prevS, prevControl, obs, cmd);
            this.#updateMetrics(obs, cmd, dt, dtMs);

            this.lastObs = obs;
            this.lastCmd = cmd;
        }

        #applyEgo(cmd, dt) {
            const e = this.ego;
            const accel = 70 * cmd.throttle;
            const brake = 190 * cmd.brake;
            const drag = 7;
            e.speed = Math.max(0, e.speed + (accel - brake - drag) * dt);
            e.speed = Math.min(e.speed, e.maxSpeed);

            // Steering authority grows with speed (a stationary car cannot turn).
            const authority = M.clamp(Math.abs(e.speed) / 30, 0, 1);
            e.angle += cmd.steer * 1.5 * authority * dt;

            const f = M.forward(e.angle);
            e.pos = M.add(e.pos, M.scale(f, e.speed * dt));
            const proj = this.graph.project(e.pos, e.laneId);
            if (proj) {
                e.s = proj.s;
                e.lateral = proj.lateral;
            }
            e.vel = M.scale(f, e.speed);
            e.polygon = M.orientedBox(e.pos.x, e.pos.y, e.angle, e.width, e.height);
        }

        #checkSafety(obs) {
            const e = this.ego;
            for (const c of this.traffic) {
                if (!this.collided.has(c.id) && M.polygonsIntersect(e.polygon, c.polygon)) {
                    this.collided.add(c.id);
                    this.metrics.collisions++;
                    this.emit("collision", { with: c.id, speed: Number(e.speed.toFixed(1)) });
                    e.speed = 0;
                }
                if (!this.nearMissed.has(c.id)) {
                    const ttc = M.timeToCollision(
                        { pos: e.pos, vel: e.vel, radius: e.radius },
                        { pos: c.pos, vel: c.vel, radius: c.radius }
                    );
                    if (ttc < 1.2) {
                        this.nearMissed.add(c.id);
                        this.metrics.nearMisses++;
                        this.emit("near-miss", { with: c.id, ttc: Number(ttc.toFixed(2)) });
                    }
                }
            }
            for (const p of this.peds) {
                const key = "ped-" + p.id;
                if (M.distance(e.pos, p.pos) < e.radius + p.radius) {
                    if (!this.collided.has(key)) {
                        this.collided.add(key);
                        this.metrics.collisions++;
                        this.emit("collision", { with: p.id, speed: Number(e.speed.toFixed(1)) });
                        e.speed = 0;
                    }
                } else if (!this.nearMissed.has(key)) {
                    const ttc = M.timeToCollision(
                        { pos: e.pos, vel: e.vel, radius: e.radius },
                        { pos: p.pos, vel: p.vel, radius: p.radius }
                    );
                    if (ttc < 1.0) {
                        this.nearMissed.add(key);
                        this.metrics.nearMisses++;
                        this.emit("near-miss", { with: p.id, ttc: Number(ttc.toFixed(2)) });
                    }
                }
            }
        }

        #checkRules(prevS, prevControl, obs, cmd) {
            // Own the junction once the stop line is crossed; release it after
            // clearing the intersection so crossing traffic may proceed.
            if (prevControl && prevS < prevControl.s && this.ego.s >= prevControl.s) {
                this.ego.junction = prevControl.junction;
            }
            if (this.ego.junction) {
                const j = this.junctions.get(this.ego.junction);
                if (j && M.distance(this.ego.pos, j.center) > 120) this.ego.junction = null;
            }

            // Ego crossing a stop line against red/yellow, moving too fast.
            if (
                prevControl &&
                prevControl.state !== "green" &&
                prevS < prevControl.s &&
                this.ego.s >= prevControl.s &&
                this.ego.speed > 5
            ) {
                this.metrics.violations++;
                this.emit("violation", { id: "ego", group: prevControl.group });
            }

            if (cmd.horn && !this.hornPrev) {
                this.metrics.hornEvents++;
                this.emit("horn", {});
            }
            this.hornPrev = cmd.horn;

            const dest = this.scene.destination;
            if (dest && !this.metrics.arrived && obs.destDist <= obs.stopRadius + 6 && this.ego.speed < 4) {
                this.arrivedMs += this.dt * 1000;
                if (this.arrivedMs >= dest.holdTime * 1000) {
                    this.metrics.arrived = true;
                    this.emit("arrived", {});
                }
            } else if (!this.metrics.arrived) {
                this.arrivedMs = 0;
            }
        }

        #updateMetrics(obs, cmd, dt, dtMs) {
            this.metrics.time = this.timeMs / 1000;
            this.metrics.distance += this.ego.speed * dt;
            this.metrics.maxSpeed = Math.max(this.metrics.maxSpeed, this.ego.speed);
            this.metrics.maxLateral = Math.max(this.metrics.maxLateral, Math.abs(obs.lateral));
            this.metrics.states[cmd.state] = (this.metrics.states[cmd.state] || 0) + dtMs;
        }

        summary() {
            return {
                arrived: this.metrics.arrived,
                time: Number(this.metrics.time.toFixed(2)),
                distance: Math.round(this.metrics.distance),
                collisions: this.metrics.collisions,
                nearMisses: this.metrics.nearMisses,
                violations: this.metrics.violations,
                hornEvents: this.metrics.hornEvents,
                maxSpeed: Number(this.metrics.maxSpeed.toFixed(1)),
                maxLateral: Number(this.metrics.maxLateral.toFixed(1)),
                finalState: this.driver.state,
                events: this.events.slice(),
            };
        }
    }

    SIM.Simulation = Simulation;
})(globalThis.SIM = globalThis.SIM || {});
