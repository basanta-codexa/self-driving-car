// sim/signals.js -- coordinated traffic-signal phases.
//
// Each junction owns a small circuit: one group green, then yellow, an all-red
// clearance, then its partner's green/yellow/clearance. Circuits run off one
// simulation clock but have independent phase offsets, so a large city does
// not share one absurdly long global cycle. Pedestrians may cross a road only
// while that road's group is red.
(function (SIM) {
    "use strict";

    class SignalController {
        constructor(groups, allRed = 500) {
            this.groups = groups || [];
            this.allRed = allRed;
            this.circuits = new Map();

            // Legacy two-group setup (EW / NS): stagger them automatically.
            if (this.groups.length === 2 && this.groups.every((g) => !g.partner && !g.offset)) {
                const a = this.groups[0];
                const b = this.groups[1];
                b.offset = a.green + a.yellow + allRed;
                a.partner = b.id;
                b.partner = a.id;
            }

            for (const g of this.groups) {
                const own = g.green + g.yellow + allRed;
                const partner = this.groups.find((p) => p.id === g.partner);
                const other = partner ? partner.green + partner.yellow + allRed : own;
                this.circuits.set(g.id, {
                    green: g.green,
                    yellow: g.yellow,
                    own,
                    cycle: own + other,
                    offset: g.offset || 0,
                });
            }
            this.cycle = Math.max(1, ...[...this.circuits.values()].map((c) => c.cycle));
        }

        stateAt(group, timeMs) {
            const c = this.circuits.get(group);
            if (!c) return "green"; // no controller for this group = free travel
            const t = (((timeMs + c.offset) % c.cycle) + c.cycle) % c.cycle;
            if (t < c.green) return "green";
            if (t < c.green + c.yellow) return "yellow";
            return "red"; // all-red clearance plus the partner's green/yellow
        }

        statesAt(timeMs) {
            const out = {};
            for (const g of this.groups) out[g.id] = this.stateAt(g.id, timeMs);
            return out;
        }

        roadIsRed(group, timeMs) {
            return this.stateAt(group, timeMs) === "red";
        }

        pedestrianCanCross(crossRoad, timeMs) {
            if (!crossRoad) return true;
            return this.roadIsRed(crossRoad, timeMs);
        }

        phaseRemaining(timeMs, group = null) {
            const id = group || (this.groups[0] && this.groups[0].id);
            const c = id && this.circuits.get(id);
            if (!c) return { group: null, state: "allRed", remaining: 0 };
            const t = (((timeMs + c.offset) % c.cycle) + c.cycle) % c.cycle;
            if (t < c.green) return { group: id, state: "green", remaining: c.green - t };
            if (t < c.green + c.yellow) {
                return { group: id, state: "yellow", remaining: c.green + c.yellow - t };
            }
            return { group: id, state: "red", remaining: c.cycle - t };
        }
    }

    SIM.SignalController = SignalController;
})(globalThis.SIM = globalThis.SIM || {});
