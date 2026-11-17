// sim/learn/features.js -- observation -> fixed numeric vector.
// The same function is used by training and inference, so the learned policy
// sees exactly the same information the rule driver saw.
(function (SIM) {
    "use strict";

    const M = SIM.math;
    const FEATURES = 16;
    const NAMES = [
        "speed", "lateral", "heading", "sigRed", "sigYellow", "sigGreen",
        "sigDist", "pedDist", "pedCrossing", "carDist", "carSpeed",
        "frontDist", "crossDist", "junctionYield", "destDist", "arrived",
    ];

    function toArray(obs) {
        const limit = obs.speedLimit || 100;
        const signal = obs.control ? obs.control.state : "none";
        let heading = 0;
        if (obs.lookahead) {
            heading = M.wrapAngle(M.angleTo(obs.pos, obs.lookahead) - obs.angle) / (Math.PI / 2);
        }
        const one = (v) => (v ? 1 : 0);
        const near = (v, scale) => (v == null ? 1 : M.clamp(v / scale, 0, 1));

        return [
            M.clamp(obs.speed / limit, 0, 1),
            M.clamp(obs.lateral / 50, -1, 1),
            M.clamp(heading, -1, 1),
            one(signal === "red"),
            one(signal === "yellow"),
            one(signal === "green"),
            obs.control ? M.clamp(obs.control.distance / 200, 0, 1) : 1,
            near(obs.ped ? obs.ped.distance : null, 150),
            one(obs.ped && obs.ped.crossing),
            near(obs.carAhead ? obs.carAhead.distance : null, 200),
            obs.carAhead ? M.clamp(obs.carAhead.speed / limit, 0, 1) : 1,
            near(obs.frontCar ? obs.frontCar.distance : null, 200),
            near(obs.crosswalk ? obs.crosswalk.distance : null, 150),
            one(obs.junctionYield),
            M.clamp((Number.isFinite(obs.destDist) ? obs.destDist : 600) / 600, 0, 1),
            one(obs.arrived),
        ];
    }

    SIM.learning = SIM.learning || {};
    SIM.learning.features = { FEATURES, NAMES, toArray };
})(globalThis.SIM = globalThis.SIM || {});
