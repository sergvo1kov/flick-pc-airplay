(() => {
'use strict';
const { ICONS, fmt, fmtTime, CoverView, setTint, pulse, bindKeys, boot } = window.FlickUI;
const $ = (id) => document.getElementById(id);

boot(({ store, T, init }) => {
  $('brandGlyph').innerHTML = ICONS.airplay;
  $('idleGlyph').innerHTML = ICONS.airplay;
  $('settings').innerHTML = ICONS.settings; $('settings').title = T.menuSettings;
  $('exit').innerHTML = ICONS.close; $('exit').title = T.exitHint;
  $('prev').innerHTML = ICONS.prev; $('prev').title = T.menuPrev;
  $('next').innerHTML = ICONS.next; $('next').title = T.menuNext;
  $('play').title = T.menuPlayPause;
  $('pill').textContent = T.paused;
  $('hint').textContent = T.exitHint;
  $('idleTitle').textContent = T.idleTitle;
  const hint = fmt(T.idleHint, { name: '\u0000' }).split('\u0000');
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = init.settings.deviceName;
  $('idleHint').append(hint[0], nameEl, hint[1] || '');

  // backdrop layers follow the cover
  let bgFront = $('bgA');
  function setBackdrop(url) {
    if (!url) { $('bgA').classList.remove('on'); $('bgB').classList.remove('on'); return; }
    const back = bgFront === $('bgA') ? $('bgB') : $('bgA');
    back.onload = () => { back.classList.add('on'); bgFront.classList.remove('on'); bgFront = back; };
    back.src = url;
  }
  const cover = new CoverView($('cover'), { onColor: setTint });
  function applyCover(url) {
    cover.set(url);
    setBackdrop(url);
    document.body.classList.toggle('has-art', !!url);
  }
  applyCover(store.cover);
  window.flick.onCover(applyCover);

  $('prev').onclick = () => window.flick.command('prev');
  $('next').onclick = () => window.flick.command('next');
  $('play').onclick = () => window.flick.command('playpause');
  $('exit').onclick = () => window.flick.closeFull();
  $('settings').onclick = () => window.flick.openSettings();
  document.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) window.flick.closeFull(); });
  bindKeys({ Escape: () => window.flick.closeFull(), KeyF: () => window.flick.closeFull() });

  // Controls fade out after inactivity and briefly come back on remote use (tvOS-like).
  let idleTimer = null;
  function wake(ms = 4000) {
    document.body.classList.remove('idle-ui', 'hide-cursor');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle-ui', 'hide-cursor'), ms);
  }
  ['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, () => wake()));
  wake();
  window.flick.onRemote((cmd) => {
    wake(2500);
    pulse({ playpause: $('play'), next: $('next'), prev: $('prev') }[cmd]);
  });
  window.flick.onRemoteError(() => { $('note').textContent = T.remoteUnavailable; setTimeout(() => { $('note').textContent = ''; }, 4000); });

  let lastTrack = -1;
  function render(s) {
    const idle = s.status === 'idle';
    document.body.classList.toggle('state-idle', idle);
    document.body.classList.toggle('paused', !idle && !!s.paused);
    if (idle) return;
    const device = s.device ? s.device.deviceName : 'iPhone';
    $('source').textContent = fmt(T.from, { device });
    const hasMeta = !!s.title;
    $('title').textContent = hasMeta ? s.title : fmt(T.audioFrom, { device });
    $('artist').textContent = hasMeta ? (s.artist || '') : '';
    $('album').textContent = hasMeta ? (s.album || '') : '';
    if (s.trackVersion !== lastTrack) {
      lastTrack = s.trackVersion;
      for (const id of ['title', 'artist', 'album']) { $(id).classList.remove('fade-in'); void $(id).offsetWidth; $(id).classList.add('fade-in'); }
    }
    $('play').innerHTML = s.paused ? ICONS.play : ICONS.pause;
    $('dur').textContent = fmtTime(s.duration);
    document.querySelector('.progress').style.visibility = s.duration ? 'visible' : 'hidden';
    for (const id of ['prev', 'play', 'next']) $(id).disabled = !s.remoteAvailable;
  }
  store.onChange(render);
  render(store.state);

  (function frame() {
    const s = store.state;
    const pos = store.position();
    $('fill').style.width = s.duration ? `${(pos / s.duration) * 100}%` : '0%';
    $('pos').textContent = fmtTime(pos);
    requestAnimationFrame(frame);
  })();

  function tickClock() {
    const d = new Date();
    $('clock').textContent = d.toLocaleTimeString(init.lang, { hour: '2-digit', minute: '2-digit' });
  }
  tickClock();
  setInterval(tickClock, 5000);
});
})();
