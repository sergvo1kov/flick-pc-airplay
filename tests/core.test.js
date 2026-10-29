'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const mdns = require('../src/main/mdns');
const P = require('../src/main/parsers');
const { Session, PAUSE_DETECT_MS, PAUSED_CARD_TIMEOUT_MS, DISCONNECT_GRACE_MS } = require('../src/main/session');
const { DacpRemote } = require('../src/main/dacp');
const { buildRc, LineSplitter, engineEnv } = require('../src/main/engine');
const { SettingsStore, sanitize } = require('../src/main/settings');
const i18n = require('../src/main/i18n');

// ------------------------------------------------------------------ mDNS
test('mdns: query round-trips through the parser', () => {
  const q = mdns.buildQuery([{ name: 'iTunes_Ctrl_ABC._dacp._tcp.local', type: mdns.TYPE.SRV, unicastResponse: true }], 0x1234);
  const m = mdns.parseMessage(q);
  assert.equal(m.id, 0x1234);
  assert.deepEqual(m.questions, [{ name: 'iTunes_Ctrl_ABC._dacp._tcp.local', type: mdns.TYPE.SRV }]);
});

test('mdns: parses compressed SRV + A records', () => {
  // hand-built response with a compression pointer for the SRV target suffix
  const header = Buffer.from([0, 7, 0x84, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
  const name = mdns.encodeName('iTunes_Ctrl_X._dacp._tcp.local'); // at offset 12
  const localOffset = 12 + name.length - 7; // "local" label starts 7 bytes before end (5+len+0)
  const srvMeta = Buffer.alloc(10);
  const target = Buffer.concat([Buffer.from([6]), Buffer.from('iPhone'), Buffer.from([0xc0, localOffset])]);
  const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x0d, 0xe7]), target]);
  srvMeta.writeUInt16BE(33, 0); srvMeta.writeUInt16BE(1, 2); srvMeta.writeUInt32BE(120, 4); srvMeta.writeUInt16BE(srvData.length, 8);
  const targetOffset = 12 + name.length + 10 + 6;
  const aName = Buffer.from([0xc0, targetOffset]);
  const aMeta = Buffer.alloc(10);
  aMeta.writeUInt16BE(1, 0); aMeta.writeUInt16BE(1, 2); aMeta.writeUInt32BE(120, 4); aMeta.writeUInt16BE(4, 8);
  const buf = Buffer.concat([header, name, srvMeta, srvData, aName, aMeta, Buffer.from([192, 168, 1, 23])]);
  const m = mdns.parseMessage(buf);
  assert.equal(m.answers[0].data.port, 3559);
  assert.equal(m.answers[0].data.target, 'iPhone.local');
  assert.equal(m.answers[1].name, 'iPhone.local');
  assert.equal(m.answers[1].data, '192.168.1.23');
});

test('mdns: compression loops are rejected', () => {
  const buf = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from([0xc0, 12, 0, 1, 0, 1])]);
  assert.throws(() => mdns.parseMessage(buf), /loop|bounds/);
});

// ------------------------------------------------------------------ parsers
test('parsers: metadata text from UxPlay -md', () => {
  const text = 'Album: Late Drive\nArtist: Northern Echo\nTitle: Midnight City\nGenre: Synthwave\nSort Name: x\n\0';
  assert.deepEqual(P.parseMetadata(text), { album: 'Late Drive', artist: 'Northern Echo', title: 'Midnight City', genre: 'Synthwave' });
  assert.deepEqual(P.parseMetadata('no data\n'), {});
  assert.deepEqual(P.parseMetadata('Title: Пісня: друга частина\n'), { title: 'Пісня: друга частина' });
});

test('parsers: progress and connection lines', () => {
  assert.deepEqual(
    P.parseProgress('audio progress (min:sec):   1:05; remaining:   2:10; track length 3:15'),
    { position: 65, duration: 195 },
  );
  assert.equal(P.parseProgress('random'), null);
  assert.deepEqual(
    P.parseConnection('connection request from iPhone Сергея (iPhone15,2) with deviceID = 1A:2B:3C:4D:5E:6F'),
    { deviceName: 'iPhone Сергея', deviceModel: 'iPhone15,2', deviceId: '1A:2B:3C:4D:5E:6F' },
  );
  assert.deepEqual(P.parseDacpFile('A1B2C3D4E5F60718\n1986535575\n'), { dacpId: 'A1B2C3D4E5F60718', activeRemote: '1986535575' });
  assert.equal(P.parseDacpFile(''), null);
});

