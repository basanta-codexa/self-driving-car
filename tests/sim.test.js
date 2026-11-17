// Tests for the new rule-based simulation. Loads exactly the same SIM modules
// the browser and headless runner use -- no DOM, no canvas, no source patching.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
for (const file of ["math", "scene", "city", "lanes", "signals", "rightofway", "agents", "driver", "scenery", "simulation", "learn/features", "learn/network", "learn/policy"]) {
    vm.runInThisContext(
        fs.readFileSync(path.join(root, "sim", file + ".js"), "utf8"),
        { filename: file + ".js" }
    );
}
const SIM = globalThis.SIM;
const M = SIM.math;

function makeSim() {
    return new SIM.Simulation(SIM.scene.createIntersectionScene());
}

test("heading helpers agree with each other", () => {
    for (const a of [-2, -0.7, 0, 0.4, 1.9]) {
        const f = M.forward(a);
        assert.ok(Math.abs(M.length(f) - 1) < 1e-9);
        const to = { x: f.x * 50, y: f.y * 50 };
        const back = M.forward(M.angleTo({ x: 0, y: 0 }, to));
        assert.ok(Math.abs(back.x - f.x) < 1e-6);
        assert.ok(Math.abs(back.y - f.y) < 1e-6);
    }
    assert.ok(Math.abs(M.wrapAngle(Math.PI * 3) - Math.PI) < 1e-9);
});

test("lane graph projects, looks ahead and finds the stop line", () => {
    const sim = makeSim();
    const g = sim.graph;
    const point = g.pointAt("EB", 580);
    assert.ok(Math.abs(point.x + 70) < 1e-6);
    assert.ok(Math.abs(point.y + 20) < 1e-6);

    const proj = g.project({ x: -120, y: -32 }, "EB");
    assert.equal(proj.laneId, "EB");
    assert.ok(proj.s > 525 && proj.s < 535);
    assert.ok(Math.abs(proj.lateral - 12) < 1e-6);

    const ahead = g.lookahead("EB", 520, 60);
    assert.ok(Math.abs(ahead.x - (-70)) < 1e-6);

    const control = g.nextControl("EB", 560);
    assert.equal(control.group, "EW");
    assert.ok(Math.abs(control.distance - 40) < 1e-6);
});

test("signal controller runs one green group at a time with all-red clearance", () => {
    const s = new SIM.SignalController(
        [{ id: "EW", green: 5000, yellow: 1000 }, { id: "NS", green: 5000, yellow: 1000 }],
        500
    );
    assert.equal(s.cycle, 13000);
    assert.equal(s.stateAt("EW", 1000), "green");
    assert.equal(s.stateAt("NS", 1000), "red");
    assert.equal(s.stateAt("EW", 5500), "yellow");
    assert.equal(s.stateAt("EW", 6200), "red");
    assert.equal(s.stateAt("NS", 6200), "red"); // all-red gap
    assert.equal(s.stateAt("NS", 8000), "green");
    assert.equal(s.pedestrianCanCross("EW", 1000), false);
    assert.equal(s.pedestrianCanCross("NS", 1000), true);
});

test("driver stops for a red signal", () => {
    const sim = makeSim();
    sim.timeMs = 7000; // all-red: both groups red
    const at = sim.graph.pointAt("EB", 560);
    sim.ego.pos = { x: at.x, y: at.y };
    sim.ego.s = 560;
    sim.ego.speed = 100;
    sim.peds = []; // isolate the signal rule from the pedestrian rule
    const obs = SIM.perceive(sim);
    const cmd = new SIM.AutonomousDriver().decide(obs, 16.7);
    assert.equal(obs.control.state, "red");
    assert.equal(cmd.state, "APPROACH_SIGNAL");
    assert.ok(cmd.target < 50);
    assert.ok(cmd.brake > 0);
});

