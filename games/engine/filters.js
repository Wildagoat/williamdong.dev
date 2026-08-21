// filters.js — temporal signal cleanup. High-acceleration motion (the impact and
// retraction frames of a punch) is exactly where generic pose models are noisiest,
// and differentiating raw keypoints amplifies that noise into unusable velocity.
// We low-pass positions with a one-euro filter BEFORE differencing (doc §4.5, §9).

/**
 * A single scalar low-pass stage. @param {number} alpha 0..1 */
class LowPass {
  constructor() { this.y = null; }
  filter(x, alpha) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
}

/**
 * One-euro filter (Casiez, Roussel & Vogel, CHI 2012). Adaptive low-pass: heavy
 * smoothing when the signal is slow (kills jitter), light smoothing when it moves
 * fast (preserves the punch). One instance per scalar channel.
 */
export class OneEuro {
  /** @param {{minCutoff?:number, beta?:number, dCutoff?:number}} opts */
  constructor({ minCutoff = 1.7, beta = 0.9, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.tPrev = null;
    this.xFilt = new LowPass();
    this.dxFilt = new LowPass();
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  /** @param {number} x @param {number} tSec absolute time in seconds */
  filter(x, tSec) {
    if (this.tPrev === null) {
      this.tPrev = tSec; this.xPrev = x;
      return this.xFilt.filter(x, 1);
    }
    const dt = Math.max(1e-3, tSec - this.tPrev);
    const dx = (x - this.xPrev) / dt;
    const edx = this.dxFilt.filter(dx, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const y = this.xFilt.filter(x, OneEuro.alpha(cutoff, dt));
    this.tPrev = tSec; this.xPrev = x;
    return y;
  }
}

/**
 * Smooth a full pose track landmark-by-landmark. Each of the 33 landmarks gets its
 * own OneEuro pair (x and y). Mutates nothing; returns new frames.
 * @param {{tSec:number, lm:{x:number,y:number}[]}[]} frames
 * @param {{minCutoff?:number, beta?:number, dCutoff?:number}} opts
 */
export function smoothTrack(frames, opts) {
  if (!frames.length) return [];
  const n = frames[0].lm.length;
  const fx = Array.from({ length: n }, () => new OneEuro(opts));
  const fy = Array.from({ length: n }, () => new OneEuro(opts));
  return frames.map((f) => ({
    ...f,
    lm: f.lm.map((p, i) => ({
      ...p,
      x: fx[i].filter(p.x, f.tSec),
      y: fy[i].filter(p.y, f.tSec),
    })),
  }));
}

/**
 * Fixed-cutoff first-order low-pass over a scalar series with irregular timestamps.
 * Used to track a slow "home" reference (the resting guard position) that punches
 * are measured against — fast enough to follow the athlete drifting around, slow
 * enough that a ~0.35s punch barely moves it.
 * @param {number[]} v @param {number[]} t seconds @param {number} fc cutoff Hz
 */
export function lowPassSeries(v, t, fc) {
  if (!v.length) return [];
  const out = new Array(v.length);
  let y = v[0]; out[0] = y;
  const tau = 1 / (2 * Math.PI * fc);
  for (let i = 1; i < v.length; i++) {
    const dt = Math.max(1e-3, t[i] - t[i - 1]);
    const alpha = 1 / (1 + tau / dt);
    y = alpha * v[i] + (1 - alpha) * y;
    out[i] = y;
  }
  return out;
}

/**
 * Central-difference derivative of a scalar series sampled at times `t`.
 * Endpoints use one-sided differences. Returns same-length array.
 * @param {number[]} v values @param {number[]} t times (seconds)
 */
export function derivative(v, t) {
  const n = v.length;
  const d = new Array(n).fill(0);
  if (n < 2) return d;
  for (let i = 1; i < n - 1; i++) {
    const dt = t[i + 1] - t[i - 1];
    d[i] = dt > 1e-6 ? (v[i + 1] - v[i - 1]) / dt : 0;
  }
  d[0] = (v[1] - v[0]) / Math.max(1e-6, t[1] - t[0]);
  d[n - 1] = (v[n - 1] - v[n - 2]) / Math.max(1e-6, t[n - 1] - t[n - 2]);
  return d;
}

/**
 * Find local maxima above `threshold` separated by at least `minSepSec`. When two
 * peaks fall inside the separation window the taller wins. Returns sorted indices.
 * @param {number[]} v @param {number[]} t @param {number} threshold @param {number} minSepSec
 */
export function findPeaks(v, t, threshold, minSepSec) {
  const cand = [];
  for (let i = 1; i < v.length - 1; i++) {
    if (v[i] > threshold && v[i] >= v[i - 1] && v[i] > v[i + 1]) cand.push(i);
  }
  cand.sort((a, b) => v[b] - v[a]); // tallest first
  const kept = [];
  for (const i of cand) {
    if (kept.every((k) => Math.abs(t[i] - t[k]) >= minSepSec)) kept.push(i);
  }
  return kept.sort((a, b) => a - b);
}
