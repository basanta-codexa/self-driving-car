# Autonomous Driver Simulation

A clean, layered 2D traffic simulation: one ego car drives through a
signalised intersection with crosswalks, pedestrians (including a jaywalker),
rule-driven traffic, and a real "arrive and stop" maneuver.

Open `sim/index.html` through a local server:

```bash
python -m http.server 8000
# visit http://localhost:8000/sim/index.html
```

Pause / Step / Restart and a speed slider are in the bottom-left corner. The
HUD shows the active behaviour state, speed/target, signal phase, detected
pedestrians and vehicles, horn status, and safety metrics.

**Viewport controls:** mouse wheel zooms around the cursor, left-drag pans, and
a minimap in the bottom-right shows the whole map, all agents and the current
view rectangle.

Headless (same code, no DOM):

```bash
npm run sim                 # 60s simulated
npm run sim:events          # with the event log
node tools/sim-headless.js --steps 4800 --json
```

## Architecture

```
sim/math.js        geometry + heading conventions (pure)
sim/scene.js       scene schema, demo scene, editor-export bridge
sim/city.js        large procedural city: routes, junctions, traffic, scenery
sim/lanes.js       directed lane graph: project / lookahead / next control
sim/signals.js     coordinated signal phases + pedestrian permission
sim/rightofway.js  junction ownership + arrival-order yielding
sim/agents.js      pedestrians + rule-driven traffic cars
sim/driver.js      perception snapshot + behaviour state machine
sim/scenery.js     procedural buildings/trees + fake-3D rendering (decorative)
sim/simulation.js  authoritative fixed-timestep world, collisions, metrics
sim/renderer.js    draw-only renderer (never mutates the sim)
sim/main.js        browser bootstrap: fixed-timestep loop
```

Key properties:

- **Fixed timestep (60 Hz).** The simulation never reads wall-clock time;
  browser and headless produce byte-identical results for the same scene.
- **Render is a subscriber.** `renderer.js` only draws state; no logic lives in
  draw calls.
- **Single observation boundary.** `SIM.perceive()` builds everything the
  driver may know. A future learned policy can replace `decide()` without
  touching the world, agents, or renderer.
- **No globals leak.** Every file attaches to one `SIM` namespace, so the old
  `js/utils.js` / `world/js/math/utils.js` duplicate-helper problem cannot
  affect this code.
- **No source patching.** The headless runner loads the same modules the
  browser loads; there are no string replacements of constants or code.

## Large city map (`sim/city.js`)

The single intersection was a test bed. The real map is a **procedural city**:

```bash
# 3D, 6×6 blocks:
http://localhost:8000/sim/3d.html?scene=city&blocks=6

# 3D, HUGE 14×14 blocks (~12 km of roads):
http://localhost:8000/sim/3d.html?scene=city&huge

# headless:
npm run sim:city
npm run sim:huge
node tools/sim-headless.js --scene city --blocks 8 --seed 7 --steps 20000
```

- Grid of `blocks × blocks` city blocks with roads, sidewalks and kerbs
- Routes are generated as long polylines with **quadratic corner arcs**, so the
  ego actually turns at junctions instead of driving off a straight line
- Every junction has its own paired signal circuit with a phase offset
- Zebra crossings and pedestrians (including jaywalkers) along the route
- Traffic cars follow their own routes across the grid
- Procedural buildings and trees inside every block

Performance: markings, buildings and trees use `THREE.InstancedMesh`, so the
draw-call count stays flat as the city grows. The 2D simulation remains the
authoritative state and is unchanged by the 3D presentation.

## Learning layer

The driver is injectable (`new Simulation(scene, { driver })`), so a learned
policy can be measured against the rule baseline on identical scenarios.

```
npm run learn:train    # imitate the rule driver -> tools/.learned-policy.json
npm run learn:dagger   # DAgger fine-tuning on states the learner visits
npm run learn:bench    # rules vs learned vs hybrid on three maps
```

- `sim/learn/features.js` — the 16-value observation the policy sees, shared by
  training and inference
- `sim/learn/network.js` — small continuous MLP trained with plain backprop
- `sim/learn/policy.js` — `LearnedDriver` (end-to-end) and `HybridDriver`
  (learned speed, rule-based steering/safety)
