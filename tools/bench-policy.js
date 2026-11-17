// Benchmark: rule driver vs learned policy on identical scenarios.
// Reports real outcomes; no claim is made unless the numbers support it.
//
//   node tools/bench-policy.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const scripts = [
    "sim/math.js", "sim/scene.js", "sim/city.js", "sim/lanes.js",
    "sim/signals.js", "sim/rightofway.js", "sim/agents.js", "sim/driver.js",
    "sim/scenery.js", "sim/simulation.js",
    "sim/learn/features.js", "sim/learn/network.js", "sim/learn/policy.js",
];
for (const file of scripts) {
    vm.runInThisContext(fs.readFileSync(path.join(root, file), "utf8"), { filename: file });
}
const SIM = globalThis.SIM;

const weightsArg = process.argv.indexOf("--weights");
const weightsFile =
    weightsArg >= 0
        ? path.resolve(process.argv[weightsArg + 1])
        : path.join(__dirname, ".learned-policy.json");
if (!fs.existsSync(weightsFile)) {
    console.error("No learned policy. Run: node tools/train-policy.js");
    process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(weightsFile, "utf8"));

function run(scene, steps, kind) {
    const driver =
        kind === "learned" ? new SIM.learning.LearnedDriver(spec)
        : kind === "hybrid" ? new SIM.learning.HybridDriver(spec)
        : kind === "blend" ? new SIM.learning.BlendDriver(spec, 0.35)
        : null;
    const sim = new SIM.Simulation(scene, driver ? { driver } : {});
    for (let i = 0; i < steps; i++) sim.step();
    return sim.summary();
}

const cases = [
    ["intersection", () => SIM.scene.createIntersectionScene(), 4800],
    ["city 4x4", () => SIM.scene.createCityScene({ blocks: 4, seed: 7 }), 15000],
    ["city 6x6", () => SIM.scene.createCityScene({ blocks: 6, seed: 7 }), 20000],
];

console.log("scenario      policy    arrived  collisions  near  viol  time(s)  distance  maxLateral  state");
for (const [name, makeScene, steps] of cases) {
    for (const kind of ["rules", "learned", "hybrid", "blend"]) {
        const s = run(makeScene(), steps, kind);
        console.log(
            [
                name.padEnd(13),
                kind.padEnd(8),
                String(s.arrived).padEnd(8),
                String(s.collisions).padEnd(11),
                String(s.nearMisses).padEnd(5),
                String(s.violations).padEnd(5),
                String(s.time).padEnd(8),
                String(s.distance).padEnd(9),
                String(s.maxLateral).padEnd(11),
                s.finalState,
            ].join(" ")
        );
    }
}
