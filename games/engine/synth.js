// synth.js — synthetic pose generator for demo mode. Produces a physically plausible
// 33-landmark side-view track of an orthodox boxer throwing scripted crosses and
// jabs — some clean, some deliberately overcommitted — so the ENTIRE pipeline
// (smoothing → features → detection → scoring) runs and can be validated with no
// footage. This is a test fixture, not a physics sim: it exists to exercise the
// analyzer and to make the backend panel's examples live.

/** Deterministic PRNG (mulberry32) so the demo is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Base guard pose (orthodox, side view, facing +x). Normalized image coords, y down. */
export function makeBase() {
  const B = new Array(33);
  const set = (i, x, y) => (B[i] = { x, y, visibility: 1 });
  set(0, 0.520, 0.300);                                   // nose
  set(1, 0.517, 0.292); set(2, 0.515, 0.292); set(3, 0.512, 0.292);
  set(4, 0.503, 0.294); set(5, 0.501, 0.294); set(6, 0.499, 0.294);
  set(7, 0.505, 0.290); set(8, 0.495, 0.295);             // ears
  set(9, 0.518, 0.315); set(10, 0.512, 0.317);            // mouth
  set(11, 0.505, 0.400); set(12, 0.475, 0.405);           // shoulders (L lead / R rear)
  set(13, 0.520, 0.500); set(14, 0.460, 0.500);           // elbows
  set(15, 0.545, 0.340); set(16, 0.505, 0.350);           // wrists
  set(17, 0.552, 0.327); set(18, 0.512, 0.337);           // pinkies
  set(19, 0.554, 0.330); set(20, 0.514, 0.340);           // indices
  set(21, 0.549, 0.335); set(22, 0.509, 0.345);           // thumbs
  set(23, 0.505, 0.600); set(24, 0.485, 0.600);           // hips
  set(25, 0.520, 0.740); set(26, 0.470, 0.740);           // knees
  set(27, 0.530, 0.880); set(28, 0.450, 0.880);           // ankles
  set(29, 0.520, 0.895); set(30, 0.440, 0.895);           // heels
  set(31, 0.560, 0.895); set(32, 0.470, 0.895);           // foot indices (toes)
  return B;
}

/** Scripted punches. Times in seconds; a jab+cross pair lands as a combo. */
const SCRIPT = [
  { t: 0.80, hand: 'right', type: 'cross', quality: 'clean' },
  { t: 1.90, hand: 'left', type: 'jab', quality: 'clean' },
  { t: 2.25, hand: 'right', type: 'cross', quality: 'over' },
  { t: 3.50, hand: 'right', type: 'cross', quality: 'clean' },
  { t: 4.70, hand: 'left', type: 'jab', quality: 'clean' },
  { t: 5.05, hand: 'right', type: 'cross', quality: 'over' },
  { t: 6.30, hand: 'left', type: 'hook', quality: 'clean' },     // lead hook
  { t: 7.20, hand: 'right', type: 'hook', quality: 'clean' },    // rear hook
  { t: 8.10, hand: 'right', type: 'uppercut', quality: 'clean' }, // rear uppercut
];

const IDX = {
  right: { wrist: 16, elbow: 14, shoulder: 12, hand: [18, 20, 22], heel: 30, ankle: 28 },
  left: { wrist: 15, elbow: 13, shoulder: 11, hand: [17, 19, 21], heel: 29, ankle: 27 },
};
// Landmarks that ride the forward lunge: the whole upper body incl. both arms and
// hands (the body carries the arm forward; the punch extension is added ON TOP of
// this for the punching side). Only the planted feet/ankles stay put. Omitting the
// wrists here would make the surging shoulder mask the arm's real extension.
const LUNGE_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];

