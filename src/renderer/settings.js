(() => {
'use strict';
const { ICONS, fmt } = window.FlickUI;
const $ = (id) => document.getElementById(id);

const TOGGLES = ['autostart', 'showMiniOnPlay', 'autoFullscreen', 'miniAlwaysOnTop', 'mediaKeys', 'taperVolume', 'allowTakeover', 'video', 'videoFullscreen', 'autoUpdate'];
const LABELS = {
  hGeneral: 'sGeneral', lName: 'sDeviceName', lNameHint: 'sDeviceNameHint', lLang: 'sLanguage', oLangAuto: 'sLangAuto',
  lAutostart: 'sAutostart', hPlayer: 'sPlayer', lShowMini: 'sShowMini', lAutoFull: 'sAutoFull', lDisplay: 'sFullDisplay',
  lOnTop: 'sOnTop', lMediaKeys: 'sMediaKeys', hSound: 'sSound', lTaper: 'sTaper', lSink: 'sAudioSink', oSinkAuto: 'sAudioAuto',
  hConn: 'sConnection', lTakeover: 'sTakeover', lVideo: 'sVideo', lVideoHint: 'sVideoHint', lVideoFull: 'sVideoFull', lStatus: 'sStatus',
  hUpdates: 'sUpdates', lAutoUpdate: 'sAutoUpdate', upCheck: 'upCheck', upInstall: 'upInstall',
  restart: 'sRestart', logs: 'sLogs', save: 'sSave', saved: 'sSaved',
};
const STATE_KEYS = { starting: 'stStarting', running: 'stRunning', restarting: 'stRestarting', error: 'stError', stopped: 'stStopped' };

(async () => {
  const init = await window.flick.init();
  const T = init.strings;
  document.documentElement.lang = init.lang;
  document.title = `Flick AirPlay — ${T.sTitle}`;
  $('logo').innerHTML = ICONS.airplay;
  $('ver').textContent = `v${init.version}`;
  for (const [id, key] of Object.entries(LABELS)) $(id).textContent = T[key];

  function fillDisplays(displays, selected) {
    const sel = $('fullscreenDisplay');
    sel.innerHTML = '';
    const auto = new Option(T.sDisplayAuto, 'auto');
    sel.add(auto);
    for (const d of displays) sel.add(new Option(d.label, d.id));
    sel.value = [...sel.options].some((o) => o.value === selected) ? selected : 'auto';
  }

  function load(s) {
    $('deviceName').value = s.deviceName;
    $('language').value = s.language;
    $('audioSink').value = s.audioSink;
    for (const k of TOGGLES) $(k).checked = !!s[k];
    fillDisplays(init.displays, s.fullscreenDisplay);
  }
  load(init.settings);

  function showEngine(e) {
    $('dot').className = `dot ${e.state}`;
    $('statusVal').textContent = fmt(T[STATE_KEYS[e.state]] || e.state, { error: e.error || '?' });
    const warns = [e.videoFallback ? T.videoFallback : '', e.networkWarning || ''].filter(Boolean);
    $('warn').hidden = !warns.length;
    $('warn').textContent = warns.join('\n\n');
  }
  showEngine(init.engine);
  window.flick.onEngine(showEngine);
  window.flick.onDisplaysChanged(async () => {
    const fresh = await window.flick.init();
    fillDisplays(fresh.displays, $('fullscreenDisplay').value);
  });

  // ---- updates
  function showUpdate(u) {
    $('upVersion').textContent = fmt(T.sVersionLine, { v: u.current || init.version });
    const st = $('upStatus');
    st.className = '';
    const text = {
      disabled: T.upDisabled,
      idle: T.upIdle,
      checking: T.upChecking,
      uptodate: T.upLatest,
      downloading: fmt(T.upDownloading, { v: u.version, p: u.percent || 0 }),
      downloaded: fmt(T.upReady, { v: u.version }),
      error: fmt(T.upError, { error: u.error }),
    }[u.status] || '';
    st.textContent = text;
    if (u.status === 'error') st.className = 'err';
    if (u.status === 'downloaded') st.className = 'ready';
    $('upBar').hidden = u.status !== 'downloading';
    $('upFill').style.width = `${u.percent || 0}%`;
    $('upCheck').hidden = u.status === 'downloaded';
    $('upCheck').disabled = ['disabled', 'checking', 'downloading'].includes(u.status);
    $('upInstall').hidden = u.status !== 'downloaded';
  }
  showUpdate(init.update);
  window.flick.onUpdate(showUpdate);
  $('upCheck').onclick = () => window.flick.checkUpdate();
  $('upInstall').onclick = () => { $('upInstall').disabled = true; window.flick.installUpdate(); };

  $('restart').onclick = () => window.flick.restartEngine();
  $('logs').onclick = () => window.flick.openLogs();

  async function save() {
    const patch = {
      deviceName: $('deviceName').value,
      language: $('language').value,
      audioSink: $('audioSink').value,
      fullscreenDisplay: $('fullscreenDisplay').value,
    };
    for (const k of TOGGLES) patch[k] = $(k).checked;
    $('save').disabled = true;
    try {
      const s = await window.flick.saveSettings(patch);
      load(s);
      $('saved').classList.add('show');
      setTimeout(() => $('saved').classList.remove('show'), 1800);
    } finally {
      $('save').disabled = false;
    }
  }
  $('save').onclick = save;
  window.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'deviceName') save(); });
})();
})();
