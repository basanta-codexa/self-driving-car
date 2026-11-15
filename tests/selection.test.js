const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test.before(() => {
    const source = fs.readFileSync(
        path.join(__dirname, "..", "world", "js", "selection.js"),
        "utf8"
    );
    vm.runInThisContext(
        source +
            "\n;globalThis.pickGenerationLeader = pickGenerationLeader;" +
            "globalThis.mergeElites = mergeElites;",
        { filename: "world/js/selection.js" }
    );
});

const scoreOf = (car) => car.score;

test("a finisher is chosen over a higher-scoring non-finisher", () => {
    const cars = [
        { name: "stopped-car", reachedTarget: false, score: 9999 },
        { name: "finisher", reachedTarget: true, score: 100 },
    ];

    const picked = pickGenerationLeader(cars, true, scoreOf);

    assert.equal(picked.arrived, true);
    assert.equal(picked.finishers, 1);
    assert.equal(picked.leader.name, "finisher");
});

test("the best finisher wins when several cars arrived", () => {
    const cars = [
        { name: "slow", reachedTarget: true, score: 50 },
        { name: "fast", reachedTarget: true, score: 80 },
        { name: "other", reachedTarget: false, score: 500 },
    ];

    const picked = pickGenerationLeader(cars, true, scoreOf);

    assert.equal(picked.leader.name, "fast");
});

test("without a finisher the highest score still leads", () => {
    const cars = [
        { name: "a", reachedTarget: false, score: 10 },
        { name: "b", reachedTarget: false, score: 30 },
    ];

    const picked = pickGenerationLeader(cars, false, scoreOf);

    assert.equal(picked.arrived, false);
    assert.equal(picked.finishers, 0);
    assert.equal(picked.leader.name, "b");
});

test("a failed generation does not treat a target touch as success", () => {
    const cars = [
        { name: "touched", reachedTarget: true, score: 10 },
        { name: "leader", reachedTarget: false, score: 20 },
    ];

    const picked = pickGenerationLeader(cars, false, scoreOf);

    assert.equal(picked.arrived, false);
    assert.equal(picked.leader.name, "leader");
});

test("an empty population returns no leader", () => {
    const picked = pickGenerationLeader([], true, scoreOf);

    assert.equal(picked.leader, null);
    assert.equal(picked.finishers, 0);
    assert.equal(picked.arrived, false);
});

const elite = (name, score, finished, generation) => ({
    name,
    brain: { id: name },
    score,
    finished,
    generation,
});

test("elites are ordered by finishing, then score", () => {
    const elites = mergeElites(
        [elite("old", 500, false, 1)],
        elite("finisher", 100, true, 2),
        5
    );

    assert.deepEqual(
        elites.map((e) => e.name),
        ["finisher", "old"]
    );
});

test("the hall of fame keeps only the best entries", () => {
    const stored = [elite("a", 10, false, 1), elite("b", 20, false, 2)];
    const elites = mergeElites(stored, elite("c", 30, false, 3), 2);

    assert.deepEqual(
        elites.map((e) => e.name),
        ["c", "b"]
    );
});

test("a tied newer elite replaces the older one on a plateau", () => {
    const stored = [elite("old", 100, false, 1)];
    const elites = mergeElites(stored, elite("new", 100, false, 2), 1);

    assert.equal(elites[0].name, "new");
});

test("the candidate is kept while the hall has room", () => {
    const elites = mergeElites([], elite("first", 5, false, 1), 5);

    assert.equal(elites.length, 1);
    assert.equal(elites[0].name, "first");
});

test("an identical brain is refreshed instead of duplicated", () => {
    const stored = [elite("same", 100, false, 1)];
    const candidate = elite("same", 120, true, 2);
    const elites = mergeElites(stored, candidate, 5);

    assert.equal(elites.length, 1);
    assert.equal(elites[0].score, 120);
    assert.equal(elites[0].finished, true);
    assert.equal(elites[0].generation, 2);
});
