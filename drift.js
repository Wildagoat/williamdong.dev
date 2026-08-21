/* drift.js — the cursor becomes a drift AE86 that drives the real page.
   Self-contained, drop-in: injects its own styles + DOM, uses the site's
   design tokens (var(--panel) etc.), and runs entirely on vanilla canvas.

   Controls:  W/A/S/D or arrows = drive/steer · Shift = handbrake · E = actuate
   the element under the nose · Esc = exit · G = toggle. Push the car into the
   top/bottom edge to scroll. Desktop only (keyboard + fine pointer).

   Ported from the drift-cursor prototype (Workflow dev\drift-cursor). */
(() => {
  "use strict";

  // Only makes sense with a mouse + keyboard. Bail on touch / coarse pointers.
  if (!window.matchMedia || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  // ---------- inject styles ----------
  const style = document.createElement("style");
  style.id = "drift-style";
  style.textContent = `
    body.drift-driving, body.drift-driving * { cursor: none !important; }
    body.drift-driving { user-select: none; }
    #drift-car, #drift-trail {
      position: fixed; inset: 0; width: 100vw; height: 100vh;
      pointer-events: none; z-index: 2147482000;
    }
    #drift-trail { z-index: 2147481999; }
    #drift-prompt {
      position: fixed; z-index: 2147483001; pointer-events: none;
      background: var(--text, #f3f3f5); color: var(--bg, #0b0b0c);
      font: 700 11px/1 var(--mono, ui-monospace, monospace); letter-spacing: .03em;
      padding: 5px 8px; border-radius: 7px; transform: translate(-50%, -150%);
      white-space: nowrap; opacity: 0; transition: opacity .1s ease;
      box-shadow: 0 6px 18px rgba(0,0,0,.4);
    }
    #drift-prompt.on { opacity: 1; }
    #drift-toggle {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
      display: inline-flex; align-items: center; gap: 8px;
      background: color-mix(in srgb, var(--panel, #131315) 86%, transparent);
      border: 1px solid var(--line-2, #34343a); color: var(--text, #f3f3f5);
      font: 600 12.5px var(--sans, system-ui); letter-spacing: .01em;
      padding: 9px 15px; border-radius: 999px; cursor: pointer;
      backdrop-filter: blur(8px); box-shadow: 0 8px 24px rgba(0,0,0,.35);
      transition: border-color .15s ease, color .15s ease;
    }
    #drift-toggle:hover { border-color: var(--muted, #8a8a93); }
    #drift-toggle .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted, #8a8a93); transition: background .15s ease; }
    #drift-toggle.on { border-color: var(--text, #f3f3f5); }
    #drift-toggle.on .dot { background: var(--text, #f3f3f5); }
    #drift-hud {
      position: fixed; left: 18px; bottom: 18px; z-index: 2147483000;
      background: color-mix(in srgb, var(--panel, #131315) 90%, transparent);
      border: 1px solid var(--line, #262629); border-radius: 12px;
      padding: 11px 13px; min-width: 208px;
      font: 400 11.5px var(--sans, system-ui); color: var(--muted, #8a8a93);
      backdrop-filter: blur(8px);
      opacity: 0; transform: translateY(8px); pointer-events: none;
      transition: opacity .18s ease, transform .18s ease;
    }
    #drift-hud.on { opacity: 1; transform: translateY(0); }
    #drift-hud .t { color: var(--text-2, #c7c7cd); font-family: var(--mono, monospace); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 9px; }
    #drift-hud .r { display: flex; justify-content: space-between; gap: 16px; margin: 5px 0; }
    #drift-hud .k { font-family: var(--mono, monospace); color: var(--text, #f3f3f5); background: var(--panel-2, #1b1b1e); border: 1px solid var(--line-2, #34343a); border-radius: 5px; padding: 1px 6px; font-size: 10.5px; }
    .drift-hover { outline: 2px solid var(--text, #f3f3f5) !important; outline-offset: 3px; border-radius: 8px; }
  `;
  document.head.appendChild(style);

  // ---------- build DOM ----------
  const mk = (tag, id, html) => { const e = document.createElement(tag); if (id) e.id = id; if (html != null) e.innerHTML = html; return e; };
  const trailCanvas = mk("canvas", "drift-trail");
  const carCanvas   = mk("canvas", "drift-car");
  const promptEl    = mk("div", "drift-prompt", "press <b>E</b>");
  const toggleBtn   = mk("button", "drift-toggle", '<span class="dot"></span><span class="lbl">drive</span>');
  const hud         = mk("div", "drift-hud",
    '<div class="t">drift mode</div>' +
    '<div class="r"><span class="k">W A S D</span><span>drive / steer</span></div>' +
    '<div class="r"><span><span class="k">&#8679;</span> shift</span><span>handbrake</span></div>' +
    '<div class="r"><span class="k">E</span><span>open / actuate</span></div>' +
    '<div class="r"><span class="k">Esc</span><span>exit</span></div>');
  document.body.append(trailCanvas, carCanvas, promptEl, toggleBtn, hud);

  const cx = carCanvas.getContext("2d");
  const tx = trailCanvas.getContext("2d");
  const toggleLabel = toggleBtn.querySelector(".lbl");

  const INTERACTABLE = 'a[href], button, input, textarea, select, [role="button"], [tabindex]:not([tabindex="-1"])';

  // ---------- tunables (feel) ----------
  const TUNE = {
    engine:      0.24,
    reverse:     0.16,
    drag:        0.950,
    gripNormal:  0.80,
    gripDrift:   0.955,
    turnRate:    0.050,
    turnDrift:   0.068,
    turnSpeedRef: 2.4,
    maxSteerLag: 0.14,
    scrollMargin: 130,
    scrollMax:   15,
    carLen:      44,
    carWid:      18,
  };

  // ---------- state ----------
  const car = { x: innerWidth/2, y: innerHeight/2, angle: -Math.PI/2, vx: 0, vy: 0 };
  let driving = false;
  let steer = 0;
  const keys = new Set();
  const skids = [];
  const smoke = [];
  const brakeTrail = [];         // {lx,ly,rx,ry,life,start} — red brake-light streaks
  let braking = false;
  let brakeContiguous = false;
  let currentTarget = null;
  let lastMouse = { x: innerWidth/2, y: innerHeight/2 };
  let lastT = performance.now();

  // ---------- canvas sizing ----------
  function sizeCanvas(c, ctx) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    c.width  = Math.floor(innerWidth  * dpr);
    c.height = Math.floor(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function sizeAll() { sizeCanvas(carCanvas, cx); sizeCanvas(trailCanvas, tx); }
  sizeAll();
  addEventListener("resize", sizeAll);

  addEventListener("mousemove", (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; });

  // ---------- drive mode ----------
  function enterDrive() {
    driving = true;
    car.x = lastMouse.x; car.y = lastMouse.y;
    car.vx = car.vy = 0; car.angle = -Math.PI/2;
    document.body.classList.add("drift-driving");
    toggleBtn.classList.add("on");
    toggleLabel.textContent = "driving";
    hud.classList.add("on");
  }
  function exitDrive() {
    driving = false;
    keys.clear(); steer = 0;
    document.body.classList.remove("drift-driving");
    toggleBtn.classList.remove("on");
    toggleLabel.textContent = "drive";
    hud.classList.remove("on");
    clearTarget();
  }
  function toggleDrive() { driving ? exitDrive() : enterDrive(); }
  toggleBtn.addEventListener("click", toggleDrive);

  // ---------- input ----------
  const DRIVE_KEYS = new Set(["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright","shift"," ","e"]);
  function isTyping() {
    const el = document.activeElement;
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }
  addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "g" && !isTyping()) { toggleDrive(); e.preventDefault(); return; }
    if (!driving) return;
    if (k === "escape") { exitDrive(); return; }
    if (DRIVE_KEYS.has(k)) {
      e.preventDefault();
      if (k === "e") { if (!keys.has("e")) actuate(); }
      keys.add(k);
    }
  });
  addEventListener("keyup", (e) => { keys.delete(e.key.toLowerCase()); });
  addEventListener("blur", () => keys.clear());
  const held = (...ks) => ks.some(k => keys.has(k));

  // ---------- interactable detection ----------
  function clearTarget() {
    if (currentTarget) currentTarget.classList.remove("drift-hover");
    currentTarget = null;
    promptEl.classList.remove("on");
  }
  function updateTarget() {
    const nx = car.x + Math.cos(car.angle) * (TUNE.carLen * 0.5);
    const ny = car.y + Math.sin(car.angle) * (TUNE.carLen * 0.5);
    const under = document.elementFromPoint(nx, ny);
    let target = null;
    if (under && !under.closest("#drift-toggle") && !under.closest("#drift-hud")) {
      target = under.closest(INTERACTABLE);
    }
    if (target !== currentTarget) {
      clearTarget();
      currentTarget = target;
      if (target) target.classList.add("drift-hover");
    }
    if (currentTarget) {
      promptEl.classList.add("on");
      promptEl.style.left = car.x + "px";
      promptEl.style.top  = car.y + "px";
    } else {
      promptEl.classList.remove("on");
    }
  }
  function actuate() {
    if (!currentTarget) return;
    const t = currentTarget, tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) {
      exitDrive();
      t.focus({ preventScroll: true });
      return;
    }
    t.click();
    const prev = t.style.transition, pt = t.style.transform;
    t.style.transition = "transform .08s ease";
    t.style.transform = (pt ? pt + " " : "") + "scale(0.96)";
    setTimeout(() => { t.style.transform = pt; t.style.transition = prev; }, 100);
  }

  // ---------- physics ----------
  function stepPhysics(dt) {
    let steerTarget = 0;
    if (held("a","arrowleft"))  steerTarget -= 1;
    if (held("d","arrowright")) steerTarget += 1;
    steer += (steerTarget - steer) * Math.min(1, TUNE.maxSteerLag * dt);

    const handbrake = held("shift", " ");

    const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
    const rx = -Math.sin(car.angle), ry = Math.cos(car.angle);
    let vForward = car.vx * fx + car.vy * fy;
    let vLateral = car.vx * rx + car.vy * ry;

    if (held("w","arrowup"))   vForward += TUNE.engine  * dt;
    if (held("s","arrowdown")) vForward -= TUNE.reverse * dt;

    vForward *= Math.pow(TUNE.drag, dt);
    const grip = handbrake ? TUNE.gripDrift : TUNE.gripNormal;
    vLateral *= Math.pow(grip, dt);

    car.vx = fx * vForward + rx * vLateral;
    car.vy = fy * vForward + ry * vLateral;

    const speed = Math.hypot(car.vx, car.vy);
    const authority = Math.min(1, speed / TUNE.turnSpeedRef);
    const maxTurn = handbrake ? TUNE.turnDrift : TUNE.turnRate;
    let turn = steer * maxTurn * authority * dt;
    if (vForward < 0) turn = -turn;
    car.angle += turn;

    car.x += car.vx * dt;
    car.y += car.vy * dt;

    if (Math.abs(vLateral) > 0.9 && speed > 0.6) spawnSkid(rx, ry);
    if (handbrake && speed > 0.8) {
      const n = 1 + (Math.random() < Math.min(1, speed / 4) ? 1 : 0);
      for (let i = 0; i < n; i++) spawnSmoke();
    }

    // red brake-light trail while braking / handbraking and moving
    braking = held("s", "arrowdown") || handbrake;
    if (braking && speed > 0.5) { spawnBrakePoint(!brakeContiguous); brakeContiguous = true; }
    else brakeContiguous = false;

    handleEdges(dt);
    car.x = Math.max(0, Math.min(innerWidth,  car.x));
    car.y = Math.max(0, Math.min(innerHeight, car.y));
  }

  function handleEdges(dt) {
    const m = TUNE.scrollMargin;
    let dy = 0;
    if (car.y < m)                     dy = -(m - car.y) / m;
    else if (car.y > innerHeight - m)  dy = (car.y - (innerHeight - m)) / m;
    if (dy !== 0) {
      // behavior:instant so the site's `scroll-behavior:smooth` doesn't lag the drive
      window.scrollBy({ top: dy * TUNE.scrollMax * dt, left: 0, behavior: "instant" });
    }
  }

  function spawnSkid(rx, ry) {
    const halfW = TUNE.carWid * 0.42;
    const bx = car.x - Math.cos(car.angle) * TUNE.carLen * 0.45;
    const by = car.y - Math.sin(car.angle) * TUNE.carLen * 0.45;
    skids.push({ ax: bx - rx*halfW, ay: by - ry*halfW, bx: bx + rx*halfW, by: by + ry*halfW, life: 1 });
    if (skids.length > 1400) skids.splice(0, skids.length - 1400);
  }
  function spawnSmoke() {
    const bx = car.x - Math.cos(car.angle) * TUNE.carLen * 0.5;
    const by = car.y - Math.sin(car.angle) * TUNE.carLen * 0.5;
    const j = () => (Math.random() - 0.5);
    smoke.push({
      x: bx + j()*TUNE.carWid, y: by + j()*TUNE.carWid,
      vx: -Math.cos(car.angle)*0.7 + j()*0.9, vy: -Math.sin(car.angle)*0.7 + j()*0.9,
      size: 5 + Math.random()*6, grow: 0.25 + Math.random()*0.35,
      life: 1, fade: 0.014 + Math.random()*0.012, rot: Math.random()*Math.PI, vr: j()*0.08,
    });
    if (smoke.length > 700) smoke.splice(0, smoke.length - 700);
  }
  function spawnBrakePoint(startFlag) {
    // world positions of the two rear brake lights, from car-local coords
    const L = TUNE.carLen, y0 = TUNE.carWid / 2 - 4.1, lx0 = -L / 2 + 1.9;
    const cos = Math.cos(car.angle), sin = Math.sin(car.angle);
    const tf = (lx, ly) => ({ x: car.x + lx * cos - ly * sin, y: car.y + lx * sin + ly * cos });
    const Lp = tf(lx0, -y0), Rp = tf(lx0, y0);
    brakeTrail.push({ lx: Lp.x, ly: Lp.y, rx: Rp.x, ry: Rp.y, life: 1, start: startFlag });
    if (brakeTrail.length > 400) brakeTrail.shift();
  }

  // ---------- rendering ----------
  function drawTrails(dt) {
    tx.clearRect(0, 0, innerWidth, innerHeight);
    tx.lineCap = "round";
    for (let i = skids.length - 1; i >= 0; i--) {
      const s = skids[i];
      s.life -= 0.004 * dt;
      if (s.life <= 0) { skids.splice(i, 1); continue; }
      tx.strokeStyle = "rgba(205,205,210," + (0.30 * s.life).toFixed(3) + ")";
      tx.lineWidth = 4;
      tx.beginPath(); tx.moveTo(s.ax, s.ay); tx.lineTo(s.ax, s.ay + 0.01); tx.stroke();
      tx.beginPath(); tx.moveTo(s.bx, s.by); tx.lineTo(s.bx, s.by + 0.01); tx.stroke();
    }
  }
  function drawBrakeTrail(dt) {
    for (let i = brakeTrail.length - 1; i >= 0; i--) brakeTrail[i].life -= 0.016 * dt;
    while (brakeTrail.length && brakeTrail[0].life <= 0) brakeTrail.shift();
    if (brakeTrail.length < 2) return;
    tx.save();
    tx.globalCompositeOperation = "lighter";   // reds add up into a glow on the dark page
    tx.lineCap = "round";
    for (let i = 1; i < brakeTrail.length; i++) {
      const p = brakeTrail[i], q = brakeTrail[i - 1];
      if (p.start) continue;                    // don't bridge a gap between braking bursts
      const a = p.life; if (a <= 0) continue;
      tx.strokeStyle = "rgba(255,28,24," + (0.12 * a).toFixed(3) + ")";
      tx.lineWidth = 7;
      tx.beginPath();
      tx.moveTo(q.lx, q.ly); tx.lineTo(p.lx, p.ly);
      tx.moveTo(q.rx, q.ry); tx.lineTo(p.rx, p.ry);
      tx.stroke();
      tx.strokeStyle = "rgba(255,86,72," + (0.55 * a).toFixed(3) + ")";
      tx.lineWidth = 2.4;
      tx.beginPath();
      tx.moveTo(q.lx, q.ly); tx.lineTo(p.lx, p.ly);
      tx.moveTo(q.rx, q.ry); tx.lineTo(p.rx, p.ry);
      tx.stroke();
    }
    tx.restore();
  }
  function drawSmoke(dt) {
    for (let i = smoke.length - 1; i >= 0; i--) {
      const p = smoke[i];
      p.life -= p.fade * dt;
      if (p.life <= 0) { smoke.splice(i, 1); continue; }
      p.x += p.vx*dt; p.y += p.vy*dt;
      p.vx *= Math.pow(0.93, dt); p.vy *= Math.pow(0.93, dt);
      p.size += p.grow*dt; p.rot += p.vr*dt;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
      cx.fillStyle = "rgba(255,255,255," + (0.7 * p.life).toFixed(3) + ")";
      cx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
      cx.restore();
    }
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y, x+w, y+h, r); ctx.arcTo(x+w, y+h, x, y+h, r);
    ctx.arcTo(x, y+h, x, y, r); ctx.arcTo(x, y, x+w, y, r); ctx.closePath();
  }
  function drawCar() {
    // AE86 Trueno (panda), top-down. Forward = +x. Tuned for a black page.
    const L = TUNE.carLen, W = TUNE.carWid, hw = W / 2;
    cx.save();
    cx.translate(car.x, car.y);
    cx.rotate(car.angle);

    cx.fillStyle = "rgba(0,0,0,.28)";
    roundRect(cx, -L/2 + 1.5, -hw + 2.5, L, W, 6); cx.fill();

    cx.fillStyle = "#f4f4f4";
    roundRect(cx, -L/2, -hw, L, W, 6); cx.fill();
    cx.lineWidth = 1; cx.strokeStyle = "rgba(0,0,0,.35)";
    roundRect(cx, -L/2, -hw, L, W, 6); cx.stroke();

    // carbon hood — light rim + weave so it reads on black
    const hx = L*0.15, hy = -hw + 1.3, hwd = L*0.30, hht = W - 2.6;
    cx.fillStyle = "#141414";
    roundRect(cx, hx, hy, hwd, hht, 3); cx.fill();
    cx.save();
    roundRect(cx, hx, hy, hwd, hht, 3); cx.clip();
    cx.strokeStyle = "rgba(255,255,255,.06)"; cx.lineWidth = 0.8;
    for (let i = -W; i < hwd + W; i += 3) {
      cx.beginPath(); cx.moveTo(hx + i, hy); cx.lineTo(hx + i - W, hy + hht); cx.stroke();
    }
    cx.restore();
    cx.lineWidth = 0.8; cx.strokeStyle = "rgba(255,255,255,.16)";
    roundRect(cx, hx, hy, hwd, hht, 3); cx.stroke();

    // greenhouse glass
    cx.fillStyle = "#241a1e";
    roundRect(cx, L*0.02, -hw + 2.2, L*0.13, W - 4.4, 2); cx.fill();
    roundRect(cx, -L*0.30, -hw + 2.2, L*0.12, W - 4.4, 2); cx.fill();
    cx.fillStyle = "#1c1418";
    roundRect(cx, -L*0.12, -hw + 3.2, L*0.10, W - 6.4, 2); cx.fill();
    cx.lineWidth = 0.7; cx.strokeStyle = "rgba(255,255,255,.10)";
    roundRect(cx, L*0.02, -hw + 2.2, L*0.13, W - 4.4, 2); cx.stroke();
    roundRect(cx, -L*0.30, -hw + 2.2, L*0.12, W - 4.4, 2); cx.stroke();

    // mirrors
    cx.fillStyle = "#e6e6e6";
    roundRect(cx, L*0.06, -hw - 2.0, 3.3, 2, 1); cx.fill();
    roundRect(cx, L*0.06,  hw + 0.0, 3.3, 2, 1); cx.fill();

    // headlights — very slight warm glow
    cx.save();
    cx.shadowColor = "rgba(255,236,190,0.85)"; cx.shadowBlur = 5;
    cx.fillStyle = "rgba(255,247,224,0.92)";
    roundRect(cx, L*0.44, -hw + 2.4, 2.6, 3, 1); cx.fill();
    roundRect(cx, L*0.44,  hw - 5.4, 2.6, 3, 1); cx.fill();
    cx.restore();

    // tail lights — flare brighter with a red glow while braking
    if (braking) {
      cx.save();
      cx.shadowColor = "rgba(255,40,30,0.95)"; cx.shadowBlur = 6;
      cx.fillStyle = "#ff3b30";
      cx.fillRect(-L/2 + 0.6, -hw + 2.4, 2.2, 3.4);
      cx.fillRect(-L/2 + 0.6,  hw - 5.8, 2.2, 3.4);
      cx.restore();
    } else {
      cx.fillStyle = "#d23b34";
      cx.fillRect(-L/2 + 1, -hw + 2.6, 1.8, 3);
      cx.fillRect(-L/2 + 1,  hw - 5.6, 1.8, 3);
    }

    cx.restore();
  }

  // ---------- main loop ----------
  function frame(now) {
    let dt = (now - lastT) / 16.667;
    lastT = now;
    dt = Math.min(dt, 3);

    cx.clearRect(0, 0, innerWidth, innerHeight);
    if (driving) {
      stepPhysics(dt);
      updateTarget();
      drawSmoke(dt);
      drawCar();
    } else {
      smoke.length = 0;
    }
    drawTrails(dt);
    drawBrakeTrail(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
