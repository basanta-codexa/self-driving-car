const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
resize();
window.addEventListener("resize", resize);

if (typeof WORLD_DATA === "undefined" || !WORLD_DATA) {
    alert("No world found. Export one from the editor and replace saved-world.js.");
    throw new Error("No exported world");
}

// Rebuild the world
const graph = Graph.load(WORLD_DATA.graph);
const world = new World(
    graph,
    WORLD_DATA.roadWidth,
    WORLD_DATA.roadRoundness,
    WORLD_DATA.buildingWidth,
    WORLD_DATA.buildingMinLength,
    WORLD_DATA.spacing,
    50,
    300
);
for (const m of WORLD_DATA.markings) {
    world.markings.push(Marking.load(m));
}
if (graph.segments.length === 0) {
    alert("Your world has no roads. Draw some in the editor first.");
    throw new Error("Empty world");
}

const borders = world.roadBorders.map((s) => [s.p1, s.p2]);

// Start and destination
const spawn = spawnInfo();
const targets = world.markings.filter((m) => m instanceof Target);
const target = targets.length > 0 ? targets[targets.length - 1] : null;

let route = null;
if (target) {
    const points = buildRoute(graph, spawn.pos, spawn.dir, target.center);
    if (points) {
        route = new Route(points);
    } else {
        alert("The Target can't be reached from the Start along your roads. Scoring will use distance instead.");
    }
}

// Brains are saved per Start/Target setup, so changing them starts fresh
const SETUP_KEY =
    "city:" +
    [spawn.pos.x, spawn.pos.y, target ? target.center.x : 0, target ? target.center.y : 0]
        .map(Math.round)
        .join(",");
const BRAIN_KEY = SETUP_KEY + ":brain4";
const BEST_KEY = SETUP_KEY + ":best6";

// Training settings
const N = 100;
const MUTATION = 0.1;
const STALL_FRAMES = 900;  // 4 seconds with no progress ends the generation
const MAX_FRAMES = 4500;   // hard cap of about 50 seconds per generation
const LOOK_AHEAD = 100;    // how far ahead on the route the car "looks"
const SIGNAL_RANGE = 120;  // how far ahead a car "feels" a signal
const STOP_SPEED = 0.8;    // max speed allowed when crossing a stop line


let violations = 0;
let zoom = 1.5;
let cars = [];
let bestCar = null;
let generation = 1;
let reachedCount = 0;
let allowFallback = true;
let frame = 0;
let lastProgressFrame = 0;
let topScore = -Infinity;
let lastEndReason = "—";


// Every light and stop sign, with the direction cars approach it from
const controls = buildControls();

function buildControls() {
    const list = [];
    for (const m of world.markings) {
        if (!(m instanceof Light) && !(m instanceof Stop)) continue;

        const seg = getNearestSegment(m.center, graph.segments, world.roadWidth);
        if (!seg) continue;

        // The signal governs traffic heading toward the junction nearer to it
        const junction =
            distance(m.center, seg.p1) < distance(m.center, seg.p2) ? seg.p1 : seg.p2;
        const dir = subtract(junction, m.center);
        if (magnitude(dir) < 1) continue;

        list.push({ marking: m, dir: normalize(dir) });
    }
    return list;
}

startGeneration();

function checkSignals(car) {
    const hx = -Math.sin(car.angle);
    const hy = -Math.cos(car.angle);

    let signal = 0;
    let nearest = Infinity;

    for (let i = 0; i < controls.length; i++) {
        const c = controls[i];

        // d: how far ahead the signal is along the road (negative = already passed)
        const rel = subtract(c.marking.center, car);
        const d = dot(rel, c.dir);
        const lateral = Math.abs(dot(rel, perpendicular(c.dir)));

        const prevD = car.prevD[i];
        car.prevD[i] = d;

        // Ignore signals on other roads, or for traffic heading the other way
        if (lateral > world.roadWidth * 0.75) continue;
        if (hx * c.dir.x + hy * c.dir.y < -0.3) continue;

        const isLight = c.marking instanceof Light;
        const state = c.marking.state;

        // Rules: caught crossing the line
        if (prevD !== undefined && prevD > 0 && d <= 0) {
            if ((isLight && state === "red") || (!isLight && car.speed > STOP_SPEED)) {
                car.damaged = true;
                car.penalty = 200;
                violations++;
            }
            
        }

        // Warning input: is something ahead that I should stop for?
        const mustStop = !isLight || state === "red" || state === "yellow";
        if (mustStop && d > 0 && d < SIGNAL_RANGE && d < nearest) {
            nearest = d;
            signal = 1 - d / SIGNAL_RANGE;
        }
    }
    return signal;
}

