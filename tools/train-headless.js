// Headless training runner.
//
// Loads the same scripts as world/ai.html into a VM with a stubbed DOM,
// then drives the real animate() loop frame by frame. This lets us measure
// generations, progress, off-route runs and signal violations from a
// terminal instead of watching the canvas.
//
// Usage:
//   node tools/train-headless.js
//   node tools/train-headless.js --generations 5 --cars 40
//   node tools/train-headless.js --look-ahead 60 --fresh
//
// Every flag is a harness override only. world/ai.js is not modified.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function parseArgs(argv) {    const args = {
        generations: 3,
        cars: 100,
        maxFrames: 4500,
        stallFrames: 900,
        lookAhead: null,
        fresh: false,
        traceEvery: 0,
        traceGen: 0,
        loadBrain: null,
        saveBrain: null,
        seed: null,
        guidance: "center",
        stopBonus: null,
        verbose: false,
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--generations") args.generations = Number(next), i++;
        else if (arg === "--cars") args.cars = Number(next), i++;
        else if (arg === "--max-frames") args.maxFrames = Number(next), i++;
        else if (arg === "--stall-frames") args.stallFrames = Number(next), i++;
        else if (arg === "--look-ahead") args.lookAhead = Number(next), i++;
        else if (arg === "--fresh") args.fresh = true;
        else if (arg === "--trace-every") args.traceEvery = Number(next), i++;
        else if (arg === "--trace-gen") args.traceGen = Number(next), i++;
        else if (arg === "--load-brain") args.loadBrain = next, i++;
        else if (arg === "--save-brain") args.saveBrain = next, i++;
        else if (arg === "--seed") args.seed = Number(next), i++;
        else if (arg === "--stop-bonus") args.stopBonus = Number(next), i++;
        else if (arg === "--verbose") args.verbose = true;
        else if (arg === "--guidance") args.guidance = next, i++;
        else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(1);
        }
    }

    return args;
}

