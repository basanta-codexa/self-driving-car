# Self-Driving Car (Vanilla JS + Canvas)

A from-scratch browser project that simulates cars with ray sensors and a small feedforward neural network, then trains them by keeping the best performer and mutating copies. It started as a straight-lane demo and grew into a simple world editor + city driving/training setup.

No framework, no build step — just HTML, CSS, and JavaScript.

## What’s in this repo

There are five entry points (they share code, but run as separate pages):

- **`index.html`** — straight-road training. Spawns `N` AI cars on a 3-lane road with dummy traffic, tracks the furthest car each frame, and restarts a generation when all cars are damaged, stalled, or past the finish line. Draws the active network on a side canvas.
- **`world/index.html`** — world editor. Edit a road graph and place markings (stop, crossing, light, start, target). Saves/exports a world as JS data.
- **`world/drive.html`** — manual driving in an exported world (`world/saved-world.js`). Spawns at the last `Start` marker if one exists, otherwise the middle of the first road segment.
- **`world/ai.html`** — city training in an exported world. If a `Start` and reachable `Target` exist it builds a route and scores cars by furthest route progress plus stop-credit and signal penalties; otherwise it falls back to distance-based behavior. Steering stays learned; a small traffic-rule layer handles braking for lights and stop signs. A few rule-driven demo cars share the route and the learner's lane, slower than the learners, so the population has to handle them instead of driving through them (see the measurements below).
- **`sim/index.html`** — new layered autonomous-driver simulation. A rule-based ego car drives a signalised intersection with sidewalks, pedestrians, a jaywalker, crosswalks, rule-driven traffic, horn warnings and a proper destination stop. This is the foundation for a genuinely realistic driving sim; see `sim/README.md`.
- **`sim/3d.html`** — the same simulation rendered in true 3D with vendored Three.js: real perspective camera, lighting, shadows, fog, extruded buildings, trees, traffic and signals. Follow / Orbit / Top-down camera modes. No CDN or build step.

## How it works (quick)

- **Sensors (`js/sensor.js`)**: casts rays from the car and returns the nearest intersection with road borders/traffic.
- **Brain (`js/network.js`)**: simple fully-connected network; forward pass outputs binary controls (throttle/left/right/reverse). Training here is selection + mutation, not backprop.
- **Car/physics (`js/car.js`, `js/controls.js`)**: basic acceleration, friction, steering, polygon collision.
- **World (`world/js/`)**: graph/primitives generate road envelopes, borders, buildings, trees, markings, and traffic-light timing. `world/js/route.js` finds/routes progress along roads.

## Running it

Open the files directly, or serve the folder locally (recommended):

```bash
python -m http.server 8000
```

Then visit:
- `http://localhost:8000/index.html`
- `http://localhost:8000/world/index.html`
- `http://localhost:8000/world/drive.html`
- `http://localhost:8000/world/ai.html`

`drive.html` and `ai.html` expect `world/saved-world.js` to define `WORLD_DATA`.

## Autonomous-driver simulation (`sim/`)

The new simulation is a clean, layered extension aimed at realistic driving:
directed lanes, sidewalks, crosswalks, coordinated signal phases, pedestrians
who yield/wait/jaywalk, traffic obeying the same rules, horn warnings and a
full stop at the destination. It also generates a **large procedural city**
(`?scene=city&blocks=6`, or `?scene=city&huge` for 14×14 blocks) with turning
routes, per-junction signals, pedestrians, traffic, right-of-way negotiation
and instanced 3D rendering. The map design follows the freeCodeCamp / Radu
Mariescu-Istodor *Virtual World* tutorial that this repo's `world/` editor came
from (procedural buildings and trees, fake-3D rendering, dynamic viewport and
minimap). The driver is deliberately rule-based first; a learned policy will be
added later and measured against this baseline.

```bash
python -m http.server 8000   # then open http://localhost:8000/sim/index.html
                             # or http://localhost:8000/sim/3d.html (true 3D)
                             # or /sim/3d.html?scene=city&blocks=6 (large city)
                             # or /sim/3d.html?scene=city&huge (14×14 city)
npm run sim                  # headless, 60s simulated
npm run sim:city             # headless, large city
npm run sim:events           # with the event log
```

