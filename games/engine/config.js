// config.js — single source of truth for all tunable parameters and biomechanical
// constants. The app AND the backend panel both import this, so documentation can
// never drift from behavior. Every threshold is expressed in SCALE-NORMALIZED units
// (multiples of shoulder width, or seconds) so values survive a change in camera
// distance between sessions — see README §"Why normalized".

/**
 * de Leva (1996) adjusted anthropometric parameters (Zatsiorsky–Seluyanov model).
 * mass  = segment mass as a fraction of total body mass.
 * com   = longitudinal position of the segment center of mass, as a fraction from
 *         the PROXIMAL endpoint toward the DISTAL endpoint.
 * Values are the adjusted male set from de Leva, J. Biomech. 29(9):1223-1230, 1996.
 * The eight bilateral limb segments are counted twice (left+right) → masses sum to 1.
 */
export const DE_LEVA = {
  head:     { mass: 0.0694, com: 0.500 }, // placed at the mid-ear point (see biomech.js)
  trunk:    { mass: 0.4346, com: 0.440 }, // mid-shoulder (proximal) → mid-hip (distal)
  upperArm: { mass: 0.0271, com: 0.5772 }, // shoulder → elbow
  forearm:  { mass: 0.0162, com: 0.4574 }, // elbow → wrist
  hand:     { mass: 0.0061, com: 0.7900 }, // wrist → index-finger MCP
  thigh:    { mass: 0.1416, com: 0.4095 }, // hip → knee
  shank:    { mass: 0.0433, com: 0.4459 }, // knee → ankle
  foot:     { mass: 0.0137, com: 0.4415 }, // heel → foot-index (toe)
};

// Sanity: head + trunk + 2*(upperArm+forearm+hand+thigh+shank+foot) === 1.0
// 0.0694 + 0.4346 + 2*(0.0271+0.0162+0.0061+0.1416+0.0433+0.0137) = 1.0000

/** MediaPipe Pose (BlazePose) 33-landmark indices. */
export const LM = {
  NOSE: 0,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT: 31, RIGHT_FOOT: 32,
};

/** Skeleton bone pairs for the overlay (index into LM values). */
export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],       // shoulders + arms
  [11, 23], [12, 24], [23, 24],                            // torso
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],        // left leg + foot
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],        // right leg + foot
];

/**
 * Tunable pipeline configuration. Grouped by pipeline stage. The backend panel
 * renders this object verbatim, so each value carries a `doc` sibling explaining
 * what it means in real-world terms and how it was chosen.
 */
export const CONFIG = {
  smoothing: {
    // One-euro filter (Casiez et al. 2012) applied to every landmark coordinate
    // before any velocity is computed. Low minCutoff kills jitter at rest; beta
    // lets the cutoff rise during fast motion so punches aren't smeared.
    minCutoff: 1.7,   // Hz — baseline low-pass cutoff at low speed
    beta: 0.9,        // speed coefficient — higher = less lag on fast motion
    dCutoff: 1.0,     // Hz — cutoff for the derivative used to drive beta
  },

  detect: {
    // Punch = a wrist-speed peak (scale-normalized) coincident with arm extension.
    // Units: shoulder-widths per second (SW/s). A jab tip reaches roughly
    // 8–14 SW/s on clean 60fps+ footage; the floor sits well below that.
    speedPeakThreshold: 4.0,     // SW/s — minimum peak speed to be a punch candidate
    minExcursionSW: 0.28,        // wrist must travel this far from guard (SW) to be a punch.
                                 //   Generalizes "arm extension": a straight extends radially,
                                 //   a hook swings laterally, an uppercut drives upward — all
                                 //   are large excursions of the wrist from its guard position.
    homeCutoffHz: 0.8,           // low-pass cutoff that tracks the resting "guard" wrist position
    minPeakSeparationMs: 180,    // reject double-counting one punch as two peaks
    elbowExtensionMinDeg: 130,   // straights open the elbow past this; hooks/uppercuts stay bent
    uppercutRiseSW: 0.35,        // upward wrist travel (SW) that marks an uppercut
    hookTravelSW: 0.35,          // horizontal wrist travel (SW) with a bent elbow that marks a hook
    retractSpeedFraction: 0.25,  // retraction end = speed falls back below 25% of peak
    windowPadMs: 120,            // context padding kept around each clipped event
  },

  combo: {
    maxGapMs: 500,   // consecutive punches within this gap group into one combo
  },

  defense: {
    // Defensive transitions, driven by head (nose) motion, in shoulder-widths.
    slipLateralMin: 0.35,   // SW of horizontal nose travel with feet planted → slip
    rollVerticalMin: 0.30,  // SW of downward nose dip → roll/duck
    pullBackMin: 0.30,      // SW of backward nose travel + CoM retreat → pull
  },

  scoring: {
    // Provisional reference bands. THESE ARE PLACEHOLDERS until a coach-derived
    // distribution replaces them (doc §6b). Each band is [ideal, tolerance]:
    // deviation beyond `tolerance` scores 0, at `ideal` scores 100, linear between.
    // The mechanism (DTW align → per-dimension deviation) is final; only the
    // numbers here are provisional.
    balance: {
      // Peak stability margin during the punch, normalized by shoulder width.
      // Negative = CoM stayed inside base of support (good). Positive = CoM
      // crossed past the lead foot (overcommitted).
      ideal: -0.05, tolerance: 0.25, higherIsBetter: false,
    },
    recovery: {
      // Residual CoM_x offset from neutral after retraction, |SW|. 0 = fully
      // recovered to a balanced stance; large = fell in / hung over lead foot.
      ideal: 0.0, tolerance: 0.30, higherIsBetter: false,
    },
    kineticChain: {
      // Fraction of the proximal→distal ordering (hip→shoulder→wrist peak times)
      // that fired in the correct sequence, weighted by plausible inter-segment
      // delay. 1.0 = textbook hip-leads-shoulder-leads-hand.
      ideal: 1.0, tolerance: 0.6, higherIsBetter: true,
    },
    guard: {
      // Lowest position of the NON-punching hand during the punch, measured as
      // drop below the chin line in shoulder-widths. 0 = hand stayed at guard.
      ideal: 0.0, tolerance: 0.45, higherIsBetter: false,
    },
    retraction: {
      // Time from impact back to guard, seconds. Faster return = safer.
      ideal: 0.12, tolerance: 0.35, higherIsBetter: false,
    },
  },

  capture: {
    // Not thresholds — capture guidance surfaced in the UI so bad footage is
    // caught before analysis rather than after.
    minFps: 60,
    idealFps: 120,
    minShutterHint: '1/500s',
  },
};

/** dataviz palette tokens (light/dark handled in CSS; these are for canvas/SVG JS). */
export const PALETTE = {
  series: ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'],
  good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b',
};