test('parsers: placeholder PNG is not a cover, JPEG is', () => {
  const png1x1 = Buffer.alloc(300); png1x1[0] = 0x89; png1x1[1] = 0x50; png1x1.writeUInt32BE(1, 16); png1x1.writeUInt32BE(1, 20);
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const jpeg = fs.readFileSync(path.join(__dirname, 'ui', 'sample-cover.jpg'));
  assert.equal(P.isRealCover(png1x1), false);
  assert.equal(P.isRealCover(tinyPng), false);
  assert.equal(P.isRealCover(jpeg), true);
});

test('parsers: netstat peers of the engine process', () => {
  const out = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:7000           0.0.0.0:0              LISTENING       4242',
    '  TCP    192.168.1.5:7000       192.168.1.23:51234     ESTABLISHED     4242',
    '  TCP    192.168.1.5:7000       192.168.1.23:51235     ESTABLISHED     4242',
    '  TCP    192.168.1.5:50000      142.250.1.1:443        ESTABLISHED     999',
    '  TCP    127.0.0.1:7001         127.0.0.1:6000         ESTABLISHED     4242',
  ].join('\r\n');
  const peers = P.parseNetstat(out, 4242);
  assert.equal(peers.length, 2);
  assert.equal(P.pickClientIp(peers), '192.168.1.23');
});