Architecture, controls, current results and the explicit "not yet implemented"
list are in `sim/README.md`.

## Headless training

The city training loop can run without a browser. The same scripts as
`world/ai.html` are loaded into Node with a stubbed canvas, then the real
`animate()` loop is driven frame by frame. This is how changes to the
training logic are measured instead of eyeballed.

```bash
npm run train -- --generations 8 --cars 40 --seed 7
npm run eval  -- --seeds 1-6 --generations 6 --cars 30
```

Useful flags for `npm run train`:

- `--seed N` — deterministic run, comparable across code changes
- `--cars N` — population size (default 100)
- `--generations N` — how many generations to run
- `--guidance center|tangent` — A/B the cross-track correction
- `--stop-bonus N` — A/B the stop-credit weight
- `--traffic N` — how many demo cars to place in the learner's lane (`0`
  disables them)
- `--dump-controls` — list every light/stop sign with how far it sits from
  the route (used to filter other roads' signals)
- `--trace-every N --trace-gen N` - print the leader's position, speed,
  guidance, brake state, nearest lights, controls and route gap to the nearest
  ambient car every `N` frames
- `--verbose` — dump the full generation-end record as JSON

`npm run eval` runs independent seeds and reports mean/median progress,
violations and target completions.

### What the numbers look like

These are measured, not estimates. They are from the current export
(`world/saved-world.js`), route length `3337`.

| run | mean best progress | target completions | signal violations |
|---|---:|---:|---:|
| 30 cars, seeds 1–4, 3 generations | 3396 | 12 / 12 | 0 |

All four seeds finish every generation on this map. An earlier, longer export
(route `3833`) was harder: 30 cars over 6 generations averaged 3428 with 13/36
completions, and 100 cars finished every generation on seed 7. Runs from
different exports are not comparable.

On the older map, the hall of fame changed aggregates by less than seed noise
(mean 3486 → 3516, completions 14 → 13, violations 6 → 0). It is kept for its
structure, not because it made training dramatically better. Filtering signals
that are not on the route changed the 30-car mean from 3516 to 3428 with the
same 13 completions; it is kept because it removed a demonstrated deadlock.

### Ambient traffic

`world/ai.html` puts three rule-driven cars on the route, in the learner's
lane and slower than the learners (`1.5` vs `3.0`). They are real obstacles:
the sensors see them and touching one ends that car's run. They are re-created
at the same positions every generation, so each population faces the same
traffic as the one before it - that is what makes it a learnable task instead
of noise.

What the population actually learns is to **follow**: after catching a car, the
generation-9 trace shows the route gap to the nearest car oscillating between
about 14 and 150 px and never going negative. The learner slows down behind the
car instead of driving through it, then completes the route once the car leaves
the map near the target. It does not overtake. An earlier reading of the trace
suggested a pass from the lane offset alone; adding the route-gap column
(`gap=` in `--trace-every` output) showed that was wrong. That column exists so
this distinction stays checkable rather than inferred.

They cost training speed. On seed 1, 30 cars, this export (route `3337`):

| generation | best progress |
|---|---:|
| 1 | 1566 |
| 2–5 | 1716 |
| 6–8 | 1871 |
| 9–12 | 3283 (target reached) |

Without traffic the same population reaches the target in every one of those
generations; with traffic it needs nine, then finishes every generation after
that. Across seeds the cost is real:

| seeds 1-4, 30 cars, 10 generations | mean best progress | target completions |
|---|---:|---:|
| no traffic | 3396 | 40 / 40 |
| three in-lane cars | 2367 | 7 / 40 |

Seeds 1 and 2 learn it (2 and 5 completions by generation 10). Seed 3 stalls at
`1936` and seed 4 at `738`. Seed 4's failure is not the cars: it sits at
`(193,1074)` with `v=0.00` and `ctl=right`, a pre-existing controller deadlock
where the network asks for a turn but never accelerates, so the car cannot
rotate. Traffic only has to perturb the population into that basin. That is a
real limitation of the current controller, not a hidden success.

Earlier versions are worth recording, because they looked plausible and were
not:

- **Decorative** (excluded from sensors and collisions) scored exactly the same
  as no traffic — 3396 mean, 12/12 completions — because the learners never had
  to react to a car. This is what shipped first: the cars were scenery.
- **Faster than the learners** (`3.4`) and recycled just ahead of the leader
  also scored the same, for the same reason: the learner never met one. That is
  the version that made traffic look decorative.
- **Obstacles recycled ahead of the leader** was worse than useless: 1838 mean
  progress, 0/12 completions, because a fresh car appeared just in front of the
  leader every time it passed one. Fixed positions plus a per-generation reset
  are what made the task learnable.

`--traffic N` sets how many cars are placed (default 3, `0` disables them).

### Rejected: yielding to other cars

Measured on the previous export (route `3833`): a rule that slowed cars down
when they closed on another car was implemented and measured over seeds 1–4,
100 cars, 2 generations.

| config | mean best progress | target completions | mean stacked pairs |
|---|---:|---:|---:|
| cars pass through each other | 3895 | 4 / 8 | 568 |
| yield to slower traffic | 3244 | 1 / 8 | 611 |

It lost on both axes. Tracing showed the pack slowing down also weakens
steering, which is scaled by speed, so cars that yield are more likely to
miss a turn and crash. The experiment is not enabled; the number of cars
sitting on top of each other is still reported as `crowded` in the trainer
output so the problem stays visible.

## Controls

**Straight-road demo (`index.html`)**
- `Save` — store current best brain in `localStorage` (`bestBrain`)
- `Discard` — clear saved brain/distance and restart
- `Export` — download current/saved brain as `brain.js` (`SAVED_BRAIN`)

**World editor (`world/index.html`)**
- Tools: `Roads`, `Stop sign`, `Crossing`, `Light`, `Start`, `Target`
- `Dispose` — clear the road graph
- `Save` — store world in `localStorage` (`world`)
- `Export` — download world as `saved-world.js` (`WORLD_DATA`)

**Manual drive (`world/drive.html`)**
- Arrow keys — steer/accelerate/brake
- `R` — reset car to spawn
- Mouse wheel — zoom

**City AI (`world/ai.html`)**
- `Save best` — persist the best brain/score for the current start/target setup
- `Discard` — clear saved brains/scores for that setup and restart
- Mouse wheel — zoom

Training keeps a hall of fame (5 brains per start/target setup). The best cars
are re-run unchanged each generation, and the rest of the population is mutated
copies of a random elite. Finishers beat non-finishers when ranking, so a car
that completed the route is never displaced by one that merely scored well.

Signals are filtered by whether they sit on the route being driven, checked
once at load time. Before that, a car at a junction could obey a crossing
road's light and deadlock between two signals that never turn green together.
Cars still pass through each other: a car-to-car yielding rule was implemented
and measured, and it made things worse (see below), so it is not enabled.

## Files worth knowing about

- `js/brain.js` — exported brain data used as a fallback in the straight-road demo (committed artifact).
- `world/saved-world.js` — exported world data used by `drive.html`/`ai.html` (committed artifact).
- `js/utils.js` and `world/js/math/utils.js` — both exist; some pages load overlapping helpers (cleanup/refactor planned).
- Training progress and editor state are stored in browser `localStorage` (keys vary by mode/setup).

## Current limitations

- Script-tag globals and some duplicated utilities make the structure fragile.
- Training is a basic evolutionary loop (elitism + mutation). The headless
  evaluator makes it measurable, but it is not tuned or benchmarked yet.
- Minimal validation/error handling for saved/exported data.
- `drive.html`/`ai.html` depend on the shape/contents of `saved-world.js`.

This is an active work-in-progress being improved in small steps (docs, structure, tests, hardening) without breaking the demos.

## Development

```bash
npm test        # geometry + network unit tests (node --test)
npm run train   # headless city training
npm run eval    # multi-seed evaluation
```
