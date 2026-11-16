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
const BRAIN_KEY = SETUP_KEY + ":brain6";
const BEST_KEY = SETUP_KEY + ":best8";
// "1" when the stored brain is known to have completed the route. Used so a
// high-scoring non-finisher can never replace a brain that actually arrived.
const FINISHED_KEY = SETUP_KEY + ":finished1";
// A small hall of fame. One saved brain gets stuck in a local optimum; keeping
// several lets the population keep exploring different lineages.
const ELITES_KEY = SETUP_KEY + ":elites1";
const ELITE_COUNT = 5;

// Training settings
const N = 100;
const MUTATION = 0.1;
const STALL_FRAMES = 900;  // 4 seconds with no progress ends the generation
const MAX_FRAMES = 4500;   // hard cap of about 50 seconds per generation
const LOOK_AHEAD = 100;    // how far ahead on the route the car "looks"
const SIGNAL_RANGE = 120;  // how far ahead a car "feels" a signal
const STOP_SPEED = 0.8;    // max speed allowed when crossing a stop line
const STOP_BONUS = 150;    // maximum reward for slowing to a stop
const TRAFFIC_COUNT = 4;   // ambient rule-driven cars on the route
const TRAFFIC_SPEED = 3.4; // faster than learners (3.0) so they pull away
const TRAFFIC_LANE = 27;   // right-hand lane offset from the centreline
const TRAFFIC_START = 320; // route position they start from
const TRAFFIC_AHEAD = 260; // respawn this far ahead of the leading learner
const TRAFFIC_LAG = 120;   // recycle a car this far behind the leader
const TRAFFIC_END = 40;    // how close to the target before recycling
const TRAFFIC_STOP_RANGE = 60;


let violations = 0;
let zoom = 1.5;
let cars = [];
let demoCars = [];
let bestCar = null;
let generation = 1;
let reachedCount = 0;
let allowFallback = true;
let frame = 0;
let lastProgressFrame = 0;
let topScore = -Infinity;
let lastEndReason = "—";
let eliteCount = 0;


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

        list.push({
            marking: m,
            dir: normalize(dir),
            // How far the signal sits from the route being driven. Signals on
            // other roads are hundreds of pixels away; the ones that actually
            // govern this route are on it. Measured on this map: 0 vs 54+.
            routeOffset: route ? route.distanceTo(m.center) : 0,
        });
    }
    return list;
}

startGeneration();
startTraffic();

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

        // Ignore signals that are not on the road this car is driving. Checked
        // once at load time against the route, because the car's own position
        // at a junction makes any position-based test ambiguous.
        if (c.routeOffset > world.roadWidth * 0.12) continue;

        // Ignore signals on other roads, or for traffic heading the other way.
        // A crossing road's light is perpendicular to this car, so a weak
        // heading test lets it block traffic that has a green light.
        if (lateral > world.roadWidth * 0.6) continue;
        if (hx * c.dir.x + hy * c.dir.y < 0.3) continue;

        const prevD = car.prevD[i];
        const isLight = c.marking instanceof Light;
        const state = c.marking.state;

        // The stop line was crossed this frame
        if (prevD !== undefined && prevD > 0 && d <= 0) {
            if (isLight && state === "red") {
                car.damaged = true;
                car.penalty = 200;
                violations++;
            } else if (!isLight && !car.stopped[i]) {
                // Ran the stop sign without ever slowing down
                car.damaged = true;
                car.penalty = 200;
                violations++;
            }
            car.stopped[i] = false;
        }

        if (!isLight) {
            // A stop sign only holds the car until it has actually stopped.
            // Once it has come to rest, clear the signal and let it go.
            if (d > 0 && d < SIGNAL_RANGE) {
                // Reward slowing down continuously, not just a full stop.
                // A binary "did you stop" bonus is a cliff the population
                // cannot climb; partial credit gives evolution a gradient.
                const slowdown = Math.max(
                    0,
                    1 - Math.abs(car.speed) / car.maxSpeed
                );
                car.stopCredit = Math.max(
                    car.stopCredit || 0,
                    slowdown * STOP_BONUS
                );

                if (Math.abs(car.speed) <= STOP_SPEED) {
                    car.stopped[i] = true;
                    car.everStopped = true;
                }
                if (!car.stopped[i] && d < nearest) {
                    nearest = d;
                    signal = 1 - d / SIGNAL_RANGE;
                }
            }
        } else {
            const mustStop = state === "red" || state === "yellow";
            if (mustStop && d > 0 && d < SIGNAL_RANGE && d < nearest) {
                nearest = d;
                signal = 1 - d / SIGNAL_RANGE;
            }
        }

        car.prevD[i] = d;
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

