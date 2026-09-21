'use strict';
/** Independent .jfs decoder used by the tests (written from the documented layout, not from the converter). */

function readString(u8, dv, pos) {
  let len = 0, shift = 0, p = pos;
  for (;;) { const b = u8[p++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  return { value: Buffer.from(u8.subarray(p, p + len)).toString('utf8'), next: p + len };
}

/**
 * @param {Uint8Array} u8
 * @param {{fs2024?: boolean}} opt  which JoinFS build layout the tail uses
 */
function decode(u8, { fs2024 = true } = {}) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
  let p = 0;
  const version = dv.getInt16(p, true); p += 2;
  const aircraftCount = dv.getInt32(p, true); p += 4;
  const aircraft = [];
  for (let a = 0; a < aircraftCount; a++) {
    const ac = { positions: [], vars: [] };
    ac.plane = dv.getUint8(p) !== 0; p += 1;
    for (const k of ['callsign', 'nickname', 'model']) { const r = readString(u8, dv, p); ac[k] = r.value; p = r.next; }
    ac.typerole = dv.getUint8(p); p += 1;
    const frameCount = dv.getInt32(p, true); p += 4;
    ac.frameCount = frameCount;
    for (let i = 0; i < frameCount; i++) {
      const type = dv.getUint8(p); const t = dv.getFloat64(p + 1, true); p += 9;
      if (type === 1) {                                            // AircraftPosition
        const f = { t, type };
        f.lat = dv.getFloat64(p, true); f.lon = dv.getFloat64(p + 8, true); f.alt = dv.getFloat64(p + 16, true); p += 24;
        const fl = (n) => { const v = dv.getFloat32(p, true); p += 4; return v; };
        f.pitch = fl(); f.bank = fl(); f.heading = fl();
        f.vel = [fl(), fl(), fl()]; f.angVel = [fl(), fl(), fl()]; f.acc = [fl(), fl(), fl()];
        f.controls = []; for (let k = 0; k < 5; k++) { f.controls.push(dv.getInt16(p, true) / 16384); p += 2; }
        f.elevation = fl(); f.ground = (dv.getUint8(p) & 1) === 1; f.flags = dv.getUint8(p); p += 1;
        if (version >= 21008) { f.staticCgToGround = fl(); }
        ac.positions.push(f);
      } else if (type === 11 || type === 12) {                     // Integer / Float variables
        const count = dv.getUint16(p, true); p += 2;
        const entries = {};
        for (let k = 0; k < count; k++) {
          const id = dv.getUint32(p, true);
          entries[id] = type === 11 ? dv.getInt32(p + 4, true) : dv.getFloat32(p + 4, true);
          p += 8;
        }
        ac.vars.push({ t, type, entries });
      } else if (type === 10) {                                    // SimEvent
        p += 8;
      } else throw new Error('unexpected frame type ' + type + ' at ' + p);
    }
    if (fs2024 && version >= 21004) { const r = readString(u8, dv, p); ac.livery = r.value; p = r.next; }
    if ((fs2024 && version >= 21005) || (!fs2024 && version >= 21004)) {
      let r = readString(u8, dv, p); ac.icaoType = r.value; p = r.next;
      r = readString(u8, dv, p); ac.icaoAirline = r.value; p = r.next;
    }
    aircraft.push(ac);
  }
  const objectCount = dv.getInt32(p, true); p += 4;
  return { version, aircraftCount, aircraft, objectCount, bytesRead: p, complete: p === u8.length };
}

/** change history of one variable: [[t, value], ...] */
function series(ac, id) {
  const out = []; let last;
  for (const v of ac.vars) if (id in v.entries && v.entries[id] !== last) { last = v.entries[id]; out.push([v.t, last]); }
  return out;
}

// variable ids: hashes of the lower-cased SimVar names (verified against the JoinFS source lookup)
const VU = {
  gear: 2991743992, flaps: 3322317413, lightStates: 437078432,
  nav: 1582526319, beacon: 1582526322, landing: 1582526316, taxi: 1582526312, strobe: 981784475,
};

module.exports = { decode, series, VU };