function applyPunch(pose, p, t) {
  const D = p.quality === 'over' ? 0.44 : 0.36;
  const impact = D * 0.42;
  const local = t - p.t;
  if (local <= 0 || local > D + 0.7) return;

  const extAt = (tt) => {
    if (tt <= 0 || tt >= D) return 0;
    if (tt <= impact) return Math.pow(tt / impact, 0.8);
    return Math.max(0, 1 - (tt - impact) / (D - impact));
  };
  const wristExt = extAt(local);
  const shExt = extAt(local + 0.015);
  const hipExt = extAt(local + 0.03);      // hip leads → proximal-to-distal sequence
  const over = p.quality === 'over';

  // Forward lunge (drives CoM). Clean stays inside the base; over crosses the lead
  // foot. A lingering residual after impact models "falling in" (poor recovery).
  const dyn = (over ? 0.090 : 0.030) * hipExt;
  const resid = over
    ? 0.055 * clamp01((local - impact) / 0.10) * Math.exp(-Math.max(0, local - D) / 0.7)
    : 0;
  const fwd = dyn + resid;
  for (const i of LUNGE_IDS) pose[i].x += fwd;

  const S = IDX[p.hand];
  // Per-shape wrist + elbow deltas (image units, at full extension). Sign of the y
  // term: negative = upward. The straight raises the elbow toward the shoulder–wrist
  // line so the arm OPENS; the hook and uppercut keep the elbow low so it stays BENT.
  let wDX, wDY, eDX, eDY, shRot;
  if (p.type === 'jab' || p.type === 'cross') {
    const reach = p.type === 'jab' ? 0.11 : 0.16;
    wDX = reach; wDY = -0.02; eDX = reach * 0.5; eDY = -0.10; shRot = 0.05;
  } else if (p.type === 'hook') {
    wDX = 0.13; wDY = -0.02; eDX = 0.045; eDY = -0.03; shRot = 0.06; // horizontal arc, bent
  } else { // uppercut
    wDX = 0.03; wDY = -0.13; eDX = 0.02; eDY = -0.05; shRot = 0.04; // vertical drive, bent
  }
  pose[S.wrist].x += wDX * wristExt; pose[S.wrist].y += wDY * wristExt;
  pose[S.elbow].x += eDX * wristExt; pose[S.elbow].y += eDY * wristExt;
  for (const h of S.hand) { pose[h].x += wDX * wristExt; pose[h].y += wDY * wristExt; }
  pose[S.shoulder].x += shRot * shExt;
  pose[S.heel].y -= 0.015 * wristExt; pose[S.ankle].y -= 0.008 * wristExt; // rear pivot

  // Overcommitted reps also drop the non-punching (guard) hand. Kept small/slow so
  // it reads as a guard fault, not a second punch — a sag, not a strike.
  if (over) {
    const G = IDX[p.hand === 'right' ? 'left' : 'right'];
    pose[G.wrist].y += 0.038 * wristExt;
    for (const h of G.hand) pose[h].y += 0.038 * wristExt;
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Generate a full synthetic track.
 * @param {{fps?:number, duration?:number, seed?:number, noise?:number}} opts
 * @returns {{tSec:number, lm:{x:number,y:number,visibility:number}[]}[]}
 */
export function generateSyntheticTrack({ fps = 120, duration = 9.0, seed = 7, noise = 0.0016 } = {}) {
  const rand = rng(seed);
  const gauss = () => (rand() + rand() + rand() - 1.5) * 2; // ~N(0,1)-ish
  const nFrames = Math.round(fps * duration);
  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const tSec = f / fps;
    const pose = makeBase().map((p) => ({ ...p }));
    for (const punch of SCRIPT) applyPunch(pose, punch, tSec);
    // Sensor jitter so the smoothing stage has something to do.
    for (const p of pose) { p.x += gauss() * noise; p.y += gauss() * noise; }
    frames.push({ tSec, lm: pose });
  }
  return frames;
}

/** The ground-truth script, exposed so the demo can show detection precision/recall. */
export const SYNTHETIC_SCRIPT = SCRIPT;