// ------------------------------------------------------------------ session
function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, add: (ms) => { c.t += ms; } };
  return c;
}
const PROG = (p, d) => `audio progress (min:sec): ${Math.floor(p / 60)}:${String(p % 60).padStart(2, '0')}; remaining: 0:00; track length ${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;

test('session: idle -> playing -> paused (freezes) -> playing', () => {
  const c = clock();
  const s = new Session({ now: c.now });
  assert.equal(s.status, 'idle');
  s.feedLine('connection request from iPad (iPad13,1) with deviceID = AA:BB:CC:DD:EE:FF');
  s.setDacp({ dacpId: 'X', activeRemote: '1' });
  assert.equal(s.status, 'connected');
  s.setMetadataText('Title: Song\nArtist: Band\n');
  s.feedLine(PROG(10, 200));
  assert.equal(s.status, 'playing');
  c.add(1000); s.feedLine(PROG(11, 200));
  c.add(500);
  assert.ok(Math.abs(s.positionAt() - 11.5) < 0.01);
  // ticks stop => paused after detection window; position frozen
  c.add(PAUSE_DETECT_MS + 100); s.housekeeping();
  assert.equal(s.status, 'paused');
  const frozen = s.positionAt();
  c.add(10_000);
  assert.equal(s.positionAt(), frozen);
  assert.ok(frozen <= 12.01, `frozen at ${frozen}`);
  // resume
  s.feedLine(PROG(12, 200));
  assert.equal(s.status, 'playing');
});

test('session: optimistic pause is not undone by in-flight ticks', () => {
  const c = clock();
  const s = new Session({ now: c.now });
  s.setDacp({ dacpId: 'X', activeRemote: '1' });
  s.feedLine(PROG(30, 200));
  s.optimisticToggle();
  assert.equal(s.status, 'paused');
  c.add(400); s.feedLine(PROG(31, 200)); // tick that was already on its way
  assert.equal(s.status, 'paused');
  c.add(5000); s.housekeeping();
  assert.equal(s.status, 'paused'); // iPhone really paused: no ticks
});

test('session: optimistic play self-corrects if the phone did not react', () => {
  const c = clock();
  const s = new Session({ now: c.now });
  s.setDacp({ dacpId: 'X', activeRemote: '1' });
  s.feedLine(PROG(30, 200));
  c.add(PAUSE_DETECT_MS + 100); s.housekeeping();
  assert.equal(s.status, 'paused');
  s.optimisticToggle();
  assert.equal(s.status, 'playing');
  c.add(4000); s.housekeeping();
  assert.equal(s.status, 'paused');
});

test('session: new track resets position, metadata cleared on disconnect', () => {
  const c = clock();
  const s = new Session({ now: c.now });
  s.setDacp({ dacpId: 'X', activeRemote: '1' });
  s.setMetadataText('Title: A\n');
  s.feedLine(PROG(100, 200));
  const v = s.trackVersion;
  s.setMetadataText('Title: B\n');
  assert.equal(s.trackVersion, v + 1);
  assert.equal(Math.round(s.positionAt()), 0);
  s.setDacp(null);
  c.add(DISCONNECT_GRACE_MS + 1000); s.housekeeping();
  assert.equal(s.status, 'idle');
  assert.equal(s.snapshot().title, '');
});

test('session: paused card times out after 15 minutes', () => {
  const c = clock();
  const s = new Session({ now: c.now });
  s.setDacp({ dacpId: 'X', activeRemote: '1' });
  s.setMetadataText('Title: A\n');
  s.feedLine(PROG(5, 200));
  c.add(PAUSE_DETECT_MS + 100); s.housekeeping();
  assert.equal(s.status, 'paused');
  c.add(PAUSED_CARD_TIMEOUT_MS + 1000); s.housekeeping();
  assert.equal(s.snapshot().title, '');
  assert.equal(s.status, 'connected');
});

test('session: identical cover is de-duplicated', () => {
  const s = new Session();
  const jpeg = fs.readFileSync(path.join(__dirname, 'ui', 'sample-cover.jpg'));
  let emits = 0;
  s.onChange(() => emits++);
  s.setCoverBytes(jpeg);
  s.setCoverBytes(Buffer.from(jpeg));
  assert.equal(emits, 1);
  assert.match(s.coverDataUrl(), /^data:image\/jpeg;base64,/);
});

// ------------------------------------------------------------------ DACP end-to-end with a fake iPhone
test('dacp: resolves via unicast mDNS and sends commands with Active-Remote', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, remote: req.headers['active-remote'] });
    res.statusCode = req.headers['active-remote'] === '777' ? 204 : 403;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const httpPort = server.address().port;

  const responder = dgram.createSocket('udp4');
  await new Promise((r) => responder.bind(0, '127.0.0.1', r));
  responder.on('message', (buf, rinfo) => {
    const q = mdns.parseMessage(buf);
    assert.equal(q.questions[0].name, 'iTunes_Ctrl_DEADBEEF._dacp._tcp.local');
    const resp = mdns.buildResponse(q.id, [
      { name: 'iTunes_Ctrl_DEADBEEF._dacp._tcp.local', type: mdns.TYPE.SRV, data: { port: httpPort, target: 'Phone.local' } },
      { name: 'Phone.local', type: mdns.TYPE.A, data: '127.0.0.1' },
    ]);
    responder.send(resp, rinfo.port, rinfo.address);
  });

  const remote = new DacpRemote({ mdnsPort: responder.address().port, multicast: false, resolveTimeoutMs: 800 });
  remote.setSession({ dacpId: 'DEADBEEF', activeRemote: '777', clientIp: '127.0.0.1' });
  assert.equal(await remote.send('playpause'), true);
  await Promise.all([remote.send('nextitem'), remote.send('previtem')]);
  assert.deepEqual(hits.map((h) => h.url), ['/ctrl-int/1/playpause', '/ctrl-int/1/nextitem', '/ctrl-int/1/previtem']);
  assert.ok(hits.every((h) => h.remote === '777'));

  // port moves (phone restarted its DACP server): command re-resolves and still lands
  server.close();
  const server2 = http.createServer((req, res) => { hits.push({ url: req.url }); res.statusCode = 204; res.end(); });
  await new Promise((r) => server2.listen(httpPort, '127.0.0.1', r));
  assert.equal(await remote.send('volumeup'), true);

  await assert.rejects(remote.send('rm -rf'), /Unknown DACP command/);
  remote.setSession(null);
  await assert.rejects(remote.send('playpause'), /No AirPlay client/);
  server2.close();
  responder.close();
});

// ------------------------------------------------------------------ engine helpers
test('engine: rc file keeps a Cyrillic name intact and uses relative paths', () => {
  const rc = buildRc({ deviceName: 'ПК Сергія "Flick"', taperVolume: true, allowTakeover: true, mirroring: false, audioSink: 'auto' });
  assert.match(rc, /^n "ПК Сергія 'Flick'"$/m);
  assert.match(rc, /^vs 0$/m);
  assert.match(rc, /^ca cover\.jpg$/m);
  assert.match(rc, /^md meta\.txt$/m);
  assert.match(rc, /^dacp dacp\.txt$/m);
  assert.match(rc, /^taper$/m);
  assert.match(rc, /^nohold$/m);
  assert.doesNotMatch(rc, /^as /m);
  const video = buildRc({ deviceName: 'x', video: true, videoFullscreen: true, audioSink: 'wasapi2sink' });
  assert.match(video, /^vs d3d11videosink$/m);
  assert.match(video, /^hls$/m);
  assert.match(video, /^fs$/m);
  assert.match(video, /^as wasapi2sink$/m);
  assert.doesNotMatch(buildRc({ deviceName: 'x', video: true, videoFullscreen: false }), /^fs$/m);
});

test('parsers: video start/stop markers from UxPlay', () => {
  assert.equal(P.parseVideoEvent('raop_rtp_mirror starting mirroring'), 'start');
  assert.equal(P.parseVideoEvent('********************on_video_play: location = http://localhost:7100/master.m3u8*** start position 0.0'), 'start');
  assert.equal(P.parseVideoEvent('**************************on_video_stop'), 'stop');
  assert.equal(P.parseVideoEvent(' video has finished, 212.3'), 'stop');
  assert.equal(P.parseVideoEvent('audio progress (min:sec): 0:01; remaining: 1:00; track length 1:01'), null);
});

test('engine: line splitter handles \\r progress redraws and split chunks', () => {
  const lines = [];
  const s = new LineSplitter((l) => lines.push(l));
  s.push('audio progress (min:sec): 0:01; remaining: 1:00; track length 1:01\raudio prog');
  s.push('ress (min:sec): 0:02; remaining: 0:59; track length 1:01\rconnection request from A (B) with deviceID = 01\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(P.parseProgress(lines[1]), { position: 2, duration: 61 });
});

test('engine: env replaces PATH case-insensitively and drops UXPLAYRC', () => {
  const env = engineEnv('C:\\eng', 'C:\\rt', { Path: 'C:\\Windows', UXPLAYRC: 'x', FOO: '1' });
  assert.equal(env.Path, undefined);
  assert.equal(env.UXPLAYRC, undefined);
  assert.ok(env.PATH.startsWith(path.join('C:\\eng', 'bin')));
  assert.ok(env.PATH.endsWith('C:\\Windows'));
  assert.equal(env.FOO, '1');
});

// ------------------------------------------------------------------ settings / i18n
test('settings: sanitize and persist, engine change detection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flick-'));
  const store = new SettingsStore(dir);
  assert.equal(store.get().deviceName, 'Flick AirPlay');
  let r = store.update({ autoFullscreen: true });
  assert.equal(r.engineChanged, false);
  r = store.update({ deviceName: '  Мій "ПК"\n ' });
  assert.equal(r.engineChanged, true);
  assert.equal(r.settings.deviceName, 'Мій ПК');
  assert.equal(new SettingsStore(dir).get().deviceName, 'Мій ПК');
  assert.equal(sanitize({ language: 'xx', audioSink: 'evil' }).language, 'auto');
  assert.equal(sanitize({ autostart: 'yes' }).autostart, true); // wrong type -> default
  assert.equal(sanitize({}).video, true);   // video on by default
  assert.equal(sanitize({ mirroring: false }).video, true); // old v0.1 key is ignored
});

test('i18n: every language has every key', () => {
  const keys = Object.keys(i18n.STRINGS.en).sort();
  for (const l of ['uk', 'ru']) assert.deepEqual(Object.keys(i18n.STRINGS[l]).sort(), keys, l);
  assert.equal(i18n.pickLanguage('auto', 'uk-UA'), 'uk');
  assert.equal(i18n.pickLanguage('auto', 'ru-RU'), 'ru');
  assert.equal(i18n.pickLanguage('auto', 'de-DE'), 'en');
  assert.equal(i18n.pickLanguage('ru', 'uk-UA'), 'ru');
});

test('engine: crash event lets the app switch the next restart to audio-only', async () => {
  const { Engine } = require('../src/main/engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  const binDir = path.join(dir, 'engine', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  // fake uxplay.exe: dies like g_error/abort when the rc asks for video
  fs.writeFileSync(path.join(binDir, 'uxplay.exe'),
    '#!/bin/sh\nif grep -q "^vs d3d11" "$2"; then exit 3; fi\necho "Initialized server socket(s)"\nsleep 30\n', { mode: 0o755 });
  const eng = new Engine({ engineDir: path.join(dir, 'engine'), runtimeDir: path.join(dir, 'rt') });
  let fallback = false;
  eng.on('crash', ({ count, settings: used }) => {
    if (used.video && !fallback && count >= 2) { fallback = true; eng.settings = { ...eng.settings, video: false }; }
  });
  await eng.start({ deviceName: 'x', video: true });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !(fallback && eng.state === 'running' && eng.proc)) await new Promise((r) => setTimeout(r, 100));
  assert.equal(fallback, true);
  assert.equal(eng.state, 'running');
  assert.match(fs.readFileSync(path.join(dir, 'rt', 'uxplay.rc'), 'utf8'), /^vs 0$/m);
  await eng.stop();
});
