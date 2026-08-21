// overlay.js — draws the skeleton, center of mass, and base of support onto a canvas
// sized to the video stage (doc §7 feedback layer). Landmarks arrive normalized
// (0..1) relative to the source video frame; we map them into a target `rect` inside
// the canvas so the skeleton lines up with the footage even when the footage is
// letterboxed (object-fit: contain) to preserve its aspect ratio. When a scored
// event is active we highlight the punching limb.

import { BONES, LM, PALETTE } from './config.js';
import { centerOfMass, baseOfSupport } from './biomech.js';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,visibility?:number}[]} lm normalized landmarks
 * @param {{highlightHand?:'left'|'right'|null, showCoM?:boolean, showBoS?:boolean,
 *          rect?:{ox:number,oy:number,w:number,h:number}}} o
 */
export function drawPose(ctx, lm, o = {}) {
  const { highlightHand = null, showCoM = true, showBoS = true } = o;
  const CW = ctx.canvas.width, CH = ctx.canvas.height;
  const rect = o.rect || { ox: 0, oy: 0, w: CW, h: CH };
  ctx.clearRect(0, 0, CW, CH);
  const P = (i) => ({ x: rect.ox + lm[i].x * rect.w, y: rect.oy + lm[i].y * rect.h });
  const MX = (x) => rect.ox + x * rect.w;
  const MY = (y) => rect.oy + y * rect.h;

  // Base of support: the sagittal ground interval the athlete must stay balanced over.
  if (showBoS) {
    const bos = baseOfSupport(lm);
    const gy = MY(bos.groundY);
    ctx.save();
    ctx.strokeStyle = PALETTE.series[4];
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(MX(bos.lo), gy); ctx.lineTo(MX(bos.hi), gy);
    ctx.stroke();
    for (const x of [bos.lo, bos.hi]) {
      ctx.beginPath(); ctx.moveTo(MX(x), gy - 7); ctx.lineTo(MX(x), gy + 7); ctx.stroke();
    }
    ctx.restore();
  }

  // Bones
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    const isHand = highlightHand &&
      ((highlightHand === 'left' && [[11, 13], [13, 15]].some(([x, y]) => x === a && y === b)) ||
       (highlightHand === 'right' && [[12, 14], [14, 16]].some(([x, y]) => x === a && y === b)));
    ctx.strokeStyle = isHand ? PALETTE.critical : 'rgba(120,180,255,0.9)';
    ctx.lineWidth = isHand ? 5 : 3;
    const pa = P(a), pb = P(b);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }

  // Joints
  ctx.fillStyle = '#eaf2ff';
  for (const i of Object.values(LM)) {
    const p = P(i);
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
  }

  // Center of mass + its vertical projection to the ground.
  if (showCoM) {
    const com = centerOfMass(lm);
    const bos = baseOfSupport(lm);
    const cx = MX(com.x), cy = MY(com.y);
    const gy = MY(bos.groundY);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, gy); ctx.stroke();
    ctx.setLineDash([]);
    // projection dot on ground: green inside base, red outside
    const outside = com.x < bos.lo || com.x > bos.hi;
    ctx.fillStyle = outside ? PALETTE.critical : PALETTE.good;
    ctx.beginPath(); ctx.arc(cx, gy, 5, 0, Math.PI * 2); ctx.fill();
    // CoM marker
    ctx.fillStyle = PALETTE.series[2];
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('CoM', cx, cy + 3);
  }
}
