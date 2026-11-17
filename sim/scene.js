// sim/scene.js -- scene data for the simulation.
//
// The scene schema is an extension of the editor's WORLD_DATA idea: lanes are
// directed (one lane per travel direction), sidewalks and crosswalks are
// explicit, signals are grouped into intersection phases, and the destination
// is a stop point rather than a circle to touch.
//
// createIntersectionScene() is a hand-authored demo that exercises every
// behaviour in one small, testable map. sceneFromWorldData() is the bridge
// that derives a basic lane layout from an existing editor export.
(function (SIM) {
    "use strict";

    const ROAD_HALF = 40;      // asphalt half-width
    const LANE_OFFSET = 20;    // distance of a lane centre from the road centre
    const SIDEWALK = 32;       // sidewalk width
    const REACH = 650;         // how far each approach extends from the centre

    function pt(x, y) {
        return { x, y };
    }

    // Helpers to keep the lane table readable.
    function straightLane(id, a, b, group) {
        return {
            id,
            points: [pt(a[0], a[1]), pt(b[0], b[1])],
            speedLimit: 120,
            // Car control: the stop line sits 50px before the intersection centre.
            controls: [{
                id: "ctrl-" + id,
                s: REACH - 50,
                group,
                junction: "main",
                center: pt(0, 0),
                axis: group === "EW" ? "h" : "v",
            }],
            // The zebra sits well before the stop line so a car waiting at a
            // red light does not straddle the crossing.
            crosswalks: [{ id: cwForLane(id), s: REACH - 130 }],
        };
    }

    function cwForLane(id) {
        return {
            EB: "cw-west",
            WB: "cw-east",
            SB: "cw-north",
            NB: "cw-south",
        }[id];
    }

    function createIntersectionScene() {
        const lanes = [
            straightLane("EB", [-REACH, -LANE_OFFSET], [REACH, -LANE_OFFSET], "EW"),
            straightLane("WB", [REACH, LANE_OFFSET], [-REACH, LANE_OFFSET], "EW"),
            straightLane("SB", [LANE_OFFSET, -REACH], [LANE_OFFSET, REACH], "NS"),
            straightLane("NB", [-LANE_OFFSET, REACH], [-LANE_OFFSET, -REACH], "NS"),
        ];

        const crosswalks = [
            { id: "cw-west", from: pt(-130, -(ROAD_HALF + SIDEWALK)), to: pt(-130, ROAD_HALF + SIDEWALK), crossRoad: "EW" },
            { id: "cw-east", from: pt(130, -(ROAD_HALF + SIDEWALK)), to: pt(130, ROAD_HALF + SIDEWALK), crossRoad: "EW" },
            { id: "cw-north", from: pt(-(ROAD_HALF + SIDEWALK), -130), to: pt(ROAD_HALF + SIDEWALK, -130), crossRoad: "NS" },
            { id: "cw-south", from: pt(-(ROAD_HALF + SIDEWALK), 130), to: pt(ROAD_HALF + SIDEWALK, 130), crossRoad: "NS" },
        ];

        return {
            id: "intersection-demo",
            name: "Signalised intersection with crosswalks",
            bounds: { minX: -730, maxX: 730, minY: -730, maxY: 730 },
            roadWidth: ROAD_HALF * 2,
            laneOffset: LANE_OFFSET,
            sidewalks: [
                { x: -720, y: -ROAD_HALF - SIDEWALK, w: 1440, h: SIDEWALK },
                { x: -720, y: ROAD_HALF, w: 1440, h: SIDEWALK },
                { x: -ROAD_HALF - SIDEWALK, y: -720, w: SIDEWALK, h: 1440 },
                { x: ROAD_HALF, y: -720, w: SIDEWALK, h: 1440 },
            ],
            roads: [
                { x: -720, y: -ROAD_HALF, w: 1440, h: ROAD_HALF * 2, axis: "x" },
                { x: -ROAD_HALF, y: -720, w: ROAD_HALF * 2, h: 1440, axis: "y" },
            ],
            lanes,
            crosswalks,
            signalGroups: [
                { id: "EW", green: 5000, yellow: 1000 },
                { id: "NS", green: 5000, yellow: 1000 },
            ],
            allRed: 500,
            destination: { laneId: "EB", s: REACH + 500, stopRadius: 20, holdTime: 1.0 },
            ego: { laneId: "EB", s: 60, maxSpeed: 120, speed: 0 },
            pedestrians: [
                { id: "p1", crosswalk: "cw-west", phase: 1000, jaywalk: false, speed: 52 },
                { id: "p2", crosswalk: "cw-north", phase: 3500, jaywalk: false, speed: 52 },
                // A jaywalker ignores the signal. This is what forces the ego
                // to yield and sound the horn during the EW green phase.
                { id: "p3", crosswalk: "cw-east", phase: 6200, jaywalk: true, speed: 58 },
            ],
            traffic: [
                { id: "t1", laneId: "EB", s: 380, speed: 76, maxSpeed: 76 },
                { id: "t2", laneId: "WB", s: 260, speed: 74, maxSpeed: 74 },
                { id: "t3", laneId: "SB", s: 300, speed: 70, maxSpeed: 70 },
            ],
        };
    }

    // Bridge from the editor's saved-world.js. It produces a *basic* scene:
    // two directed lanes per graph segment and any markings that can be
    // interpreted. Rich sidewalks/crosswalks are still authored in the editor
    // schema; this keeps old exports usable while they gain the new fields.
    function sceneFromWorldData(data, options = {}) {
        const width = data.roadWidth || 80;
        const half = width / 2;
        const lanes = [];
        let index = 0;
        for (const seg of data.graph.segments) {
            const a = seg.p1;
            const b = seg.p2;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len;
            const ny = dx / len;
            const off = Math.min(width / 4, 20);
            for (const sign of [1, -1]) {
                const id = "L" + index++;
                lanes.push({
                    id,
                    points: [
                        { x: a.x + nx * off * sign, y: a.y + ny * off * sign },
                        { x: b.x + nx * off * sign, y: b.y + ny * off * sign },
                    ],
                    speedLimit: 100,
                    controls: [],
                    crosswalks: [],
                });
            }
        }

        const lights = (data.markings || []).filter((m) => m.type === "light");
        const signalGroups = [];
        if (lights.length > 0) {
            signalGroups.push({ id: "legacy", green: 4000, yellow: 1000 });
            for (const lane of lanes) {
                for (const light of lights) {
                    const s = projectS(lane, light.center);
                    if (s !== null) {
                        lane.controls.push({ id: "light-" + light.center.x + "-" + light.center.y, s, group: "legacy" });
                    }
                }
            }
        }

        const start = (data.markings || []).find((m) => m.type === "start");
        const target = (data.markings || []).find((m) => m.type === "target");
        const egoLane = lanes[0];
        const destinationLane = target && egoLane ? egoLane : egoLane;
        return {
            id: "legacy-world",
            name: "Imported from saved-world.js",
            roadWidth: width,
            lanes,
            crosswalks: [],
            sidewalks: [],
            roads: [],
            signalGroups,
            allRed: 500,
            destination: destinationLane
                ? { laneId: destinationLane.id, s: destinationLane.length || 600, stopRadius: 30, holdTime: 1 }
                : null,
            ego: { laneId: egoLane ? egoLane.id : null, s: start ? 30 : 30, maxSpeed: 100, speed: 0 },
            pedestrians: options.pedestrians || [],
            traffic: options.traffic || [],
        };
    }

    function projectS(lane, point) {
        const [a, b] = lane.points;
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const l2 = abx * abx + aby * aby;
        if (l2 < 1e-9) return null;
        const t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / l2;
        return t >= 0 && t <= 1 ? t * Math.sqrt(l2) : null;
    }

    SIM.scene = { createIntersectionScene, sceneFromWorldData };
})(globalThis.SIM = globalThis.SIM || {});
