// sim/3d.js -- true WebGL view of the same 2D simulation.
// The SIM modules are loaded as classic scripts before this module, so the
// driving logic, determinism and headless runner are completely untouched.
import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";

const SIM = globalThis.SIM;
const M = SIM.math;
const params = new URLSearchParams(location.search);
const useCity = params.get("scene") === "city";
const defaultBlocks = params.has("huge") ? 14 : 6;
const sceneData = useCity
    ? SIM.scene.createCityScene({
          blocks: Number(params.get("blocks") || defaultBlocks),
          seed: Number(params.get("seed") || 7),
          // Cap traffic on very large maps so the simulation stays responsive.
          trafficRoutes: params.has("huge") ? 18 : undefined,
      })
    : SIM.scene.createIntersectionScene();
const policyName = params.get("policy"); // learned | hybrid | (default rules)
let learnedDriver = null;
if (["learned", "hybrid", "blend"].includes(policyName)) {
    const spec = await fetch("../tools/.learned-policy.json").then((r) => r.json());
    learnedDriver =
        policyName === "learned" ? new SIM.learning.LearnedDriver(spec)
        : policyName === "hybrid" ? new SIM.learning.HybridDriver(spec)
        : new SIM.learning.BlendDriver(spec, 0.35);
}
const sim = new SIM.Simulation(sceneData, learnedDriver ? { driver: learnedDriver } : {});
// Debug hook: ?fast=900 fast-forwards the sim before the first rendered frame
// (useful for inspecting a specific moment, e.g. in a headless screenshot).
const fastForward = Number(params.get("fast") || 0);
for (let i = 0; i < fastForward && i < 20000; i++) sim.step();

const cityBounds = sim.scene.bounds;
const worldSize = Math.max(
    cityBounds.maxX - cityBounds.minX,
    cityBounds.maxY - cityBounds.minY
) + 1600;

// ---------------------------------------------------------------------------
// Renderer / scene / lighting
// ---------------------------------------------------------------------------
const canvas = document.getElementById("view3d");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const SKY = 0x9fc7e8;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, worldSize * 0.28, worldSize * 0.75);

const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 3000);
camera.position.set(-90, 70, -90);

const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x5a6b4a, 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d8, 2.1);
sun.position.set(-180, 260, -120);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const shadowExtent = Math.min(2200, worldSize / 2);
sun.shadow.camera.left = -shadowExtent;
sun.shadow.camera.right = shadowExtent;
sun.shadow.camera.top = shadowExtent;
sun.shadow.camera.bottom = -shadowExtent;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = shadowExtent * 2.2;
sun.position.set(-shadowExtent * 0.7, shadowExtent, -shadowExtent * 0.5);
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

// Procedural canvas textures: no external assets, works offline.
function noiseTexture(base, specks, seed) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = base;
    g.fillRect(0, 0, 128, 128);
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 420; i++) {
        g.fillStyle = specks[Math.floor(rnd() * specks.length)];
        const x = rnd() * 128;
        const y = rnd() * 128;
        g.fillRect(x, y, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
function pavingTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = "#c4c4bc";
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "rgba(0,0,0,0.22)";
    g.lineWidth = 2;
    for (let i = 0; i <= 128; i += 32) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
        g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 8);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
const TEX = {
    grass: noiseTexture("#6e8f58", ["#7d9c66", "#628252", "#88a771"], 11),
    asphalt: noiseTexture("#3b3e43", ["#44474c", "#33363a", "#4b4e54"], 23),
    paving: pavingTexture(),
};

// Shared materials keep the draw-call count sane.
const MAT = {
    ground: new THREE.MeshStandardMaterial({ map: TEX.grass, color: 0xffffff, roughness: 1 }),
    road: new THREE.MeshStandardMaterial({ map: TEX.asphalt, color: 0xffffff, roughness: 0.98 }),
    sidewalk: new THREE.MeshStandardMaterial({ map: TEX.paving, color: 0xffffff, roughness: 0.95 }),
    marking: new THREE.MeshStandardMaterial({ color: 0xf2f2e8, roughness: 0.9 }),
    pole: new THREE.MeshStandardMaterial({ color: 0x2b2b2b, metalness: 0.5, roughness: 0.5 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x6b4b2a, roughness: 1 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x2f7d3a, roughness: 1 }),
    leafLight: new THREE.MeshStandardMaterial({ color: 0x3f9a4a, roughness: 1 }),
    ego: new THREE.MeshStandardMaterial({ color: 0x2f7fd1, metalness: 0.35, roughness: 0.5 }),
    traffic: new THREE.MeshStandardMaterial({ color: 0xe07b28, metalness: 0.3, roughness: 0.55 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x16242e, metalness: 0.5, roughness: 0.25 }),
    wheel: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 1 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffeeb0, emissiveIntensity: 1.2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0xd12b2b, emissive: 0x8a1010, emissiveIntensity: 0.8 }),
    pedWait: new THREE.MeshStandardMaterial({ color: 0xadb5bd, roughness: 0.9 }),
    pedWalk: new THREE.MeshStandardMaterial({ color: 0xffd43b, roughness: 0.9 }),
    pedJay: new THREE.MeshStandardMaterial({ color: 0xff922b, roughness: 0.9 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xe0ac83, roughness: 1 }),
};

