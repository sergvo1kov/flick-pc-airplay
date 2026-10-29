'use strict';
// Now-playing session model. Fed by UxPlay console lines and the files UxPlay
// exports (metadata text, cover art, DACP identity), it produces one state
// object for every window. Pure logic: clock and file reads are injected so it
// can be unit tested without UxPlay.
//
// Behaviour carried over from the Android receiver (PhairPlay / Flick AirPlay):
//  - iOS "pause" just stops the audio stream; the session stays. We keep the
//    card up in a paused state and freeze progress, and give up after 15 min.
//  - Progress is an anchor (position @ time) that advances in real time while
//    playing and holds while paused.
//  - Track metadata / artwork are dropped when the stream ends so they can't
//    bleed into the next session; identical artwork is de-duplicated by hash.

const crypto = require('crypto');
const P = require('./parsers');

const PAUSE_DETECT_MS = 2600;          // no progress tick for this long => paused
const OPTIMISTIC_HOLD_MS = 3500;       // keep a user-requested play/pause state this long
const PAUSED_CARD_TIMEOUT_MS = 15 * 60_000;
const DISCONNECT_GRACE_MS = 4000;      // DACP file gone + silence => session over

class Session {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.connected = false;
    this.device = null;           // { deviceName, deviceModel, deviceId }
    this.dacp = null;             // { dacpId, activeRemote }
    this.meta = {};
    this.cover = null;            // { hash, mime, base64 }
    this.coverVersion = 0;
    this.trackKey = '';
    this.trackVersion = 0;
    this.progress = null;         // { position, duration, anchor }
    this.lastTickAt = 0;
    this.paused = false;
    this.pausedSince = 0;
    this.optimistic = null;       // { paused, until }
    this.streamSeen = false;
    this.lastActivityAt = 0;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _emit() { for (const fn of this.listeners) fn(this.snapshot()); }

  // ---- inputs -------------------------------------------------------------

  /** One line (or \r-terminated chunk) of UxPlay console output. */
  feedLine(line) {
    const conn = P.parseConnection(line);
    if (conn) {
      const newDevice = !this.device || this.device.deviceId !== conn.deviceId;
      if (newDevice) this._clearTrack();
      this.device = conn;
      this.connected = true;
      this.lastActivityAt = this.now();
      this._emit();
      return;
    }
    const prog = P.parseProgress(line);
    if (prog) this._tick(prog);
  }

  _tick({ position, duration }) {
    const t = this.now();
    this.connected = true;
    this.streamSeen = true;
    this.lastActivityAt = t;
    this.lastTickAt = t;
    this.progress = duration > 0 ? { position: Math.min(position, duration), duration, anchor: t } : null;
    if (this.optimistic && this.optimistic.paused && t < this.optimistic.until) {
      // user just hit pause: ignore the last ticks still in flight
    } else {
      this.optimistic = null;
      if (this.paused) { this.paused = false; this.pausedSince = 0; }
    }
    this._emit();
  }

  setMetadataText(text) {
    const meta = P.parseMetadata(text);
    const key = [meta.title, meta.artist, meta.album].join('\u0001');
    if (key === this.trackKey) return;
    const isEmpty = !meta.title && !meta.artist && !meta.album;
    this.meta = meta;
    this.trackKey = key;
    if (!isEmpty) {
      this.trackVersion++;
      // new track: the old position is meaningless until the next tick
      if (this.progress) this.progress = { ...this.progress, position: 0, anchor: this.now() };
      this.connected = true;
      this.lastActivityAt = this.now();
    }
    this._emit();
  }

  setCoverBytes(buf) {
    if (!P.isRealCover(buf)) {
      if (this.cover) { this.cover = null; this.coverVersion++; this._emit(); }
      return;
    }
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    if (this.cover && this.cover.hash === hash) return;
    this.cover = { hash, mime: P.coverMime(buf), base64: buf.toString('base64') };
    this.coverVersion++;
    this._emit();
  }

  setDacp(info) {
    const same = (this.dacp && info && this.dacp.dacpId === info.dacpId && this.dacp.activeRemote === info.activeRemote)
      || (!this.dacp && !info);
    if (same) return;
    this.dacp = info;
    if (info) {
      this.connected = true;
      this.lastActivityAt = this.now();
    }
    this._emit();
  }

