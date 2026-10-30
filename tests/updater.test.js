'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { Updater } = require('../src/main/updater');
const { parseLatestYml } = require('../scripts/check-update-feed');

/** Fake electron-updater: checkForUpdates() plays back a scripted sequence of events. */
class FakeAutoUpdater extends EventEmitter {
  constructor(script) { super(); this.script = script; this.installed = null; this.checks = 0; }
  async checkForUpdates() {
    this.checks++;
    for (const [ev, arg] of this.script) this.emit(ev, arg);
  }
  quitAndInstall(silent, runAfter) { this.installed = { silent, runAfter }; }
}

test('updater: disabled in dev builds, never touches electron-updater', async () => {
  const u = new Updater({ autoUpdater: null, enabled: false, currentVersion: '0.2.0' });
  assert.equal(u.snapshot().status, 'disabled');
  assert.equal((await u.check()).status, 'disabled');
  assert.equal(u.install(), false);
});

test('updater: available -> downloading -> downloaded -> install', async () => {
  const fake = new FakeAutoUpdater([
    ['checking-for-update'],
    ['update-available', { version: '0.3.0' }],
    ['download-progress', { percent: 42.4 }],
    ['update-downloaded', { version: '0.3.0' }],
  ]);
  const u = new Updater({ autoUpdater: fake, enabled: true, currentVersion: '0.2.0' });
  const seen = [];
  let downloaded = null;
  u.on('state', (s) => seen.push(`${s.status}${s.percent ? `:${s.percent}` : ''}`));
  u.on('downloaded', (v) => { downloaded = v; });
  assert.equal(fake.autoDownload, true);
  assert.equal(fake.autoInstallOnAppQuit, true);
  await u.check(true);
  assert.deepEqual(seen, ['checking', 'checking', 'downloading', 'downloading:42', 'downloaded:100']);
  assert.equal(downloaded, '0.3.0');
  assert.equal(u.readyToInstall, true);
  // a second check while an update waits must not re-download
  await u.check(true);
  assert.equal(fake.checks, 1);
  assert.equal(u.install(), true);
  assert.deepEqual(fake.installed, { silent: true, runAfter: true });
});

test('updater: up to date, and errors only surface on manual checks', async () => {
  const fake = new FakeAutoUpdater([['checking-for-update'], ['update-not-available', {}]]);
  const u = new Updater({ autoUpdater: fake, enabled: true });
  await u.check(true);
  assert.equal(u.snapshot().status, 'uptodate');

  fake.script = [['checking-for-update'], ['error', new Error('net::ERR_INTERNET_DISCONNECTED\nstack…')]];
  await u.check(false); // background check: stay quiet
  assert.equal(u.snapshot().status, 'idle');
  await u.check(true);  // user pressed "Check"
  assert.equal(u.snapshot().status, 'error');
  assert.equal(u.snapshot().error, 'net::ERR_INTERNET_DISCONNECTED');
});

test('updater: auto-install toggle reaches electron-updater', () => {
  const fake = new FakeAutoUpdater([]);
  const u = new Updater({ autoUpdater: fake, enabled: true, autoInstall: false });
  assert.equal(fake.autoInstallOnAppQuit, false);
  u.setAutoInstall(true);
  assert.equal(fake.autoInstallOnAppQuit, true);
});

// ---------------------------------------------------------------- OTA feed check script
function makeDist(tamper = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
  const exeName = 'FlickAirPlay-Setup-0.3.0.exe';
  const buf = crypto.randomBytes(4096);
  fs.writeFileSync(path.join(dir, exeName), buf);
  fs.writeFileSync(path.join(dir, `${exeName}.blockmap`), 'x');
  const sha = crypto.createHash('sha512').update(tamper ? Buffer.from('other') : buf).digest('base64');
  // exactly the shape electron-builder writes
  fs.writeFileSync(path.join(dir, 'latest.yml'), [
    'version: 0.3.0',
    'files:',
    `  - url: ${exeName}`,
    `    sha512: ${sha}`,
    `    size: ${buf.length}`,
    `path: ${exeName}`,
    `sha512: ${sha}`,
    "releaseDate: '2026-10-29T16:40:00.000Z'",
    '',
  ].join('\n'));
  return dir;
}

test('feed: latest.yml parser reads electron-builder format', () => {
  const dir = makeDist();
  const feed = parseLatestYml(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'));
  assert.equal(feed.version, '0.3.0');
  assert.equal(feed.path, 'FlickAirPlay-Setup-0.3.0.exe');
  assert.equal(feed.files.length, 1);
  assert.equal(feed.files[0].size, '4096');
  assert.equal(feed.releaseDate, '2026-10-29T16:40:00.000Z');
});

test('feed: local check passes on a good build and fails on a bad one', () => {
  const script = path.join(__dirname, '..', 'scripts', 'check-update-feed.js');
  const good = execFileSync('node', [script, 'local', makeDist(), '0.3.0'], { encoding: 'utf8' });
  assert.match(good, /sha512 matches installer/);
  assert.throws(() => execFileSync('node', [script, 'local', makeDist(true), '0.3.0'], { stdio: 'pipe' }));
  assert.throws(() => execFileSync('node', [script, 'local', makeDist(), '9.9.9'], { stdio: 'pipe' }));
});

test('release notes: built from CHANGELOG.md for every released version', () => {
  const { changelogSection, releaseNotes } = require('../scripts/release-notes');
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  for (const v of ['0.1.0', '0.2.0', '0.2.1', '0.2.2', '0.2.3']) {
    const sec = changelogSection(text, v);
    assert.ok(sec && sec.length > 40, `CHANGELOG has a section for ${v}`);
    assert.ok(!/^## /m.test(sec), `${v} section does not swallow the next one`);
  }
  const notes = releaseNotes(text, '0.2.3', 'a/b');
  assert.match(notes, /releases\/download\/v0\.2\.3\/FlickAirPlay-Setup-0\.2\.3\.exe/);
  assert.match(notes, /DACP-ID/);
  assert.match(releaseNotes(text, '9.9.9'), /Виправлення та покращення/);
  // the version being released must have notes before it ships
  const pkg = require('../package.json');
  assert.ok(changelogSection(text, pkg.version), `CHANGELOG.md has a section for package.json version ${pkg.version}`);
});