test("driver yields and honks at a pedestrian in the lane", () => {
    const sim = makeSim();
    sim.timeMs = 1000; // EW green
    const at = sim.graph.pointAt("EB", 400);
    sim.ego.pos = { x: at.x, y: at.y };
    sim.ego.s = 400;
    sim.ego.speed = 60;
    const p = sim.peds[0];
    p.state = "crossing";
    p.pos = { x: at.x + 60, y: at.y };
    const obs = SIM.perceive(sim);
    assert.ok(obs.ped, "pedestrian should be detected");
    assert.equal(obs.ped.crossing, true);
    const cmd = new SIM.AutonomousDriver().decide(obs, 16.7);
    assert.equal(cmd.state, "YIELD_PEDESTRIAN");
    assert.ok(cmd.horn);
    assert.ok(cmd.target < 30);
});

test("driver commits to a full stop at the destination", () => {
    const sim = makeSim();
    const dest = sim.scene.destination;
    const at = sim.graph.pointAt(dest.laneId, dest.s - 10);
    sim.ego.pos = { x: at.x, y: at.y };
    sim.ego.s = dest.s - 10;
    sim.ego.speed = 5;
    const obs = SIM.perceive(sim);
    const cmd = new SIM.AutonomousDriver().decide(obs, 16.7);
    assert.equal(cmd.state, "ARRIVED");
    assert.equal(cmd.target, 0);
    assert.ok(cmd.brake > 0);
});

test("full intersection run completes safely and deterministically", () => {
    const a = makeSim();
    const b = makeSim();
    for (let i = 0; i < 4800; i++) {
        a.step();
        b.step();
    }
    const sa = a.summary();
    const sb = b.summary();
    assert.deepEqual(sa, sb, "same scene must produce identical results");
    assert.equal(sa.arrived, true);
    assert.equal(sa.collisions, 0);
    assert.equal(sa.nearMisses, 0);
    assert.equal(sa.violations, 0);
    assert.equal(typeof sa.hornEvents, "number");
});

test("procedural scenery is deterministic and stays off the roads", () => {
    const scene = SIM.scene.createIntersectionScene();
    const a = SIM.scenery.generate(scene);
    const b = SIM.scenery.generate(scene);
    assert.deepEqual(a, b, "same seed must generate the same city");
    assert.ok(a.buildings.length > 0 && a.trees.length > 0);
    const clear = scene.roadWidth / 2 + 42;
    for (const item of [...a.buildings, ...a.trees]) {
        const half = (item.w || item.size) / 2;
        assert.ok(
            Math.abs(item.x) - half > clear && Math.abs(item.y) - half > clear,
            "scenery must sit outside both road bands"
        );
    }
});

test("right of way yields to a car that owns the junction", () => {
    const sim = makeSim();
    const g = sim.graph;
    const junctions = SIM.rightOfWay.buildJunctions(g);
    const ego = sim.ego;
    const other = sim.traffic[0];
    const control = g.nextControl(ego.laneId, ego.s);
    assert.ok(control && control.junction);
    const at = g.pointAt(ego.laneId, control.s - 100);
    ego.s = control.s - 100;
    ego.pos = { x: at.x, y: at.y };

    // No one owns the junction yet -> no yield.
    assert.equal(
        SIM.rightOfWay.mustYield({
            graph: g,
            junctions,
            agents: [ego, other],
            agent: ego,
            roadWidth: sim.scene.roadWidth,
        }),
        false
    );

    // A crossing car that has crossed the same stop line owns it -> yield.
    other.junction = control.junction;
    other.speed = 40;
    assert.equal(
        SIM.rightOfWay.mustYield({
            graph: g,
            junctions,
            agents: [ego, other],
            agent: ego,
            roadWidth: sim.scene.roadWidth,
        }),
        true
    );
});

test("large city generates a long multi-junction route deterministically", () => {
    const a = SIM.scene.createCityScene({ blocks: 4, seed: 7 });
    const b = SIM.scene.createCityScene({ blocks: 4, seed: 7 });
    assert.deepEqual(a, b);
    assert.ok(a.lanes[0].length > 2500, "ego route must span the city");
    assert.ok(a.lanes[0].controls.length >= 3, "route must cross several signalised junctions");
    assert.ok(a.signalGroups.length >= 6);
    assert.ok(a.traffic.length > 0 && a.crosswalks.length > 0);
    assert.ok(a.cityBuildings.length > 10 && a.cityTrees.length > 0);
});

