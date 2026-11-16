// Runs the headless trainer across several seeds and reports aggregate
// results. Spawns a fresh process per seed because each training run needs
// untouched module state.
//
// Usage:
//   node tools/eval-headless.js --seeds 1,2,3,4,5 --generations 8 --cars 40
//   node tools/eval-headless.js --seeds 1-10 --generations 8 --cars 40 --label center
//   node tools/eval-headless.js --seeds 1,2,3 -- --guidance tangent

const { execFileSync } = require("node:child_process");
const path = require("node:path");

function parseArgs(argv) {
    const args = {
        seeds: "1,2,3",
        generations: 8,
        cars: 40,
        label: "current",
        extra: [],
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--seeds") args.seeds = next, i++;
        else if (arg === "--generations") args.generations = Number(next), i++;
        else if (arg === "--cars") args.cars = Number(next), i++;
        else if (arg === "--label") args.label = next, i++;
        else if (arg === "--") {
            args.extra = argv.slice(i + 1);
            break;
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(1);
        }
    }

    return args;
}

function expandSeeds(spec) {
    const seeds = [];
    for (const part of spec.split(",")) {
        if (part.includes("-")) {
            const [from, to] = part.split("-").map(Number);
            for (let s = from; s <= to; s++) seeds.push(s);
        } else {
            seeds.push(Number(part));
        }
    }
    return seeds;
}

const args = parseArgs(process.argv);
const seeds = expandSeeds(args.seeds);
const trainer = path.join(__dirname, "train-headless.js");

const results = [];
for (const seed of seeds) {
    const output = execFileSync(
        process.execPath,
        [
            trainer,
            "--fresh",
            "--seed",
            String(seed),
            "--generations",
            String(args.generations),
            "--cars",
            String(args.cars),
            ...args.extra,
        ],
        { encoding: "utf8" }
    );

    const match = output.match(/bestEver=(\d+)\/(\d+)/);
    const violations = output.match(/violations=(\d+)/);
    const reached = output.match(/reachedTarget=(\d+)/);
    const crowded = output.match(/crowded=(\d+)/);
    if (!match) {
        console.error(`Could not parse seed ${seed} output:\n${output}`);
        process.exit(1);
    }

    results.push({
        seed,
        best: Number(match[1]),
        routeLength: Number(match[2]),
        violations: Number(violations ? violations[1] : 0),
        reached: Number(reached ? reached[1] : 0),
        crowded: Number(crowded ? crowded[1] : 0),
    });

    console.log(
        `seed ${String(seed).padStart(3)}  best ${String(match[1]).padStart(4)}/${match[2]}` +
            `  violations ${String(violations ? violations[1] : 0).padStart(4)}` +
            `  reached ${reached ? reached[1] : 0}` +
            `  crowded ${crowded ? crowded[1] : 0}`
    );
}

const routeLength = results[0].routeLength;
const values = results.map((r) => r.best).sort((a, b) => a - b);
const mean = values.reduce((a, b) => a + b, 0) / values.length;
const median = values[Math.floor(values.length / 2)];
const violations = results.reduce((sum, r) => sum + r.violations, 0);
const reached = results.reduce((sum, r) => sum + r.reached, 0);
const crowded =
    results.reduce((sum, r) => sum + r.crowded, 0) / results.length;

console.log(`config: ${args.label}`);
console.log(`seeds: ${seeds.join(", ")}`);
console.log(`generations: ${args.generations}  cars: ${args.cars}`);
console.log("");
for (const r of results) {
    console.log(
        `  seed ${String(r.seed).padStart(3)}  best ${String(r.best).padStart(4)}` +
            `/${routeLength}  violations ${String(r.violations).padStart(4)}` +
            `  reached ${r.reached}  crowded ${r.crowded}`
    );
}
console.log("");
console.log(
    `best progress: mean ${mean.toFixed(1)}  median ${median}  min ${values[0]}  max ${
        values[values.length - 1]
    }  (route ${routeLength})`
);
console.log(`total violations: ${violations}  total reached: ${reached}`);
console.log(`mean crowded pairs at generation end: ${crowded.toFixed(1)}`);
