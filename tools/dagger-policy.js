// DAgger-style fine tuning: run the learned policy, ask the rule driver what
// it would do in the states the learner actually reaches, and retrain on
// those states. This targets the off-route drift that plain imitation has.
//
//   node tools/dagger-policy.js --rounds 3 --steps 9000 --epochs 40

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

function args() {
    const out = {
        rounds: 3,
        steps: 9000,
        epochs: 40,
        seed: 7,
        out: path.join(__dirname, ".learned-policy.json"),
        init: null,
    };
    for (let i = 2; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === "--rounds") out.rounds = Number(process.argv[++i]);
        else if (a === "--steps") out.steps = Number(process.argv[++i]);
        else if (a === "--epochs") out.epochs = Number(process.argv[++i]);
        else if (a === "--seed") out.seed = Number(process.argv[++i]);
        else if (a === "--out") out.out = process.argv[++i];
        else if (a === "--init") out.init = process.argv[++i];
        else { console.error("Unknown argument: " + a); process.exit(1); }
    }
    return out;
}
const opts = args();
const weightsFile = opts.out;
const initFile = opts.init || weightsFile;
if (!fs.existsSync(initFile)) {
    console.error("Run tools/train-policy.js first, or pass --init <weights.json>.");
    process.exit(1);
}
let net = new SIM.learning.MLP(JSON.parse(fs.readFileSync(initFile, "utf8")));

const makeScenarios = () => [
    SIM.scene.createIntersectionScene(),
    SIM.scene.createCityScene({ blocks: 4, seed: opts.seed }),
    SIM.scene.createCityScene({ blocks: 6, seed: opts.seed }),
];

// Keep every demonstration from every round. Replacing the dataset each
// round caused catastrophic forgetting (the policy stopped moving entirely).
const allSamples = [];
const teacher = new SIM.AutonomousDriver();
for (const scene of makeScenarios()) {
    const sim = new SIM.Simulation(scene);
    for (let i = 0; i < Math.floor(opts.steps / 3); i++) {
        sim.step();
        if (!sim.lastObs) continue;
        allSamples.push({
            x: SIM.learning.features.toArray(sim.lastObs),
            y: SIM.learning.encodeTargets(teacher.decide(sim.lastObs)),
        });
    }
}
console.log("seed demonstrations: " + allSamples.length);

for (let round = 0; round < opts.rounds; round++) {
    const newlySeen = [];
    for (const scene of makeScenarios()) {
        const driver = new SIM.learning.LearnedDriver(net);
        const sim = new SIM.Simulation(scene, { driver });
        const steps = Math.floor(opts.steps / 3);
        for (let i = 0; i < steps; i++) {
            sim.step();
            if (!sim.lastObs) continue;
            newlySeen.push({
                x: SIM.learning.features.toArray(sim.lastObs),
                y: SIM.learning.encodeTargets(teacher.decide(sim.lastObs)),
            });
        }
    }
    allSamples.push(...newlySeen);
    net = SIM.learning.train(allSamples, {
        epochs: opts.epochs,
        lr: 0.005,
        seed: opts.seed + round,
        hidden: [32, 24],
        init: net.toJSON(),
    });
    console.log(
        "DAgger round " + (round + 1) + "/" + opts.rounds +
            "  new=" + newlySeen.length + "  total=" + allSamples.length +
            "  loss=" + SIM.learning.loss(net, allSamples).toFixed(4)
    );
    fs.writeFileSync(weightsFile, JSON.stringify(net.toJSON()));
}
console.log("saved fine-tuned weights to " + weightsFile);
