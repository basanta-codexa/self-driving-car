// sim/rightofway.js -- right-of-way negotiation at junctions.
//
// Cars approaching the same junction on crossing axes must agree who goes
// first. The rules are deliberately simple and deterministic:
//   1. never enter a junction already occupied by a crossing car;
//   2. otherwise the car that will arrive first goes first.
// Signals still override this (a red light is an absolute stop).
(function (SIM) {
    "use strict";

    const M = SIM.math;

    function buildJunctions(graph) {
        const map = new Map();
        for (const lane of graph.lanes.values()) {
            for (const c of lane.controls) {
                if (!c.junction || !c.center) continue;
                if (!map.has(c.junction)) {
                    map.set(c.junction, {
                        key: c.junction,
                        center: { x: c.center.x, y: c.center.y },
                    });
                }
            }
        }
        return map;
    }

    // Fallback axis for a car that has already passed its stop line.
    function axisFromAngle(angle) {
        const f = M.forward(angle);
        return Math.abs(f.x) >= Math.abs(f.y) ? "h" : "v";
    }

    // Must `agent` yield at its upcoming junction?
    function mustYield(ctx) {
        const { graph, junctions, agents, agent, roadWidth } = ctx;
        const control = graph.nextControl(agent.laneId, agent.s);
        if (!control || !control.junction || control.distance < -5 || control.distance > 170) {
            return false;
        }
        const junction = junctions.get(control.junction);
        if (!junction) return false;
        const myTime = control.distance / Math.max(agent.speed, 12);

        for (const other of agents) {
            if (other === agent || other.damaged) continue;
            const oc = graph.nextControl(other.laneId, other.s);
            const sameJunction = oc && oc.junction === control.junction;

            // Rule 1: a car that has actually crossed this junction's stop
            // line owns the junction until it clears. This is unambiguous --
            // unlike guessing from position, a car waiting at the line is
            // correctly treated as not yet inside.
            if (other.junction === control.junction && other.speed > 4) return true;

            // Rule 2: first to arrive goes first, but only across axes -- cars
            // on the same road are handled by normal car-following.
            if (
                sameJunction &&
                oc.axis !== control.axis &&
                oc.distance >= -5 &&
                oc.distance < 170
            ) {
                const otherTime = oc.distance / Math.max(other.speed, 12);
                if (otherTime < myTime - 0.2) return true;
            }
        }
        return false;
    }

    SIM.rightOfWay = { buildJunctions, mustYield, axisFromAngle };
})(globalThis.SIM = globalThis.SIM || {});
