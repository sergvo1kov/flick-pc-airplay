'use strict';
// DACP remote control: lets the PC send play/pause/next/prev/volume commands
// back to the iPhone/iPad that is currently streaming (same mechanism an
// Apple TV or AirPlay speaker uses for its remote / hardware buttons).
//
// UxPlay exports the client's DACP-ID and Active-Remote token (-dacp file).
// The client advertises "iTunes_Ctrl_<DACP-ID>._dacp._tcp.local" over mDNS;
// we resolve its port with a unicast query straight to the client (reply passes
// the Windows firewall as an answer to our own packet) and, in parallel, a
// multicast query asking for a unicast answer.

const dgram = require('dgram');
const http = require('http');
const mdns = require('./mdns');

const MDNS_GROUP = '224.0.0.251';

// Commands understood by iOS / iPadOS / macOS DACP servers.
const COMMANDS = new Set([
  'playpause', 'play', 'pause', 'stop', 'nextitem', 'previtem',
  'beginff', 'beginrew', 'playresume', 'volumeup', 'volumedown', 'mutetoggle',
  'shuffle_songs',
]);

/**
 * iOS sends the DACP-ID header as a 64-bit hex number WITHOUT leading zeros
 * ("BD2CD1D0834418"), but advertises its service with all 16 digits
 * ("iTunes_Ctrl_00BD2CD1D0834418"). Same convention as shairport-sync.
 */
function dacpInstanceId(dacpId) {
  const hex = String(dacpId || '').trim().toUpperCase().replace(/^0X/, '');
  return hex.length < 16 ? hex.padStart(16, '0') : hex;
}

/** Compare two DACP ids ignoring leading zeros and case. */
function sameDacpId(a, b) {
  const norm = (x) => String(x || '').toUpperCase().replace(/^0+/, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

const INSTANCE_RE = /^iTunes_Ctrl_([0-9A-Fa-f]+)\._dacp\._tcp\.local$/;

function resolveDacpService(dacpId, { clientIp, mdnsPort = 5353, timeoutMs = 1500, multicast = true } = {}) {
  const instance = `iTunes_Ctrl_${dacpInstanceId(dacpId)}._dacp._tcp.local`;
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const id = (Math.random() * 0xfffe + 1) | 0;
    let done = false;
    const asked = new Set();
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) { /* already closed */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`DACP service ${instance} not found`)), timeoutMs);

    sock.on('error', (e) => finish(e));
    sock.on('message', (buf, rinfo) => {
      let msg;
      try { msg = mdns.parseMessage(buf); } catch (_) { return; }
      if (!(msg.flags & 0x8000)) return; // not a response
      const all = [...msg.answers, ...msg.additionals];
      // exact name, or any iTunes_Ctrl_<id> whose id matches ignoring leading zeros
      const srv = all.find((r) => {
        if (r.type !== mdns.TYPE.SRV) return false;
        if (r.name.toLowerCase() === instance.toLowerCase()) return true;
        const m = INSTANCE_RE.exec(r.name);
        return !!m && sameDacpId(m[1], dacpId);
      });
      if (!srv) {
        // a PTR answer from the browse question: ask for that instance's SRV directly
        const ptr = all.find((r) => r.type === mdns.TYPE.PTR && INSTANCE_RE.test(r.data) && sameDacpId(INSTANCE_RE.exec(r.data)[1], dacpId));
        if (ptr && !asked.has(ptr.data)) {
          asked.add(ptr.data);
          const q2 = mdns.buildQuery([{ name: ptr.data, type: mdns.TYPE.SRV, unicastResponse: true }], id);
          sock.send(q2, mdnsPort, rinfo.address, () => {});
        }
        return;
      }
      const a = all.find((r) => r.type === mdns.TYPE.A && r.name.toLowerCase() === srv.data.target.toLowerCase());
      finish(null, { host: a ? a.data : rinfo.address, port: srv.data.port, target: srv.data.target });
    });

    sock.bind(0, () => {
      const q = mdns.buildQuery([
        { name: instance, type: mdns.TYPE.SRV, unicastResponse: true },
        // fallback: browse all DACP remotes, in case the id format differs
        { name: '_dacp._tcp.local', type: mdns.TYPE.PTR, unicastResponse: true },
      ], id);
      if (clientIp && !clientIp.includes(':')) {
        sock.send(q, mdnsPort, clientIp, () => {});
      }
      if (multicast) {
        try { sock.setMulticastTTL(255); } catch (_) { /* not fatal */ }
        sock.send(q, mdnsPort, MDNS_GROUP, () => {});
      }
    });
  });
}

