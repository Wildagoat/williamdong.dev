// punch-trainer.js — UI + real-time control for the CV Punch Trainer. Two input
// paths (live webcam, or a no-camera synthetic demo) feed the SAME streaming
// analyzer (LiveTrainer) and the same HUD. All heavy lifting lives in engine/.

import { LiveTrainer } from './engine/live.js';
import { drawPose } from './engine/overlay.js';
import { generateSyntheticTrack } from './engine/synth.js';
import { initPose } from './engine/pose.js';
import { PALETTE, CONFIG } from './engine/config.js';

const $ = (id) => document.getElementById(id);
const dom = {
  stage: $('stage'), video: $('video'), canvas: $('overlay'), ctx: $('overlay').getContext('2d'),
  stageEmpty: $('stageEmpty'), status: $('status'),
  liveChips: $('liveChips'), chipBalance: $('chipBalance'), chipGuard: $('chipGuard'), chipFps: $('chipFps'),
  scoreFlash: $('scoreFlash'), sfType: $('sfType'), sfScore: $('sfScore'),
  ringFg: $('ringFg'), ringScore: $('ringScore'), lastType: $('lastType'), dims: $('dims'), notes: $('notes'),
  stPunches: $('stPunches'), stAvg: $('stAvg'), stBest: $('stBest'), stCombo: $('stCombo'),
  feed: $('feed'), camBtn: $('camBtn'), demoBtn: $('demoBtn'), resetBtn: $('resetBtn'),
  dbg: $('dbgReadout'), dbgChk: $('dbgChk'),
};

const RING_C = 2 * Math.PI * 52; // circumference of the score ring
const DIM_LABELS = {
  balance: 'Balance', recovery: 'Recovery', kineticChain: 'Kinetic chain',
  guard: 'Guard', retraction: 'Retraction',
};

const setStatus = (s, rec = false) => { dom.status.textContent = s; dom.status.classList.toggle('rec', rec); };
const scoreColor = (s) =>
  s >= 85 ? PALETTE.good : s >= 70 ? PALETTE.warning : s >= 55 ? PALETTE.serious : PALETTE.critical;

// --- Shared state ------------------------------------------------------------
const state = {
  mode: null,            // 'live' | 'demo' | null
  stance: 'orthodox',
  running: false,
  debug: false,
  stopCamera: null,      // () => void, releases the webcam
  raf: 0,
  fpsEMA: 0, lastFrameT: 0,
  flashTimer: 0,
};

let trainer = makeTrainer();
function makeTrainer() {
  return new LiveTrainer({ stance: state.stance, onPunch });
}

// --- Canvas sizing + letterbox rect (matches object-fit: contain) ------------
function resizeCanvas() {
  const r = dom.stage.getBoundingClientRect();
  dom.canvas.width = Math.round(r.width);
  dom.canvas.height = Math.round(r.height);
}
function contentRect() {
  const W = dom.canvas.width, H = dom.canvas.height;
  const vw = dom.video.videoWidth, vh = dom.video.videoHeight;
  if (dom.video.hidden || !vw || !vh) return { ox: 0, oy: 0, w: W, h: H };
  const va = vw / vh, sa = W / H;
  if (va > sa) { const h = W / va; return { ox: 0, oy: (H - h) / 2, w: W, h }; }
  const w = H * va; return { ox: (W - w) / 2, oy: 0, w, h: H };
}
window.addEventListener('resize', resizeCanvas);

// --- One frame: analyze + draw + live chips ----------------------------------
function handleFrame(tSec, lm, mirror) {
  // Feed the analyzer, and draw its display-smoothed landmarks (dlm): steady at rest so
  // the skeleton doesn't twitch, but lightly filtered so it doesn't trail the body like
  // the heavier detection smoothing did. Mirror x to match the CSS-mirrored camera feed.
  const { dlm } = trainer.push(tSec, lm);
  const rect = contentRect();
  const drawLm = mirror ? dlm.map((p) => ({ ...p, x: 1 - p.x })) : dlm;
  drawPose(dom.ctx, drawLm, { rect, showCoM: true, showBoS: true });
  updateLiveChips(tSec);
}

