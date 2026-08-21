// live.js — streaming wrapper that turns the batch kodawari analyzer into a
// real-time trainer. The batch pipeline (pipeline.js) smooths a whole recorded
// track, then detects and scores. Here we do the same work incrementally over a
// short rolling buffer of the most recent frames, emitting each punch the moment
// its retraction has settled. Detection and scoring are the SAME functions the
// offline analyzer uses — only the orchestration is different.
//
// Contract: push(tSec, lm) every frame with normalized 33-landmark poses; get back
// the smoothed landmarks for the overlay, and `onPunch(ev, score)` fires once per
// completed, graded punch.

import { CONFIG } from './config.js';
import { OneEuro } from './filters.js';
import { frameFeatures } from './biomech.js';
import { detectPunches } from './detect.js';
import { scoreEvent } from './scoring.js';

const z0 = (p) => (p && Number.isFinite(p.z) ? p.z : 0);
const mkFilters = (n, opts) => Array.from({ length: n }, () => new OneEuro(opts));

// z (depth) from BlazePose is far noisier than x/y, so it gets stronger smoothing —
// otherwise its jitter inflates 3D wrist speed even while you sit perfectly still.
const Z_SMOOTH = { minCutoff: 1.2, beta: 0.6, dCutoff: 1.0 };
// A separate, more responsive filter used ONLY for the drawn overlay: low enough cutoff
// to kill rest twitch, high enough beta not to trail the body during a punch.
const DISPLAY_SMOOTH = { minCutoff: 1.5, beta: 2.5, dCutoff: 1.0 };

export class LiveTrainer {
  /**
   * @param {{stance?:'orthodox'|'southpaw', bufferSec?:number,
   *          settleSec?:number, onPunch?:(ev:any, score:any)=>void}} opts
   */
  constructor({ stance = 'orthodox', bufferSec = 3.0, settleSec = 0.12, warmupSec = 1.2,
                scanIntervalSec = 0.06, onPunch = () => {} } = {}) {
    this.stance = stance;
    this.bufferSec = bufferSec;
    // Detection (detectPunches over the whole buffer) is the expensive per-frame work.
    // It doesn't need to run every frame — a punch lasts ~300-500ms — so we throttle it
    // to keep the render loop (and therefore the overlay) fast and responsive.
    this.scanIntervalSec = scanIntervalSec;
    // How long a punch's retraction must sit in the past before we grade it, so the
    // scoring window (which reaches past impact into the recovery tail) is complete.
    this.settleSec = settleSec;
    // Required pre-roll before a punch's onset once the buffer has begun trimming.
    // detect.js tracks the drifting "guard" position with a causal low-pass; near the
    // buffer's leading edge that reference hasn't converged, which can misread a
    // straight's retraction as a fresh (outgoing) punch. Demanding pre-roll before the
    // onset means the guard reference is settled by the time the punch departs it —
    // exactly what the offline analyzer gets from a full track. See reset()/_scan.
    this.warmupSec = warmupSec;
    this.onPunch = onPunch;
    this.reset();
  }

  setStance(stance) { this.stance = stance; }

  reset() {
    this._fx = null;          // per-landmark OneEuro (x) — detection
    this._fy = null;          // per-landmark OneEuro (y) — detection
    this._fz = null;          // per-landmark OneEuro (z / depth) — detection (stronger)
    this._dx = null;          // per-landmark OneEuro (x) — display overlay only
    this._dy = null;          // per-landmark OneEuro (y) — display overlay only
    this._homeL = null;       // running guard (home) estimate, lead/left wrist (body-relative, SW)
    this._homeR = null;       // running guard estimate, rear/right wrist
    this._firstT = null;      // tSec of the very first frame (the initial guard pose)
    this._lastScanT = -Infinity;
    this.feats = [];          // rolling smoothed feature frames
    this._emitted = [];       // impact times already graded (dedupe guard)
    this.stats = freshStats();
    // Live per-frame diagnostics (surfaced by the trainer's debug panel).
    this.live = { speedL: 0, speedR: 0, elbowL: NaN, elbowR: NaN, excL: 0, excR: 0 };
  }

  /**
   * Ingest one raw pose frame. Returns the smoothed landmarks so the caller can
   * draw an overlay that matches what detection actually sees.
   * @param {number} tSec seconds (monotonic)
   * @param {{x:number,y:number,visibility?:number}[]} lm normalized landmarks
   * @returns {{slm:{x:number,y:number,visibility?:number}[]}}
   */
  push(tSec, lm) {
    if (!this._fx) {
      const n = lm.length;
      this._fx = mkFilters(n, CONFIG.smoothing);
      this._fy = mkFilters(n, CONFIG.smoothing);
      this._fz = mkFilters(n, Z_SMOOTH);            // depth: stronger smoothing
      this._dx = mkFilters(n, DISPLAY_SMOOTH);      // overlay: responsive smoothing
      this._dy = mkFilters(n, DISPLAY_SMOOTH);
      this._firstT = tSec;
    }
    // Detection copy: one-euro smooth each coordinate (incl. depth z) before any velocity
    // is computed (doc §4.5). z is what lets a punch thrown TOWARD the camera register.
    const slm = lm.map((p, i) => ({
      ...p,
      x: this._fx[i].filter(p.x, tSec),
      y: this._fy[i].filter(p.y, tSec),
      z: this._fz[i].filter(z0(p), tSec),
    }));
    // Display copy: lighter, more responsive smoothing for the drawn skeleton — steady at
    // rest (no twitch), still tight to the body during a punch. Not used for detection.
    const dlm = lm.map((p, i) => ({
      ...p,
      x: this._dx[i].filter(p.x, tSec),
      y: this._dy[i].filter(p.y, tSec),
    }));
    this.feats.push(frameFeatures({ tSec, lm: slm }, this.stance));

    // Drop frames older than the rolling window.
    const tMin = tSec - this.bufferSec;
    while (this.feats.length > 2 && this.feats[0].tSec < tMin) this.feats.shift();

    this._updateLive();
    // Throttle the heavy detection pass; features are still recorded every frame.
    if (tSec - this._lastScanT >= this.scanIntervalSec) {
      this._lastScanT = tSec;
      this._scan(tSec);
    }
    return { slm, dlm };
  }

