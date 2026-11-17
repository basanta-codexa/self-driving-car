// sim/city.js -- large procedural city scene for the simulation.
//
// A grid of blocks with directed routes that turn at junctions (quadratic
// corner arcs), per-junction signal circuits, crosswalks, sidewalks, traffic
// on its own routes, and procedural scenery. The driver needs no changes: a
// whole route is represented as one long lane polyline.
(function (SIM) {
    "use strict";

    function mulberry32(seed) {
        return function random() {
            seed |= 0;
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const DIR = { E: { x: 1, y: 0 }, W: { x: -1, y: 0 }, S: { x: 0, y: 1 }, N: { x: 0, y: -1 } };
    const rightOf = (d) => ({ x: -d.y, y: d.x });
    const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
    const scale = (a, k) => ({ x: a.x * k, y: a.y * k });
    const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
    const cross = (a, b) => a.x * b.y - a.y * b.x;
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    function bezier(a, p, b, t) {
        const u = 1 - t;
        return {
            x: u * u * a.x + 2 * u * t * p.x + t * t * b.x,
            y: u * u * a.y + 2 * u * t * p.y + t * t * b.y,
        };
    }

    function lineIntersection(a, d, b, e) {
        const denom = cross(d, e);
        if (Math.abs(denom) < 1e-6) return scale(add(a, b), 0.5);
        const t = cross(sub(b, a), e) / denom;
        return add(a, scale(d, t));
    }

    function monotonePath(rand, si, sj, ei, ej) {
        const dirs = [];
        let i = si;
        let j = sj;
        while (i < ei || j < ej) {
            const options = [];
            if (i < ei) options.push("E");
            if (j < ej) options.push("S");
            let choice = options[0];
            if (options.length === 2) {
                const last = dirs[dirs.length - 1];
                choice = last && rand() < 0.68 && options.includes(last) ? last : options[Math.floor(rand() * 2)];
            }
            dirs.push(choice);
            if (choice === "E") i++;
            else j++;
        }
        return dirs;
    }

    function createCityScene(options = {}) {
        const blocks = options.blocks || 6;
        const blockSize = options.blockSize || 420;
        const rand = mulberry32(options.seed || 7);
        const roadWidth = options.roadWidth || 96;
        const half = roadWidth / 2;
        const sidewalk = 30;
        const laneOffset = roadWidth / 4;
        const corner = 44;
        const extent = (blocks * blockSize) / 2;
        const J = (i, j) => ({ x: -extent + i * blockSize, y: -extent + j * blockSize });

        function buildRoute(id, si, sj, dirs, withMeta) {
            const points = [];
            const junctions = [];
            let ci = si;
            let cj = sj;
            let length = 0;
            const push = (p) => {
                if (points.length) length += distance(points[points.length - 1], p);
                points.push(p);
            };

            // dirs[k] is the leg from junction k to junction k+1. The first
            // point sits on the initial approach, before junction 1.
            const first = DIR[dirs[0]];
            push(add(add(J(si, sj), scale(first, -blockSize * 0.42)), scale(rightOf(first), laneOffset)));

            const stepCounters = (dir) => {
                if (dir === "E") ci++;
                else cj++;
            };

            for (let k = 1; k < dirs.length; k++) {
                stepCounters(dirs[k - 1]); // arrive at the junction we are crossing
                const din = DIR[dirs[k - 1]];
                const dout = DIR[dirs[k]];
                const C = J(ci, cj);
                const A = add(add(C, scale(din, -corner)), scale(rightOf(din), laneOffset));
                push(A);
                const entryS = length;
                const axis = din.x !== 0 ? "h" : "v";
                const key = "j" + ci + "_" + cj;
                if (withMeta) junctions.push({ key, axis, entryS, C, d: din });

                const B = add(add(C, scale(dout, corner)), scale(rightOf(dout), laneOffset));
                const P = lineIntersection(A, din, B, dout);
                for (let q = 1; q <= 8; q++) push(bezier(A, P, B, q / 8));
            }

            // Final approach: leave the last junction and run past the target.
            stepCounters(dirs[dirs.length - 1]);
            const lastDir = DIR[dirs[dirs.length - 1]];
            push(add(add(J(ci, cj), scale(lastDir, blockSize * 0.42)), scale(rightOf(lastDir), laneOffset)));

            const lane = { id, points, length, speedLimit: 98, controls: [], crosswalks: [] };
            for (const junc of junctions) {
                const group = junc.key + "-" + junc.axis;
                lane.controls.push({
                    id: "stop-" + junc.key,
                    s: junc.entryS,
                    group,
                    junction: junc.key,
                    center: junc.C,
                    axis: junc.axis,
                });
                const X = add(junc.C, scale(junc.d, -115));
                const r = rightOf(junc.d);
                const cwId = "cw-" + junc.key;
                lane.crosswalks.push({ id: cwId, s: Math.max(0, junc.entryS - 115) });
                if (withMeta) {
                    lane.__crosswalks = lane.__crosswalks || [];
                    lane.__crosswalks.push({
                        id: cwId,
                        crossRoad: group,
                        from: add(X, scale(r, -(half + sidewalk))),
                        to: add(X, scale(r, half + sidewalk)),
                    });
                }
            }
            return { lane, junctions, meta: lane.__crosswalks || [] };
        }

        // Ego route: corner to corner, long enough to cross many junctions.
        const egoDirs = monotonePath(rand, 0, 0, blocks, blocks);
        const ego = buildRoute("ego-route", 0, 0, egoDirs, true);

        // Traffic routes: random monotone paths across the grid.
        const trafficRoutes = [];
        const trafficCount = options.trafficRoutes || Math.min(20, Math.max(6, blocks * 2));
        for (let t = 0; t < trafficCount; t++) {
            const si = Math.floor(rand() * (blocks + 1));
            const sj = Math.floor(rand() * (blocks + 1));
            const ei = Math.min(blocks, si + 1 + Math.floor(rand() * Math.max(1, blocks - si)));
            const ej = Math.min(blocks, sj + 1 + Math.floor(rand() * Math.max(1, blocks - sj)));
            if (ei <= si && ej <= sj) continue;
            const route = buildRoute("traffic-" + t, si, sj, monotonePath(rand, si, sj, ei, ej), false);
            trafficRoutes.push(route);
        }

        // One signal circuit per junction touched by any route.
        const junctionKeys = new Map();
        for (const junc of ego.junctions) junctionKeys.set(junc.key, junc);
        for (const r of trafficRoutes) for (const junc of r.junctions) {
            if (!junctionKeys.has(junc.key)) junctionKeys.set(junc.key, junc);
        }
        const signalGroups = [];
        let idx = 0;
        for (const [key] of junctionKeys) {
            const baseGreen = 3800 + (idx % 3) * 400;
            const offset = (idx * 1237) % (2 * (baseGreen + 900 + 500));
            signalGroups.push({ id: key + "-h", green: baseGreen, yellow: 900, partner: key + "-v", offset });
            signalGroups.push({
                id: key + "-v",
                green: 3600,
                yellow: 900,
                partner: key + "-h",
                offset: offset + baseGreen + 900 + 500,
            });
            idx++;
        }

        // Roads and sidewalks as rectangles (axis-aligned grid).
        const margin = blockSize * 0.5;
        const roads = [];
        const sidewalks = [];
        for (let j = 0; j <= blocks; j++) {
            const cy = J(0, j).y;
            roads.push({ x: -extent - margin, y: cy - half, w: 2 * (extent + margin), h: roadWidth, axis: "x" });
            sidewalks.push({ x: -extent - margin, y: cy - half - sidewalk, w: 2 * (extent + margin), h: sidewalk });
            sidewalks.push({ x: -extent - margin, y: cy + half, w: 2 * (extent + margin), h: sidewalk });
        }
        for (let i = 0; i <= blocks; i++) {
            const cx = J(i, 0).x;
            roads.push({ x: cx - half, y: -extent - margin, w: roadWidth, h: 2 * (extent + margin), axis: "y" });
            sidewalks.push({ x: cx - half - sidewalk, y: -extent - margin, w: sidewalk, h: 2 * (extent + margin) });
            sidewalks.push({ x: cx + half, y: -extent - margin, w: sidewalk, h: 2 * (extent + margin) });
        }

        // Building blocks + trees inside each city block.
        const buildings = [];
        const trees = [];
        const inner = blockSize - 2 * (half + sidewalk) - 30;
        for (let i = 0; i < blocks; i++) {
            for (let j = 0; j < blocks; j++) {
                const c = {
                    x: (J(i, j).x + J(i + 1, j + 1).x) / 2,
                    y: (J(i, j).y + J(i + 1, j + 1).y) / 2,
                };
                const count = rand() < 0.35 ? 2 : 1;
                for (let k = 0; k < count; k++) {
                    const w = 70 + rand() * 60;
                    const h = 70 + rand() * 60;
                    const x = c.x + (rand() - 0.5) * (inner - w);
                    const y = c.y + (rand() - 0.5) * (inner - h);
                    buildings.push({ x, y, w, h, height: 26 + rand() * 60, shade: Math.floor(rand() * 3) });
                }
                if (rand() < 0.7) {
                    trees.push({
                        x: c.x + (rand() - 0.5) * inner,
                        y: c.y + (rand() - 0.5) * inner,
                        size: 26 + rand() * 16,
                        tone: rand(),
                    });
                }
            }
        }

        // Pedestrians on a subset of the ego route's crossings.
        const peds = [];
        ego.meta.forEach((cw, i) => {
            if (i % 2 !== 0) return;
            peds.push({
                id: "ped-" + i,
                crosswalk: cw.id,
                phase: (i * 900) % 6000,
                jaywalk: i % 6 === 4,
                speed: 48 + rand() * 14,
            });
        });

        // Traffic cars placed along their own routes.
        const traffic = [];
        trafficRoutes.forEach((r, i) => {
            const cars = 1 + Math.floor(rand() * 2);
            for (let k = 0; k < cars; k++) {
                const s = 40 + rand() * Math.max(1, r.lane.length - 120);
                traffic.push({
                    id: "car-" + i + "-" + k,
                    laneId: r.lane.id,
                    s,
                    speed: 58 + rand() * 18,
                    maxSpeed: 76,
                });
            }
        });

        const lanes = [ego.lane, ...trafficRoutes.map((r) => r.lane)];
        const end = Math.max(0, ego.lane.length - 24);
        return {
            id: "large-city",
            name: "Procedural city (" + blocks + "×" + blocks + " blocks)",
            bounds: {
                minX: -extent - blockSize,
                maxX: extent + blockSize,
                minY: -extent - blockSize,
                maxY: extent + blockSize,
            },
            roadWidth,
            blockSize,
            blocks,
            roads,
            sidewalks,
            lanes,
            crosswalks: ego.meta,
            signalGroups,
            allRed: 500,
            destination: { laneId: ego.lane.id, s: end, stopRadius: 26, holdTime: 1 },
            ego: { laneId: ego.lane.id, s: 8, maxSpeed: 98, speed: 0 },
            pedestrians: peds,
            traffic,
            // Scenery is generated from these directly (avoids the quadrant
            // filter in sim/scenery.js, which assumes one intersection).
            cityBuildings: buildings,
            cityTrees: trees,
        };
    }

    SIM.scene.createCityScene = createCityScene;
})(globalThis.SIM = globalThis.SIM || {});
