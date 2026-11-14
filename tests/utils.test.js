const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHelpers(file) {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "utils.js"), "utf8");
    vm.runInThisContext(source, { filename: file });
}

test("getIntersection finds a crossing", () => {
    loadHelpers("../js/utils.js");

    const hit = getIntersection(
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: -5 },
        { x: 5, y: 5 }
    );

    assert.ok(hit);
    assert.equal(hit.x, 5);
    assert.equal(hit.y, 0);
    assert.equal(hit.offset, 0.5);
});

test("getIntersection rejects a miss", () => {
    loadHelpers("../js/utils.js");

    const miss = getIntersection(
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 15, y: -5 },
        { x: 15, y: 5 }
    );

    assert.equal(miss, null);
});

test("polysIntersect detects overlapping polygons", () => {
    loadHelpers("../js/utils.js");

    const squareA = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ];
    const squareB = [
        { x: 5, y: 5 },
        { x: 15, y: 5 },
        { x: 15, y: 15 },
        { x: 5, y: 15 },
    ];

    assert.equal(polysIntersect(squareA, squareB), true);
});

test("polysIntersect rejects separated polygons", () => {
    loadHelpers("../js/utils.js");

    const squareA = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ];
    const squareB = [
        { x: 20, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 10 },
        { x: 20, y: 10 },
    ];

    assert.equal(polysIntersect(squareA, squareB), false);
});