- The weights file is generated and gitignored

### Honest benchmark result

`npm run learn:bench` (350-epoch base policy):

| scenario | policy | arrived | collisions | violations | max lateral |
|---|---|---:|---:|---:|---:|
| intersection | rules | yes | 0 | 0 | 0 |
| intersection | learned end-to-end | no | 1 | 0 | 76 px |
| intersection | blended co-pilot | **yes** | 0 | 0 | 0 |
| city 4×4 | rules | yes | 1 | 0 | 14 px |
| city 4×4 | learned end-to-end | yes* | 0 | 0 | **980 px** |
| city 4×4 | blended co-pilot | **yes** | 2 | 0 | 15 px |
| city 6×6 | rules | yes | 1 | 0 | 14 px |
| city 6×6 | learned end-to-end | no | 1 | 0 | **1245 px** |
| city 6×6 | blended co-pilot | **yes** | 0 | 0 | 15 px |

\* The end-to-end policy reaches the destination coordinates but **cuts across
the map** (max lateral ~1000+ px). That is not driving the route.

**Conclusion:** plain imitation learns throttle/brake but not route keeping;
more epochs did not fix it. DAgger on accumulated on-policy data still made the
loss worse. The **blended co-pilot** — learned speed shaping with rule-based
steering and safety — matches the rule baseline across all maps and stays on
route, but does not beat it. The learning layer is real and measurable; it is
not yet a replacement for the rule driver.

## Right of way (fixed)

The earlier low-speed junction contacts had two causes, both found by logging
the collision moment rather than guessing:

1. Traffic cars only looked for vehicles sharing their `laneId`, so a faster
   car behind the ego on a different route never braked and rear-ended it.
2. Crossing traffic had no agreed priority at junctions.

Both are fixed in `sim/rightofway.js` and `sim/agents.js`:

- Traffic cars now **project the ego onto their lane** and treat it as a vehicle
  ahead when it is physically in front.
- A car that has actually crossed a junction's stop line **owns** that junction
  until it clears; a car waiting at the line is correctly *not* an occupant.
- Otherwise the car that will arrive first goes first; only crossing axes
  negotiate, same-road conflicts stay with normal car-following.
- Signals still override everything (red is an absolute stop).

**Result (measured):**

| scene | simulated time | collisions | near-misses | violations |
|---|---:|---:|---:|---:|
| small intersection | 80 s | 0 | 0 | 0 |
| 4×4 city | 250 s | 0 | 1 | 0 |
| 6×6 city | 333 s | 0 | 1 | 0 |
| 14×14 city (`huge`) | 667 s | 0 | 1 | 0 |

The remaining single near-miss is a low time-to-collision warning, not a contact.

## True 3D view (`sim/3d.html`)

`3d.html` is a **real WebGL renderer** (Three.js) for the same simulation.
The 2D simulation remains authoritative — the 3D page just reads its state
every frame and draws it. Nothing about the driving logic, determinism or the
headless runner changed.

```bash
# serve the repo root, then open:
http://localhost:8000/sim/3d.html
```

- **Follow** — smoothed chase camera behind the ego car
- **Orbit** — drag to rotate, wheel to zoom, right-drag to pan
- **Top-down** — straight overhead view
- `?fast=900` fast-forwards 900 simulation steps before the first frame (handy
  for inspecting a specific moment)
- `?scene=city&blocks=6` switches the 3D view to the large city map
- `?scene=city&huge` uses a 14×14-block city with traffic capped for performance
- `?policy=learned`, `?policy=hybrid` or `?policy=blend` runs a learned policy
  in the 3D view (requires `npm run learn:train` first)
- Every signal now faces the lane it controls; the ego keeps its blue colour
  for the whole run (collisions are reported in the HUD, not by repainting it)

The 3D world contains extruded buildings with window textures, cone-stack
trees, raised sidewalks and curbs, lane markings, zebra crossings, stop lines,
traffic-signal poles with live bulb colours, cars with wheels/headlights, and
pedestrians. Lighting is a hemisphere light plus a shadow-casting sun, with
ACES tone mapping, fog and a sky colour.