// With a route, score is how far along it the car ever got, plus credit for
// stopping at stop signs, minus signal penalties. Without a route, plain
// distance driven.
function scoreOf(car) {
    return route
        ? (car.maxProgress || 0) + (car.stopCredit || 0) - (car.penalty || 0)
        : car.traveled;
}

function getStartBrain() {
    const own = localStorage.getItem(BRAIN_KEY);
    if (!own) return null;
    const brain = JSON.parse(own);
    const expected = cars[0].brain.levels[0].inputs.length;
    return brain.levels[0].inputs.length === expected ? brain : null;
}

// Elites are stored as { brain, score, finished, generation }. Older saves
// only had a single brain, so migrate that one into the list on first read.
function loadElites() {
    let list = null;
    try {
        list = JSON.parse(localStorage.getItem(ELITES_KEY) || "null");
    } catch (error) {
        list = null;
    }

    const expected = cars[0].brain.levels[0].inputs.length;
    if (Array.isArray(list)) {
        const valid = list.filter(
            (elite) =>
                elite &&
                elite.brain &&
                Array.isArray(elite.brain.levels) &&
                elite.brain.levels[0].inputs.length === expected
        );
        if (valid.length > 0) return valid;
    }

    const brain = getStartBrain();
    if (!brain) return [];
    return [
        {
            brain,
            score: parseFloat(localStorage.getItem(BEST_KEY)) || 0,
            finished: localStorage.getItem(FINISHED_KEY) === "1",
            generation: 0,
        },
    ];
}

function saveElites(elites) {
    localStorage.setItem(ELITES_KEY, JSON.stringify(elites));
}

