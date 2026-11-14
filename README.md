# Self-Driving Car (Vanilla JS + Canvas)

A from-scratch browser project that simulates cars with ray sensors and a small feedforward neural network, then trains them by keeping the best performer and mutating copies. It started as a straight-lane demo and grew into a simple world editor + city driving/training setup.

No framework, no build step — just HTML, CSS, and JavaScript.

## What’s in this repo

There are four entry points (they share code, but run as separate pages):

- **`index.html`** — straight-road training. Spawns `N` AI cars on a 3-lane road with dummy traffic, tracks the furthest car each frame, and restarts a generation when all cars are damaged, stalled, or past the finish line. Draws the active network on a side canvas.
- **`world/index.html`** — world editor. Edit a road graph and place markings (stop, crossing, light, start, target). Saves/exports a world as JS data.
- **`world/drive.html`** — manual driving in an exported world (`world/saved-world.js`). Spawns at the last `Start` marker if one exists, otherwise the middle of the first road segment.
- **`world/ai.html`** — city training in an exported world. If a `Start` and reachable `Target` exist it builds a route and scores cars by route progress + guidance/signal inputs; otherwise it falls back to distance-based behavior. Includes basic stop-sign/light rule checks.

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
- `Save best` — persist best brain/score for the current start/target setup
- `Discard` — clear saved brain/score for that setup and restart
- Mouse wheel — zoom

## Files worth knowing about

- `js/brain.js` — exported brain data used as a fallback in the straight-road demo (committed artifact).
- `world/saved-world.js` — exported world data used by `drive.html`/`ai.html` (committed artifact).
- `js/utils.js` and `world/js/math/utils.js` — both exist; some pages load overlapping helpers (cleanup/refactor planned).
- Training progress and editor state are stored in browser `localStorage` (keys vary by mode/setup).

## Current limitations

- No automated tests, CI, or lint/type tooling yet.
- Script-tag globals and some duplicated utilities make the structure fragile.
- Training is a basic evolutionary loop (elitism + mutation), not tuned or benchmarked.
- Minimal validation/error handling for saved/exported data.
- `drive.html`/`ai.html` depend on the shape/contents of `saved-world.js`.

This is an active work-in-progress being improved in small steps (docs, structure, tests, hardening) without breaking the demos.