function updateLiveChips(tSec) {
  const f = trainer.feats[trainer.feats.length - 1];
  if (!f) return;
  // Balance: is the center of mass still inside the base of support?
  const committed = f.stability > 0.02;
  dom.chipBalance.textContent = committed ? 'balance · committed' : 'balance · in base';
  dom.chipBalance.className = 'chip ' + (committed ? 'bad' : 'good');
  // Guard: has either hand dropped well below the chin line?
  const drop = Math.max(f.guardDrop.left, f.guardDrop.right);
  const guardDown = drop > 0.5;
  dom.chipGuard.textContent = guardDown ? 'guard · dropped' : 'guard · up';
  dom.chipGuard.className = 'chip ' + (guardDown ? 'bad' : 'good');
  // FPS (smoothed)
  if (state.lastFrameT) {
    const inst = 1 / Math.max(1e-3, tSec - state.lastFrameT);
    state.fpsEMA = state.fpsEMA ? state.fpsEMA * 0.9 + inst * 0.1 : inst;
    dom.chipFps.textContent = `${Math.round(state.fpsEMA)} fps`;
  }
  state.lastFrameT = tSec;

  if (state.debug) updateDebug();
}

// Live diagnostics: shows the exact numbers detection sees so a miss can be explained
// (e.g. "my jab only hits 2.5 SW/s" → below the 4.0 threshold). Lead/rear are resolved
// from the current stance.
function updateDebug() {
  const L = trainer.live;
  const spThr = CONFIG.detect.speedPeakThreshold;
  const excThr = CONFIG.detect.minExcursionSW;
  const ortho = state.stance === 'orthodox';
  const leadSpeed = ortho ? L.speedL : L.speedR, rearSpeed = ortho ? L.speedR : L.speedL;
  const leadExc = ortho ? L.excL : L.excR, rearExc = ortho ? L.excR : L.excL;
  const leadElbow = ortho ? L.elbowL : L.elbowR, rearElbow = ortho ? L.elbowR : L.elbowL;
  const hs = (v) => (v > spThr ? ' hot' : '');
  const he = (v) => (v > excThr ? ' hot' : '');
  const deg = (v) => (Number.isFinite(v) ? Math.round(v) + '°' : '–');
  dom.dbg.innerHTML =
    `<span>speed 3D</span> lead <b class="v${hs(leadSpeed)}">${leadSpeed.toFixed(1)}</b> · ` +
    `rear <b class="v${hs(rearSpeed)}">${rearSpeed.toFixed(1)}</b> <span>SW/s ≥ ${spThr.toFixed(1)}</span> &nbsp; ` +
    `<span>reach</span> lead <b class="v${he(leadExc)}">${leadExc.toFixed(2)}</b> · ` +
    `rear <b class="v${he(rearExc)}">${rearExc.toFixed(2)}</b> <span>SW ≥ ${excThr.toFixed(2)}</span> &nbsp; ` +
    `<span>elbow</span> lead <b class="v">${deg(leadElbow)}</b> · rear <b class="v">${deg(rearElbow)}</b> ` +
    `<span>straight ≥ ${CONFIG.detect.elbowExtensionMinDeg}°</span>`;
}