function startGeneration() {
    cars = [];
    for (let i = 0; i < N; i++) {
        const car = new Car(spawn.pos.x, spawn.pos.y, 18, 32, "AI", 3, "blue", true);
        car.angle = spawn.angle;
        car.progress = 0;
        car.maxProgress = 0;
        car.offRoute = false;
        car.reachedTarget = false;
        car.prevD = [];
        car.stopped = [];
        cars.push(car);
    }

    const elites = loadElites();
    eliteCount = elites.length;
    if (elites.length > 0) {
        // Always leave at least one car free to mutate, otherwise a tiny
        // population would only ever re-run the hall and never explore.
        const pristine = Math.min(elites.length, Math.max(0, cars.length - 1));
        for (let i = 0; i < cars.length; i++) {
            // Keep the elites themselves intact at the front of the grid so
            // their score is re-measured every generation, and mutate copies
            // of a parent drawn from the hall. Parents are biased toward the
            // best elite so weaker elites add diversity without diluting the
            // selection pressure.
            let elite;
            if (i < pristine) {
                elite = elites[i];
            } else if (Math.random() < 0.6) {
                elite = elites[0];
            } else {
                elite = elites[Math.floor(Math.random() * elites.length)];
            }
            cars[i].brain = JSON.parse(JSON.stringify(elite.brain));
            if (i >= pristine) {
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
    // When the route was completed, the brain worth keeping is the one that
    // actually arrived. Stop-credit can let a non-finisher outscore it.
    const { leader: furthest, finishers, arrived } = pickGenerationLeader(
        cars,
        success,
        scoreOf
    );
    const score = scoreOf(furthest);
    // Read the hall before saving, so a freshly saved single brain is not both
    // migrated and merged as a separate entry.
    const storedElites = loadElites();
    const stored = parseFloat(localStorage.getItem(BEST_KEY));
    const wasFinished = localStorage.getItem(FINISHED_KEY) === "1";
    // Save on a new high score, or whenever this run finished and the stored
    // brain never did. A finisher must not be blocked by leftover stop-credit.
    const saved = isNaN(stored) || score >= stored || (arrived && !wasFinished);
    if (saved) {
        localStorage.setItem(BRAIN_KEY, JSON.stringify(furthest.brain));
        localStorage.setItem(BEST_KEY, String(score));
        localStorage.setItem(FINISHED_KEY, arrived ? "1" : "0");
    }

    // The hall of fame updates even when the single-brain gate declines, so a
    // finisher always earns a slot and can seed future generations.
    const elites = mergeElites(
        storedElites,
        {
            brain: JSON.parse(JSON.stringify(furthest.brain)),
            score,
            finished: arrived,
            generation,
        },
        ELITE_COUNT
    );
    saveElites(elites);

    lastEndReason =
        reason +
        " @ " +
        Math.round(furthest.maxProgress || 0) +
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
        progress: Math.round(furthest.maxProgress || 0),
        liveProgress: Math.round(furthest.progress || 0),
        position: { x: Math.round(furthest.x), y: Math.round(furthest.y) },
        damaged: furthest.damaged,
        offRoute: !!furthest.offRoute,
        speed: Number(furthest.speed.toFixed(2)),
        penalty: furthest.penalty || 0,
        stopCredit: Number((furthest.stopCredit || 0).toFixed(0)),
        signalAhead: Number(((furthest.guidance && furthest.guidance[2]) || 0).toFixed(3)),
        nearestSignal: nearestSignalInfo(furthest),
        alive: cars.filter((c) => !c.damaged).length,
        stopped: cars.filter((c) => c.everStopped).length,
        crowded: closePairs(cars.filter((c) => !c.damaged)),
        finishers: finishers,
        selected: arrived ? "finisher" : "best",
        elites: elites.length,
        eliteScore: Math.round(elites[0] ? elites[0].score : 0),
        eliteFinished: !!(elites[0] && elites[0].finished),
        bestEver: Math.round(saved ? score : stored),
        saved,
    });

    if (success) reachedCount++;
    generation++;
    startGeneration();
}

function saveBrain() {
    // Prefer a car that actually finished, even if a non-finisher has more
    // stop-credit, so the saved brain is the one that completes the route.
    const { leader, arrived } = pickGenerationLeader(cars, true, scoreOf);
    const chosen = leader || bestCar;
    const score = scoreOf(chosen);
    localStorage.setItem(BRAIN_KEY, JSON.stringify(chosen.brain));
    localStorage.setItem(BEST_KEY, String(score));
    localStorage.setItem(FINISHED_KEY, arrived ? "1" : "0");
    saveElites(
        mergeElites(
            loadElites(),
            {
                brain: JSON.parse(JSON.stringify(chosen.brain)),
                score,
                finished: arrived,
                generation,
            },
            ELITE_COUNT
        )
    );
}

function discardBrain() {
    localStorage.removeItem(BRAIN_KEY);
    localStorage.removeItem(BEST_KEY);
    localStorage.removeItem(FINISHED_KEY);
    localStorage.removeItem(ELITES_KEY);
    allowFallback = false;
    generation = 1;
    reachedCount = 0;
    startGeneration();
}

function guidanceFor(car) {
    if (!route) return [0, 0];

    // Use the true nearest point on the route, even for off-route cars.
    // car.progress is zeroed for scoring, so it must not drive guidance.
    const p = route.progress(car);
    const look = route.pointAt(p + LOOK_AHEAD);
    const next = route.pointAt(p + LOOK_AHEAD + 20);

    // Direction of travel along the route ahead, as a unit vector.
    let dx = next.x - look.x;
    let dy = next.y - look.y;
    const tangentLength = Math.hypot(dx, dy);
    if (tangentLength > 0.001) {
        dx /= tangentLength;
        dy /= tangentLength;
    }

    // How far the car sits from the centreline, and which way is back.
    const centre = route.pointAt(p);
    const ex = centre.x - car.x;
    const ey = centre.y - car.y;
    const lateral = Math.hypot(ex, ey);

    if (car.offRoute && lateral > 0.001) {
        // Get back on the road before trying to follow it.
        dx = ex / lateral;
        dy = ey / lateral;
    } else if (lateral > 1) {
        // Blend back toward the centreline. The pull grows with the error
        // and never exceeds the tangent, so corners still dominate.
        const gain = Math.min(1, lateral / (world.roadWidth / 2));
        dx += (ex / lateral) * gain;
        dy += (ey / lateral) * gain;
    }

    // The direction the car is facing
    const hx = -Math.sin(car.angle);
    const hy = -Math.cos(car.angle);

    // Signed angle from facing direction to the desired direction
    // (positive = turn right, negative = turn left)
    const rel = Math.atan2(hx * dy - hy * dx, hx * dx + hy * dy);

    // Turn it into 0..1, reaching 1 at a 90 degree bend
    const amount = Math.min(1, Math.abs(rel) / (Math.PI / 2));
    return rel > 0 ? [0, amount] : [amount, 0];
}

// Pairs of cars sitting almost on top of each other. A rough visual quality
// measure: following traffic should not stack like ghosts.
function closePairs(others, limit = 24) {
    let pairs = 0;
    for (let i = 0; i < others.length; i++) {
        for (let j = i + 1; j < others.length; j++) {
            if (distance(others[i], others[j]) < limit) pairs++;
        }
    }
    return pairs;
}

// ---------------------------------------------------------------------------
// Ambient traffic. These are not learners: they follow the route on rules
// alone, in the right-hand lane, so the city looks inhabited. They are kept out
// of `cars`, so they never affect scoring, selection, or the elite hall.
//
// They are also not physical obstacles for the learners. Making them collide
// was measured: 4 cars on the route dropped mean progress from 3396 to 1838 and
// completions from 12/12 to 0/12, because a learner at 3.0 catches a slower car
// and both queues stop at the same stop line. Learners cannot yet follow a lead
// car, so ambient traffic stays a visual layer until they can.
// ---------------------------------------------------------------------------

// The route point at `progress`, shifted into the right-hand lane.
function lanePoint(progress) {
    const point = route.pointAt(progress);
    const ahead = route.pointAt(Math.min(route.length, progress + 20));
    let dx = ahead.x - point.x;
    let dy = ahead.y - point.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Right-hand side of travel. Screen y grows downward, so rotating the
    // heading by +90 degrees gives (-dy, dx).
    return {
        x: point.x - dy * TRAFFIC_LANE,
        y: point.y + dx * TRAFFIC_LANE,
        dx,
        dy,
    };
}

function makeDemoCar(progress) {
    const p = lanePoint(progress);
    const car = new Car(
        p.x,
        p.y,
        18,
        32,
        "DUMMY",
        TRAFFIC_SPEED,
        "#e8590c"
    );
    car.angle = Math.atan2(-p.dx, -p.dy);
    car.progress = progress;
    car.maxProgress = progress;
    car.stopCleared = [];
    return car;
}

function startTraffic() {
    demoCars = [];
    if (!route || TRAFFIC_COUNT <= 0) return;

    // Space the cars along the route so the road is never empty.
    const span = route.length - TRAFFIC_START;
    for (let i = 0; i < TRAFFIC_COUNT; i++) {
        demoCars.push(makeDemoCar(TRAFFIC_START + (i * span) / TRAFFIC_COUNT));
    }
}

// Where a recycled car re-enters: ahead of the leading learner, so the pack
// never meets it head-on, but on the road and visible.
function demoRespawnProgress(i) {
    const lead = bestCar ? bestCar.progress || 0 : 0;
    const ahead = lead + TRAFFIC_AHEAD + i * 90;
    return Math.min(
        route.length - TRAFFIC_END,
        Math.max(TRAFFIC_START, ahead)
    );
}

// Steering for ambient cars: aim at the centreline shifted into the right lane.
function demoSteer(car) {
    const p = route.progress(car);
    const look = route.pointAt(p + LOOK_AHEAD);
    const next = route.pointAt(p + LOOK_AHEAD + 20);
    let dx = next.x - look.x;
    let dy = next.y - look.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;

    const tx = look.x - dy * TRAFFIC_LANE - car.x;
    const ty = look.y + dx * TRAFFIC_LANE - car.y;

    const hx = -Math.sin(car.angle);
    const hy = -Math.cos(car.angle);
    const rel = Math.atan2(hx * ty - hy * tx, hx * tx + hy * ty);
    const amount = Math.min(1, Math.abs(rel) / (Math.PI / 2));
    return rel > 0 ? [0, amount] : [amount, 0];
}

// Rules for ambient cars: keep the lane, stop at red/yellow lights, stop once
// at stop signs. No neural network and no scoring.
function demoBrake(car) {
    for (let i = 0; i < controls.length; i++) {
        const c = controls[i];
        if (c.routeOffset > world.roadWidth * 0.12) continue;

        const d = distance(c.marking.center, car);
        if (c.marking instanceof Light) {
            const state = c.marking.state;
            if ((state === "red" || state === "yellow") && d < TRAFFIC_STOP_RANGE) {
                return true;
            }
        } else if (!car.stopCleared[i] && d < TRAFFIC_STOP_RANGE) {
            if (Math.abs(car.speed) <= STOP_SPEED) {
                car.stopCleared[i] = true;
            } else {
                return true;
            }
        }
    }
    return false;
}

function updateTraffic() {
    if (!route) return;

    const lead = bestCar ? bestCar.progress || 0 : 0;
    for (let i = 0; i < demoCars.length; i++) {
        const car = demoCars[i];

        // No room ahead of the leader: park the slot until the next
        // generation, rather than recycling it into the pack.
        if (route.length - TRAFFIC_END - lead < TRAFFIC_AHEAD) {
            demoCars[i] = null;
            continue;
        }

        const spent =
            !car ||
            car.damaged ||
            car.progress >= route.length - TRAFFIC_END ||
            car.progress < lead - TRAFFIC_LAG;
        if (spent) {
            demoCars[i] = makeDemoCar(demoRespawnProgress(i));
            continue;
        }

        const steer = demoSteer(car);
        car.controls.left = steer[0] >= steer[1] && steer[0] > 0.1;
        car.controls.right = steer[1] > steer[0] && steer[1] > 0.1;
        car.controls.forward = !demoBrake(car);
        car.controls.reverse = false;

        car.update(borders, []);
        car.progress = route.progress(car);
        car.maxProgress = Math.max(car.maxProgress, car.progress);
    }
}

function animate() {
    frame++;
    world.update(frame * (1000 / 60));
    updateTraffic();

    let reachedTarget = false;
    for (const car of cars) {
        if (car.damaged) continue;
        car.guidance = guidanceFor(car).concat(checkSignals(car));
        car.brake = car.guidance[2] > 0.05;
        // Ambient cars are not obstacles: see the traffic section above. They
        // are excluded from sensors and collisions so a decorative car cannot
        // end a generation.
        car.update(borders, []);
        if (route) {
            const pos = new Point(car.x, car.y);
            car.progress = route.progress(pos);
            car.offRoute = route.distanceTo(pos) > world.roadWidth / 2;
            if (car.offRoute) {
                car.progress = 0;
            }
            car.maxProgress = Math.max(car.maxProgress || 0, car.progress);
            if (distance(car, target.center) < world.roadWidth / 2) {
                car.reachedTarget = true;
                reachedTarget = true;
            }
        }
    }

    const alive = cars.filter((c) => !c.damaged);
    const pool = alive.length > 0 ? alive : cars;
    bestCar = pool.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a));

    // Progress is measured over the whole generation, so a leader crashing
    // doesn't look like a stall. Waiting at a red light is not a stall either.
    const top = Math.max(...cars.map(scoreOf));
    const waitingAtSignal =
        bestCar &&
        bestCar.guidance &&
        bestCar.guidance[2] > 0.05 &&
        Math.abs(bestCar.speed) < 0.5;
    if (top > topScore + 1 || waitingAtSignal) {
        topScore = Math.max(topScore, top);
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
            ? "Progress: " + Math.round(bestCar.maxProgress || 0) + " / " + Math.round(route.length) + "<br>"
            : "Distance: " + Math.round(scoreOf(bestCar)) + "<br>") +
        "Best score: " + best + "<br>" +
        "Elites kept: " + eliteCount + "<br>" +
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
    for (const car of demoCars) {
        if (car) car.draw(ctx);
    }
    if (route) {
        const shownProgress = bestCar.offRoute ? bestCar.maxProgress : bestCar.progress;
        const look = route.pointAt((shownProgress || 0) + LOOK_AHEAD);
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