function nearestSignalInfo(car) {
    let nearest = null;
    for (const c of controls) {
        const d = distance(c.marking.center, car);
        if (!nearest || d < nearest.distance) {
            nearest = {
                type: c.marking instanceof Light ? "light" : "stop",
                state: c.marking instanceof Light ? c.marking.state : "stop",
                distance: Math.round(d),
            };
        }
    }
    return nearest;
}

animate();

function spawnInfo() {
    const starts = world.markings.filter((m) => m instanceof Start);
    if (starts.length > 0) {
        const s = starts[starts.length - 1];
        return {
            pos: s.center,
            dir: s.directionVector,
            angle: Math.atan2(-s.directionVector.x, -s.directionVector.y),
        };
    }
    const seg = graph.segments[0];
    const dir = seg.directionVector();
    return {
        pos: average(seg.p1, seg.p2),
        dir: dir,
        angle: Math.atan2(-dir.x, -dir.y),
    };
}

// With a route, score is progress along it. Without one, plain distance driven.
function scoreOf(car) {
    return route ? car.progress - (car.penalty || 0) : car.traveled;
}

function getStartBrain() {
    const own = localStorage.getItem(BRAIN_KEY);
    if (!own) return null;
    const brain = JSON.parse(own);
    const expected = cars[0].brain.levels[0].inputs.length;
    return brain.levels[0].inputs.length === expected ? brain : null;
}

function startGeneration() {
    cars = [];
    for (let i = 0; i < N; i++) {
        const car = new Car(spawn.pos.x, spawn.pos.y, 18, 32, "AI", 3, "blue", true);
        car.angle = spawn.angle;
        car.progress = 0;
        car.offRoute = false;
        car.prevD = [];
        cars.push(car);
    }

    const start = getStartBrain();
    if (start) {
        const text = JSON.stringify(start);
        for (let i = 0; i < cars.length; i++) {
            cars[i].brain = JSON.parse(text);
            if (i !== 0) {
                NeuralNetwork.mutate(cars[i].brain, MUTATION);
            }
        }
    }

    bestCar = cars[0];
    frame = 0;
    lastProgressFrame = 0;
    topScore = -Infinity;
}

function endGeneration(success, reason) {
    const furthest = cars.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a));
    const score = scoreOf(furthest);
    const stored = parseFloat(localStorage.getItem(BEST_KEY));
    const saved = isNaN(stored) || score >= stored;
    // Only overwrite the saved brain if this generation matched or beat it
    if (saved) {
        localStorage.setItem(BRAIN_KEY, JSON.stringify(furthest.brain));
        localStorage.setItem(BEST_KEY, String(score));
    }

    lastEndReason =
        reason +
        " @ " +
        Math.round(score) +
        (furthest.damaged ? " (crashed)" : " (alive)") +
        " x=" +
        Math.round(furthest.x) +
        " y=" +
        Math.round(furthest.y);

    console.log("[generation end]", {
        generation,
        reason,
        success,
        frame,
        score: Math.round(score),
        progress: Math.round(furthest.progress || 0),
        position: { x: Math.round(furthest.x), y: Math.round(furthest.y) },
        damaged: furthest.damaged,
        offRoute: !!furthest.offRoute,
        speed: Number(furthest.speed.toFixed(2)),
        penalty: furthest.penalty || 0,
        signalAhead: Number(((furthest.guidance && furthest.guidance[2]) || 0).toFixed(3)),
        nearestSignal: nearestSignalInfo(furthest),
        alive: cars.filter((c) => !c.damaged).length,
        bestEver: Math.round(saved ? score : stored),
        saved,
    });

    if (success) reachedCount++;
    generation++;
    startGeneration();
}

