// biomech.js — turns raw keypoints into boxing-meaningful features. Every distance
// is normalized by shoulder width (SW) so features transfer across body types and
// camera distances (doc §4, §6a). Image coordinates: +x right, +y DOWN (screen).
// We flip y into a math-up convention for anything a human reads as "height".

import { DE_LEVA, LM } from './config.js';
import { mid, lerp, dist, weightedMean, jointAngleDeg, intervalSignedDistance } from './vec.js';

/** @typedef {{x:number, y:number, visibility?:number}} P */
/** @typedef {P[]} Pose 33 landmarks */

/**
 * Robust body scale in image units — the normalization length for the frame (all
 * SW-normalized features divide by this). Naively this is shoulder width, but in a
 * near-side view the two shoulders project almost on top of each other, so raw
 * shoulder width collapses toward zero and every normalized value explodes. We
 * therefore take the LARGER of measured shoulder width and 0.66·torso-length
 * (shoulder-mid → hip-mid): in a frontal/synthetic view shoulder width dominates
 * (~a true shoulder width); in a side view the stable torso term takes over and
 * yields the same scale. This keeps one consistent "shoulder-width-equivalent"
 * unit across camera angles — the property is still called `sw` downstream.
 */
export function bodyScale(lm) {
  const sw = dist(lm[LM.LEFT_SHOULDER], lm[LM.RIGHT_SHOULDER]);
  const torso = dist(mid(lm[LM.LEFT_SHOULDER], lm[LM.RIGHT_SHOULDER]),
                     mid(lm[LM.LEFT_HIP], lm[LM.RIGHT_HIP]));
  return Math.max(sw, 0.66 * torso) || 1e-6;
}

/**
 * Whole-body center of mass via de Leva segment weighting. Each segment's CoM is a
 * point a fixed fraction along the segment; the body CoM is the mass-weighted mean.
 * The head is placed at the mid-ear point (a stable head-center proxy from
 * keypoints). Returns a point in image coordinates.
 * @param {Pose} lm
 */
export function centerOfMass(lm) {
  const shoulderMid = mid(lm[LM.LEFT_SHOULDER], lm[LM.RIGHT_SHOULDER]);
  const hipMid = mid(lm[LM.LEFT_HIP], lm[LM.RIGHT_HIP]);
  const earMid = mid(lm[LM.LEFT_EAR], lm[LM.RIGHT_EAR]);

  /** @type {P[]} */ const pts = [];
  /** @type {number[]} */ const w = [];
  const push = (pt, mass) => { pts.push(pt); w.push(mass); };

  // Axial segments
  push(earMid, DE_LEVA.head.mass);
  push(lerp(shoulderMid, hipMid, DE_LEVA.trunk.com), DE_LEVA.trunk.mass);

  // Bilateral limbs: proximal → distal, CoM a fraction along the segment
  const limb = (prox, distal, seg) => push(lerp(lm[prox], lm[distal], seg.com), seg.mass);
  limb(LM.LEFT_SHOULDER, LM.LEFT_ELBOW, DE_LEVA.upperArm);
  limb(LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, DE_LEVA.upperArm);
  limb(LM.LEFT_ELBOW, LM.LEFT_WRIST, DE_LEVA.forearm);
  limb(LM.RIGHT_ELBOW, LM.RIGHT_WRIST, DE_LEVA.forearm);
  limb(LM.LEFT_WRIST, LM.LEFT_INDEX, DE_LEVA.hand);
  limb(LM.RIGHT_WRIST, LM.RIGHT_INDEX, DE_LEVA.hand);
  limb(LM.LEFT_HIP, LM.LEFT_KNEE, DE_LEVA.thigh);
  limb(LM.RIGHT_HIP, LM.RIGHT_KNEE, DE_LEVA.thigh);
  limb(LM.LEFT_KNEE, LM.LEFT_ANKLE, DE_LEVA.shank);
  limb(LM.RIGHT_KNEE, LM.RIGHT_ANKLE, DE_LEVA.shank);
  limb(LM.LEFT_HEEL, LM.LEFT_FOOT, DE_LEVA.foot);
  limb(LM.RIGHT_HEEL, LM.RIGHT_FOOT, DE_LEVA.foot);

  return weightedMean(pts, w);
}

/**
 * Ground-plane foot-contact x-extent = the sagittal base of support. Uses heel and
 * toe of both feet. Returns {lo, hi, groundY} in image coords.
 * @param {Pose} lm
 */