Three.js is **vendored** in `vendor/` (`three.module.js`, `three.core.js`,
`OrbitControls.js`, `THREE-LICENSE.txt`) — no CDN and no build step. It works
offline through your existing local server.

**Visual realism pass:** procedural canvas textures for asphalt, grass and
paving; a gradient sky dome with matching horizon fog; building parapets and
window textures; windows, mirrors, headlights and tail lights on cars; shadow
casting from buildings, trees and vehicles; and live signal bulbs that face the
approaching driver.

**Honest realism note:** this is *stylised* realism — real-time lighting,
shadows, fog, materials and a perspective camera, but simple procedural box
and cone geometry. It is not photogrammetry, PBR scanning, HDRI lighting or
ray tracing. It "feels like a 3D city", not like a photograph of one.

## Map design (from the "Virtual World" tutorial)

The map techniques follow Radu Mariescu-Istodor's *A Virtual World* course
(the freeCodeCamp **Build a Virtual World Filled with Self-Driving Cars**
video, 12 Dec 2023) — which your existing `world/` editor was originally
built from. Ported into `sim/`:

- **Procedural layout** — building footprints are generated on a jittered grid
  with spacing, and trees are scattered only where they do not overlap roads,
  sidewalks or buildings (`sim/scenery.js`). A seeded PRNG makes it identical
  every run.
- **Fake 3D** — buildings get a ground shadow, an extruded wall band, a lifted
  roof face and small windows; trees use stacked, shrinking, lightening layers
  with a shadow. Items are sorted back-to-front by y so overlaps look right.
- **Dynamic viewport + minimap** — zoom around the cursor, drag to pan, and an
  overview that shows all agents plus the current view rectangle.
- **Road markings** — lane centrelines, stop lines and proper zebra stripes
  (perpendicular to the pedestrian's walking direction).

These are render-only: scenery is never read by physics or sensing, so the
simulation stays deterministic and the headless runner needs no canvas.

## The ego driver (rules first)

`sim/driver.js` is a behaviour state machine with explicit priorities:

1. **ARRIVED** — decelerate to a full stop at the destination and hold.
2. **YIELD_PEDESTRIAN** — stop before the zebra when someone is waiting or
   stepping into the crossing; sound the horn if they enter the path nearby.
3. **APPROACH_SIGNAL / STOPPED_SIGNAL** — stop at the line on red/yellow.
4. **ARRIVING** — creep to the destination stop point.
5. **CRUISE** — follow the lane at the speed limit, keeping a gap to traffic.

Steering is pure pursuit; speed is PID-like with a deliberate creep floor so
drag cannot stall the car just short of the stop line.

Realism note: this controller is deterministic and safe by
construction, not learned. The learned layer comes later and will be measured
against this baseline (collisions, near-misses, violations, comfort, time).

## Implemented

- Directed lanes with arc-length projection and lookahead
- Coordinated two-phase signals with yellow + all-red clearance
- Crosswalks with legal pedestrians and a jaywalker
- Ego yielding, horn warnings, stop-line compliance, destination stop
- Rule-driven traffic that obeys signals and yields to pedestrians
- Collision, near-miss (TTC), violation and horn event metrics
- Headless deterministic runner and 9 dedicated unit tests

## Not yet implemented

This is the first milestone, not the finished vision:

- Lane changes / overtaking (the ego follows one lane)
- Turning at junctions (lanes currently run straight through)
- Bicycles, parked cars, weather, occlusion
- Learning: the policy is rules-only by design at this stage
- Editor UI for authoring lanes/sidewalks/crosswalks (`sceneFromWorldData`
  only makes a basic two-lane layout from an existing export)
- OpenStreetMap import and a graph editor inside the sim (the tutorial's later
  lessons; the existing `world/index.html` already has the editor)

## Verification

Current headless result on the demo scene (80 s simulated, 4800 steps):

```
arrived: true   collisions: 0   near-misses: 0   violations: 0   horn: 1
```

Run `npm test` for the full suite (29 tests, including right-of-way, determinism,
scenery-placement and large-city checks).
