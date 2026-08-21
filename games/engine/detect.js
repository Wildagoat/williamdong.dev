// detect.js — critical-moment detection. Segments a continuous feature stream into
// punch events, classifies them, groups combos, and flags defensive transitions
// (doc §5). Heuristic by design: correct-by-construction and fully inspectable, and
// the labels it produces are exactly what would bootstrap a learned segmenter later.

import { CONFIG } from './config.js';
import { wristSpeeds } from './biomech.js';
import { findPeaks, derivative, lowPassSeries } from './filters.js';

/**
 * @typedef {Object} PunchEvent
 * @property {'left'|'right'} hand
 * @property {'jab'|'cross'|'hook'|'uppercut'} type
 * @property {number} onsetT @property {number} impactT @property {number} endT
 * @property {number} peakSpeed  SW/s
 * @property {number} elbowExtDeg elbow angle at impact
 * @property {number} onsetIdx @property {number} impactIdx @property {number} endIdx
 */

/**
 * Detect punch events from per-frame features.
 * @param {import('./biomech.js').frameFeatures[]} feats
 * @returns {{events:PunchEvent[], speeds:{left:number[],right:number[],t:number[]}}}
 */
export function detectPunches(feats) {
  const speeds = wristSpeeds(feats);
  const t = speeds.t;
  const cfg = CONFIG.detect;
  const minSep = cfg.minPeakSeparationMs / 1000;

  const n = feats.length;
  /** @type {PunchEvent[]} */
  const events = [];
  for (const hand of /** @type {const} */ (['left', 'right'])) {
    const v = speeds[hand];
    const wKey = hand === 'left' ? 'wristL' : 'wristR';
    // Excursion = how far the wrist is from its resting guard position, in the
    // BODY frame (relative to the shoulder, so whole-body translation cancels).
    // This generalizes "arm extension": a straight extends radially, a hook swings
    // laterally, an uppercut drives upward — all are large wrist excursions, so all
    // are detected the same way. `home` is a slow low-pass of the body-relative
    // wrist = the drifting guard position each punch departs from and returns to.
    const relX = feats.map((f) => (f[wKey].x - f.shoulderMid.x) / f.sw);
    const relY = feats.map((f) => (f[wKey].y - f.shoulderMid.y) / f.sw);
    // Depth component: a jab/cross thrown at a front-facing camera travels mostly in z
    // and barely in x/y, so a 2D excursion misses it entirely. Absent z → 0 (side-view
    // and the synthetic demo are unchanged).
    const relZ = feats.map((f) => ((f[wKey].z || 0) - (f.shoulderMid.z || 0)) / f.sw);
    const homeX = lowPassSeries(relX, t, cfg.homeCutoffHz);
    const homeY = lowPassSeries(relY, t, cfg.homeCutoffHz);
    const homeZ = lowPassSeries(relZ, t, cfg.homeCutoffHz);
    const exc = relX.map((_, i) => Math.hypot(relX[i] - homeX[i], relY[i] - homeY[i], relZ[i] - homeZ[i]));
    const excVel = derivative(exc, t);

    // A punch has two speed peaks (out and back); keep only OUTGOING ones — where
    // the wrist is still travelling away from guard — so retraction isn't recounted.
    const peaks = findPeaks(v, t, cfg.speedPeakThreshold, minSep)
      .filter((pk) => excVel[pk] > 0);

    for (const pk of peaks) {
      const peakSpeed = v[pk];
      const floor = cfg.retractSpeedFraction * peakSpeed;
      // Impact = farthest point of the punch = local max of excursion at/after peak.
      let impactIdx = pk;
      while (impactIdx < n - 1 && exc[impactIdx + 1] >= exc[impactIdx]) impactIdx++;
      // Onset = the guard position the punch departs from = excursion local-minimum
      // before impact. Excursion-based (not speed-based), so it stays correct inside
      // combos where wrist speed never fully settles between punches.
      let onset = impactIdx;
      while (onset > 0 && exc[onset - 1] < exc[onset]) onset--;
      // A punch is a real excursion of the wrist from guard (doc §5.1). Gate on
      // amplitude so settling blips and jitter in a busy retraction aren't counted.
      if (exc[impactIdx] - exc[onset] < cfg.minExcursionSW) continue;

      // End = retraction (mostly) complete: speed dropped back below the floor AND the
      // wrist has returned ≥60% of the way to guard. A fractional threshold (not an
      // absolute "within 0.1 SW of guard") keeps this robust to the slow-moving home
      // reference lagging behind a fast retraction.
      const backThresh = exc[onset] + 0.4 * (exc[impactIdx] - exc[onset]);
      let end = impactIdx;
      while (end < n - 1 && !(v[end] < floor && exc[end] <= backThresh)) end++;

      events.push({
        hand,
        type: classifyPunch(feats, hand, onset, impactIdx, end),
        onsetT: t[onset], impactT: t[impactIdx], endT: t[end],
        peakSpeed, elbowExtDeg: feats[impactIdx].elbowDeg[hand],
        onsetIdx: onset, impactIdx, endIdx: end,
      });
    }
  }
  // Two same-hand peaks can resolve to the same extension (one physical punch);
  // dedupe by impact frame, keeping the faster.
  events.sort((a, b) => a.impactT - b.impactT || b.peakSpeed - a.peakSpeed);
  const deduped = [];
  for (const e of events) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.hand === e.hand && prev.impactIdx === e.impactIdx) continue;
    deduped.push(e);
  }

  // Suppress sympathetic opposite-hand co-activations: when both wrists peak within a
  // very short window — the guard hand twitching as you punch, or camera jitter — keep
  // only the faster one. Stops a real jab being mirrored into a phantom cross (and the
  // reverse). The window (110ms) is short enough that a genuine fast 1-2 survives.
  const CROSS_HAND_SEC = 0.11;
  const kept = [];
  for (const e of deduped) {
    const j = kept.findIndex((k) => k.hand !== e.hand && Math.abs(k.impactT - e.impactT) < CROSS_HAND_SEC);
    if (j >= 0) { if (e.peakSpeed > kept[j].peakSpeed) kept[j] = e; continue; }
    kept.push(e);
  }
  return { events: kept, speeds };
}

