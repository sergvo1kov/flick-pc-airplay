(() => {
'use strict';
/* Shared renderer helpers: icons, state store with smooth progress, cover cross-fade. */

const ICONS = {
  play: '<svg class="icon" viewBox="0 0 24 24"><path d="M8 5.6v12.8c0 .8.9 1.3 1.6.8l10-6.4c.6-.4.6-1.3 0-1.7l-10-6.4C8.9 4.3 8 4.8 8 5.6z"/></svg>',
  pause: '<svg class="icon" viewBox="0 0 24 24"><rect x="6.2" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.6" y="5" width="4.2" height="14" rx="1.2"/></svg>',
  next: '<svg class="icon" viewBox="0 0 24 24"><path d="M3.5 7.1v9.8c0 .7.8 1.1 1.4.7l7.1-4.9c.5-.4.5-1.1 0-1.4L4.9 6.4c-.6-.4-1.4 0-1.4.7zM12 7.1v9.8c0 .7.8 1.1 1.4.7l7.1-4.9c.5-.4.5-1.1 0-1.4l-7.1-4.9c-.6-.4-1.4 0-1.4.7z"/></svg>',
  prev: '<svg class="icon" viewBox="0 0 24 24"><path d="M20.5 7.1v9.8c0 .7-.8 1.1-1.4.7L12 12.7c-.5-.4-.5-1.1 0-1.4l7.1-4.9c.6-.4 1.4 0 1.4.7zM12 7.1v9.8c0 .7-.8 1.1-1.4.7l-7.1-4.9c-.5-.4-.5-1.1 0-1.4l7.1-4.9c.6-.4 1.4 0 1.4.7z"/></svg>',
  expand: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 9V5.5C4 4.7 4.7 4 5.5 4H9v2H6v3H4zm11-5h3.5c.8 0 1.5.7 1.5 1.5V9h-2V6h-3V4zM4 15h2v3h3v2H5.5c-.8 0-1.5-.7-1.5-1.5V15zm14 0h2v3.5c0 .8-.7 1.5-1.5 1.5H15v-2h3v-3z"/></svg>',
  close: '<svg class="icon" viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
  settings: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm8.3 4.6-1.6-.4a7 7 0 0 0 0-1.6l1.6-.4c.4-.1.6-.6.4-1l-1.2-2.1c-.2-.4-.7-.5-1-.3l-1.3.9a7 7 0 0 0-1.4-.8l-.3-1.6c-.1-.4-.4-.7-.8-.7h-2.4c-.4 0-.8.3-.8.7l-.3 1.6c-.5.2-1 .5-1.4.8l-1.3-.9c-.4-.2-.8-.1-1 .3L4.3 9.9c-.2.4-.1.8.3 1l1.5.4a7 7 0 0 0 0 1.6l-1.5.4c-.4.1-.6.6-.4 1l1.2 2.1c.2.4.7.5 1 .3l1.3-.9c.4.3.9.6 1.4.8l.3 1.6c.1.4.4.7.8.7h2.4c.4 0 .8-.3.8-.7l.3-1.6c.5-.2 1-.5 1.4-.8l1.3.9c.4.2.8.1 1-.3l1.2-2.1c.2-.4 0-.9-.4-1z"/></svg>',
  // Original "stream to screen" glyph: a display outline with sound waves flowing into a triangle.
  airplay: '<svg class="icon" viewBox="0 0 48 48"><path d="M8 8h32a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4h-5.2l-3-3.4H40c.4 0 .6-.2.6-.6V12c0-.4-.2-.6-.6-.6H8c-.4 0-.6.2-.6.6v19c0 .4.2.6.6.6h8.2l-3 3.4H8a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z"/><path d="M24 26.5c.5 0 1 .2 1.3.6l9.1 10.4c.8.9.1 2.3-1.1 2.3H14.7c-1.2 0-1.9-1.4-1.1-2.3l9.1-10.4c.3-.4.8-.6 1.3-.6z"/><path d="M17.3 22.6a9.4 9.4 0 0 1 13.4 0" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M13.6 19a14.6 14.6 0 0 1 20.8 0" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".55"/></svg>',
  note: '<svg class="icon" viewBox="0 0 24 24"><path d="M19 3.6v11.2a3.2 3.2 0 1 1-1.8-2.9V7.4l-7.4 1.9v7.6a3.2 3.2 0 1 1-1.8-2.9V6.5c0-.6.4-1.1 1-1.3l8.9-2.3c.6-.2 1.1.3 1.1.7z"/></svg>',
};

function fmt(str, vars) {
  return String(str || '').replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''));
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Holds the latest state and extrapolates the play position between updates. */
class PlayerStore {
  constructor() {
    this.state = { status: 'idle', position: 0, duration: 0, paused: false };
    this.receivedAt = performance.now();
    this.cover = null;
    this.listeners = [];
  }
  set(state) {
    this.state = state;
    this.receivedAt = performance.now();
    this.listeners.forEach((fn) => fn(state));
  }
  onChange(fn) { this.listeners.push(fn); }
  position() {
    const s = this.state;
    if (!s.duration) return 0;
    let p = s.position;
    if (s.status === 'playing' && !s.paused) p += (performance.now() - this.receivedAt) / 1000;
    return Math.max(0, Math.min(s.duration, p));
  }
}

/** Two stacked <img> layers so a new cover cross-fades over the old one. */
class CoverView {
  constructor(el, { onColor } = {}) {
    this.el = el;
    this.onColor = onColor;
    this.a = document.createElement('img');
    this.b = document.createElement('img');
    this.a.alt = '';
    this.b.alt = '';
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.innerHTML = ICONS.note;
    el.append(ph, this.a, this.b);
    this.front = this.a;
    this.url = null;
  }
  set(url) {
    if (url === this.url) return;
    this.url = url;
    if (!url) {
      this.a.classList.remove('on');
      this.b.classList.remove('on');
      this.el.classList.remove('has-art');
      if (this.onColor) this.onColor(null);
      return;
    }
    const back = this.front === this.a ? this.b : this.a;
    back.onload = () => {
      back.classList.add('on');
      this.front.classList.remove('on');
      this.front = back;
      this.el.classList.add('has-art');
      if (this.onColor) this.onColor(dominantColor(back));
    };
    back.src = url;
  }
}

/** Average colour of the image, nudged to be usable as a dark tint. Returns [r,g,b]. */
function dominantColor(img) {
  try {
    const c = document.createElement('canvas');
    c.width = 24; c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    let r = 0, gr = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i], d[i + 1], d[i + 2]);
      const min = Math.min(d[i], d[i + 1], d[i + 2]);
      const weight = 0.15 + (max - min) / 255; // favour saturated pixels
      r += d[i] * weight; gr += d[i + 1] * weight; b += d[i + 2] * weight; w += weight;
    }
    let rgb = [r / w, gr / w, b / w];
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const k = lum > 90 ? 90 / lum : 1; // keep it dark enough for white text
    return rgb.map((v) => Math.round(v * k));
  } catch (_) {
    return null;
  }
}

