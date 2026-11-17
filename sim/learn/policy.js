// sim/learn/policy.js -- learned driver that implements the same decide()
// interface as the rule-based AutonomousDriver.
(function (SIM) {
    "use strict";

    const M = SIM.math;

    // Teacher commands -> targets inside tanh's comfortable range. Asking a
    // tanh unit for exactly +/-1 drives it into saturation and stalls learning.
    const SPAN = 0.8;
    function encodeTargets(cmd) {
        return [
            (M.clamp(cmd.throttle, 0, 1) * 2 - 1) * SPAN,
            (M.clamp(cmd.brake, 0, 1) * 2 - 1) * SPAN,
            M.clamp(cmd.steer, -1, 1) * SPAN,
            (cmd.horn ? 1 : -1) * SPAN,
        ];
    }
    function decode(v) {
        return M.clamp(v / SPAN, -1, 1);
    }

    class LearnedDriver {
        constructor(spec) {
            this.net = spec instanceof SIM.learning.MLP ? spec : new SIM.learning.MLP(spec);
            this.state = "LEARNED";
        }

        decide(obs) {
            const x = SIM.learning.features.toArray(obs);
            const y = this.net.forward(x);
            const throttle = M.clamp((decode(y[0]) + 1) / 2, 0, 1);
            const brake = M.clamp((decode(y[1]) + 1) / 2, 0, 1);
            const steer = decode(y[2]);
            return {
                throttle,
                brake,
                steer,
                horn: y[3] > 0,
                state: "LEARNED",
                target: (obs.speedLimit || 100) * throttle,
            };
        }
    }

    // Hybrid: the learned network owns throttle/brake; the rule driver keeps
    // lateral control and safety (pure pursuit, right of way, horn). This is
    // the honest intermediate step while the end-to-end policy learns to stay
    // on the road by itself.
    class HybridDriver {
        constructor(spec) {
            this.learned = new LearnedDriver(spec);
            this.rules = new SIM.AutonomousDriver();
            this.state = "HYBRID";
        }

        decide(obs) {
            const ruleCmd = this.rules.decide(obs);
            const learnedCmd = this.learned.decide(obs);
            return Object.assign({}, ruleCmd, {
                throttle: learnedCmd.throttle,
                brake: learnedCmd.brake,
                horn: ruleCmd.horn || learnedCmd.horn,
                state: "HYBRID",
                target: learnedCmd.target,
            });
        }
    }

    // Co-pilot: learned and rule controls are blended for speed, while the
    // rule layer keeps full authority over steering and safety.
    class BlendDriver {
        constructor(spec, weight = 0.35) {
            this.learned = new LearnedDriver(spec);
            this.rules = new SIM.AutonomousDriver();
            this.weight = weight;
            this.state = "BLEND";
        }

        decide(obs) {
            const r = this.rules.decide(obs);
            // Hand full control back to the rule layer for safety-critical and
            // precision states; the learned co-pilot only shapes normal cruising.
            if (r.state !== "CRUISE") return Object.assign({}, r, { state: "BLEND" });
            const l = this.learned.decide(obs);
            const w = this.weight;
            return Object.assign({}, r, {
                throttle: M.clamp((1 - w) * r.throttle + w * l.throttle, 0, 1),
                brake: M.clamp((1 - w) * r.brake + w * l.brake, 0, 1),
                steer: r.steer,
                horn: r.horn,
                state: "BLEND",
            });
        }
    }

    SIM.learning = SIM.learning || {};
    SIM.learning.encodeTargets = encodeTargets;
    SIM.learning.LearnedDriver = LearnedDriver;
    SIM.learning.HybridDriver = HybridDriver;
    SIM.learning.BlendDriver = BlendDriver;
})(globalThis.SIM = globalThis.SIM || {});