// --- Per-punch: the money moment ---------------------------------------------
function onPunch(ev, score) {
  const overall = Number.isFinite(score.overall) ? Math.round(score.overall) : 0;
  const col = scoreColor(overall);

  // Score ring
  dom.ringScore.textContent = overall;
  dom.ringScore.style.color = col;
  dom.ringFg.style.stroke = col;
  dom.ringFg.style.strokeDashoffset = String(RING_C * (1 - overall / 100));
  dom.lastType.textContent = ev.type.toUpperCase();

  // Dimension bars
  dom.dims.innerHTML = Object.entries(score.dims).map(([k, d]) => {
    if (!Number.isFinite(d.score)) {
      return `<div class="dim na"><span class="dname">${DIM_LABELS[k]}</span>` +
        `<span class="bar"></span><span class="dval">N/A</span></div>`;
    }
    const v = Math.round(d.score);
    return `<div class="dim"><span class="dname">${DIM_LABELS[k]}</span>` +
      `<span class="bar"><span style="width:${v}%;background:${scoreColor(v)}"></span></span>` +
      `<span class="dval" style="color:${scoreColor(v)}">${v}</span></div>`;
  }).join('');

  // Coaching notes
  const clean = score.notes.length === 1 && /^Clean/.test(score.notes[0]);
  dom.notes.innerHTML = '<ul>' + score.notes
    .map((n) => `<li class="${clean ? 'clean' : ''}">${n}</li>`).join('') + '</ul>';

  // Big flash
  dom.sfType.textContent = ev.type.toUpperCase();
  dom.sfScore.textContent = overall;
  dom.sfScore.style.color = col;
  dom.scoreFlash.hidden = false;
  dom.scoreFlash.style.animation = 'none';
  void dom.scoreFlash.offsetWidth; // reflow to restart the animation
  dom.scoreFlash.style.animation = '';
  clearTimeout(state.flashTimer);
  state.flashTimer = setTimeout(() => { dom.scoreFlash.hidden = true; }, 1500);

  // Feed row
  if (trainer.stats.count === 1) dom.feed.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'feed-row';
  row.innerHTML =
    `<span class="fr-type" style="color:${col}">${ev.type.toUpperCase()}</span>` +
    `<span class="fr-meta">${ev.hand} · ${ev.peakSpeed.toFixed(1)} SW/s</span>` +
    `<span class="fr-score" style="color:${col}">${overall}</span>`;
  dom.feed.prepend(row);
  while (dom.feed.children.length > 30) dom.feed.lastChild.remove();

  // Session tiles
  const s = trainer.stats;
  dom.stPunches.textContent = s.count;
  dom.stAvg.textContent = Number.isFinite(s.avg) ? Math.round(s.avg) : '·';
  dom.stBest.textContent = s.best ? Math.round(s.best) : '·';
  dom.stCombo.textContent = s.bestCombo;
}

// --- Camera path -------------------------------------------------------------
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('This browser can’t access a camera here. Try “Run demo” instead.');
    return;
  }
  stopEverything();
  state.mode = 'live';
  dom.stage.classList.add('mirror');
  setStatus('Loading pose model…');
  let lmk;
  try {
    lmk = await initPose(setStatus);
  } catch (err) {
    console.error(err);
    setStatus('Couldn’t start the pose engine (' + err.message + '). Try Chrome or Edge, or use “Run demo”.');
    dom.stage.classList.remove('mirror');
    return;
  }
  let stream;
  try {
    setStatus('Requesting camera…');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false,
    });
  } catch (err) {
    console.error(err);
    setStatus('Camera permission denied or unavailable. “Run demo” still works: ' + err.message);
    dom.stage.classList.remove('mirror');
    return;
  }

  dom.video.srcObject = stream;
  dom.video.hidden = false;
  dom.stageEmpty.style.display = 'none';
  dom.liveChips.hidden = false;
  await dom.video.play();
  resizeCanvas();

  trainer = makeTrainer();
  resetHud();
  setCamButtons(true);
  setStatus('● Live. Throw straight punches side-on. Video stays on your device.', true);

  state.running = true;
  const t0 = performance.now();
  let lastTs = -1;
  const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const loop = () => {
    if (!state.running) return;
    const tSec = (performance.now() - t0) / 1000;
    const tsMs = Math.max(lastTs + 1, Math.round(tSec * 1000));
    lastTs = tsMs;
    try {
      const res = lmk.detectForVideo(dom.video, tsMs);
      if (res.landmarks && res.landmarks[0]) {
        handleFrame(tSec, res.landmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })), true);
      }
    } catch (e) { /* skip a bad frame */ }
    if (useRVFC) dom.video.requestVideoFrameCallback(loop);
    else state.raf = requestAnimationFrame(loop);
  };
  if (useRVFC) dom.video.requestVideoFrameCallback(loop);
  else state.raf = requestAnimationFrame(loop);

  state.stopCamera = () => {
    stream.getTracks().forEach((t) => t.stop());
    dom.video.srcObject = null;
    dom.video.hidden = true;
    dom.stage.classList.remove('mirror');
  };
}

