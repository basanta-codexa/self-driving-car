// sim/scenery.js -- procedural city scenery for the simulation map.
//
// Port of the map-design techniques from Radu Mariescu-Istodor's "Virtual
// World" course (the freeCodeCamp video): procedural building footprints laid
// out with spacing, trees scattered where they do not overlap anything, and a
// fake-3D look built from extrusion + shadows. Purely decorative -- the
// simulation never reads this for physics or sensing.
(function (SIM) {
    "use strict";

    // Deterministic PRNG so a scene always generates the same city.
    function mulberry32(seed) {
        return function random() {
            seed |= 0;
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function generate(scene, options = {}) {
        // Large city scenes carry their own block-based layout.
        if (scene.cityBuildings || scene.cityTrees) {
            const buildings = (scene.cityBuildings || []).slice();
            const trees = (scene.cityTrees || []).slice();
            const items = [
                ...buildings.map((b) => Object.assign({ kind: "building", sortY: b.y }, b)),
                ...trees.map((t) => Object.assign({ kind: "tree", sortY: t.y }, t)),
            ].sort((a, b) => a.sortY - b.sortY);
            return { buildings, trees, items };
        }
        const rand = mulberry32(options.seed || 1337);
        const b = scene.bounds || { minX: -730, maxX: 730, minY: -730, maxY: 730 };
        const roadHalf = (scene.roadWidth || 80) / 2;
        const clear = roadHalf + 42; // sidewalk width plus a gap
        const buildings = [];
        const trees = [];
        const step = 150;

        const overlaps = (a, pad) =>
            buildings.some(
                (o) =>
                    Math.abs(a.x - o.x) < (a.w + o.w) / 2 + pad &&
                    Math.abs(a.y - o.y) < (a.h + o.h) / 2 + pad
            );

        for (let x = b.minX + 60; x <= b.maxX - 60; x += step) {
            for (let y = b.minY + 60; y <= b.maxY - 60; y += step) {
                const jitterX = x + (rand() - 0.5) * 26;
                const jitterY = y + (rand() - 0.5) * 26;
                const w = 62 + rand() * 48;
                const h = 62 + rand() * 48;

                // Stay out of both road bands (quadrants only).
                const offRoad =
                    Math.abs(jitterX) - w / 2 > clear && Math.abs(jitterY) - h / 2 > clear;
                if (!offRoad) continue;

                const box = { x: jitterX, y: jitterY, w, h };
                if (!overlaps(box, 16) && rand() < 0.62) {
                    buildings.push(
                        Object.assign(box, {
                            height: 22 + rand() * 46,
                            shade: Math.floor(rand() * 3),
                        })
                    );
                } else if (rand() < 0.4) {
                    const size = 26 + rand() * 18;
                    if (
                        Math.abs(jitterX) - size / 2 > clear &&
                        Math.abs(jitterY) - size / 2 > clear &&
                        !overlaps({ x: jitterX, y: jitterY, w: size, h: size }, 6)
                    ) {
                        trees.push({ x: jitterX, y: jitterY, size, tone: rand() });
                    }
                }
            }
        }

        // Back-to-front draw order, exactly like the tutorial's item sorting.
        const items = [
            ...buildings.map((b) => Object.assign({ kind: "building", sortY: b.y }, b)),
            ...trees.map((t) => Object.assign({ kind: "tree", sortY: t.y }, t)),
        ].sort((a, b) => a.sortY - b.sortY);
        return { buildings, trees, items };
    }

    function draw(ctx, scenery) {
        for (const item of scenery.items) {
            if (item.kind === "building") drawBuilding(ctx, item);
            else drawTree(ctx, item);
        }
    }

    const WALL_COLORS = [
        ["#adb5bd", "#868e96"],
        ["#ced4da", "#adb5bd"],
        ["#e9ecef", "#ced4da"],
    ];

    function drawBuilding(ctx, b) {
        const h = b.height;
        const left = b.x - b.w / 2;
        const top = b.y - b.h / 2 - h; // extruded upward on screen

        // Ground shadow.
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.fillRect(left + 7, top + h + 6, b.w, b.h);

        // Side / wall band between the roof and the ground footprint.
        ctx.fillStyle = WALL_COLORS[b.shade][1];
        ctx.fillRect(left, top, b.w, b.h + h);

        // Roof face, slightly lifted and lighter.
        ctx.fillStyle = WALL_COLORS[b.shade][0];
        ctx.fillRect(left, top, b.w, b.h);
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(left, top, b.w, b.h);

        // A few windows on the visible wall to sell the 3D effect.
        ctx.fillStyle = "rgba(255,236,170,0.55)";
        const cols = Math.max(1, Math.floor(b.w / 22));
        for (let i = 0; i < cols; i++) {
            const wx = left + 8 + i * 22;
            if (wx + 7 < left + b.w) ctx.fillRect(wx, top + b.h + 7, 6, Math.min(9, h - 12));
        }
    }

    function drawTree(ctx, t) {
        const size = t.size;
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.beginPath();
        ctx.arc(t.x, t.y + 4, size / 2, 0, Math.PI * 2);
        ctx.fill();

        const layers = 4;
        for (let i = 0; i < layers; i++) {
            const f = i / (layers - 1);
            const radius = size * (0.5 - 0.3 * f);
            const lift = f * size * 0.45;
            const r = Math.round(28 + 70 * f);
            const g = Math.round(95 + 90 * f + t.tone * 20);
            const bl = Math.round(45 + 35 * f);
            ctx.fillStyle = "rgb(" + r + "," + g + "," + bl + ")";
            ctx.beginPath();
            ctx.arc(t.x, t.y - lift, radius, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    SIM.scenery = { generate, draw };
})(globalThis.SIM = globalThis.SIM || {});
