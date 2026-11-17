// sim/math.js -- pure math and geometry primitives for the new simulation.
// Attach everything to a single namespace so we never leak globals or depend
// on the order in which the old world/js helpers were loaded.
(function (SIM) {
    "use strict";

    const TAU = Math.PI * 2;

    function clamp(v, lo, hi) {
        return v < lo ? lo : v > hi ? hi : v;
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    // Normalise an angle to [-PI, PI].
    function wrapAngle(a) {
        a %= TAU;
        if (a > Math.PI) a -= TAU;
        if (a < -Math.PI) a += TAU;
        return a;
    }

    function add(a, b) {
        return { x: a.x + b.x, y: a.y + b.y };
    }
    function sub(a, b) {
        return { x: a.x - b.x, y: a.y - b.y };
    }
    function scale(a, k) {
        return { x: a.x * k, y: a.y * k };
    }
    function dot(a, b) {
        return a.x * b.x + a.y * b.y;
    }
    function cross(a, b) {
        return a.x * b.y - a.y * b.x;
    }
    function length(a) {
        return Math.hypot(a.x, a.y);
    }
    function normalise(a) {
        const l = length(a);
        return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
    }
    function perp(a) {
        return { x: -a.y, y: a.x };
    }
    function distance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    // Heading convention matches the original Car: angle 0 points "up" (-y).
    function forward(angle) {
        return { x: -Math.sin(angle), y: -Math.cos(angle) };
    }
    // Right-hand side of travel. At angle 0 this is (+1, 0).
    function right(angle) {
        return { x: Math.cos(angle), y: -Math.sin(angle) };
    }
    // Angle that makes forward(angle) point from `from` toward `to`.
    function angleTo(from, to) {
        return Math.atan2(-(to.x - from.x), -(to.y - from.y));
    }

    // Closest point on segment AB to P, with the parameter t clamped to [0,1].
    function projectOnSegment(p, a, b) {
        const ab = sub(b, a);
        const l2 = dot(ab, ab);
        if (l2 < 1e-9) return { point: { x: a.x, y: a.y }, t: 0, distance: distance(p, a) };
        const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
        const point = add(a, scale(ab, t));
        return { point, t, distance: distance(p, point) };
    }

    // Segment/segment intersection. Returns {x, y, t, u} or null.
    function segmentIntersection(a, b, c, d) {
        const r = sub(b, a);
        const s = sub(d, c);
        const denom = cross(r, s);
        if (Math.abs(denom) < 1e-6) return null; // parallel or degenerate
        const qp = sub(c, a);
        const t = cross(qp, s) / denom;
        const u = cross(qp, r) / denom;
        if (t < 0 || t > 1 || u < 0 || u > 1) return null;
        return { x: a.x + r.x * t, y: a.y + r.y * t, t, u };
    }

    function polygonsIntersect(p1, p2) {
        for (let i = 0; i < p1.length; i++) {
            const a = p1[i];
            const b = p1[(i + 1) % p1.length];
            for (let j = 0; j < p2.length; j++) {
                const c = p2[j];
                const d = p2[(j + 1) % p2.length];
                if (segmentIntersection(a, b, c, d)) return true;
            }
        }
        // Also handle full containment (no edge crossings).
        if (pointInPolygon(p1[0], p2) || pointInPolygon(p2[0], p1)) return true;
        return false;
    }

    function pointInPolygon(p, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i];
            const b = poly[j];
            if (
                a.y > p.y !== b.y > p.y &&
                p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
            ) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Oriented bounding box for a car centred at (x,y) with the given heading.
    // Corner order: front-left, front-right, rear-right, rear-left.
    function orientedBox(x, y, angle, width, height) {
        const centre = { x, y };
        const f = forward(angle);
        const r = right(angle);
        const hl = height / 2;
        const hw = width / 2;
        return [
            add(add(centre, scale(f, hl)), scale(r, -hw)),
            add(add(centre, scale(f, hl)), scale(r, hw)),
            add(add(centre, scale(f, -hl)), scale(r, hw)),
            add(add(centre, scale(f, -hl)), scale(r, -hw)),
        ];
    }

    // Move `current` toward `target` by at most `maxDelta`.
    function approach(current, target, maxDelta) {
        if (current < target) return Math.min(current + maxDelta, target);
        if (current > target) return Math.max(current - maxDelta, target);
        return target;
    }

    // Time to closest approach of two agents on their current headings.
    // Used for near-miss detection. Returns Infinity when not converging.
    function timeToCollision(a, b) {
        const rel = sub(a.pos, b.pos);
        const rv = sub(a.vel, b.vel);
        const rv2 = dot(rv, rv);
        if (rv2 < 1e-6) return Infinity;
        const t = -dot(rel, rv) / rv2;
        if (t < 0) return Infinity;
        const closest = add(rel, scale(rv, t));
        return length(closest) < (a.radius + b.radius) ? t : Infinity;
    }

    SIM.math = {
        TAU, clamp, lerp, wrapAngle, add, sub, scale, dot, cross, length,
        normalise, perp, distance, forward, right, angleTo, projectOnSegment,
        segmentIntersection, polygonsIntersect, pointInPolygon, orientedBox,
        approach, timeToCollision,
    };
})(globalThis.SIM = globalThis.SIM || {});
