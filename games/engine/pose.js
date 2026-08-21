// pose.js — MediaPipe Pose Landmarker wrapper (BlazePose, 33 landmarks incl. heel +
// foot index — doc §3 Tier 1). Loaded from CDN; the app runs from a static server so
// external scripts are fine here (unlike a sandboxed artifact). Falls back gracefully
// if the model can't load, so demo mode still works offline.

const TASKS_VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

let landmarker = null;

/** Lazily create the PoseLandmarker in VIDEO mode. */
export async function initPose(onStatus = () => {}) {
  if (landmarker) return landmarker;
  onStatus('Loading MediaPipe runtime…');
  const vision = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
  const { FilesetResolver, PoseLandmarker } = vision;
  const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  onStatus('Loading pose model…');
  landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  onStatus('');
  return landmarker;
}

/**
 * Process a loaded <video> element end-to-end, sampling every rendered frame via
 * requestVideoFrameCallback for accurate per-frame timestamps. Returns the raw track.
 * @param {HTMLVideoElement} video
 * @param {(p:number)=>void} onProgress 0..1
 * @returns {Promise<{tSec:number, lm:{x:number,y:number,visibility:number}[]}[]>}
 */
export async function processVideo(video, onProgress = () => {}) {
  const lmk = await initPose();
  const frames = [];
  const duration = video.duration;

  await new Promise((resolve, reject) => {
    let lastTs = -1;
    const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

    const onFrame = (now, meta) => {
      const tSec = meta ? meta.mediaTime : video.currentTime;
      const tsMs = Math.max(lastTs + 1, Math.round(tSec * 1000)); // strictly increasing
      lastTs = tsMs;
      try {
        const res = lmk.detectForVideo(video, tsMs);
        if (res.landmarks && res.landmarks[0]) {
          frames.push({ tSec, lm: res.landmarks[0].map((p) => ({ x: p.x, y: p.y, visibility: p.visibility })) });
        }
      } catch (e) { /* skip bad frame */ }
      onProgress(duration ? Math.min(1, tSec / duration) : 0);
      if (video.ended || video.paused) return resolve(frames);
      if (useRVFC) video.requestVideoFrameCallback(onFrame);
    };

    video.addEventListener('ended', () => resolve(frames), { once: true });
    video.addEventListener('error', () => reject(new Error('Video decode error')), { once: true });
    video.muted = true;
    video.play().then(() => {
      if (useRVFC) video.requestVideoFrameCallback(onFrame);
      else {
        const iv = setInterval(() => {
          if (video.ended || video.paused) { clearInterval(iv); return resolve(frames); }
          onFrame(performance.now(), null);
        }, 1000 / 30);
      }
    }).catch(reject);
  });

  return frames;
}

/** Pick a MediaRecorder mime type the browser supports, or '' if none / unsupported. */
function pickRecMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ } }
  return '';
}

/**
 * Live webcam capture. Streams the camera into `video`, runs pose per rendered frame,
 * and calls onFrame(tSec, landmarks) in real time (draw the overlay there). It also
 * RECORDS the stream so the take can be reviewed as seekable footage afterwards (a
 * live MediaStream isn't seekable). localhost is a secure context, so getUserMedia
 * works from the dev server.
 * @param {HTMLVideoElement} video
 * @param {(tSec:number, lm:{x:number,y:number,visibility:number}[])=>void} onFrame
 * @param {(s:string)=>void} onStatus
 * @returns {Promise<() => Promise<Blob|null>>} stop(): stops capture, releases the
 *   camera, and resolves to the recorded video Blob (or null if recording is
 *   unsupported).
 */
export async function startLiveCapture(video, onFrame, onStatus = () => {}) {
  const lmk = await initPose(onStatus);
  onStatus('Requesting camera…');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  // Record the raw stream (same frames MediaPipe sees, so the overlay aligns).
  const chunks = [];
  let recorder = null;
  const mime = pickRecMime();
  if (mime !== null) {
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start();
    } catch (e) { recorder = null; }
  }

  let running = true;
  const t0 = performance.now();
  let lastTs = -1;
  const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  const loop = () => {
    if (!running) return;
    const tSec = (performance.now() - t0) / 1000;
    const tsMs = Math.max(lastTs + 1, Math.round(tSec * 1000));
    lastTs = tsMs;
    try {
      const res = lmk.detectForVideo(video, tsMs);
      if (res.landmarks && res.landmarks[0]) {
        onFrame(tSec, res.landmarks[0].map((p) => ({ x: p.x, y: p.y, visibility: p.visibility })));
      }
    } catch (e) { /* skip frame */ }
    if (useRVFC) video.requestVideoFrameCallback(loop);
    else setTimeout(loop, 1000 / 30);
  };
  if (useRVFC) video.requestVideoFrameCallback(loop);
  else setTimeout(loop, 1000 / 30);

  return () => new Promise((resolve) => {
    running = false;
    const finish = () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      resolve(chunks.length ? new Blob(chunks, { type: chunks[0].type || 'video/webm' }) : null);
    };
    if (recorder && recorder.state !== 'inactive') { recorder.onstop = finish; recorder.stop(); }
    else finish();
  });
}
