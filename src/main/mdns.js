'use strict';
// Minimal DNS / mDNS message builder and parser (RFC 1035 + RFC 6762).
// Only what Flick AirPlay needs: questions, PTR, SRV, TXT, A, AAAA records.

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));

function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  const bufs = [];
  for (const label of parts) {
    const b = Buffer.from(label, 'utf8');
    if (b.length > 63) throw new Error(`DNS label too long: ${label}`);
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

/**
 * Build a query packet.
 * @param {Array<{name:string,type:number,unicastResponse?:boolean}>} questions
 * @param {number} id  transaction id (non-zero for legacy unicast queries)
 */
function buildQuery(questions, id = 0) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(questions.length, 4);
  const qs = questions.map((q) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE((q.unicastResponse ? 0x8000 : 0) | 1, 2); // class IN
    return Buffer.concat([encodeName(q.name), tail]);
  });
  return Buffer.concat([header, ...qs]);
}

function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let jumped = false;
  let end = offset;
  let hops = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('DNS name out of bounds');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      if (!jumped) end = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('DNS pointer out of bounds');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) end = pos + 2;
      jumped = true;
      pos = ptr;
      if (++hops > 64) throw new Error('DNS compression loop');
      continue;
    }
    pos += 1;
    labels.push(buf.toString('utf8', pos, pos + len));
    pos += len;
  }
  return { name: labels.join('.'), next: end };
}

function parseRecord(buf, offset) {
  const { name, next } = readName(buf, offset);
  let pos = next;
  const type = buf.readUInt16BE(pos);
  const klass = buf.readUInt16BE(pos + 2) & 0x7fff;
  const ttl = buf.readUInt32BE(pos + 4);
  const rdlen = buf.readUInt16BE(pos + 8);
  pos += 10;
  const rdStart = pos;
  const rec = { name, type, typeName: TYPE_NAME[type] || String(type), klass, ttl };
  switch (type) {
    case TYPE.A:
      rec.data = Array.from(buf.subarray(rdStart, rdStart + 4)).join('.');
      break;
    case TYPE.AAAA: {
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(rdStart + i).toString(16));
      rec.data = parts.join(':');
      break;
    }
    case TYPE.PTR:
      rec.data = readName(buf, rdStart).name;
      break;
    case TYPE.SRV:
      rec.data = {
        priority: buf.readUInt16BE(rdStart),
        weight: buf.readUInt16BE(rdStart + 2),
        port: buf.readUInt16BE(rdStart + 4),
        target: readName(buf, rdStart + 6).name,
      };
      break;
    case TYPE.TXT: {
      const items = [];
      let p = rdStart;
      while (p < rdStart + rdlen) {
        const l = buf[p];
        items.push(buf.toString('utf8', p + 1, p + 1 + l));
        p += 1 + l;
      }
      rec.data = items;
      break;
    }
    default:
      rec.data = buf.subarray(rdStart, rdStart + rdlen);
  }
  return { rec, next: rdStart + rdlen };
}

function parseMessage(buf) {
  if (buf.length < 12) throw new Error('DNS message too short');
  const msg = {
    id: buf.readUInt16BE(0),
    flags: buf.readUInt16BE(2),
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
  };
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
  let pos = 12;
  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = readName(buf, pos);
    msg.questions.push({ name, type: buf.readUInt16BE(next) });
    pos = next + 4;
  }
  const sections = ['answers', 'authorities', 'additionals'];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]; i++) {
      const { rec, next } = parseRecord(buf, pos);
      msg[sections[s]].push(rec);
      pos = next;
    }
  }
  return msg;
}

/** Build a response packet (used by tests to emulate an iPhone). */
function buildResponse(id, records) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(records.length, 6);
  const rs = records.map((r) => {
    let rdata;
    if (r.type === TYPE.SRV) {
      const fixed = Buffer.alloc(6);
      fixed.writeUInt16BE(r.data.priority || 0, 0);
      fixed.writeUInt16BE(r.data.weight || 0, 2);
      fixed.writeUInt16BE(r.data.port, 4);
      rdata = Buffer.concat([fixed, encodeName(r.data.target)]);
    } else if (r.type === TYPE.A) {
      rdata = Buffer.from(r.data.split('.').map(Number));
    } else if (r.type === TYPE.PTR) {
      rdata = encodeName(r.data);
    } else {
      rdata = Buffer.alloc(0);
    }
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(r.type, 0);
    meta.writeUInt16BE(1, 2);
    meta.writeUInt32BE(r.ttl || 120, 4);
    meta.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([encodeName(r.name), meta, rdata]);
  });
  return Buffer.concat([header, ...rs]);
}

module.exports = { TYPE, buildQuery, parseMessage, buildResponse, encodeName, readName };
