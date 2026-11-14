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

- No automated tests/CI/lint/type tooling yet.
- Docs (`README.md`) and license (`LICENSE`) are in place as the first polish steps.
- Runtime behavior unchanged by documentation work in this phase.
