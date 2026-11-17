// sim/driver.js -- perception snapshot + the rule-based autonomous driver.
//
// This is the "intelligence" layer for now: a behaviour state machine built
// from explicit rules, with pure-pursuit steering and PID-like speed control.
// A learned policy can later implement decide() against the same observation;
// everything else in the simulation stays unchanged.
(function (SIM) {
    "use strict";

    const M = SIM.math;

    // Build everything the driver is allowed to know about this frame.
    function perceive(sim) {
        const ego = sim.ego;
        const graph = sim.graph;
        const proj = graph.project(ego.pos, ego.laneId) || {
            s: 0, lateral: 0, point: ego.pos,
        };
        const lane = graph.get(ego.laneId);
        const lookahead =
            graph.lookahead(ego.laneId, proj.s, 35 + ego.speed * 0.35) ||
            graph.pointAt(ego.laneId, proj.s);

        const control = graph.nextControl(ego.laneId, proj.s);
        const signalState = control ? sim.signals.stateAt(control.group, sim.timeMs) : "green";
        const crosswalk = graph.nextCrosswalk(ego.laneId, proj.s);

        const junctionYield =
            !!sim.junctions &&
            SIM.rightOfWay.mustYield({
                graph,
                junctions: sim.junctions,
                agents: sim.traffic.concat([ego]),
                agent: ego,
                roadWidth: sim.scene.roadWidth,
            });

        let ped = null;
        for (const p of sim.peds) {
            const pp = graph.project(p.pos, ego.laneId);
            // Two independent cues:
            //  1. a pedestrian whose projection is actually inside our lane
            //     (a narrow window -- someone crossing a perpendicular road can
            //     project nearby without ever being in our path);
            //  2. a pedestrian at the crossing we are approaching, even while
            //     waiting on the kerb -- seeing them early is what lets us stop
            //     *before* the zebra instead of inside it.
            const cues = [];
            if (pp) {
                const ahead = pp.s - proj.s;
                if (ahead > -12 && ahead < 170 && pp.lateral < 24) {
                    cues.push(ahead);
                }
            }
            if (
                crosswalk &&
                p.crosswalk &&
                p.crosswalk.id === crosswalk.id &&
                crosswalk.distance >= 0 &&
                crosswalk.distance < 170
            ) {
                // Only a pedestrian who is in the road, or about to step off
                // the kerb, is a conflict. A permanent "waiting" cue would stop
                // the ego forever in front of an empty crossing.
                const mayGo = p.jaywalk || sim.signals.pedestrianCanCross(p.crosswalk.crossRoad, sim.timeMs);
                const aboutToGo =
                    p.state === "waiting" && mayGo && p.timer >= Math.max(0, p.phase - 2000);
                if (p.state === "crossing" || aboutToGo) {
                    cues.push(crosswalk.distance);
                }
            }
            for (const distance of cues) {
                if (!ped || distance < ped.distance) {
                    ped = {
                        id: p.id,
                        distance,
                        lateral: pp ? pp.lateral : null,
                        crossing: p.state === "crossing",
                        inCrosswalk: !!crosswalk && !!p.crosswalk && p.crosswalk.id === crosswalk.id,
                    };
                }
            }
        }

        let carAhead = null;
        const considerCar = (id, distance, speed) => {
            if (distance > -10 && distance < 220 && (!carAhead || distance < carAhead.distance)) {
                carAhead = { id, distance, speed };
            }
        };
        for (const c of sim.traffic) {
            // Project every car onto our lane: a car on a different route can
            // still be physically in front of us at a junction or crossing.
            const cp = graph.project(c.pos, ego.laneId);
            if (cp && cp.lateral < 32) considerCar(c.id, cp.s - proj.s, c.speed);
            else if (c.laneId === ego.laneId) considerCar(c.id, c.s - proj.s, c.speed);
        }

        // Physical forward cone: catches cars that are in front of us even
        // when they belong to a completely different route (junctions).
        const heading = M.forward(ego.angle);
        let frontCar = null;
        for (const c of sim.traffic) {
            const rel = M.sub(c.pos, ego.pos);
            const along = M.dot(rel, heading);
            const lateral = Math.abs(M.cross(heading, rel));
            if (along > 0 && along < 260 && lateral < 30) {
                if (!frontCar || along < frontCar.distance) {
                    frontCar = { id: c.id, distance: along, speed: c.speed };
                }
            }
        }

        const dest = sim.scene.destination;
        const destDist = dest ? dest.s - proj.s : Infinity;

        return {
            pos: { ...ego.pos },
            angle: ego.angle,
            speed: ego.speed,
            laneId: ego.laneId,
            s: proj.s,
            lateral: proj.lateral,
            speedLimit: lane ? lane.speedLimit : 100,
            lookahead,
            control: control
                ? { id: control.id, group: control.group, distance: control.distance, state: signalState }
                : null,
            crosswalk,
            junctionYield,
            ped,
            carAhead,
            frontCar,
            destDist,
            arrived: sim.metrics.arrived,
            stopRadius: dest ? dest.stopRadius : 15,
            timeMs: sim.timeMs,
        };
    }

    class AutonomousDriver {
        constructor() {
            this.state = "CRUISE";
            this.hornUntil = 0;
            this.blockedMs = 0;
            this.lastHornMs = -10000;
        }

        decide(obs, dtMs) {
            const limit = obs.speedLimit;
            let target = limit;
            let state = "CRUISE";
            let horn = false;

            // Once parked, stay parked and silent.
            if (obs.arrived) {
                this.state = "ARRIVED";
                return { throttle: 0, brake: 1, steer: 0, horn: false, state: "ARRIVED", target: 0 };
            }

            // 1. Destination: decelerate to a full stop at the stop point.
            if (obs.destDist <= obs.stopRadius) {
                state = "ARRIVED";
                target = 0;
            } else if (obs.destDist < 190) {
                state = "ARRIVING";
                // Keep a small creep speed so drag cannot stall us just short
                // of the mark; only command zero once we are on top of it.
                target =
                    obs.destDist < obs.stopRadius + 5
                        ? 0
                        : M.clamp(Math.max(6, (obs.destDist - obs.stopRadius) * 0.8), 0, limit);
            }

            // 2. Traffic signal: stop at the line while red/yellow.
            if (obs.control && (obs.control.state === "red" || obs.control.state === "yellow")) {
                const d = Math.max(0, obs.control.distance);
                if (d < 180) {
                    // Stop far enough back that the nose clears both the stop
                    // line and the zebra that sits just before it.
                    // The zebra sits ~115px before the junction entry; the
                    // whole car must stop behind it, including braking lag.
                    const stopClearance = 190;
                    state = d < stopClearance && obs.speed < 3 ? "STOPPED_SIGNAL" : "APPROACH_SIGNAL";
                    target = Math.min(
                        target,
                        d < stopClearance ? 0 : M.clamp((d - stopClearance) * 0.55, 0, limit)
                    );
                }
            }

            // 3. Pedestrian in the lane: yield, and warn if it is close.
            if (obs.ped && obs.ped.distance < 140) {
                state = "YIELD_PEDESTRIAN";
                const d = obs.ped.distance;
                // Stop at least a car-length before the crossing, otherwise the
                // pedestrian can walk into the nose of a correctly stopped car.
                const clearance = 46;
                target = Math.min(target, d < clearance ? 0 : M.clamp((d - clearance) * 0.5, 0, limit));
                if (d < 100 && obs.speed > 12 && obs.ped.crossing) horn = true;
            }

            // 4. Vehicle ahead: keep a speed-proportional gap.
            if (obs.carAhead) {
                // IDM-style following: keep a speed-dependent gap, and close
                // that gap slowly instead of waiting until the last moment.
                const desiredGap = 42 + obs.speed * 0.65;
                const following =
                    obs.carAhead.speed + (obs.carAhead.distance - desiredGap) * 0.9;
                target = Math.min(target, Math.max(0, following));
            }

            // Any nonzero request must overcome rolling drag, otherwise a
            // tiny target (e.g. 2px/s near a hazard) stalls the car forever.
            if (target > 0) target = Math.max(target, 8);
            // Right of way: a crossing car already in the junction goes first.
            if (obs.junctionYield) {
                state = "YIELD_JUNCTION";
                target = 0;
            }

            // Hard safety brake for anything physically in the forward cone.
            if (obs.frontCar && obs.frontCar.distance < 120) {
                state = "YIELD_VEHICLE";
                target = 0;
            }

            if (target > 0) target = Math.max(target, 8);
            target = M.clamp(target, 0, limit);

            // Horn if we have been blocked for a while and have not just honked.
            const pedBlocking = obs.ped && obs.ped.crossing && obs.ped.distance < 60;
            const carBlocking = obs.carAhead && obs.carAhead.distance < 60;
            const waitingAtSignal =
                obs.control && obs.control.state !== "green" && obs.control.distance < 75;
            if (state !== "ARRIVED" && obs.speed < 3 && !waitingAtSignal && (pedBlocking || carBlocking)) {
                this.blockedMs += dtMs;
            } else {
                this.blockedMs = Math.max(0, this.blockedMs - dtMs * 2);
            }
            if (state !== "ARRIVED" && this.blockedMs > 1200 && obs.timeMs - this.lastHornMs > 2500) {
                horn = true;
            }
            if (horn) {
                this.hornUntil = obs.timeMs + 650;
                this.lastHornMs = obs.timeMs;
                this.blockedMs = 0;
            }
            const hornActive = obs.timeMs < this.hornUntil;

            // Longitudinal control.
            let throttle = 0;
            let brake = 0;
            if (state === "ARRIVED") {
                brake = obs.speed > 0.2 ? 1 : 0;
            } else if (obs.speed < target - 1.5) {
                throttle = M.clamp((target - obs.speed) / 25, 0, 1);
            } else if (obs.speed > target + 1.5) {
                brake = M.clamp((obs.speed - target) / 35, 0, 1);
            }

            // Lateral control: pure pursuit toward the lookahead point.
            let steer = 0;
            if (obs.lookahead) {
                const desired = M.angleTo(obs.pos, obs.lookahead);
                const err = M.wrapAngle(desired - obs.angle);
                steer = M.clamp(err * 1.6, -1, 1); // positive = turn left
            }

            this.state = state;
            return { throttle, brake, steer, horn: hornActive, state, target };
        }
    }

    SIM.perceive = perceive;
    SIM.AutonomousDriver = AutonomousDriver;
})(globalThis.SIM = globalThis.SIM || {});