function box(w, h, d, material, x, y, z, parent = scene) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
}

// ---------------------------------------------------------------------------
// Static world
// ---------------------------------------------------------------------------
const ground = new THREE.Mesh(new THREE.PlaneGeometry(worldSize, worldSize), MAT.ground);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Gradient sky dome: deeper blue overhead, pale haze at the horizon.
const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(worldSize * 1.6, 32, 16),
    new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
            topColor: { value: new THREE.Color(0x3f82cf) },
            bottomColor: { value: new THREE.Color(0xdbe9f2) },
            exponent: { value: 0.7 },
        },
        vertexShader:
            "varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position,1.0); " +
            "vWorld = w.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader:
            "uniform vec3 topColor; uniform vec3 bottomColor; uniform float exponent; " +
            "varying vec3 vWorld; void main(){ float h = normalize(vWorld).y; " +
            "gl_FragColor = vec4(mix(bottomColor, topColor, pow(max(h,0.0), exponent)),1.0); }",
    })
);
scene.add(skyDome);
scene.fog.color.setHex(0xdbe9f2);

// Map 2D (x, y) to 3D (x, 0, z).
function v2(p, height = 0) {
    return new THREE.Vector3(p.x, height, p.y);
}

for (const r of sim.scene.roads) {
    box(r.w, 0.3, r.h, MAT.road, r.x + r.w / 2, 0.15, r.y + r.h / 2);
}
for (const s of sim.scene.sidewalks) {
    box(s.w, 0.55, s.h, MAT.sidewalk, s.x + s.w / 2, 0.28, s.y + s.h / 2);
}

// Lane centre lines (dashed) + stop lines + zebra crossings.
// Instanced: a large city has thousands of markings and one draw call matters.
const markInstances = [];
function addMark(x, z, y, w, d, rot) {
    markInstances.push({ x, z, y, w, d, rot });
}
for (const lane of sim.graph.lanes.values()) {
    for (let s = 0; s < lane.length; s += 34) {
        const p = sim.graph.pointAt(lane.id, s);
        const next = sim.graph.pointAt(lane.id, Math.min(lane.length, s + 16));
        if (!p || !next) continue;
        addMark(
            (p.x + next.x) / 2,
            (p.y + next.y) / 2,
            0.34,
            1.8,
            M.distance(p, next),
            M.angleTo(p, next)
        );
    }
    for (const c of lane.controls) {
        const p = sim.graph.pointAt(lane.id, c.s);
        if (!p) continue;
        const across = M.perp(p.tangent);
        addMark(p.x, p.y, 0.36, (sim.scene.roadWidth || 80) - 6, 4, Math.atan2(-across.y, across.x));
    }
    for (const cw of lane.crosswalks) {
        const crossing = sim.scene.crosswalks.find((c) => c.id === cw.id);
        if (!crossing) continue;
        const dir = M.normalise(M.sub(crossing.to, crossing.from));
        const along = M.perp(dir);
        const half = (sim.scene.roadWidth || 80) / 2;
        for (let i = 0; i < 9; i++) {
            const t = (i + 0.5) / 9;
            const c = M.add(crossing.from, M.scale(M.sub(crossing.to, crossing.from), t));
            addMark(c.x, c.y, 0.35, 5, half * 2, Math.atan2(along.x, along.y));
        }
    }
}
const markMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 0.06, 1),
    MAT.marking,
    markInstances.length
);
const dummy = new THREE.Object3D();
markInstances.forEach((m, i) => {
    dummy.position.set(m.x, m.y, m.z);
    dummy.rotation.set(0, m.rot, 0);
    dummy.scale.set(m.w, 1, m.d);
    dummy.updateMatrix();
    markMesh.setMatrixAt(i, dummy.matrix);
});
markMesh.instanceMatrix.needsUpdate = true;
scene.add(markMesh);