// --- Demo path (no camera) ---------------------------------------------------
function startDemo() {
  stopEverything();
  state.mode = 'demo';
  dom.video.hidden = true;
  dom.stageEmpty.style.display = 'none';
  dom.liveChips.hidden = false;
  dom.stage.classList.remove('mirror');
  resizeCanvas();

  trainer = makeTrainer();
  resetHud();
  setStatus('Demo: a scripted side-on boxer (jabs, crosses, hooks, uppercuts) streamed in real time.');
  setDemoButton(true);

  const frames = generateSyntheticTrack();           // 9 s @120 fps
  const duration = frames[frames.length - 1].tSec;
  let cursor = 0, base = 0, lastDraw = null;
  const t0 = performance.now();
  state.running = true;

  const loop = () => {
    if (!state.running) return;
    const wall = (performance.now() - t0) / 1000;
    while (cursor < frames.length && base + frames[cursor].tSec <= wall) {
      const fr = frames[cursor++];
      const { dlm } = trainer.push(base + fr.tSec, fr.lm);
      lastDraw = dlm;
    }
    if (cursor >= frames.length) { base += duration; cursor = 0; } // seamless loop, monotonic time
    if (lastDraw) {
      drawPose(dom.ctx, lastDraw, { rect: contentRect(), showCoM: true, showBoS: true });
      updateLiveChips(base + (frames[Math.max(0, cursor - 1)]?.tSec ?? 0));
    }
    state.raf = requestAnimationFrame(loop);
  };
  state.raf = requestAnimationFrame(loop);
}

// --- Lifecycle ---------------------------------------------------------------
function stopEverything() {
  state.running = false;
  cancelAnimationFrame(state.raf);
  if (state.stopCamera) { try { state.stopCamera(); } catch (e) {} state.stopCamera = null; }
  state.lastFrameT = 0; state.fpsEMA = 0;
  setCamButtons(false); setDemoButton(false);
}

function resetHud() {
  dom.ringScore.textContent = '·'; dom.ringScore.style.color = '';
  dom.ringFg.style.strokeDashoffset = String(RING_C); dom.ringFg.style.stroke = 'var(--muted)';
  dom.lastType.textContent = '·';
  dom.dims.innerHTML = '';
  dom.notes.innerHTML = 'Your per-punch coaching feedback will appear here.';
  dom.feed.innerHTML = '<div class="feed-empty">No punches yet.</div>';
  dom.stPunches.textContent = '0'; dom.stAvg.textContent = '·';
  dom.stBest.textContent = '·'; dom.stCombo.textContent = '0';
  dom.scoreFlash.hidden = true;
}

function setCamButtons(on) {
  for (const b of [dom.camBtn, $('camBtn2')]) {
    if (!b) continue;
    b.textContent = on ? 'Stop camera' : (b.id === 'camBtn2' ? 'Start camera' : 'Start camera');
    b.classList.toggle('recording', on);
  }
}
function setDemoButton(on) {
  for (const b of [dom.demoBtn, $('demoBtn2')]) {
    if (!b) continue;
    b.textContent = on ? 'Stop demo' : (b.id === 'demoBtn2' ? 'No camera? Run the demo' : 'Run demo');
  }
}

// --- Wiring ------------------------------------------------------------------
function toggleCamera() { (state.mode === 'live' && state.running) ? stopEverything() : startCamera(); }
function toggleDemo() { (state.mode === 'demo' && state.running) ? stopEverything() : startDemo(); }

dom.camBtn.addEventListener('click', toggleCamera);
$('camBtn2')?.addEventListener('click', toggleCamera);
dom.demoBtn.addEventListener('click', toggleDemo);
$('demoBtn2')?.addEventListener('click', toggleDemo);
dom.resetBtn.addEventListener('click', () => { trainer = makeTrainer(); resetHud(); });

dom.dbgChk.addEventListener('change', () => {
  state.debug = dom.dbgChk.checked;
  dom.dbg.hidden = !state.debug;
  if (!state.debug) dom.dbg.innerHTML = '';
});

document.querySelectorAll('#stanceSeg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#stanceSeg button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.stance = b.dataset.stance;
  trainer.setStance(state.stance);
}));

resizeCanvas();
