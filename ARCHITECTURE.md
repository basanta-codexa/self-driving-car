# Architecture Notes

Status: working prototype / learning project, improved in small steps.

## Big picture

This repo is a set of static HTML/CSS/JS pages that all run on HTML Canvas:

1. **Straight-road demo / training** — `index.html`, `style.css`, `js/*`
2. **World editor** — `world/index.html`, `world/main.js`, plus editor domain in `world/js/*`
3. **Manual drive** — `world/drive.html`, `world/drive.js`
4. **City AI training** — `world/ai.html`, `world/ai.js`, plus route/world helpers

They are separate pages but intentionally share a handful of JS globals/classes.

## Entry points and responsibilities

### `index.html` + `js/`
- `js/main.js` — training loop, generation logic, stats overlay, camera transform, network draw.
- `js/car.js` — car state/physics + damage assessment.
- `js/controls.js` — keyboard/dummy control abstraction.
- `js/sensor.js` — raycasting and nearest-hit readings.
- `js/network.js` — tiny feedforward network + mutation.
- `js/visualizer.js` — network visualization.
- `js/road.js` — lane road geometry/borders.
- `js/utils.js` — geometry helpers (lerp, intersection, polygon intersect, RGBA).

### `world/index.html` + `world/main.js`
- Editor orchestration, tool mode switching, world save/export.
- Uses editor domain classes in `world/js/` (graph, primitives, markings, world generation, viewport, editors).

### `world/drive.html` + `world/drive.js`
- Loads `world/saved-world.js` (`WORLD_DATA`), builds `Graph`, `World`, finds spawn, runs manual keyboard car.

### `world/ai.html` + `world/ai.js`
- Loads `world/saved-world.js`, builds world/graph/route, trains city cars, handles stop/signals/generation loop.
- Fitness: furthest route progress, plus continuous credit for slowing at stop signs, minus signal penalties.
- Selection: a generation that reaches the target picks its leader from the cars that actually arrived (`world/js/selection.js`), not just the highest score.
- Elites: a 5-entry hall of fame per start/target setup. Elites are re-run unchanged and the rest of the population is mutated copies of a random elite; finishers outrank non-finishers, ties go to the newer entry.
- Steering: route-tangent guidance with a cross-track pull toward the centreline. Off-route progress is ignored.
- Longitudinal rule layer: cars coast when a red/yellow light or an un-cleared stop sign is ahead. Stop signs clear once the car has actually stopped.
- Signals are filtered once at load time by `route.distanceTo(signal)`. Signals on other roads sit 54+ pixels off the route (own-road signals are at 0) and are ignored; before this, a car at a junction could obey a crossing light and deadlock.
- Car-to-car yielding was implemented and rejected: 1/8 completions vs 4/8 without it, because speed-scaled steering loses authority when cars slow down. Cars still overlap; the trainer reports `crowded` pairs.
- Ambient traffic: three rule-driven `DUMMY` cars share the learner's lane at `1.5` speed, so the population is forced to handle them rather than drive through them. They are re-created at the same route positions each generation, which keeps the task stationary across generations. They are kept out of `cars`, so they never affect selection or the elite hall directly. Measured behaviour is following at a 14-150 px gap, not overtaking; `--trace-every` prints the `gap=` column that confirms it. Two variants were measured and rejected: decorative cars (no sensor or collision coupling) and faster cars recycled ahead of the leader - both left training identical to no traffic, because the learner never had to react.
- Headless equivalents live in `tools/train-headless.js` (one run) and `tools/eval-headless.js` (multi-seed).

## Shared state / data artifacts

- `js/brain.js` — `const SAVED_BRAIN = {...}` fallback for the straight-road demo.
- `world/saved-world.js` — `const WORLD_DATA = {...}` consumed by `drive.html` / `ai.html`.

These are checked in as data artifacts. The editor can regenerate/replace them.

## Known structural friction (being addressed in small steps)

- No module system yet; classes/functions are global and loaded via script tags in a specific order.
- Duplicate utility surfaces:
  - `js/utils.js` (road demo: lerp, getIntersection, polysIntersect, getRGBA)
  - `world/js/math/utils.js` (broader math + geometry helpers)
- Pages like `world/ai.html` may load overlapping helpers; current behavior depends on load order.
- Logic/UI/persistence/evolution are mixed in several animate loops and helpers.

## Planned direction

- Consolidate shared helpers into one authoritative set.
- Move toward a clearer module organization or build step, incrementally.
- Add tests for core math/routing/network before deeper refactors.

## Current status

- Unit tests (`npm test`) cover geometry, the neural network, and generation selection.
- Headless training/evaluation (`npm run train`, `npm run eval`) runs the real
  city loop in Node, seeded and repeatable.
- The city route is completed reliably in headless runs (100 cars): every
  generation reaches the target with zero or near-zero signal violations.
- Remaining friction: script-tag globals, duplicated utility surfaces, and
  loose error handling for saved/exported data.