// Small deterministic PRNG so two runs with the same seed are comparable.
function mulberry32(seed) {
    return function random() {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function mustReplace(source, pattern, replacement, label) {
    const matched =
        typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
    if (!matched) {
        throw new Error(`Harness override did not match: ${label}`);
    }
    return source.replace(pattern, replacement);
}

const args = parseArgs(process.argv);

if (args.seed !== null) {
    Math.random = mulberry32(args.seed);
}

const scripts = [
    "js/utils.js",
    "world/js/math/utils.js",
    "world/js/primitives/point.js",
    "world/js/primitives/segment.js",
    "world/js/primitives/polygon.js",
    "world/js/primitives/envelope.js",
    "world/js/graph.js",
    "world/js/items/tree.js",
    "world/js/markings/marking.js",
    "world/js/markings/stop.js",
    "world/js/markings/crossing.js",
    "world/js/markings/light.js",
    "world/js/markings/start.js",
    "world/js/markings/target.js",
    "world/js/world.js",
    "world/js/route.js",
    "js/controls.js",
    "js/sensor.js",
    "js/network.js",
    "js/car.js",
    "world/saved-world.js",
    "world/ai.js",
];

let source = "";
for (const file of scripts) {
    source += fs.readFileSync(path.join(root, file), "utf8") + "\n;\n";
}

// Harness-only overrides of the training constants.
source = mustReplace(
    source,
    "const N = 100;",
    `const N = ${args.cars};`,
    "cars"
);
source = mustReplace(
    source,
    "const MAX_FRAMES = 4500;",
    `const MAX_FRAMES = ${args.maxFrames};`,
    "maxFrames"
);
source = mustReplace(
    source,
    "const STALL_FRAMES = 900;",
    `const STALL_FRAMES = ${args.stallFrames};`,
    "stallFrames"
);
if (args.lookAhead !== null) {
    source = mustReplace(
        source,
        "const LOOK_AHEAD = 100;",
        `const LOOK_AHEAD = ${args.lookAhead};`,
        "lookAhead"
    );
}

// A/B switch: reward for stopping at a stop sign (0 disables it).
if (args.stopBonus !== null) {
    source = mustReplace(
        source,
        "const STOP_BONUS = 150;",
        `const STOP_BONUS = ${args.stopBonus};`,
        "stopBonus"
    );
}

// A/B switch: pull toward the route centreline (app default) or follow the
// tangent alone, which is what let cars drift into the border.
if (args.guidance === "tangent") {
    source = mustReplace(
        source,
        /    if \(car\.offRoute && lateral > 0\.001\) \{[\s\S]*?\n    \}/,
        "    // cross-track correction disabled by the harness",
        "guidance"
    );
} else if (args.guidance !== "center") {
    console.error(`Unknown --guidance value: ${args.guidance}`);
    process.exit(1);
}

// Skip all rendering; the simulation does not depend on it.
source += `
world.draw = () => {};
Route.prototype.draw = () => {};
Car.prototype.draw = () => {};
Point.prototype.draw = () => {};
globalThis.__headless = {
    state() {
        return {
            generation,
            frame,
            violations,
            reachedCount,
            lastEndReason,
            routeLength: route ? route.length : 0,
            alive: cars.filter((c) => !c.damaged).length,
            bestEver: parseFloat(localStorage.getItem(BEST_KEY)) || 0,
            lights: world.markings
                .filter((m) => m instanceof Light)
                .map((m) => m.state),
        };
    },
    step() {
        animate();
    },
    best() {
        if (!bestCar) return null;
        let centre = null;
        if (route) {
            const p = route.pointAt(route.progress(bestCar));
            centre = { x: p.x, y: p.y };
        }
        return {
            x: bestCar.x,
            y: bestCar.y,
            centre,
            speed: bestCar.speed,
            angle: bestCar.angle,
            progress: bestCar.progress || 0,
            maxProgress: bestCar.maxProgress || 0,
            offRoute: !!bestCar.offRoute,
            damaged: bestCar.damaged,
            brake: !!bestCar.brake,
            signalsNear: controls
                .map((c, i) => {
                    const rel = subtract(c.marking.center, bestCar);
                    const d = dot(rel, c.dir);
                    const lateral = Math.abs(dot(rel, perpendicular(c.dir)));
                    return {
                        i,
                        type: c.marking instanceof Light ? "light" : "stop",
                        state: c.marking.state,
                        d: Math.round(d),
                        lateral: Math.round(lateral),
                    };
                })
                .filter((s) => s.d > -20 && s.d < 130 && s.lateral < 83),
            guidance: (bestCar.guidance || []).slice(),
            controls: {
                forward: !!bestCar.controls.forward,
                reverse: !!bestCar.controls.reverse,
                left: !!bestCar.controls.left,
                right: !!bestCar.controls.right,
            },
        };
    },
};
`;

const store = new Map();

if (args.fresh) store.clear();
if (args.loadBrain && fs.existsSync(args.loadBrain)) {
    const saved = JSON.parse(fs.readFileSync(args.loadBrain, "utf8"));
    for (const [key, value] of Object.entries(saved)) store.set(key, value);
    console.error(`loaded brain state from ${args.loadBrain}`);
}

const noop = () => {};
const canvas = {
    width: 1600,
    height: 900,
    getContext: () => ctx,
    addEventListener: noop,
};

// Every draw call is ignored, so any method can be a no-op.
const ctx = new Proxy(
    {},
    {
        get(target, prop) {
            if (prop === "canvas") return canvas;
            if (prop === "measureText") return () => ({ width: 0 });
            return target[prop] || noop;
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        },
    }
);

const elements = {
    gameCanvas: canvas,
    stats: { innerHTML: "" },
};

// Load the bundle into this process rather than a separate VM context.
// Contextified globals make every lookup dramatically slower, and the
// simulation touches globals millions of times per generation.
globalThis.window = {
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener: noop,
};
globalThis.document = {
    getElementById: (id) => elements[id] || { innerHTML: "" },
};
globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
};
globalThis.requestAnimationFrame = noop;
globalThis.alert = (message) => console.error("[alert]", message);
globalThis.__lastEnd = null;

const realLog = console.log;
console.log = (...values) => {
    if (values[0] === "[generation end]") {
        globalThis.__lastEnd = values[1];
        return;
    }
    realLog(...values);
};

vm.runInThisContext(source, { filename: "headless-bundle.js" });

const headless = globalThis.__headless;

function fmt(value, digits = 0) {
    return Number(value).toFixed(digits);
}

function run() {
    console.log(
        `headless training: cars=${args.cars} generations=${args.generations}` +
            ` maxFrames=${args.maxFrames} stall=${args.stallFrames}` +
            (args.lookAhead !== null ? ` lookAhead=${args.lookAhead}` : "") +
            (args.seed !== null ? ` seed=${args.seed}` : "") +
            (args.stopBonus !== null ? ` stopBonus=${args.stopBonus}` : "") +
            ` guidance=${args.guidance}`
    );

    const startGeneration = headless.state().generation;
    const rows = [];
    let guard = 0;

    while (
        headless.state().generation < startGeneration + args.generations &&
        guard < args.generations * (args.maxFrames + 100)
    ) {
        const before = headless.state().generation;
        headless.step();
        guard++;

        if (
            args.traceEvery > 0 &&
            (args.traceGen === 0 || args.traceGen === before) &&
            headless.state().frame % args.traceEvery === 0
        ) {
            const car = headless.best();
            if (car) {
                console.log(
                    `  g${before} f${String(headless.state().frame).padStart(4)} ` +
                        `pos=(${Math.round(car.x)},${Math.round(car.y)}) ` +
                        `off=${car.centre ? Math.round(car.x - car.centre.x) : "?"} ` +
                        `v=${car.speed.toFixed(2)} ` +
                        `p=${Math.round(car.progress)}/${Math.round(car.maxProgress)} ` +
                        `guide=[${car.guidance.map((g) => Number(g).toFixed(2)).join(",")}] ` +
                        `brake=${car.brake ? "Y" : "n"} ` +
                        `lights=[${headless.state().lights.join(",")}] ` +
                        `near=${JSON.stringify(car.signalsNear)} ` +
                        `ctl=${Object.entries(car.controls)
                            .filter(([, on]) => on)
                            .map(([name]) => name)
                            .join("+") || "none"}`
                );
            }
        }

        if (headless.state().generation !== before) {
            const end = globalThis.__lastEnd || {};
            rows.push({
                generation: before,
                reason: end.reason || "?",
                alive: end.alive,
                score: end.score,
                progress: end.progress,
                bestEver: end.bestEver,
                saved: end.saved,
                damaged: end.damaged,
                offRoute: end.offRoute,
                x: end.position ? end.position.x : null,
                y: end.position ? end.position.y : null,
                speed: end.speed,
                penalty: end.penalty,
                liveProgress: end.liveProgress,
                signalAhead: end.signalAhead,
                nearestSignal: end.nearestSignal,
                stopped: end.stopped,
                stopCredit: end.stopCredit,
            });
        }
    }

    const routeLength = Math.round(headless.state().routeLength);
    if (args.verbose) {
        for (const row of rows) console.log(JSON.stringify(row));
    }
    console.log(
        "\ngen  reason          alive   score  progress  best   pos            flags"
    );
    for (const row of rows) {
        const flags = [
            row.damaged ? "crashed" : "alive",
            row.offRoute ? "OFF-ROUTE" : "on-route",
        ].join(",");
        console.log(
            [
                String(row.generation).padStart(3),
                String(row.reason).padEnd(15),
                String(row.alive).padStart(4),
                String(row.score).padStart(7),
                `${String(row.progress).padStart(4)}/${routeLength}`,
                String(row.bestEver).padStart(6),
                `${fmt(row.x)} , ${fmt(row.y)}`.padEnd(15),
                `stopped=${row.stopped || 0}`,
                flags,
            ].join("  ")
        );
    }

    const finished = headless.state();
    console.log(
        `\nsummary: violations=${finished.violations} reachedTarget=${finished.reachedCount} bestEver=${Math.round(
            finished.bestEver
        )}/${routeLength} lastEnd=${finished.lastEndReason}`
    );

    if (args.saveBrain) {
        const data = {};
        for (const [key, value] of store.entries()) data[key] = value;
        fs.writeFileSync(args.saveBrain, JSON.stringify(data));
        console.error(`saved brain state to ${args.saveBrain}`);
    }
}

run();
