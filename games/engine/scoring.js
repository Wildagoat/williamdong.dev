// scoring.js — per-dimension technique scoring (doc §6). The SCORING MECHANISM is
// final: extract a normalized feature trajectory per technique, measure deviation
// per dimension, DTW-align the weight-transfer trace to a reference. The reference
// BANDS in CONFIG.scoring are provisional placeholders until a coach-derived
// distribution replaces them — swapping those numbers changes nothing here.

import { CONFIG } from './config.js';
import { clamp, argmax } from './vec.js';
import { derivative } from './filters.js';
import { dtw, resample } from './dtw.js';

/**
 * Map a measured value to a 0–100 score against a band. `tolerance` is the
 * deviation (in the value's own units) at which the score reaches 0.
 * @param {number} value
 * @param {{ideal:number, tolerance:number, higherIsBetter:boolean}} band
 */
export function scoreBand(value, band) {
  if (!Number.isFinite(value)) return { score: NaN, deviation: NaN };
  const deviation = band.higherIsBetter
    ? Math.max(0, band.ideal - value)
    : Math.max(0, value - band.ideal);
  const score = clamp(100 * (1 - deviation / band.tolerance), 0, 100);
  return { score, deviation };
}

/**
 * Score a single punch event across all dimensions.
 * @param {import('./detect.js').PunchEvent} ev
 * @param {import('./biomech.js').frameFeatures[]} feats
 * @param {number[]} referenceTransfer optional ideal weight-transfer trace (resampled)
 */
export function scoreEvent(ev, feats, referenceTransfer = null, bounds = {}) {
  const { onsetIdx, impactIdx, endIdx, hand } = ev;
  // Clamp the analysis window to the neighboring punches. In a fast combo the CoM
  // is shared, so an unclamped window would measure the NEXT punch's forward lunge
  // as this punch's balance loss / failure to recover (doc §5.4 segmentation).
  const nextOnset = bounds.nextOnsetIdx ?? feats.length;
  const prevEnd = bounds.prevEndIdx ?? -1;
  const lo = Math.max(onsetIdx, prevEnd + 1);
  const hi = Math.min(feats.length - 1, endIdx, nextOnset - 1);
  const win = feats.slice(lo, hi + 1);
  const cfg = CONFIG.scoring;

  // 1. Balance discipline — worst (most positive) stability margin in the window.
  const peakStability = Math.max(...win.map((f) => f.stability));
  const balance = scoreBand(peakStability, cfg.balance);

  // 2. Weight-transfer recovery — residual CoM offset after retraction, measured in
  //    a short tail that stops before the next punch begins. Recovery is only
  //    meaningful when the athlete actually had room to reset: mid-combo (the next
  //    punch starts within ~2 frames) we can't judge it, so we report it as N/A
  //    rather than penalizing the deliberate weight-chaining of a combo.
  const tailEnd = Math.min(feats.length, endIdx + 5, nextOnset);
  const tail = feats.slice(endIdx, tailEnd);
  const midCombo = nextOnset - endIdx <= 2;
  const residual = tail.length
    ? Math.abs(tail.reduce((s, f) => s + f.comOffset, 0) / tail.length)
    : Math.abs(feats[Math.min(endIdx, feats.length - 1)].comOffset);
  const recovery = midCombo ? { score: NaN, deviation: NaN } : scoreBand(residual, cfg.recovery);

  // 3. Kinetic-chain sequencing — proximal→distal peak-velocity ordering. In the
  //    2D MVP we proxy hip/shoulder "rotation" by horizontal velocity of the hip
  //    and shoulder midpoints; full 3D segment rotation is the v2 upgrade.
  const chainFrac = kineticChainOrdering(win, hand);
  const kineticChain = scoreBand(chainFrac, cfg.kineticChain);

  // 4. Guard integrity — deepest drop of the NON-punching hand during the punch.
  const otherHand = hand === 'left' ? 'right' : 'left';
  const guardDrop = Math.max(...win.map((f) => f.guardDrop[otherHand]));
  const guard = scoreBand(guardDrop, cfg.guard);

  // 5. Retraction speed — time from impact back to guard.
  const retractSec = ev.endT - ev.impactT;
  const retraction = scoreBand(retractSec, cfg.retraction);

  // Weight-transfer trace (CoM offset over the window), resampled to a common base
  // and DTW-aligned to the reference when one is provided.
  const transfer = resample(win.map((f) => f.comOffset), 32);
  let transferMatch = null;
  if (referenceTransfer) {
    const { normalized } = dtw(transfer, referenceTransfer, { band: 0.25 });
    // Convert alignment error to a 0–100 similarity; 0.35 SW mean error → 0.
    transferMatch = clamp(100 * (1 - normalized / 0.35), 0, 100);
  }

  const dims = { balance, recovery, kineticChain, guard, retraction };
  const scores = Object.values(dims).map((d) => d.score).filter(Number.isFinite);
  const overall = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : NaN;

  return {
    dims,
    overall,
    raw: { peakStability, residual, chainFrac, guardDrop, retractSec },
    transfer,
    transferMatch,
    notes: coachingNotes(dims, { peakStability, residual, guardDrop, retractSec }, ev),
  };
}