// Traffic signals: pole + housing per approach, bulbs instanced so a huge
// city stays cheap. The bulbs face the driver approaching the stop line.
const bulbInstances = []; // { group, color, x, y, z }
const seenSignals = new Set();
const bulbColors = {
    green: new THREE.Color(0x35e25a),
    yellow: new THREE.Color(0xffd43b),
    red: new THREE.Color(0xff4646),
};
const darkBulb = new THREE.Color(0x181818);
for (const lane of sim.graph.lanes.values()) {
    for (const c of lane.controls) {
        const p = sim.graph.pointAt(lane.id, c.s);
        if (!p) continue;
        const key = c.group + ":" + Math.round(p.x) + ":" + Math.round(p.y);
        if (seenSignals.has(key)) continue;
        seenSignals.add(key);

        const across = M.perp(p.tangent);
        const facing = { x: -p.tangent.x, y: -p.tangent.y }; // back toward the approaching car
        const side = (sim.scene.roadWidth || 80) / 2 + 12;
        const base = { x: p.x + across.x * side, y: p.y + across.y * side };

        const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 32, 8), MAT.pole);
        pole.position.set(base.x, 16, base.y);
        pole.castShadow = true;
        scene.add(pole);
        const housing = box(8, 18, 7, MAT.pole, base.x, 32, base.y);
        housing.rotation.y = Math.atan2(facing.x, facing.y);
        // Small visor above each lamp, also facing the driver.
        box(6, 1.2, 4, MAT.pole, base.x + facing.x * 3, 40, base.y + facing.y * 3);

        ["red", "yellow", "green"].forEach((color, i) => {
            bulbInstances.push({
                group: c.group,
                color,
                x: base.x + facing.x * 4.2,
                y: 37 - i * 5.2,
                z: base.y + facing.y * 4.2,
            });
        });
    }
}
const bulbMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(2.2, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    bulbInstances.length
);
bulbInstances.forEach((bulb, i) => {
    dummy.position.set(bulb.x, bulb.y, bulb.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bulbMesh.setMatrixAt(i, dummy.matrix);
    bulbMesh.setColorAt(i, darkBulb);
});
bulbMesh.instanceMatrix.needsUpdate = true;
bulbMesh.instanceColor.needsUpdate = true;
scene.add(bulbMesh);

// Procedural buildings and trees from the same scenery data the 2D view uses.
function windowTexture(seed) {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext("2d");
    ctx.fillStyle = ["#adb5bd", "#ced4da", "#e9ecef"][seed % 3];
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = "rgba(255,241,196,0.85)";
    for (let y = 12; y < 118; y += 22) {
        for (let x = 10; x < 118; x += 20) {
            if ((x + y + seed * 7) % 5 !== 0) ctx.fillRect(x, y, 9, 12);
        }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
const buildingMats = [0, 1, 2].map((i) =>
    new THREE.MeshStandardMaterial({ map: windowTexture(i), roughness: 0.85 })
);
if (sim.scenery) {
    // One instanced mesh per building shade keeps the draw-call count flat
    // even when the city has hundreds of buildings.
    const byShade = [[], [], []];
    for (const bb of sim.scenery.buildings) byShade[bb.shade % 3].push(bb);
    byShade.forEach((list, shade) => {
        if (!list.length) return;
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildingMats[shade], list.length);
        list.forEach((bb, i) => {
            const h = bb.height * 2.4;
            dummy.position.set(bb.x, h / 2, bb.y);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(bb.w, h, bb.h);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        scene.add(mesh);

        // A thin parapet around the roof reads as a real building edge.
        const parapet = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            buildingMats[shade],
            list.length
        );
        list.forEach((bb, i) => {
            const h = bb.height * 2.4;
            dummy.position.set(bb.x, h + 1.5, bb.y);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(bb.w + 2, 3, bb.h + 2);
            dummy.updateMatrix();
            parapet.setMatrixAt(i, dummy.matrix);
        });
        parapet.castShadow = true;
        parapet.instanceMatrix.needsUpdate = true;
        scene.add(parapet);
    });

    const trees = sim.scenery.trees;
    if (trees.length) {
        const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 7), MAT.trunk, trees.length);
        trees.forEach((t, i) => {
            dummy.position.set(t.x, t.size * 0.35, t.y);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(t.size * 0.1, t.size * 0.7, t.size * 0.1);
            dummy.updateMatrix();
            trunks.setMatrixAt(i, dummy.matrix);
        });
        trunks.castShadow = true;
        trunks.instanceMatrix.needsUpdate = true;
        scene.add(trunks);

        for (let layer = 0; layer < 3; layer++) {
            const cones = new THREE.InstancedMesh(
                new THREE.ConeGeometry(1, 1, 9),
                layer === 1 ? MAT.leafLight : MAT.leaf,
                trees.length
            );
            trees.forEach((t, i) => {
                const r = t.size * (0.46 - layer * 0.1);
                dummy.position.set(t.x, t.size * (0.75 + layer * 0.38), t.y);
                dummy.rotation.set(0, 0, 0);
                dummy.scale.set(r, t.size * 0.7, r);
                dummy.updateMatrix();
                cones.setMatrixAt(i, dummy.matrix);
            });
            cones.castShadow = true;
            cones.instanceMatrix.needsUpdate = true;
            scene.add(cones);
        }
    }
}

// Destination marker.
const dest = sim.scene.destination;
const destPoint = sim.graph.pointAt(dest.laneId, dest.s);
const destRing = new THREE.Mesh(
    new THREE.TorusGeometry(12, 2, 8, 28),
    new THREE.MeshStandardMaterial({ color: 0xff4d4d, emissive: 0xaa0000, emissiveIntensity: 0.6 })
);
destRing.rotation.x = -Math.PI / 2;
destRing.position.copy(v2(destPoint, 1.2));
scene.add(destRing);

// ---------------------------------------------------------------------------
// Dynamic agents
// ---------------------------------------------------------------------------
function makeCar(colorMat) {
    const g = new THREE.Group();
    box(18, 9, 32, colorMat, 0, 5.5, 0, g);          // lower body
    box(16, 6.5, 15, colorMat, 0, 11.5, 1, g);       // roof / cabin shell
    box(14.5, 5.2, 0.6, MAT.glass, 0, 11.8, -6.6, g); // windscreen (front)
    box(14.5, 5.2, 0.6, MAT.glass, 0, 11.8, 8.4, g);  // rear glass
    for (const sx of [-1, 1]) {
        box(0.6, 5, 12, MAT.glass, sx * 8.1, 11.8, 1, g); // side windows
        box(3, 2, 2, colorMat, sx * 10, 10, -6, g);        // mirrors
        box(3.5, 1.8, 1.4, MAT.lamp, sx * 5.5, 7, -16.4, g); // headlights
        box(3.5, 1.8, 1.4, MAT.tail, sx * 5.5, 7, 16.4, g);  // tail lights
        for (const sz of [-1, 1]) {
            const wheel = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 2.4, 12), MAT.wheel);
            wheel.rotation.z = Math.PI / 2;
            wheel.position.set(sx * 9.5, 3.4, sz * 10);
            wheel.castShadow = true;
            g.add(wheel);
        }
    }
    scene.add(g);
    return g;
}
const egoMesh = makeCar(MAT.ego);
const trafficMeshes = sim.traffic.map(() => makeCar(MAT.traffic));