/**
 * Rule-based punch classifier over the event window. A tiny learned classifier is
 * the documented upgrade (doc §5.2); the features it would use are computed here.
 * Straight vs hook vs uppercut from wrist-path direction + elbow extension; jab vs
 * cross from which hand fired relative to stance.
 */
export function classifyPunch(feats, hand, onsetIdx, impactIdx, endIdx) {
  const wKey = hand === 'left' ? 'wristL' : 'wristR';
  // Wrist path from guard to impact, measured in the BODY frame (relative to the
  // shoulder) so the direction isn't corrupted by the athlete stepping/leaning.
  const a = feats[onsetIdx], b = feats[impactIdx];
  const relA = { x: (a[wKey].x - a.shoulderMid.x) / a.sw, y: (a[wKey].y - a.shoulderMid.y) / a.sw };
  const relB = { x: (b[wKey].x - b.shoulderMid.x) / b.sw, y: (b[wKey].y - b.shoulderMid.y) / b.sw };
  const dx = relB.x - relA.x;
  const dyUp = -(relB.y - relA.y); // screen y down → positive dyUp means the wrist rose
  // Forward reach toward the camera (BlazePose z: smaller = closer), body-relative.
  const relAz = ((a[wKey].z || 0) - (a.shoulderMid.z || 0)) / a.sw;
  const relBz = ((b[wKey].z || 0) - (b.shoulderMid.z || 0)) / b.sw;
  const fwd = relAz - relBz; // > 0 means the wrist drove toward the camera
  const horiz = Math.abs(dx), vert = Math.abs(dyUp);
  const elbowImpact = feats[impactIdx].elbowDeg[hand];
  const elbowOnset = feats[onsetIdx].elbowDeg[hand];
  const dElbow = elbowImpact - elbowOnset; // straights OPEN the elbow; hooks/uppercuts hold it
  const cfg = CONFIG.detect;
  // Straight if the elbow opens through the shot OR the wrist drove forward at the lens.
  const straightArm = elbowImpact > cfg.elbowExtensionMinDeg || dElbow > 30 || fwd > 0.30;

  let shape;
  // Uppercut: wrist drives upward with a bent arm (vertical dominates, elbow stays closed).
  if (dyUp > cfg.uppercutRiseSW && vert >= horiz && !straightArm) shape = 'uppercut';
  // Straight: the elbow opens through the shot.
  else if (straightArm) shape = 'straight';
  // Hook: horizontal travel with the elbow held bent.
  else if (horiz > cfg.hookTravelSW) shape = 'hook';
  else shape = 'straight';

  if (shape !== 'straight') return shape; // hook/uppercut named directly
  // Straight → jab (lead hand) or cross (rear hand), from stance.
  const stance = feats[impactIdx].stance;
  const leadHand = stance === 'orthodox' ? 'left' : 'right';
  return hand === leadHand ? 'jab' : 'cross';
}

/**
 * Group punches into combos: consecutive events whose inter-impact gap is below
 * the threshold become one ordered unit (doc §5.4).
 * @param {PunchEvent[]} events
 */
export function groupCombos(events) {
  const combos = [];
  let cur = [];
  const maxGap = CONFIG.combo.maxGapMs / 1000;
  for (const e of events) {
    if (cur.length && e.impactT - cur[cur.length - 1].impactT > maxGap) {
      combos.push(cur); cur = [];
    }
    cur.push(e);
  }
  if (cur.length) combos.push(cur);
  return combos;
}

/**
 * Defensive transitions from head (nose) trajectory (doc §5.3). Slip = lateral
 * head travel with feet planted; roll = vertical dip; pull = backward retreat.
 * Values are already SW-normalized in feats[].nose.
 * @param {import('./biomech.js').frameFeatures[]} feats
 */
export function detectDefense(feats) {
  const cfg = CONFIG.defense;
  const t = feats.map((f) => f.tSec);
  const nx = feats.map((f) => f.nose.x);
  const ny = feats.map((f) => f.nose.y);
  const vx = derivative(nx, t).map(Math.abs);
  const events = [];
  // Sliding 400ms windows; flag the dominant motion if it clears a threshold.
  const win = 0.4;
  for (let i = 0; i < feats.length; i++) {
    let j = i;
    while (j < feats.length && t[j] - t[i] < win) j++;
    if (j >= feats.length) break;
    const lateral = Math.abs(nx[j] - nx[i]);
    const drop = ny[j] - ny[i]; // +down
    if (drop > cfg.rollVerticalMin && drop > lateral) {
      events.push({ type: 'roll', t: t[i], magnitude: drop });
    } else if (lateral > cfg.slipLateralMin && lateral > Math.abs(drop)) {
      events.push({ type: 'slip', t: t[i], magnitude: lateral });
    }
    i = j - 1; // non-overlapping windows so one move isn't flagged many times
  }
  return events;
}
