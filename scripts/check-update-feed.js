'use strict';
// OTA feed check. Verifies what installed apps will see when they look for an
// update (electron-updater reads latest.yml from the GitHub Release).
//
//   node scripts/check-update-feed.js local  <dist_dir> [expected_version]
//       latest.yml exists, names the installer that sits next to it, and its
//       size + sha512 match that file (a mismatch = every client fails the
//       download with "sha512 checksum mismatch").
//   node scripts/check-update-feed.js remote <owner/repo> <expected_version>
//       the published release serves that latest.yml and installer.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

/** Tiny reader for electron-builder's latest.yml (flat keys + one "files" list). */
function parseLatestYml(text) {
  const out = { files: [] };
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let m;
    if ((m = /^ {2}- (\w+): ?(.*)$/.exec(raw))) { cur = { [m[1]]: unq(m[2]) }; out.files.push(cur); continue; }
    if ((m = /^ {4}(\w+): ?(.*)$/.exec(raw)) && cur) { cur[m[1]] = unq(m[2]); continue; }
    if ((m = /^(\w+): ?(.*)$/.exec(raw))) { cur = null; if (m[1] !== 'files') out[m[1]] = unq(m[2]); }
  }
  return out;
}
function unq(v) { return v.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'); }

function sha512b64(buf) { return crypto.createHash('sha512').update(buf).digest('base64'); }

function fail(msg) { console.error(`FAIL ${msg}`); process.exitCode = 1; }
function ok(msg) { console.log(`ok   ${msg}`); }

function checkLocal(dist, expected) {
  const ymlPath = path.join(dist, 'latest.yml');
  if (!fs.existsSync(ymlPath)) return fail(`${ymlPath} missing (is "publish" configured in package.json?)`);
  const feed = parseLatestYml(fs.readFileSync(ymlPath, 'utf8'));
  ok(`latest.yml version ${feed.version}, path ${feed.path}`);
  if (expected && feed.version !== expected) fail(`version ${feed.version} != expected ${expected}`);
  const file = feed.files[0] || {};
  const exe = path.join(dist, file.url || feed.path || '');
  if (!fs.existsSync(exe)) return fail(`installer named in latest.yml not found: ${exe}`);
  const buf = fs.readFileSync(exe);
  if (String(buf.length) !== String(file.size)) fail(`size ${buf.length} != latest.yml ${file.size}`); else ok(`size ${buf.length}`);
  const sha = sha512b64(buf);
  if (sha !== file.sha512 || sha !== feed.sha512) fail('sha512 does not match the installer'); else ok('sha512 matches installer');
  if (!fs.existsSync(`${exe}.blockmap`)) console.log('note blockmap missing: updates will download in full'); else ok('blockmap present (differential updates)');
  if (!/^\d+\.\d+\.\d+$/.test(feed.version || '')) fail(`version "${feed.version}" is not x.y.z`);
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'flick-airplay-feed-check' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function checkRemote(repo, expected) {
  const base = `https://github.com/${repo}/releases/latest/download`;
  let res;
  // the release can take a moment to become "latest"
  for (let i = 0; i < 6; i++) {
    res = await get(`${base}/latest.yml`);
    if (res.status === 200 && parseLatestYml(res.body.toString()).version === expected) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (res.status !== 200) return fail(`${base}/latest.yml -> HTTP ${res.status}`);
  const feed = parseLatestYml(res.body.toString());
  if (feed.version !== expected) return fail(`published feed says ${feed.version}, expected ${expected}`);
  ok(`published feed: version ${feed.version}`);
  const exe = await get(`${base}/${encodeURIComponent(feed.path)}`);
  if (exe.status !== 200) return fail(`installer download -> HTTP ${exe.status}`);
  if (sha512b64(exe.body) !== feed.sha512) return fail('published installer sha512 mismatch');
  ok(`published installer downloads and matches sha512 (${(exe.body.length / 1048576).toFixed(1)} MB)`);
}

if (require.main === module) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'local') checkLocal(a || 'dist', b);
  else if (mode === 'remote') checkRemote(a, b).catch((e) => fail(e.message));
  else { console.error('usage: check-update-feed.js local <dist> [version] | remote <owner/repo> <version>'); process.exitCode = 2; }
}

module.exports = { parseLatestYml, checkLocal };