function httpGet({ host, port, path, headers, timeoutMs = 2500 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'GET', headers, timeout: timeoutMs, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('DACP request timed out')));
    req.on('error', reject);
    req.end();
  });
}

class DacpRemote {
  constructor({ log = () => {}, mdnsPort = 5353, multicast = true, resolveTimeoutMs = 1500 } = {}) {
    this.log = log;
    this.mdnsPort = mdnsPort;
    this.multicast = multicast;
    this.resolveTimeoutMs = resolveTimeoutMs;
    this.session = null; // { dacpId, activeRemote, clientIp }
    this.endpoint = null; // { host, port }
    this.resolving = null;
    this.queue = Promise.resolve();
  }

  setSession(session) {
    const changed = !this.session || !session
      || this.session.dacpId !== session.dacpId
      || this.session.activeRemote !== session.activeRemote;
    const ipChanged = session && this.session && session.clientIp && session.clientIp !== this.session.clientIp;
    this.session = session ? { ...session } : null;
    if (changed || ipChanged) {
      this.endpoint = null;
      this.resolving = null;
    }
  }

  get available() {
    return !!(this.session && this.session.dacpId && this.session.activeRemote);
  }

  async resolve(force = false) {
    if (!this.available) throw new Error('No AirPlay client connected');
    if (this.endpoint && !force) return this.endpoint;
    if (!this.resolving || force) {
      const { dacpId, clientIp } = this.session;
      this.log(`resolving iTunes_Ctrl_${dacpInstanceId(dacpId)} (client ${clientIp || 'unknown'})`);
      this.resolving = (async () => {
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const ep = await resolveDacpService(dacpId, {
              clientIp, mdnsPort: this.mdnsPort, timeoutMs: this.resolveTimeoutMs, multicast: this.multicast,
            });
            this.log(`DACP resolved: ${ep.host}:${ep.port}`);
            this.endpoint = ep;
            return ep;
          } catch (e) {
            lastErr = e;
          }
        }
        this.resolving = null;
        throw lastErr;
      })();
    }
    return this.resolving;
  }

  /** Commands are serialized so fast double-clicks don't arrive out of order. */
  send(cmd) {
    if (!COMMANDS.has(cmd)) return Promise.reject(new Error(`Unknown DACP command ${cmd}`));
    const run = () => this._send(cmd);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _send(cmd) {
    if (!this.available) throw new Error('No AirPlay client connected');
    const headers = { 'Active-Remote': this.session.activeRemote };
    for (let attempt = 0; attempt < 2; attempt++) {
      const ep = await this.resolve(attempt > 0);
      try {
        const status = await httpGet({ host: ep.host, port: ep.port, path: `/ctrl-int/1/${cmd}`, headers });
        if (status >= 200 && status < 300) return true;
        this.log(`DACP ${cmd} -> HTTP ${status}`);
        if (status === 403) throw new Error('Client rejected Active-Remote token');
      } catch (e) {
        this.log(`DACP ${cmd} failed: ${e.message}`);
        if (attempt === 1) throw e;
      }
      // port can change if the client restarted its DACP server: re-resolve once
      this.endpoint = null;
    }
    return false;
  }
}

module.exports = { DacpRemote, resolveDacpService, dacpInstanceId, sameDacpId, COMMANDS };
