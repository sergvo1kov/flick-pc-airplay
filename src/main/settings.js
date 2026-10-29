'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  deviceName: 'Flick AirPlay',
  language: 'auto',            // auto | uk | ru | en
  autostart: true,
  showMiniOnPlay: true,
  autoFullscreen: false,
  fullscreenDisplay: 'auto',   // auto (where the mini player is) | display id
  miniAlwaysOnTop: true,
  mediaKeys: true,             // keyboard media keys control the iPhone while connected
  taperVolume: true,           // AirPlay volume curve like Apple speakers
  allowTakeover: true,         // another device may take over (like Apple TV)
  mirroring: false,            // experimental screen mirroring
  audioSink: 'auto',
});

// Settings that require restarting the AirPlay engine when changed.
const ENGINE_KEYS = ['deviceName', 'taperVolume', 'allowTakeover', 'mirroring', 'audioSink'];

function sanitize(input) {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (input && input[k] !== undefined && typeof input[k] === typeof DEFAULTS[k]) s[k] = input[k];
  }
  s.deviceName = String(s.deviceName).replace(/["\r\n\t]/g, '').trim().slice(0, 48) || DEFAULTS.deviceName;
  if (!['auto', 'uk', 'ru', 'en'].includes(s.language)) s.language = 'auto';
  if (!['auto', 'wasapi2sink', 'wasapisink', 'directsoundsink'].includes(s.audioSink)) s.audioSink = 'auto';
  return s;
}

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = sanitize(this._read());
  }
  _read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return {}; }
  }
  get() { return { ...this.data }; }
  /** @returns {{settings:object, engineChanged:boolean}} */
  update(patch) {
    const next = sanitize({ ...this.data, ...patch });
    const engineChanged = ENGINE_KEYS.some((k) => next[k] !== this.data[k]);
    this.data = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    return { settings: this.get(), engineChanged };
  }
}

module.exports = { SettingsStore, DEFAULTS, ENGINE_KEYS, sanitize };
