'use strict';
// CI helper: asks the network (mDNS) who offers AirPlay, using the same DNS
// code the app uses for DACP. Informational: prints what answered.
const dgram = require('dgram');
const mdns = require('../src/main/mdns');

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const found = new Set();
sock.on('message', (buf, rinfo) => {
  try {
    const m = mdns.parseMessage(buf);
    for (const r of [...m.answers, ...m.additionals]) {
      if (/_(airplay|raop)\._tcp\.local$/i.test(r.name) || /_(airplay|raop)\._tcp/i.test(String(r.data))) {
        found.add(`${r.typeName} ${r.name} -> ${typeof r.data === 'object' ? JSON.stringify(r.data) : r.data} (from ${rinfo.address})`);
      }
    }
  } catch (_) { /* not DNS */ }
});
sock.bind(0, () => {
  const q = mdns.buildQuery([
    { name: '_airplay._tcp.local', type: mdns.TYPE.PTR, unicastResponse: true },
    { name: '_raop._tcp.local', type: mdns.TYPE.PTR, unicastResponse: true },
  ], 0x4242);
  for (const host of ['224.0.0.251', '127.0.0.1']) sock.send(q, 5353, host);
});
setTimeout(() => {
  sock.close();
  if (found.size) { console.log('AirPlay services answering:'); for (const f of found) console.log('  ' + f); process.exit(0); }
  console.log('no mDNS answer seen (runner networking may block multicast)');
  process.exit(1);
}, 3000);
