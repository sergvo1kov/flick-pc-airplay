'use strict';
// Parsers for what UxPlay exports: metadata text file, console output,
// DACP export file, plus `netstat -ano` output on Windows.

const META_KEYS = {
  'Title': 'title',
  'Artist': 'artist',
  'Album': 'album',
  'Album artist': 'albumArtist',
  'Genre': 'genre',
  'Composer': 'composer',
};

/** UxPlay -md file: lines like "Title: Song", "Artist: Name". "no data" = empty. */
function parseMetadata(text) {
  const out = {};
  if (!text) return out;
  const clean = text.replace(/\0/g, '');
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const idx = line.indexOf(': ');
    if (idx <= 0) continue;
    const key = META_KEYS[line.slice(0, idx)];
    if (key) out[key] = line.slice(idx + 2).trim();
  }
  return out;
}

const PROGRESS_RE = /audio progress \(min:sec\):\s*(\d+):(\d+);\s*remaining:\s*(-?\d+):(\d+);\s*track length\s*(\d+):(\d+)/;

/** "audio progress (min:sec):   1:05; remaining:   2:10; track length 3:15" */
function parseProgress(line) {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return { position: n[0] * 60 + n[1], duration: n[4] * 60 + n[5] };
}

const CONN_RE = /connection request from (.+?) \(([^()]*)\) with deviceID = ([0-9A-Fa-f:]+)/;

function parseConnection(line) {
  const m = CONN_RE.exec(line);
  return m ? { deviceName: m[1], deviceModel: m[2], deviceId: m[3] } : null;
}

const VIDEO_START_RE = /raop_rtp_mirror starting mirroring|on_video_play: location/;
const VIDEO_STOP_RE = /on_video_stop|video has finished|raop_rtp_mirror->running is no longer true|hls video has sent EOS/;

/** 'start' | 'stop' | null — mirroring / AirPlay (YouTube) video begins or ends. */
function parseVideoEvent(line) {
  if (VIDEO_START_RE.test(line)) return 'start';
  if (VIDEO_STOP_RE.test(line)) return 'stop';
  return null;
}

/** -dacp file: "<DACP-ID>\n<Active-Remote>\n" */
function parseDacpFile(text) {
  if (!text) return null;
  const [dacpId, activeRemote] = text.replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim());
  if (!dacpId || !activeRemote) return null;
  return { dacpId, activeRemote };
}

/** UxPlay writes a 1x1 transparent PNG as "no cover" placeholder. Real cover art is JPEG. */
function isRealCover(buf) {
  if (!buf || buf.length < 200) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    // PNG: width/height at bytes 16..23
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return w > 1 && h > 1;
  }
  return buf[0] === 0xff && buf[1] === 0xd8; // JPEG
}

function coverMime(buf) {
  return buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
}

/**
 * Find remote peers of established TCP connections owned by `pid`.
 * netstat -ano lines: "  TCP    192.168.1.5:7000    192.168.1.23:51234   ESTABLISHED     4242"
 */
function parseNetstat(text, pid) {
  const peers = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP') continue;
    if (cols[3] !== 'ESTABLISHED' || Number(cols[4]) !== Number(pid)) continue;
    const remote = cols[2];
    const ip = remote.startsWith('[') ? remote.slice(1, remote.lastIndexOf(']')) : remote.slice(0, remote.lastIndexOf(':'));
    const localPort = Number(cols[1].slice(cols[1].lastIndexOf(':') + 1));
    if (ip === '127.0.0.1' || ip === '::1') continue;
    peers.push({ ip: ip.replace(/^::ffff:/, ''), localPort });
  }
  return peers;
}

/** Pick the client IP: prefer IPv4, most frequent peer. */
function pickClientIp(peers) {
  const counts = new Map();
  for (const p of peers) counts.set(p.ip, (counts.get(p.ip) || 0) + 1);
  const ips = [...counts.entries()].sort((a, b) => {
    const a4 = a[0].includes(':') ? 0 : 1;
    const b4 = b[0].includes(':') ? 0 : 1;
    return b4 - a4 || b[1] - a[1];
  });
  return ips.length ? ips[0][0] : null;
}

module.exports = {
  parseVideoEvent, parseMetadata, parseProgress, parseConnection, parseDacpFile, isRealCover, coverMime, parseNetstat, pickClientIp,
};
