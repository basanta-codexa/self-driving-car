// Imitation-learning trainer: record the rule driver, train a small MLP to
// reproduce its controls, then save the weights. No browser, no canvas.
//
//   node tools/train-policy.js --steps 30000 --epochs 200
//   node tools/train-policy.js --scene intersection --steps 8000

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
        steps: 30000,
        epochs: 200,
        scene: "city",
        blocks: 4,
        seed: 7,
        out: path.join(__dirname, ".learned-policy.json"),
    };
    for (let i = 2; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === "--steps") out.steps = Number(process.argv[++i]);
        else if (a === "--epochs") out.epochs = Number(process.argv[++i]);
        else if (a === "--scene") out.scene = process.argv[++i];
        else if (a === "--blocks") out.blocks = Number(process.argv[++i]);
        else if (a === "--seed") out.seed = Number(process.argv[++i]);
        else if (a === "--out") out.out = process.argv[++i];
        else {
            console.error("Unknown argument: " + a);
            process.exit(1);
        }
    }
    return out;
}

const opts = args();
const scenarios =
    opts.scene === "city"
        ? [
              [SIM.scene.createCityScene({ blocks: opts.blocks, seed: opts.seed }), opts.steps],
              [SIM.scene.createCityScene({ blocks: 6, seed: opts.seed }), opts.steps],
              [SIM.scene.createIntersectionScene(), Math.floor(opts.steps / 2)],
          ]
        : [[SIM.scene.createIntersectionScene(), opts.steps]];

const samples = [];
for (const [scene, steps] of scenarios) {
    const sim = new SIM.Simulation(scene);
    for (let i = 0; i < steps; i++) {
        sim.step();
        if (!sim.lastObs || !sim.lastCmd) continue;
        samples.push({
            x: SIM.learning.features.toArray(sim.lastObs),
            y: SIM.learning.encodeTargets(sim.lastCmd),
        });
    }
}
console.log("recorded " + samples.length + " demonstrations from the rule driver");
const initial = SIM.learning.train(samples.slice(0, 2000), {
    epochs: 1,
    seed: opts.seed,
    hidden: [32, 24],
});
console.log("initial loss:  " + SIM.learning.loss(initial, samples.slice(0, 2000)).toFixed(5));

const net = SIM.learning.train(samples, {
    epochs: opts.epochs,
    seed: opts.seed,
    lr: 0.008,
    hidden: [32, 24],
});
console.log("final loss:    " + SIM.learning.loss(net, samples).toFixed(5));
fs.writeFileSync(opts.out, JSON.stringify(net.toJSON()));
console.log("saved weights to " + opts.out);
