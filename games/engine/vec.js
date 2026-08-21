// vec.js — small, dependency-free 2D vector + geometry helpers used across the
// biomech and detection layers. Everything operates on {x, y} points.

/** @typedef {{x:number, y:number}} P */

/** @param {P} a @param {P} b */
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
/** @param {P} a @param {P} b */
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
/** @param {P} a @param {number} s */
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
/** @param {P} a */
export const len = (a) => Math.hypot(a.x, a.y);
/** @param {P} a @param {P} b */
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** Weighted centroid of points. @param {P[]} pts @param {number[]} weights */
export function weightedMean(pts, weights) {
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < pts.length; i++) {
    sx += pts[i].x * weights[i];
    sy += pts[i].y * weights[i];
    sw += weights[i];
  }
  return { x: sx / sw, y: sy / sw };
}

/** Midpoint. @param {P} a @param {P} b */
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Point a fraction `t` from a toward b (t in [0,1]). @param {P} a @param {P} b @param {number} t */
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * Interior joint angle at vertex `b`, formed by segments b→a and b→c, in degrees.
 * Used for elbow extension (a=shoulder, b=elbow, c=wrist).
 * @param {P} a @param {P} b @param {P} c
 */
export function jointAngleDeg(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const denom = len(u) * len(v);
  if (denom < 1e-9) return NaN;
  let cos = (u.x * v.x + u.y * v.y) / denom;
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Signed distance from a scalar x to the closed interval [lo, hi].
 *   > 0  → x is OUTSIDE, past the nearer edge (how far it overshot)
 *   < 0  → x is INSIDE; magnitude is the margin to the nearer edge
 * This is the 1-D (sagittal) base-of-support stability metric. In a pure side
 * view the two feet collapse onto the depth axis, so the honest base of support
 * is the lead↔rear x-interval — a 2-D convex hull would be degenerate. Front-view
 * fusion (v2) upgrades this to a real polygon; `hullSignedDistance` below is ready
 * for that day.
 * @param {number} x @param {number} lo @param {number} hi
 */
export function intervalSignedDistance(x, lo, hi) {
  if (lo > hi) [lo, hi] = [hi, lo];
  if (x < lo) return lo - x;
  if (x > hi) return x - hi;
  return -Math.min(x - lo, hi - x);
}

/**
 * Andrew's monotone-chain convex hull. Returns hull vertices CCW.
 * Kept for front-view / multi-contact base-of-support (v2). Not used by the 2D
 * sagittal MVP path, which uses intervalSignedDistance instead.
 * @param {P[]} points
 */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/**
 * Signed distance from point p to a convex polygon (hull). Negative inside
 * (margin to nearest edge), positive outside (distance to hull). For v2 front-view
 * base of support. @param {P} p @param {P[]} hull
 */
export function hullSignedDistance(p, hull) {
  if (hull.length < 3) {
    // Degenerate (side view): fall back to the x-interval metric.
    const xs = hull.map((h) => h.x);
    return intervalSignedDistance(p.x, Math.min(...xs), Math.max(...xs));
  }
  let inside = true;
  let minEdge = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const e = sub(b, a), w = sub(p, a);
    const t = Math.max(0, Math.min(1, (w.x * e.x + w.y * e.y) / (e.x * e.x + e.y * e.y || 1e-9)));
    const proj = { x: a.x + e.x * t, y: a.y + e.y * t };
    minEdge = Math.min(minEdge, dist(p, proj));
    if (e.x * w.y - e.y * w.x < 0) inside = false; // right of a CCW edge → outside
  }
  return inside ? -minEdge : minEdge;
}

/** Clamp helper. */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Index of the maximum value in an array (NaN-safe). @param {number[]} arr */
export function argmax(arr) {
  let bi = -1, bv = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (Number.isFinite(arr[i]) && arr[i] > bv) { bv = arr[i]; bi = i; }
  }
  return bi;
}