function saveBrain() {
    localStorage.setItem(BRAIN_KEY, JSON.stringify(bestCar.brain));
    localStorage.setItem(BEST_KEY, String(scoreOf(bestCar)));
}

function discardBrain() {
    localStorage.removeItem(BRAIN_KEY);
    localStorage.removeItem(BEST_KEY);
    allowFallback = false;
    generation = 1;
    reachedCount = 0;
    startGeneration();
}

function guidanceFor(car) {
    if (!route) return [0, 0];

    const look = route.pointAt(car.progress + LOOK_AHEAD);
    const next = route.pointAt(car.progress + LOOK_AHEAD + 20);
    const dx = next.x - look.x;
    const dy = next.y - look.y;

    // The direction the car is facing
    const hx = -Math.sin(car.angle);
    const hy = -Math.cos(car.angle);

    // Signed angle from facing direction to the look-ahead point
    // (positive = the point is to the right, negative = to the left)
    const rel = Math.atan2(hx * dy - hy * dx, hx * dx + hy * dy);

    // Turn it into 0..1, reaching 1 at a 90 degree bend
    const amount = Math.min(1, Math.abs(rel) / (Math.PI / 2));
    return rel > 0 ? [0, amount] : [amount, 0];
}

function animate() {
    frame++;
    world.update(frame * (1000 / 60));

    let reachedTarget = false;
    for (const car of cars) {
        if (car.damaged) continue;
        car.guidance = guidanceFor(car).concat(checkSignals(car));
        car.update(borders, []);
        if (route) {
            const pos = new Point(car.x, car.y);
            car.progress = route.progress(pos);
            car.offRoute = route.distanceTo(pos) > world.roadWidth / 2;
            if (car.offRoute) {
                car.progress = 0;
            }
            if (distance(car, target.center) < world.roadWidth / 2) {
                reachedTarget = true;
            }
        }
    }

    const alive = cars.filter((c) => !c.damaged);
    const pool = alive.length > 0 ? alive : cars;
    bestCar = pool.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a));

    // Progress is measured over the whole generation, so a leader crashing
    // doesn't look like a stall
    const top = Math.max(...cars.map(scoreOf));
    if (top > topScore + 1) {
        topScore = top;
        lastProgressFrame = frame;
    }

    const stalled = frame - lastProgressFrame > STALL_FRAMES;
    if (reachedTarget || alive.length === 0 || stalled || frame > MAX_FRAMES) {
        let reason = "unknown";
        if (reachedTarget) reason = "reached-target";
        else if (alive.length === 0) reason = "all-dead";
        else if (frame > MAX_FRAMES) reason = "max-frames";
        else if (stalled) reason = "stalled";

        endGeneration(reachedTarget, reason);
        requestAnimationFrame(animate);
        return;
    }

    const best = Math.round(parseFloat(localStorage.getItem(BEST_KEY)) || 0);
    document.getElementById("stats").innerHTML =
        "Generation: " + generation + "<br>" +
        "Alive: " + alive.length + " / " + N + "<br>" +
        (route
            ? "Progress: " + Math.round(scoreOf(bestCar)) + " / " + Math.round(route.length) + "<br>"
            : "Distance: " + Math.round(scoreOf(bestCar)) + "<br>") +
        "Best ever: " + best + "<br>" +
        "Signal violations: " + violations + "<br>" +
        (route ? "Reached target: " + reachedCount + " times<br>" : "") +
        "Last end: " + lastEndReason;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-bestCar.x, -bestCar.y);

    world.draw(ctx);
    if (route) route.draw(ctx);
    if (route) {
        const look = route.pointAt(bestCar.progress + LOOK_AHEAD);
        look.draw(ctx, { color: "white", size: 22 });
        look.draw(ctx, { color: "#ff6b00", size: 14 });
    }

    ctx.globalAlpha = 0.25;
    for (const car of cars) {
        car.draw(ctx);
    }
    ctx.globalAlpha = 1;
    bestCar.draw(ctx, true);

    ctx.restore();
    requestAnimationFrame(animate);
}

canvas.addEventListener(
    "wheel",
    (evt) => {
        evt.preventDefault();
        zoom *= evt.deltaY < 0 ? 1.1 : 0.9;
        zoom = Math.max(0.4, Math.min(4, zoom));
    },
    { passive: false }
);