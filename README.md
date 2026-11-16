# Self-Driving Car (Vanilla JS + Canvas)

A from-scratch browser project that simulates cars with ray sensors and a small feedforward neural network, then trains them by keeping the best performer and mutating copies. It started as a straight-lane demo and grew into a simple world editor + city driving/training setup.

No framework, no build step — just HTML, CSS, and JavaScript.

## What’s in this repo

There are four entry points (they share code, but run as separate pages):

- **`index.html`** — straight-road training. Spawns `N` AI cars on a 3-lane road with dummy traffic, tracks the furthest car each frame, and restarts a generation when all cars are damaged, stalled, or past the finish line. Draws the active network on a side canvas.
- **`world/index.html`** — world editor. Edit a road graph and place markings (stop, crossing, light, start, target). Saves/exports a world as JS data.
- **`world/drive.html`** — manual driving in an exported world (`world/saved-world.js`). Spawns at the last `Start` marker if one exists, otherwise the middle of the first road segment.
- **`world/ai.html`** — city training in an exported world. If a `Start` and reachable `Target` exist it builds a route and scores cars by furthest route progress plus stop-credit and signal penalties; otherwise it falls back to distance-based behavior. Steering stays learned; a small traffic-rule layer handles braking for lights and stop signs.

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
- `--dump-controls` — list every light/stop sign with how far it sits from
  the route (used to filter other roads' signals)
- `--trace-every N --trace-gen N` — print the leader's position, speed,
  guidance, brake state, nearest lights and controls every `N` frames
- `--verbose` — dump the full generation-end record as JSON

`npm run eval` runs independent seeds and reports mean/median progress,
violations and target completions.

### What the numbers look like

These are measured, not estimates. Route length is `3833`.

| run | mean best progress | target completions | signal violations |
|---|---:|---:|---:|
| 100 cars, seed 7, 1 generation | 3892 | 1 / 1 | 0–2 |
| 30 cars, seeds 1–6, 6 generations | 3428 | 13 / 36 | 0 |

So at the app's default population the route is completed every generation.
At 30 cars, roughly half the seeds finish within 6 generations; the rest stall
around 2800–3000 where a car is waiting at a light or has not found the turn.
The hall of fame changed these aggregates by less than seed noise (mean
3486 → 3516, completions 14 → 13, violations 6 → 0). It is kept for its
structure, not because it made training dramatically better. Filtering signals
that are not on the route changed the 30-car mean from 3516 to 3428 with the
same 13 completions; it is kept because it removed a demonstrated deadlock.

### Rejected: yielding to other cars

A rule that slowed cars down when they closed on another car was implemented
and measured over seeds 1–4, 100 cars, 2 generations:

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