export function baseOfSupport(lm) {
  const xs = [lm[LM.LEFT_HEEL].x, lm[LM.LEFT_FOOT].x, lm[LM.RIGHT_HEEL].x, lm[LM.RIGHT_FOOT].x];
  const ys = [lm[LM.LEFT_HEEL].y, lm[LM.LEFT_FOOT].y, lm[LM.RIGHT_HEEL].y, lm[LM.RIGHT_FOOT].y];
  return { lo: Math.min(...xs), hi: Math.max(...xs), groundY: Math.max(...ys) };
}

/**
 * Full per-frame feature record. All lengths in shoulder-widths (SW). `stability`
 * is the signed CoM→base-of-support distance normalized by SW: negative = inside
 * the base (balanced), positive = CoM crossed past the nearer foot (committed).
 * @param {{tSec:number, lm:Pose}} frame
 * @param {'orthodox'|'southpaw'} stance
 */
export function frameFeatures(frame, stance = 'orthodox') {
  const lm = frame.lm;
  const sw = bodyScale(lm);
  const com = centerOfMass(lm);
  const bos = baseOfSupport(lm);

  const footMid = (bos.lo + bos.hi) / 2;
  const stability = intervalSignedDistance(com.x, bos.lo, bos.hi) / sw;
  const comOffset = (com.x - footMid) / sw; // running weight-distribution signal

  // Elbow extension per arm (straight = large angle at impact)
  const leftElbow = jointAngleDeg(lm[LM.LEFT_SHOULDER], lm[LM.LEFT_ELBOW], lm[LM.LEFT_WRIST]);
  const rightElbow = jointAngleDeg(lm[LM.RIGHT_SHOULDER], lm[LM.RIGHT_ELBOW], lm[LM.RIGHT_WRIST]);

  // Head + guard references. Chin proxy = point just below nose toward shoulders.
  const nose = lm[LM.NOSE];
  const shoulderMid = mid(lm[LM.LEFT_SHOULDER], lm[LM.RIGHT_SHOULDER]);
  // Carry depth on the shoulder midpoint so wrist excursion can be measured in 3D
  // (front-camera punches travel mostly in z). Absent z (synthetic demo) → 0.
  shoulderMid.z = ((lm[LM.LEFT_SHOULDER].z || 0) + (lm[LM.RIGHT_SHOULDER].z || 0)) / 2;
  const chinY = lerp(nose, shoulderMid, 0.35).y;

  // Guard drop for each hand = how far the wrist sits BELOW the chin line (SW).
  // Screen y grows downward, so (wristY - chinY) positive means below the chin.
  const leftGuardDrop = (lm[LM.LEFT_WRIST].y - chinY) / sw;
  const rightGuardDrop = (lm[LM.RIGHT_WRIST].y - chinY) / sw;

  return {
    tSec: frame.tSec,
    sw,
    com,
    bos,
    stability,
    comOffset,
    footMidX: footMid,
    stanceWidthSW: (bos.hi - bos.lo) / sw, // sagittal (lead↔rear) spread in side view
    wristL: { ...lm[LM.LEFT_WRIST] },
    wristR: { ...lm[LM.RIGHT_WRIST] },
    elbowDeg: { left: leftElbow, right: rightElbow },
    guardDrop: { left: leftGuardDrop, right: rightGuardDrop },
    nose: { x: nose.x / sw, y: nose.y / sw }, // SW-normalized for defense detection
    hipMid: mid(lm[LM.LEFT_HIP], lm[LM.RIGHT_HIP]),
    shoulderMid,
    stance,
  };
}

/**
 * Per-hand wrist speed in SW/s. Positions are already smoothed upstream; here we
 * normalize by the per-frame shoulder width, then central-difference.
 * @param {ReturnType<typeof frameFeatures>[]} feats
 */
export function wristSpeeds(feats) {
  const t = feats.map((f) => f.tSec);
  const speed = (key) => {
    const s = new Array(feats.length).fill(0);
    for (let i = 1; i < feats.length - 1; i++) {
      const dt = t[i + 1] - t[i - 1];
      if (dt <= 1e-6) continue;
      const a = feats[i - 1][key], b = feats[i + 1][key];
      // 3D so a punch driven toward the camera (large z, small x/y) still shows speed.
      s[i] = (Math.hypot(b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0)) / feats[i].sw) / dt;
    }
    if (feats.length >= 2) { s[0] = s[1]; s[feats.length - 1] = s[feats.length - 2]; }
    return s;
  };
  return { left: speed('wristL'), right: speed('wristR'), t };
}
