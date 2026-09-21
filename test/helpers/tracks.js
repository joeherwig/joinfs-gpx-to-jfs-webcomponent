'use strict';
/**
 * Deterministic synthetic flights for tests and the demo sample track.
 * Nothing here is recorded data: the flights are generated from simple motion commands.
 */

const M_PER_DEG = 6371008.8 * Math.PI / 180;         // metres per degree of latitude (same sphere as the converter)
const KT = 0.514444;
const FT = 0.3048;
const NM = 1852;

/** small seeded PRNG (LCG) so "noisy" tracks are reproducible */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Step-based flight simulator, one point per second.
 * steps: [{ dur | until, max, v, acc, vz, turn }]
 *   v     target ground speed (m/s), reached with `acc` (m/s^2, default 1.2)
 *   vz    vertical speed (m/s)
 *   turn  turn rate in deg/s, positive = right
 *   until (state) => boolean, ends the step (dur is then only the safety limit)
 * Altitude is clamped to `ground` when descending below it.
 */
function simulate(steps, opt = {}) {
  const o = Object.assign({ lat0: 50.0, lon0: 10.0, ground: 320, heading: 90, t0: Date.UTC(2026, 4, 2, 9, 0, 0) / 1000, noise: 0, seed: 1 }, opt);
  const rand = rng(o.seed);
  const st = { t: 0, x: 0, y: 0, hdg: o.heading * Math.PI / 180, v: 0, alt: o.ground };
  const pts = [];
  const emit = () => {
    const nx = o.noise ? (rand() - 0.5) * 2 * o.noise * 1.5 : 0, ny = o.noise ? (rand() - 0.5) * 2 * o.noise * 1.5 : 0;
    const na = o.noise ? (rand() - 0.5) * 2 * o.noise : 0;
    const lat = o.lat0 + (st.y + ny) / M_PER_DEG;
    const lon = o.lon0 + (st.x + nx) / (M_PER_DEG * Math.cos(o.lat0 * Math.PI / 180));
    pts.push({ t: o.t0 + st.t, lat, lon, ele: st.alt + na });
  };
  emit();
  for (const step of steps) {
    const limit = step.until ? (step.max || 3600) : step.dur;
    for (let i = 0; i < limit; i++) {
      if (step.until && step.until(st)) break;
      const acc = step.acc || 1.2;
      if (step.v !== undefined) st.v += Math.max(-acc, Math.min(acc, step.v - st.v));
      st.hdg += (step.turn || 0) * Math.PI / 180;
      st.x += st.v * Math.sin(st.hdg);
      st.y += st.v * Math.cos(st.hdg);
      st.alt += step.vz || 0;
      if (st.alt < o.ground) st.alt = o.ground;
      st.t += 1;
      emit();
    }
  }
  return pts;
}

/** ~23 minute local flight: taxi, takeoff, climb, out-and-back, descent, landing, taxi. Starts and ends at 320 m. */
function patternFlight(opt = {}) {
  const G = (opt.ground !== undefined ? opt.ground : 320);
  return simulate([
    { dur: 60, v: 0 },                                            // parked
    { dur: 45, v: 5 },                                            // taxi
    { dur: 20, v: 0 },                                            // hold at the runway
    { dur: 22, v: 34, acc: 1.6 },                                 // takeoff roll
    { until: (s) => s.alt >= G + 457, max: 400, v: 40, vz: 3.5 }, // climb to ~1500 ft above the field
    { dur: 300, v: 50, vz: 0 },                                   // outbound
    { dur: 60, v: 50, turn: -3 },                                 // 180 degree left turn
    { dur: 300, v: 50 },                                          // inbound
    { until: (s) => s.alt <= G + 300, max: 200, v: 45, vz: -3 },  // descent
    { dur: 60, v: 42, turn: -3, vz: -2.5 },                       // turn to final
    { until: (s) => s.alt <= G + 1, max: 300, v: 35, vz: -2.4, acc: 0.5 }, // final
    { dur: 25, v: 0, acc: 1.5, vz: 0 },                           // rollout
    { dur: 40, v: 5 },                                            // taxi
    { dur: 30, v: 0 },                                            // parked
  ], Object.assign({ ground: G }, opt));
}

function iso(t) { return new Date(t * 1000).toISOString(); }

/** serialize points as a GPX 1.1 track */
function toGpx(points, { name = 'Synthetic test flight', creator = 'joinfs-gpx2jfs-converter-webcomponent test fixture' } = {}) {
  const pts = points.map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">\n        <ele>${p.ele.toFixed(2)}</ele>\n        <time>${iso(p.t)}</time>\n      </trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${name}</name></metadata>\n  <trk>\n    <name>${name}</name>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>\n</gpx>\n`;
}

/** great-circle-ish distance in metres between two points (same sphere as above) */
function dist(a, b) {
  const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180, dl = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = { simulate, patternFlight, toGpx, dist, rng, M_PER_DEG, KT, FT, NM };