  /** Cheap per-frame diagnostics (3D wrist speed, excursion, elbow) for the debug panel. */
  _updateLive() {
    const f = this.feats;
    const cur = f[f.length - 1];
    if (!cur) return;
    this.live.elbowL = cur.elbowDeg.left;
    this.live.elbowR = cur.elbowDeg.right;

    // Body-relative wrist position in SW (same quantity detect.js measures excursion on).
    const rel = (w) => ({
      x: (w.x - cur.shoulderMid.x) / cur.sw,
      y: (w.y - cur.shoulderMid.y) / cur.sw,
      z: (z0(w) - (cur.shoulderMid.z || 0)) / cur.sw,
    });
    const rl = rel(cur.wristL), rr = rel(cur.wristR);
    if (!this._homeL) { this._homeL = { ...rl }; this._homeR = { ...rr }; }

    if (f.length >= 2) {
      const prev = f[f.length - 2];
      // Readout speed over a 3-frame span (halves the jitter of a raw 2-frame diff);
      // falls back to 2 frames at the very start.
      const ref = f[f.length - 3] || prev;
      const dtSp = Math.max(1e-3, cur.tSec - ref.tSec);
      const sp = (key) => {
        const a = ref[key], b = cur[key];
        return Math.hypot(b.x - a.x, b.y - a.y, z0(b) - z0(a)) / cur.sw / dtSp;
      };
      this.live.speedL = sp('wristL');
      this.live.speedR = sp('wristR');
      // Track the slow "guard" reference each wrist departs from, and report how far the
      // wrist currently sits from it — mirrors detect.js's home low-pass + excursion.
      const dt = Math.max(1e-3, cur.tSec - prev.tSec);
      const tau = 1 / (2 * Math.PI * CONFIG.detect.homeCutoffHz);
      const a = 1 / (1 + tau / dt);
      for (const k of ['x', 'y', 'z']) {
        this._homeL[k] += a * (rl[k] - this._homeL[k]);
        this._homeR[k] += a * (rr[k] - this._homeR[k]);
      }
    }
    this.live.excL = Math.hypot(rl.x - this._homeL.x, rl.y - this._homeL.y, rl.z - this._homeL.z);
    this.live.excR = Math.hypot(rr.x - this._homeR.x, rr.y - this._homeR.y, rr.z - this._homeR.z);
  }

  /** Run detection over the buffer and grade any newly-settled punches. */
  _scan(nowT) {
    if (this.feats.length < 8) return;
    const { events } = detectPunches(this.feats);
    const bufStartT = this.feats[0].tSec;
    // While the buffer still starts at the very first frame, its start IS a real
    // guard pose, so the guard low-pass is well-initialized and every detection is
    // trustworthy. Once trimming has moved the start into mid-motion, demand pre-roll.
    const atSessionStart = bufStartT === this._firstT;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      // Grade only once retraction has settled, so the scoring window is whole.
      if (ev.endT > nowT - this.settleSec) continue;
      // Reject buffer-edge artifacts: a punch whose onset lacks enough settled pre-roll
      // was measured against an unconverged guard reference (see this.warmupSec).
      if (!atSessionStart && this.feats[ev.onsetIdx].tSec - bufStartT < this.warmupSec) continue;
      // Dedupe: the same physical punch reappears as the buffer grows; skip if we
      // already graded a punch within a peak-separation of this impact time.
      const dupWin = CONFIG.detect.minPeakSeparationMs / 1000;
      if (this._emitted.some((t) => Math.abs(t - ev.impactT) < dupWin)) continue;

      const score = scoreEvent(ev, this.feats, null, {
        prevEndIdx: i > 0 ? events[i - 1].endIdx : -1,
        nextOnsetIdx: i < events.length - 1 ? events[i + 1].onsetIdx : this.feats.length,
      });

      this._emitted.push(ev.impactT);
      if (this._emitted.length > 64) this._emitted.shift();
      this._accumulate(ev, score);
      this.onPunch(ev, score);
    }
  }

  _accumulate(ev, score) {
    const s = this.stats;
    s.count += 1;
    s.byType[ev.type] = (s.byType[ev.type] || 0) + 1;
    if (Number.isFinite(score.overall)) {
      s.scoreSum += score.overall;
      s.scored += 1;
      s.avg = s.scoreSum / s.scored;
      if (score.overall > s.best) s.best = score.overall;
    }
    if (ev.peakSpeed > s.fastest) s.fastest = ev.peakSpeed;
    // Rolling combo: punches within combo.maxGapMs of the previous one chain up.
    const gap = ev.impactT - s._lastImpactT;
    if (s._lastImpactT > -Infinity && gap <= CONFIG.combo.maxGapMs / 1000) s._combo += 1;
    else s._combo = 1;
    s._lastImpactT = ev.impactT;
    if (s._combo > s.bestCombo) s.bestCombo = s._combo;
  }
}

function freshStats() {
  return {
    count: 0, scored: 0, scoreSum: 0, avg: NaN, best: 0, fastest: 0,
    bestCombo: 0, byType: {}, _combo: 0, _lastImpactT: -Infinity,
  };
}
