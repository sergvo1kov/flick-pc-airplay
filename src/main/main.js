'use strict';
// Flick AirPlay for Windows — main process.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, shell, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { Engine } = require('./engine');
const { Session } = require('./session');
const { DacpRemote } = require('./dacp');
const { SettingsStore } = require('./settings');
const P = require('./parsers');
const i18n = require('./i18n');
const { Updater, loadAutoUpdater } = require('./updater');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.sergvo1kov.flickairplay');

const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');
const userDir = app.getPath('userData');
const runtimeDir = path.join(userDir, 'runtime');
const logDir = path.join(userDir, 'logs');
const engineDir = app.isPackaged
  ? path.join(process.resourcesPath, 'engine')
  : path.join(__dirname, '..', '..', 'engine');

// ---------------------------------------------------------------- logging
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'flick-airplay.log');
try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`); } catch (_) { /* first run */ }
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  logStream.write(line);
  if (!app.isPackaged) process.stdout.write(line);
}

// ---------------------------------------------------------------- state
const settingsStore = new SettingsStore(userDir);
let settings = settingsStore.get();
let lang = 'en';
let T = i18n.strings('en');
const session = new Session();
const remote = new DacpRemote({ log: (m) => log(`[dacp] ${m}`) });
const engine = new Engine({ engineDir, runtimeDir, log: (m) => log(`[engine] ${m}`) });
let engineState = { state: 'stopped', error: '' };
let networkWarning = '';
let tray = null;
let miniWin = null;
let fullWin = null;
let settingsWin = null;
let lastStatus = 'idle';
let quitting = false;
let mediaKeysOn = false;
let videoActive = false;     // UxPlay's own video window is showing (mirroring / YouTube)
let videoFallback = false;  // engine crashed with video on: running audio-only
let updater = null;          // created in whenReady (needs the packaged app)
let updateNotified = '';

function t(key, vars) { return i18n.format(T[key] || key, vars); }
function applyLanguage() {
  lang = i18n.pickLanguage(settings.language, app.getPreferredSystemLanguages()[0] || app.getLocale());
  T = i18n.strings(lang);
}

// ---------------------------------------------------------------- windows
const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false,
};

function allWindows() { return [miniWin, fullWin, settingsWin].filter((w) => w && !w.isDestroyed()); }
function send(channel, payload) { for (const w of allWindows()) w.webContents.send(channel, payload); }

function miniBounds(display) {
  const wa = (display || screen.getPrimaryDisplay()).workArea;
  const width = 380;
  const height = 160;
  return { width, height, x: wa.x + wa.width - width - 16, y: wa.y + wa.height - height - 16 };
}

function createMini() {
  if (miniWin && !miniWin.isDestroyed()) return miniWin;
  miniWin = new BrowserWindow({
    ...miniBounds(),
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.miniAlwaysOnTop,
    show: false,
    backgroundColor: '#15151a',
    title: 'Flick AirPlay',
    webPreferences,
  });
  miniWin.loadFile(path.join(RENDERER, 'mini.html'));
  miniWin.on('closed', () => { miniWin = null; });
  return miniWin;
}

function showMini() {
  const w = createMini();
  const show = () => { w.showInactive(); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', show); else show();
}

function hideMini() { if (miniWin && !miniWin.isDestroyed()) miniWin.hide(); }

function targetDisplay() {
  if (settings.fullscreenDisplay !== 'auto') {
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(settings.fullscreenDisplay));
    if (d) return d;
  }
  if (miniWin && !miniWin.isDestroyed() && miniWin.isVisible()) {
    return screen.getDisplayMatching(miniWin.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function openFull() {
  if (fullWin && !fullWin.isDestroyed()) { fullWin.focus(); return; }
  const { bounds } = targetDisplay();
  fullWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    title: 'Flick AirPlay',
    webPreferences,
  });
  fullWin.setMenu(null);
  fullWin.loadFile(path.join(RENDERER, 'full.html'));
  fullWin.once('ready-to-show', () => { fullWin.setFullScreen(true); fullWin.show(); fullWin.focus(); });
  fullWin.on('closed', () => {
    fullWin = null;
    if (session.status !== 'idle' && settings.showMiniOnPlay) showMini();
  });
  hideMini();
}

function closeFull() { if (fullWin && !fullWin.isDestroyed()) fullWin.close(); }

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 600,
    height: 760,
    minWidth: 480,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#15151a',
    title: `${T.appName} — ${T.sTitle}`,
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences,
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------------------------------------------------------------- tray
function trayIcon(active) {
  const img = nativeImage.createFromPath(path.join(ASSETS, active ? 'tray-active.png' : 'tray-idle.png'));
  return img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16, height: 16 }) : img;
}

function trayTooltip(s) {
  if (engineState.state === 'error') return `${T.appName} — ${T.trayError}`;
  const device = s.device ? s.device.deviceName : '';
  let line;
  if (s.status === 'playing' && s.title) line = t('trayPlaying', { title: s.title, artist: s.artist || device });
  else if (s.status === 'paused' && s.title) line = t('trayPaused', { title: s.title });
  else if (s.status !== 'idle') line = t('trayConnected', { device: device || 'iPhone' });
  else line = t('trayIdle');
  const full = `${T.appName} — ${line}`;
  return full.length > 127 ? `${full.slice(0, 124)}…` : full;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = session.snapshot();
  const active = s.status !== 'idle';
  const canControl = active && s.remoteAvailable;
  const items = [];
  if (active && s.title) {
    items.push({ label: `${s.title}${s.artist ? ` — ${s.artist}` : ''}`.slice(0, 60), enabled: false });
    items.push({ type: 'separator' });
  }
  items.push(
    { label: T.menuMini, click: () => showMini() },
    { label: T.menuFull, click: () => openFull() },
    { type: 'separator' },
    { label: T.menuPlayPause, enabled: canControl, click: () => command('playpause') },
    { label: T.menuNext, enabled: canControl, click: () => command('next') },
    { label: T.menuPrev, enabled: canControl, click: () => command('prev') },
    { type: 'separator' },
    ...(updater && updater.readyToInstall
      ? [{ label: t('menuInstallUpdate', { v: updater.state.version }), click: () => installUpdate() }]
      : [{ label: T.menuCheckUpdates, enabled: !!updater && updater.state.status !== 'disabled', click: () => { updater.check(true); openSettings(); } }]),
    { label: T.menuSettings, click: () => openSettings() },
    { label: T.menuRestart, click: () => restartEngine() },
    { label: T.menuLogs, click: () => shell.openPath(logDir) },
    { type: 'separator' },
    { label: T.menuQuit, click: () => quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(trayTooltip(s));
  tray.setImage(trayIcon(active));
}

function createTray() {
  tray = new Tray(trayIcon(false));
  tray.on('click', () => {
    if (session.status === 'idle') openSettings();
    else if (miniWin && miniWin.isVisible()) hideMini();
    else showMini();
  });
  tray.on('double-click', () => openFull());
  rebuildTrayMenu();
}

// ---------------------------------------------------------------- remote control
const COMMAND_MAP = { playpause: 'playpause', next: 'nextitem', prev: 'previtem', volup: 'volumeup', voldown: 'volumedown' };

async function command(name) {
  const dacpCmd = COMMAND_MAP[name];
  if (!dacpCmd || session.status === 'idle') return false;
  if (name === 'playpause') session.optimisticToggle();
  if (name === 'next' || name === 'prev') session.optimisticSkip();
  send('remote', name);
  try {
    return await remote.send(dacpCmd);
  } catch (e) {
    log(`command ${name} failed: ${e.message}`);
    send('remote-error', name);
    return false;
  }
}

function updateMediaKeys(active) {
  const want = active && settings.mediaKeys;
  if (want === mediaKeysOn) return;
  if (want) {
    const ok = [
      globalShortcut.register('MediaPlayPause', () => command('playpause')),
      globalShortcut.register('MediaNextTrack', () => command('next')),
      globalShortcut.register('MediaPreviousTrack', () => command('prev')),
    ];
    if (ok.includes(false)) log('some media keys are taken by another app');
  } else {
    for (const k of ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack']) globalShortcut.unregister(k);
  }
  mediaKeysOn = want;
}

// ---------------------------------------------------------------- session wiring
let lastCoverVersion = -1;
let lastTrayKey = '';

session.onChange((s) => {
  send('state', s);
  if (s.coverVersion !== lastCoverVersion) {
    lastCoverVersion = s.coverVersion;
    send('cover', session.coverDataUrl());
  }
  const trayKey = [s.status, s.title, s.artist, s.remoteAvailable, engineState.state].join('|');
  if (trayKey !== lastTrayKey) { lastTrayKey = trayKey; rebuildTrayMenu(); }

  if (s.status !== lastStatus) {
    const was = lastStatus;
    lastStatus = s.status;
    log(`session: ${was} -> ${s.status}`);
    const nowActive = s.status === 'playing' || s.status === 'paused';
    if (was === 'idle' || was === 'connected') {
      if (s.status === 'playing' && !videoActive) {
        if (settings.autoFullscreen) openFull();
        else if (settings.showMiniOnPlay && !(fullWin && !fullWin.isDestroyed())) showMini();
      }
    }
    if (s.status === 'idle') {
      hideMini();
      remote.setSession(null);
    }
    updateMediaKeys(nowActive || s.status === 'connected');
  }
});

engine.on('line', (line) => {
  if (!/audio progress/.test(line)) log(`[uxplay] ${line}`);
  session.feedLine(line);
  const ev = P.parseVideoEvent(line);
  if (ev === 'start' && !videoActive) {
    // UxPlay opens its own Direct3D video window: get our windows out of the way
    videoActive = true;
    log('video started (mirroring / AirPlay video)');
    closeFull();
    hideMini();
  } else if (ev === 'stop' && videoActive) {
    videoActive = false;
    log('video stopped');
    if ((session.status === 'playing' || session.status === 'paused') && settings.showMiniOnPlay) showMini();
  }
});

engine.on('files', async (f) => {
  if ('meta' in f) session.setMetadataText(f.meta || '');
  if ('cover' in f) session.setCoverBytes(f.cover);
  if ('dacp' in f) {
    const info = P.parseDacpFile(f.dacp);
    session.setDacp(info);
    if (info) {
      const clientIp = await engine.clientIp();
      log(`client DACP-ID ${info.dacpId}, ip ${clientIp || 'unknown'}`);
      remote.setSession({ ...info, clientIp });
      remote.resolve().catch((e) => log(`[dacp] early resolve failed: ${e.message}`));
    } else {
      remote.setSession(null);
    }
  }
});

// Safety net: if the engine keeps crashing with video enabled (driver, codec or
// plugin problem on this PC), fall back to audio-only so music keeps working.
engine.on('crash', ({ code, count, settings: used }) => {
  if (used && used.video && !videoFallback && count >= 2) {
    videoFallback = true;
    log(`engine crashed ${count}x with video on (exit ${code}); restarting audio-only`);
    send('engine', engineStatus());
    // the engine restarts itself after a crash, with engine.settings
    engine.settings = { ...engine.settings, video: false };
  }
});

engine.on('state', (st) => {
  if (st.state !== 'running') videoActive = false;
  engineState = st;
  log(`engine state: ${st.state}${st.error ? ` (${st.error})` : ''}`);
  send('engine', engineStatus());
  rebuildTrayMenu();
});

function engineStatus() {
  return { ...engineState, networkWarning, videoFallback };
}

/** Settings as the engine needs them: user settings + effective UI language. */
function engineSettings() {
  return { ...settings, uiLanguage: lang };
}

function restartEngine() {
  videoFallback = false;
  session.reset();
  session._emit();
  return engine.restart(engineSettings());
}

// ---------------------------------------------------------------- Windows checks
function checkNetworkProfile() {
  if (process.platform !== 'win32') return;
  const ps = 'Get-NetConnectionProfile | Select-Object Name,NetworkCategory | ConvertTo-Json -Compress';
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
    if (err || !out.trim()) return;
    try {
      let list = JSON.parse(out);
      if (!Array.isArray(list)) list = [list];
      // NetworkCategory: 0 = Public, 1 = Private, 2 = DomainAuthenticated (or the names)
      const pub = list.find((n) => n.NetworkCategory === 0 || n.NetworkCategory === 'Public');
      networkWarning = pub ? t('netPublic', { name: pub.Name }) : '';
      if (networkWarning) log(`network warning: ${pub.Name} is Public`);
      send('engine', engineStatus());
    } catch (_) { /* ignore */ }
  });
}

function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.autostart, args: ['--hidden'] });
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('get-init', (e) => ({
  strings: T,
  lang,
  settings,
  state: session.snapshot(),
  cover: session.coverDataUrl(),
  engine: engineStatus(),
  displays: screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `${i + 1}: ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' ★' : ''}`,
  })),
  version: app.getVersion(),
  update: updater ? updater.snapshot() : { status: 'disabled', current: app.getVersion() },
  isFull: !!(fullWin && e.sender === fullWin.webContents),
}));
ipcMain.handle('command', (_e, name) => command(name));
ipcMain.handle('save-settings', async (_e, patch) => {
  const { settings: next, engineChanged } = settingsStore.update(patch);
  const langChanged = next.language !== settings.language;
  settings = next;
  applyLanguage();
  applyAutostart();
  if (updater) updater.setAutoInstall(settings.autoUpdate);
  if (miniWin && !miniWin.isDestroyed()) miniWin.setAlwaysOnTop(settings.miniAlwaysOnTop);
  updateMediaKeys(session.status !== 'idle');
  if (engineChanged) await restartEngine();
  if (langChanged) for (const w of allWindows()) w.webContents.reload();
  rebuildTrayMenu();
  return settings;
});
ipcMain.handle('restart-engine', () => restartEngine());
ipcMain.handle('open-logs', () => shell.openPath(logDir));
ipcMain.handle('update-check', () => (updater ? updater.check(true) : null));
ipcMain.handle('update-install', () => installUpdate());

async function installUpdate() {
  if (!updater || !updater.readyToInstall) return false;
  log(`installing update ${updater.state.version}`);
  quitting = true;                 // let the updater's app.quit() through
  globalShortcut.unregisterAll();
  await engine.stop();             // installer replaces uxplay.exe: it must not be running
  return updater.install();
}
ipcMain.on('open-full', () => openFull());
ipcMain.on('close-full', () => closeFull());
ipcMain.on('open-settings', () => openSettings());
ipcMain.on('hide-mini', () => hideMini());

// ---------------------------------------------------------------- lifecycle
app.on('second-instance', () => { if (session.status !== 'idle') showMini(); else openSettings(); });
app.on('window-all-closed', () => { /* keep running in the tray */ });

async function quit() {
  quitting = true;
  globalShortcut.unregisterAll();
  await engine.stop();
  app.quit();
}

app.on('before-quit', (e) => {
  if (!quitting) { e.preventDefault(); quit(); }
});

app.whenReady().then(async () => {
  applyLanguage();
  log(`Flick AirPlay ${app.getVersion()} starting, engine: ${engineDir}`);
  createTray();
  createMini(); // preload so it appears instantly on first play
  applyAutostart();
  setInterval(() => session.housekeeping(), 500);
  // keep progress bars moving in open windows without flooding IPC
  setInterval(() => { if (session.status === 'playing') send('state', session.snapshot()); }, 1000);
  await engine.start(engineSettings());
  checkNetworkProfile();

  updater = new Updater({
    autoUpdater: app.isPackaged ? loadAutoUpdater(log) : null,
    enabled: app.isPackaged,
    autoInstall: settings.autoUpdate,
    currentVersion: app.getVersion(),
    log,
  });
  updater.on('state', (st) => { send('update', st); rebuildTrayMenu(); });
  updater.on('downloaded', (v) => {
    if (updateNotified === v || !Notification.isSupported()) return;
    updateNotified = v;
    const n = new Notification({ title: t('notifyUpdateTitle', { v }), body: T.notifyUpdateBody, icon: path.join(ASSETS, 'icon.png') });
    n.on('click', () => openSettings());
    n.show();
  });
  updater.start();
  screen.on('display-added', () => send('displays-changed'));
  screen.on('display-removed', () => send('displays-changed'));

  const firstRunFlag = path.join(userDir, '.first-run-done');
  if (!fs.existsSync(firstRunFlag)) {
    fs.writeFileSync(firstRunFlag, '1');
    if (Notification.isSupported()) {
      new Notification({ title: T.firstRunTitle, body: t('firstRunBody', { name: settings.deviceName }), icon: path.join(ASSETS, 'icon.png') }).show();
    }
    if (!process.argv.includes('--hidden')) openSettings();
  }
});
