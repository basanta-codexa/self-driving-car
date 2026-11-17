// sim/lanes.js -- directed lane graph geometry.
//
// A lane is a polyline with an arc-length parameter `s` measured from its
// first point. Everything the autonomous driver needs (projection, lookahead,
// the next stop line or crossing) is expressed in terms of `s`.
(function (SIM) {
    "use strict";

    const M = SIM.math;

    class LaneGraph {
        constructor(defs) {
            this.lanes = new Map();
            for (const def of defs) this.lanes.set(def.id, this.#build(def));
        }

        #build(def) {
            const points = def.points.map((p) => ({ x: p.x, y: p.y }));
            const segments = [];
            const cumulative = [0];
            for (let i = 0; i < points.length - 1; i++) {
                const a = points[i];
                const b = points[i + 1];
                const len = M.distance(a, b);
                segments.push({ a, b, len, start: cumulative[i] });
                cumulative.push(cumulative[i] + len);
            }
            return {
                id: def.id,
                points,
                segments,
                cumulative,
                length: cumulative[cumulative.length - 1],
                speedLimit: def.speedLimit || 100,
                controls: (def.controls || []).slice().sort((a, b) => a.s - b.s),
                crosswalks: (def.crosswalks || []).slice().sort((a, b) => a.s - b.s),
            };
        }

        get(id) {
            return this.lanes.get(id) || null;
        }

        length(id) {
            const lane = this.get(id);
            return lane ? lane.length : 0;
        }

        // Point and unit tangent at arc-length s on a lane.
        pointAt(id, s) {
            const lane = this.get(id);
            if (!lane || lane.segments.length === 0) return null;
            s = M.clamp(s, 0, lane.length);
            for (let i = 0; i < lane.segments.length; i++) {
                const seg = lane.segments[i];
                if (s <= seg.start + seg.len || i === lane.segments.length - 1) {
                    const t = seg.len < 1e-9 ? 0 : (s - seg.start) / seg.len;
                    return {
                        x: M.lerp(seg.a.x, seg.b.x, t),
                        y: M.lerp(seg.a.y, seg.b.y, t),
                        tangent: M.normalise(M.sub(seg.b, seg.a)),
                        s,
                    };
                }
            }
            return null;
        }

        // A point `d` pixels ahead of s on the same lane.
        lookahead(id, s, d) {
            return this.pointAt(id, s + d);
        }

        // Nearest point on one lane (or all lanes when id is null).
        project(pos, id = null) {
            const candidates = id ? [this.get(id)].filter(Boolean) : [...this.lanes.values()];
            let best = null;
            for (const lane of candidates) {
                for (let i = 0; i < lane.segments.length; i++) {
                    const seg = lane.segments[i];
                    const proj = M.projectOnSegment(pos, seg.a, seg.b);
                    if (!best || proj.distance < best.lateral) {
                        const tangent = M.normalise(M.sub(seg.b, seg.a));
                        const off = M.sub(pos, proj.point);
                        best = {
                            laneId: lane.id,
                            s: seg.start + proj.t * seg.len,
                            point: proj.point,
                            tangent,
                            lateral: proj.distance,
                            signedLateral: M.cross(tangent, off),
                        };
                    }
                }
            }
            return best;
        }

        // First control/crossing strictly ahead of s (wraps by clamping to end).
        nextControl(id, s) {
            const lane = this.get(id);
            if (!lane) return null;
            for (const c of lane.controls) {
                if (c.s >= s - 0.5) return Object.assign({}, c, { distance: c.s - s });
            }
            return null;
        }

        nextCrosswalk(id, s) {
            const lane = this.get(id);
            if (!lane) return null;
            for (const c of lane.crosswalks) {
                if (c.s >= s - 0.5) return Object.assign({}, c, { distance: c.s - s });
            }
            return null;
        }
    }

    SIM.LaneGraph = LaneGraph;
})(globalThis.SIM = globalThis.SIM || {});