function setTint(rgb) {
  const v = rgb || [40, 36, 60];
  document.documentElement.style.setProperty('--tint', v.join(', '));
}

function pulse(btn) {
  if (!btn) return;
  btn.classList.remove('pulse');
  void btn.offsetWidth;
  btn.classList.add('pulse');
}

/** Wires keyboard shortcuts shared by mini and full players. */
function bindKeys(extra = {}) {
  // media keys are handled globally by the main process (no double toggle when focused)
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); window.flick.command('playpause'); }
    else if (e.code === 'ArrowRight') window.flick.command('next');
    else if (e.code === 'ArrowLeft') window.flick.command('prev');
    else if (e.code === 'ArrowUp') window.flick.command('volup');
    else if (e.code === 'ArrowDown') window.flick.command('voldown');
    else if (extra[e.code]) extra[e.code](e);
  });
}

/** Boots a page: fetch initial data, subscribe to updates. */
async function boot(render) {
  const store = new PlayerStore();
  const init = await window.flick.init();
  const T = init.strings;
  document.documentElement.lang = init.lang;
  store.cover = init.cover;
  store.set(init.state);
  window.flick.onState((s) => store.set(s));
  render({ store, T, init });
  return store;
}

window.FlickUI = { ICONS, fmt, fmtTime, PlayerStore, CoverView, dominantColor, setTint, pulse, bindKeys, boot };
})();