function makePed(material) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 12, 8), material);
    body.position.y = 6;
    body.castShadow = true;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(2.8, 10, 8), MAT.skin);
    head.position.y = 14;
    head.castShadow = true;
    g.add(head);
    scene.add(g);
    return g;
}
const pedMeshes = sim.peds.map((p) => makePed(p.jaywalk ? MAT.pedJay : MAT.pedWait));

// Horn pulse ring.
const hornRing = new THREE.Mesh(
    new THREE.TorusGeometry(6, 0.8, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0 })
);
hornRing.rotation.x = -Math.PI / 2;
scene.add(hornRing);
let hornAge = 99;

function syncAgents() {
    egoMesh.position.copy(v2(sim.ego.pos, 0));
    egoMesh.rotation.y = sim.ego.angle;
    // The ego stays blue. A collision is reported in the HUD/metrics, not by
    // permanently repainting the car mid-run.

    trafficMeshes.forEach((mesh, i) => {
        const c = sim.traffic[i];
        if (!c) return;
        mesh.visible = true;
        mesh.position.copy(v2(c.pos, 0));
        mesh.rotation.y = c.angle;
    });
    pedMeshes.forEach((mesh, i) => {
        const p = sim.peds[i];
        if (!p) return;
        mesh.position.copy(v2(p.pos, 0));
        const mat = p.jaywalk ? MAT.pedJay : p.state === "crossing" ? MAT.pedWalk : MAT.pedWait;
        mesh.children[0].material = mat;
    });

    const states = sim.signals.statesAt(sim.timeMs);
    for (let i = 0; i < bulbInstances.length; i++) {
        const bulb = bulbInstances[i];
        const on = states[bulb.group] === bulb.color;
        bulbMesh.setColorAt(i, on ? bulbColors[bulb.color] : darkBulb);
    }
    bulbMesh.instanceColor.needsUpdate = true;

    if (sim.lastCmd && sim.lastCmd.horn && hornAge > 0.5) hornAge = 0;
}

