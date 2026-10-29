'use strict';
// OTA updates from GitHub Releases (electron-updater).
//
// Release flow: push a tag "vX.Y.Z" -> CI builds the NSIS installer and uploads
// it with latest.yml (+ .blockmap for differential download) to a GitHub
// Release. Installed apps read latest.yml, download in the background and
// install on demand or when the app quits.
//
// State machine kept separate from electron-updater so it can be unit tested
// with a fake updater (any EventEmitter with the same methods).

const EventEmitter = require('events');

const CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

class Updater extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object|null} opts.autoUpdater electron-updater's autoUpdater, or null when unavailable
   * @param {boolean} opts.enabled   false in development (unpackaged) builds
   * @param {boolean} opts.autoInstall install a downloaded update when the app quits
   */
  constructor({ autoUpdater, enabled, autoInstall = true, currentVersion = '0.0.0', log = () => {} }) {
    super();
    this.u = autoUpdater;
    this.log = log;
    this.currentVersion = currentVersion;
    this.state = { status: enabled && autoUpdater ? 'idle' : 'disabled', version: '', percent: 0, error: '', manual: false };
    this.timers = [];
    if (this.state.status === 'disabled') return;

    const u = autoUpdater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = autoInstall;
    u.allowPrerelease = false;
    u.allowDowngrade = false;
    if (u.logger !== undefined) u.logger = { info: (m) => log(`[update] ${m}`), warn: (m) => log(`[update] ${m}`), error: (m) => log(`[update] ${m}`), debug() {} };

    u.on('checking-for-update', () => this._set({ status: 'checking', error: '' }));
    u.on('update-available', (info) => this._set({ status: 'downloading', version: info.version, percent: 0 }));
    u.on('update-not-available', () => this._set({ status: 'uptodate', version: '' }));
    u.on('download-progress', (p) => this._set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    u.on('update-downloaded', (info) => {
      this._set({ status: 'downloaded', version: info.version, percent: 100 });
      this.emit('downloaded', info.version);
    });
    u.on('error', (err) => {
      const msg = String((err && err.message) || err).split('\n')[0].slice(0, 200);
      log(`[update] error: ${msg}`);
      // a failed background check shouldn't nag; a manual one shows the error
      if (this.state.status === 'downloaded') return;
      this._set({ status: this.state.manual ? 'error' : 'idle', error: msg });
    });
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.snapshot());
  }

  snapshot() { return { ...this.state, current: this.currentVersion }; }

  /** Background schedule: first check shortly after start, then every 6 hours. */
  start() {
    if (this.state.status === 'disabled') return;
    this.timers.push(setTimeout(() => this.check(false), CHECK_DELAY_MS));
    this.timers.push(setInterval(() => this.check(false), CHECK_INTERVAL_MS));
  }

  stop() { this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); this.timers = []; }

  async check(manual = true) {
    if (this.state.status === 'disabled') return this.snapshot();
    if (['checking', 'downloading', 'downloaded'].includes(this.state.status)) {
      if (manual) this._set({ manual: true });
      return this.snapshot();
    }
    this._set({ manual, status: 'checking', error: '' });
    try {
      await this.u.checkForUpdates();
    } catch (e) {
      // also reported through the 'error' event; make sure we leave 'checking'
      if (this.state.status === 'checking') this._set({ status: manual ? 'error' : 'idle', error: String(e.message || e).slice(0, 200) });
    }
    return this.snapshot();
  }

  setAutoInstall(on) { if (this.u && this.state.status !== 'disabled') this.u.autoInstallOnAppQuit = !!on; }

  get readyToInstall() { return this.state.status === 'downloaded'; }

  /** Caller must stop the engine first (installer replaces uxplay.exe). */
  install() {
    if (!this.readyToInstall) return false;
    // isSilent: no wizard; isForceRunAfter: start the new version when done
    this.u.quitAndInstall(true, true);
    return true;
  }
}

/** Loads electron-updater if it is bundled (it is a runtime dependency of the packaged app). */
function loadAutoUpdater(log) {
  try {
    return require('electron-updater').autoUpdater;
  } catch (e) {
    log(`[update] electron-updater not available: ${e.message}`);
    return null;
  }
}

module.exports = { Updater, loadAutoUpdater, CHECK_DELAY_MS, CHECK_INTERVAL_MS };