test("large city run reaches the destination", () => {
    const sim = new SIM.Simulation(SIM.scene.createCityScene({ blocks: 4, seed: 7 }));
    for (let i = 0; i < 15000; i++) sim.step();
    const s = sim.summary();
    assert.equal(s.arrived, true);
    assert.equal(s.violations, 0);
    // Right-of-way negotiation + traffic seeing the ego physically ahead
    // removes the junction contacts that used to occur here.
    assert.equal(s.collisions, 0);
    assert.ok(s.nearMisses <= 2);
});

test("learning features are fixed-size and finite", () => {
    const sim = makeSim();
    sim.step();
    const f = SIM.learning.features.toArray(sim.lastObs);
    assert.equal(f.length, SIM.learning.features.FEATURES);
    assert.equal(f.length, 16);
    assert.ok(f.every(Number.isFinite));
    assert.equal(SIM.learning.features.NAMES.length, f.length);
});

test("learned MLP forward pass and driver output are bounded", () => {
    const net = SIM.learning.train(
        [
            { x: new Array(16).fill(0), y: [0.8, -0.8, 0, -0.8] },
            { x: new Array(16).fill(1), y: [-0.8, 0.8, 0, 0.8] },
        ],
        { epochs: 2, seed: 3, hidden: [4, 4] }
    );
    const out = net.forward(new Array(16).fill(0.2));
    assert.equal(out.length, 4);
    assert.ok(out.every((v) => Number.isFinite(v) && v >= -1 && v <= 1));

    const driver = new SIM.learning.LearnedDriver(net);
    const cmd = driver.decide(simObs());
    assert.ok(cmd.throttle >= 0 && cmd.throttle <= 1);
    assert.ok(cmd.brake >= 0 && cmd.brake <= 1);
    assert.ok(cmd.steer >= -1 && cmd.steer <= 1);
    assert.equal(cmd.state, "LEARNED");
});

test("hybrid driver combines a learned speed policy with rule steering", () => {
    const net = SIM.learning.train(
        [
            { x: new Array(16).fill(0), y: [0.8, -0.8, 0, -0.8] },
            { x: new Array(16).fill(1), y: [-0.8, 0.8, 0, 0.8] },
        ],
        { epochs: 2, seed: 5, hidden: [4, 4] }
    );
    const driver = new SIM.learning.HybridDriver(net);
    const cmd = driver.decide(simObs());
    assert.equal(cmd.state, "HYBRID");
    assert.ok(cmd.throttle >= 0 && cmd.throttle <= 1);
    assert.ok(cmd.brake >= 0 && cmd.brake <= 1);
    assert.ok(Number.isFinite(cmd.steer));
});

function simObs() {
    const s = makeSim();
    s.step();
    return s.lastObs;
}

test("blend co-pilot defers to rule driver outside cruising", () => {
    const net = SIM.learning.train(
        [
            { x: new Array(16).fill(0), y: [0.8, -0.8, 0, -0.8] },
            { x: new Array(16).fill(1), y: [-0.8, 0.8, 0, 0.8] },
        ],
        { epochs: 2, seed: 9, hidden: [4, 4] }
    );
    const driver = new SIM.learning.BlendDriver(net, 0.35);
    const cmd = driver.decide(simObs());
    assert.equal(cmd.state, "BLEND");
    assert.ok(cmd.throttle >= 0 && cmd.throttle <= 1);
});

test("editor export bridge produces two directed lanes per segment", () => {
    const world = {
        roadWidth: 80,
        graph: {
            segments: [
                { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 } },
                { p1: { x: 0, y: 0 }, p2: { x: 0, y: 100 } },
            ],
        },
        markings: [{ type: "light", center: { x: 50, y: 0 } }],
    };
    const scene = SIM.scene.sceneFromWorldData(world);
    assert.equal(scene.lanes.length, 4);
    assert.equal(scene.signalGroups.length, 1);
    assert.ok(scene.lanes.every((l) => l.controls.length > 0));
});
