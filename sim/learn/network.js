// sim/learn/network.js -- tiny continuous-output MLP trained by SGD.
// No framework: forward pass, tanh activations, plain backprop on MSE.
(function (SIM) {
    "use strict";

    function mulberry32(seed) {
        return function random() {
            seed |= 0;
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    class MLP {
        constructor(spec) {
            this.sizes = spec.sizes.slice();
            this.layers = spec.layers.map((l) => ({
                w: l.w.map((row) => row.slice()),
                b: l.b.slice(),
            }));
        }

        forward(input) {
            let a = input;
            for (const layer of this.layers) {
                const next = new Array(layer.b.length);
                for (let i = 0; i < next.length; i++) {
                    let sum = layer.b[i];
                    for (let j = 0; j < a.length; j++) sum += a[j] * layer.w[i][j];
                    next[i] = Math.tanh(sum);
                }
                a = next;
            }
            return a;
        }

        toJSON() {
            return { sizes: this.sizes, layers: this.layers };
        }
    }

    function initialise(sizes, rand) {
        const layers = [];
        for (let i = 0; i < sizes.length - 1; i++) {
            const inN = sizes[i];
            const outN = sizes[i + 1];
            const scale = 1 / Math.sqrt(inN);
            const w = [];
            for (let o = 0; o < outN; o++) {
                const row = [];
                for (let j = 0; j < inN; j++) row.push((rand() * 2 - 1) * scale);
                w.push(row);
            }
            layers.push({ w, b: new Array(outN).fill(0) });
        }
        return new MLP({ sizes, layers });
    }

    function train(samples, opts = {}) {
        const epochs = opts.epochs || 200;
        const lr = opts.lr || 0.01;
        const momentum = opts.momentum == null ? 0.9 : opts.momentum;
        const rand = mulberry32(opts.seed || 11);
        const inputN = samples[0].x.length;
        const outputN = samples[0].y.length;
        const sizes = [inputN].concat(opts.hidden || [32, 24], [outputN]);
        // Warm start lets DAgger fine-tune an existing policy instead of
        // throwing away what the previous round learned.
        const net = opts.init
            ? new MLP({
                  sizes: opts.init.sizes,
                  layers: opts.init.layers.map((l) => ({
                      w: l.w.map((row) => row.slice()),
                      b: l.b.slice(),
                  })),
              })
            : initialise(sizes, rand);
        const velocity = net.layers.map((l) => ({
            w: l.w.map((row) => row.map(() => 0)),
            b: l.b.map(() => 0),
        }));

        for (let epoch = 0; epoch < epochs; epoch++) {
            // Shuffle in place with the seeded generator.
            for (let i = samples.length - 1; i > 0; i--) {
                const j = Math.floor(rand() * (i + 1));
                const t = samples[i]; samples[i] = samples[j]; samples[j] = t;
            }
            const grads = net.layers.map((l) => ({
                w: l.w.map((row) => row.map(() => 0)),
                b: l.b.map(() => 0),
            }));

            for (const s of samples) {
                // Forward, caching activations.
                const acts = [s.x];
                for (const layer of net.layers) {
                    const out = [];
                    for (let i = 0; i < layer.b.length; i++) {
                        let sum = layer.b[i];
                        for (let j = 0; j < acts[acts.length - 1].length; j++) {
                            sum += acts[acts.length - 1][j] * layer.w[i][j];
                        }
                        out.push(Math.tanh(sum));
                    }
                    acts.push(out);
                }

                // Output delta for tanh + MSE.
                let delta = acts[acts.length - 1].map((a, i) => (a - s.y[i]) * (1 - a * a));
                for (let l = net.layers.length - 1; l >= 0; l--) {
                    const prev = acts[l];
                    const g = grads[l];
                    for (let i = 0; i < delta.length; i++) {
                        g.b[i] += delta[i];
                        for (let j = 0; j < prev.length; j++) {
                            g.w[i][j] += delta[i] * prev[j];
                        }
                    }
                    if (l > 0) {
                        const nextDelta = new Array(prev.length).fill(0);
                        for (let j = 0; j < prev.length; j++) {
                            let sum = 0;
                            for (let i = 0; i < delta.length; i++) sum += net.layers[l].w[i][j] * delta[i];
                            nextDelta[j] = sum * (1 - prev[j] * prev[j]);
                        }
                        delta = nextDelta;
                    }
                }
            }

            for (let l = 0; l < net.layers.length; l++) {
                const layer = net.layers[l];
                const g = grads[l];
                const v = velocity[l];
                const n = samples.length;
                for (let i = 0; i < layer.b.length; i++) {
                    v.b[i] = momentum * v.b[i] - (lr / n) * g.b[i];
                    layer.b[i] += v.b[i];
                    for (let j = 0; j < layer.w[i].length; j++) {
                        v.w[i][j] = momentum * v.w[i][j] - (lr / n) * g.w[i][j];
                        layer.w[i][j] += v.w[i][j];
                    }
                }
            }
        }
        return net;
    }

    function loss(net, samples) {
        let sum = 0;
        for (const s of samples) {
            const out = net.forward(s.x);
            for (let i = 0; i < out.length; i++) sum += (out[i] - s.y[i]) ** 2;
        }
        return sum / samples.length;
    }

    SIM.learning = SIM.learning || {};
    SIM.learning.MLP = MLP;
    SIM.learning.train = train;
    SIM.learning.loss = loss;
})(globalThis.SIM = globalThis.SIM || {});