/**
 * Fraction of the proximal→distal ordering that fired correctly, comparing peak
 * horizontal-velocity times of hip → shoulder → wrist. A segment is only graded if
 * it actually moved (velocity amplitude above a noise floor, in SW/s) — otherwise
 * we can't judge its timing and don't penalize it. A jab, being a lead-arm punch
 * with little hip/shoulder rotation, may legitimately return NaN (not enough
 * proximal motion to assess the chain) rather than a failing score.
 * @param {import('./biomech.js').frameFeatures[]} win
 * @param {'left'|'right'} hand
 * @returns {number} fraction in [0,1], or NaN if no pair is gradable
 */
export function kineticChainOrdering(win, hand) {
  if (win.length < 3) return NaN;
  const t = win.map((f) => f.tSec);
  const floor = 0.8; // SW/s — below this a segment is treated as "did not move"
  const seg = (getter) => {
    const v = derivative(win.map((f, i) => getter(f) / f.sw), t).map(Math.abs);
    return { amp: Math.max(...v), tPeak: t[argmax(v)] };
  };
  const hip = seg((f) => f.hipMid.x);
  const sh = seg((f) => f.shoulderMid.x);
  const wKey = hand === 'left' ? 'wristL' : 'wristR';
  const wr = seg((f) => f[wKey].x);

  let ok = 0, total = 0;
  if (hip.amp > floor && sh.amp > floor) { total++; if (hip.tPeak <= sh.tPeak) ok++; }
  if (sh.amp > floor && wr.amp > floor) { total++; if (sh.tPeak <= wr.tPeak) ok++; }
  return total ? ok / total : NaN;
}

/**
 * Plain-language coaching notes mapped from per-dimension deviations to the
 * curriculum (doc §7). Only fires notes for dimensions that actually deviated.
 */
function coachingNotes(dims, raw, ev) {
  const notes = [];
  if (dims.balance.score < 70) {
    notes.push(`Weight crossed ${(raw.peakStability).toFixed(2)} SW past the lead foot on the ${ev.type} — overcommitted. Drive-and-recover drill.`);
  }
  if (dims.recovery.score < 70) {
    notes.push(`Didn't recover to a neutral stance after the ${ev.type} (residual ${raw.residual.toFixed(2)} SW) — you're falling in.`);
  }
  if (dims.guard.score < 70) {
    notes.push(`Rear hand dropped ${raw.guardDrop.toFixed(2)} SW below guard during the ${ev.type}. Keep it home.`);
  }
  if (dims.kineticChain.score < 70) {
    notes.push(`Kinetic chain out of sequence — hips, shoulder and hand didn't fire proximal-to-distal. Turn the hip first.`);
  }
  if (dims.retraction.score < 70) {
    notes.push(`Slow retraction (${(raw.retractSec * 1000).toFixed(0)} ms) — snap the hand back to guard.`);
  }
  if (!notes.length) notes.push(`Clean ${ev.type}. Balance, transfer, guard and sequencing all in band.`);
  return notes;
}

/**
 * Build a reference weight-transfer trace from one or more clean exemplar events —
 * the "distribution, not a hero frame" idea (doc §6b), here a mean trace. Feed
 * coach footage to replace the synthetic ideal.
 * @param {number[][]} exemplarTransfers each already resampled to length 32
 */
export function buildReferenceTransfer(exemplarTransfers) {
  if (!exemplarTransfers.length) return null;
  const len = exemplarTransfers[0].length;
  const mean = new Array(len).fill(0);
  for (const ex of exemplarTransfers) for (let i = 0; i < len; i++) mean[i] += ex[i] / exemplarTransfers.length;
  return mean;
}
