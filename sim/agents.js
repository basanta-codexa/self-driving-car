// sim/agents.js -- the other road users: pedestrians and rule-driven traffic.
// They are full simulation agents (position, velocity, intent), not scenery.
(function (SIM) {
    "use strict";

    const M = SIM.math;

    function createPedestrians(scene) {
        return (scene.pedestrians || []).map((p) => {
            const cw = scene.crosswalks.find((c) => c.id === p.crosswalk);
            return {
                id: p.id,
                crosswalk: cw,
                from: cw ? { ...cw.from } : { x: 0, y: 0 },
                to: cw ? { ...cw.to } : { x: 0, y: 0 },
                pos: cw ? { ...cw.from } : { x: 0, y: 0 },
                radius: 9,
                speed: p.speed || 52,
                jaywalk: !!p.jaywalk,
                phase: p.phase || 0,
                state: "waiting",
                u: 0,
                timer: 0,
                cooldown: 5000,
                vel: { x: 0, y: 0 },
            };
        });
    }

    function updatePedestrians(peds, signals, timeMs, dt) {
        for (const p of peds) {
            if (!p.crosswalk) continue;
            const span = M.distance(p.from, p.to) || 1;
            const dir = M.normalise(M.sub(p.to, p.from));

            if (p.state === "crossing") {
                p.u += (p.speed * dt) / span;
                p.vel = M.scale(dir, p.speed);
                if (p.u >= 1) {
                    p.u = 1;
                    p.pos = { ...p.to };
                    p.state = "cooldown";
                    p.timer = 0;
                    p.vel = { x: 0, y: 0 };
                } else {
                    p.pos = M.add(p.from, M.scale(M.sub(p.to, p.from), p.u));
                }
            } else {
                p.timer += dt * 1000;
                if (p.state === "cooldown" && p.timer >= p.cooldown) {
                    p.state = "waiting";
                    p.timer = 0;
                    p.u = 0;
                    p.pos = { ...p.from };
                } else if (p.state === "waiting") {
                    const allowed =
                        p.jaywalk || signals.pedestrianCanCross(p.crosswalk.crossRoad, timeMs);
                    if (p.timer >= p.phase && allowed) {
                        p.state = "crossing";
                    }
                }
            }
        }
    }

    function createTrafficCars(scene, graph) {
        return (scene.traffic || []).map((t) => {
            const at = graph.pointAt(t.laneId, t.s);
            const angle = at ? M.angleTo(at, graph.lookahead(t.laneId, t.s, 30) || at) : 0;
            return {
                id: t.id,
                kind: "traffic",
                laneId: t.laneId,
                s: t.s,
                pos: at ? { x: at.x, y: at.y } : { x: 0, y: 0 },
                angle,
                speed: t.speed || 0,
                maxSpeed: t.maxSpeed || 70,
                radius: 16,
                width: 18,
                height: 32,
                polygon: M.orientedBox(at ? at.x : 0, at ? at.y : 0, angle, 18, 32),
                vel: { x: 0, y: 0 },
            };
        });
    }

    // Front vehicle on the same lane, ahead of `car`.
    function vehicleAhead(car, others) {
        let best = null;
        for (const o of others) {
            if (o === car || o.laneId !== car.laneId) continue;
            const gap = o.s - car.s;
            if (gap > 0 && (!best || gap < best.gap)) best = { other: o, gap };
        }
        return best;
    }

    function pedestrianInCrossing(carsPed, crosswalkId) {
        return carsPed.some(
            (p) => p.crosswalk && p.crosswalk.id === crosswalkId && p.state === "crossing"
        );
    }

    function updateTrafficCars(cars, ctx) {
        const { graph, signals, timeMs, ego, peds, dt, emit, junctions, roadWidth } = ctx;
        const agents = cars.concat(ego ? [ego] : []);
        for (const car of cars) {
            const prevS = car.s;
            const control = graph.nextControl(car.laneId, car.s);
            const signalState = control ? signals.stateAt(control.group, timeMs) : "green";
            const crosswalk = graph.nextCrosswalk(car.laneId, car.s);
            let target = car.maxSpeed;

            if (control && (signalState === "red" || signalState === "yellow")) {
                const d = Math.max(0, control.distance);
                target = Math.min(target, d < 70 ? 0 : M.clamp((d - 70) * 0.7, 0, car.maxSpeed));
            }
            if (
                crosswalk &&
                crosswalk.distance < 130 &&
                pedestrianInCrossing(peds, crosswalk.id)
            ) {
                target = 0;
            }
            let ahead = vehicleAhead(car, cars);
            // The ego follows its own route, so a shared lane id is not enough
            // to see it. Detect it physically when it is strictly ahead.
            if (ego && ego !== car) {
                const ep = graph.project(ego.pos, car.laneId);
                if (ep && ep.lateral < 32 && ep.s > car.s) {
                    const gap = ep.s - car.s;
                    if (gap < 200 && (!ahead || gap < ahead.gap)) {
                        ahead = { other: ego, gap };
                    }
                }
            }
            if (ahead) {
                const desiredGap = 42 + car.speed * 0.65;
                target = Math.min(
                    target,
                    Math.max(0, ahead.other.speed + (ahead.gap - desiredGap) * 0.9)
                );
            }

            // Junction right of way: crossing traffic on the same approach
            // yields instead of clipping each other.
            if (
                junctions &&
                SIM.rightOfWay.mustYield({
                    graph,
                    junctions,
                    agents,
                    agent: car,
                    roadWidth,
                })
            ) {
                target = 0;
            }

            // Longitudinal control.
            if (car.speed < target) car.speed = Math.min(target, car.speed + 90 * dt);
            else car.speed = Math.max(target, car.speed - 150 * dt);
            car.speed = M.clamp(car.speed, 0, car.maxSpeed);

            car.s += car.speed * dt;
            if (car.s >= graph.length(car.laneId) - 1) {
                // Recycle at the route start, but never materialise on top of
                // the ego (including a car parked at its destination).
                const startPoint = graph.pointAt(car.laneId, 0);
                if (startPoint && (!ego || SIM.math.distance(startPoint, ego.pos) > 120)) {
                    car.s = 0;
                } else {
                    car.s = graph.length(car.laneId) - 1;
                    car.speed = 0;
                }
            }
            const at = graph.pointAt(car.laneId, car.s);
            const aim = graph.lookahead(car.laneId, car.s, 28 + car.speed * 0.3) || at;
            if (at && aim) {
                const desired = M.angleTo(at, aim);
                car.angle += M.clamp(M.wrapAngle(desired - car.angle), -1.6 * dt, 1.6 * dt);
                car.pos = { x: at.x, y: at.y };
                car.vel = M.scale(M.forward(car.angle), car.speed);
                car.polygon = M.orientedBox(car.pos.x, car.pos.y, car.angle, car.width, car.height);
            }

            // Mark junction ownership once the stop line is actually crossed,
            // and release it once the car has cleared the junction.
            if (control && prevS < control.s && car.s >= control.s) {
                car.junction = control.junction;
            }
            if (car.junction && junctions) {
                const j = junctions.get(car.junction);
                if (j && M.distance(car.pos, j.center) > 120) car.junction = null;
            }

            // Crossing a stop line against a red/yellow signal is a violation.
            if (control && prevS < control.s && car.s >= control.s && signalState !== "green") {
                emit("violation", { id: car.id, group: control.group });
            }
        }
    }

    SIM.agents = {
        createPedestrians,
        updatePedestrians,
        createTrafficCars,
        updateTrafficCars,
    };
})(globalThis.SIM = globalThis.SIM || {});