// ---------------------------------------------------------------------------
// Camera modes
// ---------------------------------------------------------------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.copy(v2(sim.ego.pos, 6));
controls.enabled = false;

let mode = "follow"; // follow | orbit | top
const followPos = new THREE.Vector3().copy(camera.position);
const followTarget = new THREE.Vector3().copy(controls.target);

function updateCamera(dt) {
    if (mode === "orbit") {
        controls.enabled = true;
        controls.update();
        return;
    }
    controls.enabled = false;
    const f = M.forward(sim.ego.angle);
    if (mode === "top") {
        followPos.set(sim.ego.pos.x, 220, sim.ego.pos.y + 0.01);
        followTarget.set(sim.ego.pos.x, 0, sim.ego.pos.y);
    } else {
        followPos.set(sim.ego.pos.x - f.x * 95, 44, sim.ego.pos.y - f.y * 95);
        followTarget.set(sim.ego.pos.x + f.x * 20, 6, sim.ego.pos.y + f.y * 20);
    }
    const k = 1 - Math.pow(0.001, dt);
    camera.position.lerp(followPos, k);
    // The look-at target is smoothed separately to avoid drift.
    camera.userData.look = camera.userData.look || followTarget.clone();
    camera.userData.look.lerp(followTarget, k);
    camera.lookAt(camera.userData.look);
}

function setMode(next) {
    mode = next;
    document.querySelectorAll(".mode").forEach((el) => el.classList.toggle("active", el.dataset.mode === next));
    if (next === "orbit") {
        controls.enabled = true;
        controls.target.copy(v2(sim.ego.pos, 6));
    }
}
document.querySelectorAll(".mode").forEach((el) =>
    el.addEventListener("click", () => setMode(el.dataset.mode))
);

// ---------------------------------------------------------------------------
// HUD + loop
// ---------------------------------------------------------------------------
const hud = document.getElementById("hud");
let running = true;
let timeScale = 1;
let accumulator = 0;
let last = performance.now();

function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

document.getElementById("btnPause").addEventListener("click", (e) => {
    running = !running;
    e.target.textContent = running ? "Pause" : "Play";
});
document.getElementById("btnReset").addEventListener("click", () => window.location.reload());
document.getElementById("speed").addEventListener("input", (e) => {
    timeScale = Number(e.target.value);
    document.getElementById("speedLabel").textContent = timeScale + "x";
});

function updateHud() {
    const m = sim.metrics;
    const cmd = sim.lastCmd || {};
    const obs = sim.lastObs || {};
    hud.innerHTML = [
        "AUTONOMOUS DRIVER · 3D VIEW · " + (policyName || "rules") + " policy",
        "state   " + (cmd.state || "-"),
        "speed   " + sim.ego.speed.toFixed(1) + " / target " + (cmd.target || 0).toFixed(1),
        "signal  " + (obs.control ? obs.control.state + " (" + Math.round(obs.control.distance) + "px)" : "none"),
        "ped     " + (obs.ped ? Math.round(obs.ped.distance) + "px" : "-") + "   horn " + (cmd.horn ? "ON" : "off"),
        "arrived " + (m.arrived ? "YES" : "no") + "   t " + m.time.toFixed(1) + "s",
        "collisions " + m.collisions + "  near " + m.nearMisses + "  violations " + m.violations,
    ].join("<br>");
}

function animate(now) {
    const elapsed = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (running) {
        accumulator += elapsed * timeScale;
        let steps = 0;
        while (accumulator >= sim.dt && steps < 30) {
            sim.step();
            accumulator -= sim.dt;
            steps++;
        }
        if (steps === 30) accumulator = 0;
    }
    syncAgents();
    updateCamera(elapsed);
    hornAge += elapsed;
    if (hornAge < 0.6) {
        const k = hornAge / 0.6;
        hornRing.position.copy(v2(sim.ego.pos, 9));
        hornRing.scale.setScalar(1 + k * 3);
        hornRing.material.opacity = 1 - k;
    } else {
        hornRing.material.opacity = 0;
    }
    updateHud();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

window.view3dDebug = { sim, scene, camera, setMode };
