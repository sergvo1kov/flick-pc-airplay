'use strict';
// Mini player placement: magnetic screen edges, pinning, and a position that
// survives resolution changes (games often switch the desktop resolution).
//
// A position is stored as an "anchor" relative to a display's work area:
//   { displayId, h: 'left'|'right'|'free', v: 'top'|'bottom'|'free', fx, fy }
// 'left'/'right'/'top'/'bottom' = glued to that edge (MARGIN px away);
// 'free' = fx/fy is the fraction of the free space before the window (0..1).

const MARGIN = 12;     // gap between a docked player and the screen edge
const SNAP = 28;       // drag within this many px of an edge -> it sticks
const CORNER = 120;    // when pinning, also take the other edge if this close

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Window bounds for an anchor on a work area. */
function boundsFor(anchor, wa, size) {
  const freeW = Math.max(0, wa.width - size.width - 2 * MARGIN);
  const freeH = Math.max(0, wa.height - size.height - 2 * MARGIN);
  let x;
  if (anchor.h === 'left') x = wa.x + MARGIN;
  else if (anchor.h === 'right') x = wa.x + wa.width - size.width - MARGIN;
  else x = wa.x + MARGIN + Math.round(clamp(anchor.fx ?? 1, 0, 1) * freeW);
  let y;
  if (anchor.v === 'top') y = wa.y + MARGIN;
  else if (anchor.v === 'bottom') y = wa.y + wa.height - size.height - MARGIN;
  else y = wa.y + MARGIN + Math.round(clamp(anchor.fy ?? 1, 0, 1) * freeH);
  return { x, y, width: size.width, height: size.height };
}

/**
 * Anchor for where the user left the window.
 * pin=false: edges within SNAP px stick (magnet), others stay free.
 * pin=true: the nearest edge always sticks, plus the other axis if it is within
 * CORNER px of an edge (so dropping near a corner pins to the corner).
 */
function anchorFromBounds(b, wa, displayId, { pin = false } = {}) {
  const dl = b.x - wa.x;
  const dr = wa.x + wa.width - (b.x + b.width);
  const dt = b.y - wa.y;
  const db = wa.y + wa.height - (b.y + b.height);
  const freeW = Math.max(1, wa.width - b.width - 2 * MARGIN);
  const freeH = Math.max(1, wa.height - b.height - 2 * MARGIN);
  const a = {
    displayId: String(displayId),
    h: 'free',
    v: 'free',
    fx: clamp((b.x - wa.x - MARGIN) / freeW, 0, 1),
    fy: clamp((b.y - wa.y - MARGIN) / freeH, 0, 1),
  };
  const nearH = dl <= dr ? 'left' : 'right';
  const nearV = dt <= db ? 'top' : 'bottom';
  const distH = Math.min(dl, dr);
  const distV = Math.min(dt, db);
  if (pin) {
    // the closest edge overall always sticks
    if (distH <= distV) a.h = nearH; else a.v = nearV;
    if (a.h === 'free' && distH <= CORNER) a.h = nearH;
    if (a.v === 'free' && distV <= CORNER) a.v = nearV;
  } else {
    if (distH <= SNAP) a.h = nearH;
    if (distV <= SNAP) a.v = nearV;
  }
  return a;
}

/** Default spot: bottom-right corner of the primary display. */
function defaultAnchor(displayId) {
  return { displayId: String(displayId), h: 'right', v: 'bottom', fx: 1, fy: 1 };
}

/** Accepts only a well-formed anchor from settings.json, else null. */
function validAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const H = ['left', 'right', 'free'];
  const V = ['top', 'bottom', 'free'];
  if (!H.includes(a.h) || !V.includes(a.v)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 1);
  return { displayId: String(a.displayId ?? ''), h: a.h, v: a.v, fx: num(a.fx), fy: num(a.fy) };
}

/** Pick the anchor's display, or the primary one if it is gone (monitor unplugged). */
function displayFor(anchor, displays, primary) {
  return (anchor && displays.find((d) => String(d.id) === String(anchor.displayId))) || primary;
}

module.exports = { MARGIN, SNAP, CORNER, boundsFor, anchorFromBounds, defaultAnchor, validAnchor, displayFor };
