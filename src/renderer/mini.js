(() => {
'use strict';
  const { ICONS, fmt, fmtTime, CoverView, setTint, pulse, bindKeys, boot } = window.FlickUI;
  const $ = (id) => document.getElementById(id);

  boot(({ store, T, init }) => {
    $('full').innerHTML = ICONS.expand; $('full').title = T.menuFull;
    $('close').innerHTML = ICONS.close;
    $('prev').innerHTML = ICONS.prev; $('prev').title = T.menuPrev;
    $('next').innerHTML = ICONS.next; $('next').title = T.menuNext;

    const cover = new CoverView($('cover'), { onColor: setTint });
    cover.set(store.cover);
    window.flick.onCover((url) => cover.set(url));

    function showPinned(pinned) {
      document.body.classList.toggle('pinned', !!pinned);
      $('pin').innerHTML = pinned ? ICONS.pinned : ICONS.pin;
      $('pin').title = pinned ? T.unpinMini : T.pinMini;
    }
    showPinned(init.pinned);
    window.flick.onPinned(showPinned);
    $('pin').onclick = () => window.flick.togglePin();

    // Drag anywhere except buttons. Screen coordinates stay valid while the
    // window moves under the cursor; moves are batched per animation frame.
    let drag = null;
    let pending = null;
    document.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      drag = { x: e.screenX, y: e.screenY, moved: false, id: e.pointerId };
      try { document.body.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    document.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.screenX - drag.x;
      const dy = e.screenY - drag.y;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;   // a click, not a drag
        drag.moved = true;
        document.body.classList.add('dragging');
        window.flick.dragStart();
      }
      if (!pending) requestAnimationFrame(() => { if (pending) window.flick.dragMove(pending.dx, pending.dy); pending = null; });
      pending = { dx, dy };
    });
    const endDrag = () => {
      if (!drag) return;
      if (drag.moved) {
        if (pending) window.flick.dragMove(pending.dx, pending.dy);
        pending = null;
        window.flick.dragEnd();
      }
      try { document.body.releasePointerCapture(drag.id); } catch (_) { /* ignore */ }
      document.body.classList.remove('dragging');
      drag = null;
    };
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    $('full').onclick = () => window.flick.openFull();
    $('close').onclick = () => window.flick.hideMini();
    $('prev').onclick = () => window.flick.command('prev');
    $('next').onclick = () => window.flick.command('next');
    $('play').onclick = () => window.flick.command('playpause');
    window.flick.onRemote((cmd) => pulse({ playpause: $('play'), next: $('next'), prev: $('prev') }[cmd]));
    bindKeys({ Escape: () => window.flick.hideMini(), KeyF: () => window.flick.openFull() });

    let lastTrack = -1;
    function render(s) {
      const device = s.device ? s.device.deviceName : 'iPhone';
      document.body.classList.toggle('paused', !!s.paused && s.status !== 'idle');
      document.body.classList.toggle('no-remote', !s.remoteAvailable);
      $('source').innerHTML = '';
      const src = document.createElement('span');
      src.textContent = fmt(T.from, { device }).replace(device, '');
      const b = document.createElement('b');
      b.textContent = device;
      $('source').append(src, b);
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = T.paused;
      $('source').append(pill);

      const hasMeta = !!s.title;
      $('title').textContent = hasMeta ? s.title : fmt(T.audioFrom, { device });
      $('artist').textContent = hasMeta ? [s.artist, s.album].filter(Boolean).join(' — ') : '';
      if (s.trackVersion !== lastTrack) {
        lastTrack = s.trackVersion;
        for (const id of ['title', 'artist']) { $(id).classList.remove('fade-in'); void $(id).offsetWidth; $(id).classList.add('fade-in'); }
      }
      $('play').innerHTML = s.paused ? ICONS.play : ICONS.pause;
      $('play').title = T.menuPlayPause;
      $('dur').textContent = fmtTime(s.duration);
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
  });
})();
