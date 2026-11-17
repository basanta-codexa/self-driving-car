// Headless runner for the new simulation. No DOM, no canvas, no source patching.
// Loads the same SIM modules the browser loads and steps the real Simulation.
//
//   node tools/sim-headless.js --steps 3600
//   node tools/sim-headless.js --steps 3600 --json
//   node tools/sim-headless.js --steps 3600 --events

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const scripts = [
    "sim/math.js",
    "sim/scene.js",
    "sim/city.js",
    "sim/lanes.js",
    "sim/signals.js",
    "sim/rightofway.js",
    "sim/agents.js",
    "sim/driver.js",
    "sim/scenery.js",
    "sim/simulation.js",
];
for (const file of scripts) {
    vm.runInThisContext(fs.readFileSync(path.join(root, file), "utf8"), { filename: file });
}
const SIM = globalThis.SIM;

function args() {
    const out = {
        steps: 3600,
        json: false,
        events: false,
        scene: "intersection",
        blocks: 6,
        seed: 7,
        trafficRoutes: null,
    };
    for (let i = 2; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === "--steps") out.steps = Number(process.argv[++i]);
        else if (a === "--json") out.json = true;
        else if (a === "--events") out.events = true;
        else if (a === "--scene") out.scene = process.argv[++i];
        else if (a === "--blocks") out.blocks = Number(process.argv[++i]);
        else if (a === "--seed") out.seed = Number(process.argv[++i]);
        else if (a === "--traffic-routes") out.trafficRoutes = Number(process.argv[++i]);
        else {
            console.error("Unknown argument: " + a);
            process.exit(1);
        }
    }
    return out;
}

const opts = args();
const scene =
    opts.scene === "city"
        ? SIM.scene.createCityScene({
              blocks: opts.blocks,
              seed: opts.seed,
              trafficRoutes: opts.trafficRoutes || undefined,
          })
        : SIM.scene.createIntersectionScene();
const sim = new SIM.Simulation(scene);

for (let i = 0; i < opts.steps; i++) sim.step();
const summary = sim.summary();

if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
} else {
    console.log("scene:      " + scene.name);
    console.log("steps:      " + opts.steps + "  (" + summary.time + "s simulated)");
    console.log("arrived:    " + summary.arrived);
    console.log("distance:   " + summary.distance + "px");
    console.log("collisions: " + summary.collisions + "  near-misses: " + summary.nearMisses +
        "  violations: " + summary.violations + "  horn: " + summary.hornEvents);
    console.log("state:      " + summary.finalState);
    console.log("events:     " + summary.events.length);
}
if (opts.events) {
    for (const e of summary.events) {
        console.log(
            "  " + (e.t / 1000).toFixed(2) + "s  " + e.type + "  " +
                JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== "type" && k !== "t")))
        );
    }
}