  /** User pressed play/pause on the PC: show the new state immediately. */
  optimisticToggle() {
    const target = !this.isPaused();
    this._freezeProgress();
    this.paused = target;
    this.pausedSince = target ? this.now() : 0;
    this.optimistic = { paused: target, until: this.now() + OPTIMISTIC_HOLD_MS };
    this._emit();
  }

  /** User pressed next/prev: position restarts, metadata follows shortly. */
  optimisticSkip() {
    if (this.progress) this.progress = { ...this.progress, position: 0, anchor: this.now() };
    this.optimistic = { paused: false, until: this.now() + OPTIMISTIC_HOLD_MS };
    this.paused = false;
    this._emit();
  }

  /** The command never reached the phone: drop the optimistic state we showed. */
  revertOptimistic() {
    if (!this.optimistic) return;
    this.optimistic = null;
    const ticking = this.lastTickAt && this.now() - this.lastTickAt < PAUSE_DETECT_MS;
    this.paused = this.streamSeen && !ticking;
    this.pausedSince = this.paused ? this.now() : 0;
    this._emit();
  }

  /** Called periodically (e.g. every 500 ms). */
  housekeeping() {
    const t = this.now();
    let changed = false;
    if (this.optimistic && t >= this.optimistic.until) {
      this.optimistic = null;
    }
    // pause detection: stream seen, ticks stopped
    if (this.connected && this.streamSeen && !this.paused && !this.optimistic
        && this.lastTickAt && t - this.lastTickAt > PAUSE_DETECT_MS) {
      this._freezeProgress(this.lastTickAt + 1000);
      this.paused = true;
      this.pausedSince = t;
      changed = true;
    }
    // session end: DACP identity gone and nothing heard for a while
    if (this.connected && !this.dacp && t - this.lastActivityAt > DISCONNECT_GRACE_MS
        && (!this.lastTickAt || t - this.lastTickAt > DISCONNECT_GRACE_MS)) {
      this.reset();
      changed = true;
    }
    // paused for too long: drop the card, keep the connection
    if (this.paused && this.pausedSince && t - this.pausedSince > PAUSED_CARD_TIMEOUT_MS) {
      this._clearTrack();
      this.streamSeen = false;
      changed = true;
    }
    if (changed) this._emit();
  }

  // ---- helpers ------------------------------------------------------------

  _clearTrack() {
    this.meta = {};
    this.trackKey = '';
    if (this.cover) { this.cover = null; this.coverVersion++; }
    this.progress = null;
    this.paused = false;
    this.pausedSince = 0;
    this.optimistic = null;
    this.lastTickAt = 0;
  }

  _freezeProgress(atTime) {
    if (!this.progress) return;
    const pos = this.positionAt(atTime === undefined ? this.now() : Math.min(atTime, this.now()));
    this.progress = { ...this.progress, position: pos, anchor: this.now() };
  }

  isPaused() {
    if (this.optimistic && this.now() < this.optimistic.until) return this.optimistic.paused;
    return this.paused;
  }

  positionAt(t = this.now()) {
    if (!this.progress) return 0;
    const { position, duration, anchor } = this.progress;
    const pos = this.isPaused() ? position : position + (t - anchor) / 1000;
    return Math.max(0, Math.min(duration, pos));
  }

  /** "idle" | "connected" | "playing" | "paused" */
  get status() {
    if (!this.connected) return 'idle';
    if (!this.streamSeen && !this.meta.title) return 'connected';
    return this.isPaused() ? 'paused' : 'playing';
  }

  snapshot() {
    return {
      status: this.status,
      device: this.device,
      remoteAvailable: !!this.dacp,
      title: this.meta.title || '',
      artist: this.meta.artist || '',
      album: this.meta.album || '',
      trackVersion: this.trackVersion,
      coverVersion: this.coverVersion,
      hasCover: !!this.cover,
      position: this.positionAt(),
      duration: this.progress ? this.progress.duration : 0,
      paused: this.isPaused(),
      at: this.now(),
    };
  }

  coverDataUrl() {
    return this.cover ? `data:${this.cover.mime};base64,${this.cover.base64}` : null;
  }
}

module.exports = { Session, PAUSE_DETECT_MS, PAUSED_CARD_TIMEOUT_MS, DISCONNECT_GRACE_MS, OPTIMISTIC_HOLD_MS };
