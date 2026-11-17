# Simulation

Layered traffic simulation. The 2D simulation owns the state; the 3D page only draws it. Fixed 60 Hz timestep, so browser and headless runs match.

## Run

From the repo root:

```bash
python -m http.server 8000
```

- `sim/index.html` — 2D view
- `sim/3d.html` — 3D view with Follow / Orbit / Top-down camera
- `?scene=city&blocks=6` — 6×6 city
- `?scene=city&huge` — 14×14 city
- `?policy=blend` — learned co-pilot (run `npm run learn:train` first)

Drag to pan, wheel to zoom. Pause, step, restart and speed are on screen.

## Commands

```bash
npm run sim           # headless intersection
npm run sim:city      # headless 6×6 city
npm run sim:huge      # headless 14×14 city
npm run learn:train   # imitate the rule driver
npm run learn:dagger  # fine-tune on visited states
npm run learn:bench   # compare rules / learned / blended
npm test
```

## Layout

- `math.js`, `lanes.js`, `signals.js` — geometry and signal phases
- `scene.js`, `city.js`, `scenery.js` — maps and procedural scenery
- `agents.js`, `driver.js`, `rightofway.js` — traffic, pedestrians, yielding
- `simulation.js` — fixed-step world, collisions, metrics
- `renderer.js`, `main.js` — 2D view
- `3d.js`, `3d.html` — Three.js view
- `learn/` — observation, network, learned drivers

## Behaviour

The rule driver handles signals, stop lines, pedestrians, right of way, car following and stopping at the destination. On every tested map it arrives with no signal violations and no collisions.

Learned policies are behind `SIM.perceive()`. `npm run learn:bench` shows the current comparison: the blended co-pilot matches the rule baseline; the end-to-end policy still leaves the route.

## Known gaps

- No lane changes or overtaking
- No bicycles, parked cars, weather or night
- The learned policy is not yet a replacement for the rule driver
- `sceneFromWorldData` only makes a basic layout from an editor export
