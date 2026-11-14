const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test.before(() => {
    const utilsSource = fs.readFileSync(path.join(__dirname, "..", "js", "utils.js"), "utf8");
    vm.runInThisContext(utilsSource, { filename: "js/utils.js" });

    const source = fs.readFileSync(path.join(__dirname, "..", "js", "network.js"), "utf8");
    vm.runInThisContext(
        source + "\n;globalThis.NeuralNetwork = NeuralNetwork; globalThis.Level = Level;",
        { filename: "js/network.js" }
    );
});

test("feedForward activates when the weighted sum exceeds the bias", () => {
    const net = new NeuralNetwork([2, 1]);
    net.levels[0].weights[0][0] = 2;
    net.levels[0].weights[1][0] = 0;
    net.levels[0].biases[0] = -1;

    const out = NeuralNetwork.feedForward([1, 0], net);
    assert.equal(out.length, 1);
    assert.equal(out[0], 1);
});

test("feedForward stays off when the weighted sum does not exceed the bias", () => {
    const net = new NeuralNetwork([2, 1]);
    net.levels[0].weights[0][0] = 1;
    net.levels[0].weights[1][0] = 1;
    net.levels[0].biases[0] = 2;

    const out = NeuralNetwork.feedForward([0.5, 0.5], net);
    assert.equal(out.length, 1);
    assert.equal(out[0], 0);
});

test("mutate leaves weights unchanged with zero mutation amount", () => {
    const net = new NeuralNetwork([2, 1]);
    net.levels[0].weights[0][0] = 0.5;
    net.levels[0].weights[1][0] = -0.5;
    net.levels[0].biases[0] = 0.25;

    NeuralNetwork.mutate(net, 0);

    assert.equal(net.levels[0].weights[0][0], 0.5);
    assert.equal(net.levels[0].weights[1][0], -0.5);
    assert.equal(net.levels[0].biases[0], 0.25);
});
