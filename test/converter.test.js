'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DOMParser } = require('@xmldom/xmldom');

const J = require('../src/joinfs-gpx-to-jfs.js');
const { simulate, patternFlight, toGpx, dist, FT, KT, NM } = require('./helpers/tracks.js');
const { decode, series, VU } = require('./helpers/jfs.js');
const { FakeWorker } = require('./helpers/nodeWorker.js');

class QuietParser extends DOMParser { constructor() { super({ onError() {} }); } }
const conv = (pts, opts) => J.convert(toGpx(pts), opts, QuietParser);
const OFF = { systems: 'off' };
const angDiff = (a, b) => Math.abs(((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
const deg = (r) => r * 180 / Math.PI;

const gpx = (body, root = 'trk') => `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><name>T</name>${root === 'trk' ? `<trk><trkseg>${body}</trkseg></trk>` : `<rte>${body}</rte>`}</gpx>`;
const tp = (tag, lat, lon, ele, time) => `<${tag} lat="${lat}" lon="${lon}">${ele === null ? '' : `<ele>${ele}</ele>`}${time === null ? '' : `<time>${time}</time>`}</${tag}>`;

test('GPX parsing', async (t) => {
  await t.test('reads a namespaced GPX 1.1 track', () => {
    const { pts, name } = J.parseGpx(gpx(tp('trkpt', 48.1, 9.2, 300, '2026-05-02T09:00:00Z') + tp('trkpt', 48.2, 9.3, 310.5, '2026-05-02T09:00:01.500Z')), QuietParser);
    assert.equal(name, 'T');
    assert.equal(pts.length, 2);
    assert.deepEqual([pts[1].lat, pts[1].lon, pts[1].ele], [48.2, 9.3, 310.5]);
    assert.equal(pts[1].t - pts[0].t, 1.5);
  });
  await t.test('a time without zone is taken as UTC', () => {
    const { pts } = J.parseGpx(gpx(tp('trkpt', 1, 1, 0, '2026-05-02T09:00:00') + tp('trkpt', 1, 1, 0, '2026-05-02T09:00:00Z')), QuietParser);
    assert.equal(pts[0].t, pts[1].t);
  });
  await t.test('missing elevations are filled from the nearest known one; none at all becomes 0', () => {
    const a = J.parseGpx(gpx(tp('trkpt', 1, 1, null, '2026-05-02T09:00:00Z') + tp('trkpt', 1, 1, 120, '2026-05-02T09:00:01Z') + tp('trkpt', 1, 1, null, '2026-05-02T09:00:02Z')), QuietParser);
    assert.deepEqual(a.pts.map((p) => p.ele), [120, 120, 120]);
    const b = J.parseGpx(gpx(tp('trkpt', 1, 1, null, '2026-05-02T09:00:00Z') + tp('trkpt', 1, 1, null, '2026-05-02T09:00:01Z')), QuietParser);
    assert.deepEqual(b.pts.map((p) => p.ele), [0, 0]);
  });
  await t.test('route points are used when there is no track', () => {
    const { pts } = J.parseGpx(gpx(tp('rtept', 1, 1, 5, '2026-05-02T09:00:00Z') + tp('rtept', 1, 2, 5, '2026-05-02T09:00:10Z'), 'rte'), QuietParser);
    assert.equal(pts.length, 2);
  });
  await t.test('errors carry a code for translation', () => {
    const code = (text) => { try { J.parseGpx(text, QuietParser); } catch (e) { assert.ok(e instanceof J.GpxError); return e.code; } return null; };
    assert.equal(code('not xml at all'), 'notXml');
    assert.equal(code('<foo/>'), 'notGpx');
    assert.equal(code('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><gpx>&a;</gpx>'), 'doctype');
    assert.equal(code(gpx(tp('trkpt', 1, 1, 0, null) + tp('trkpt', 1, 1, 0, null))), 'noTime');
    assert.equal(code(gpx(tp('trkpt', 1, 1, 0, '2026-05-02T09:00:00Z'))), 'fewPoints');
  });
  await t.test('duplicate and out-of-order timestamps are cleaned up', () => {
    const body = [5, 3, 3, 0, 1, 2, 4].map((s, i) => tp('trkpt', 50 + s * 1e-4, 10, 300, `2026-05-02T09:00:0${s}Z`)).join('');
    const r = J.convert(gpx(body), { ...OFF, hz: 1 }, QuietParser);
    assert.equal(r.info.inputPoints, 6);
    assert.equal(r.info.frames, 6);
  });
  await t.test('very large tracks are refused', () => {
    assert.throws(() => J.convert(toGpx(patternFlight()), { maxPoints: 100 }, QuietParser), (e) => e.code === 'tooLarge' && e.params.limit === 100);
  });
  await t.test('elevationLooksScaled: flags a track whose altitude lost a digit, not a real one', () => {
    // 30 points, every value an exact multiple of 0.1, 8.7 m of range - exactly the shape seen from an
    // IGC->GPX conversion that wrote real terrain heights at a tenth of their size
    const scaled = Array.from({ length: 30 }, (_, i) => ({ ele: 60 + i * 0.3 }));
    assert.equal(J.elevationLooksScaled(scaled), true);
    assert.equal(J.elevationLooksScaled(scaled.slice(0, 15)), false, 'too few points to be sure');
    assert.equal(J.elevationLooksScaled(scaled.map((p) => ({ ele: 60 }))), false, 'no vertical movement at all');
    // a real, unscaled altitude track essentially never lands on exact tenths - the noiseless fixture used
    // elsewhere in this suite is *not* a fair negative here, its altitude is deterministic tenths-arithmetic
    // (vz integrated a second at a time) and happens to satisfy the same test the bug's fingerprint does
    const { pts } = J.parseGpx(toGpx(patternFlight({ noise: 0.6, seed: 42 })), QuietParser);
    assert.equal(J.elevationLooksScaled(pts), false);
  });
});

test('file layout', async (t) => {
  const pts = patternFlight();
  const dur = pts.at(-1).t - pts[0].t;
  const base = { ...OFF, callsign: 'ASGX', nickname: 'Pilot', model: 'Cessna 172 Wheels', icaoType: 'C172', icaoAirline: 'XY', livery: 'Blue', typerole: 3 };

  await t.test('MSFS 2024 layout: livery, ICAO type and airline strings after the frames', () => {
    const d = decode(conv(pts, { ...base, jfsVersion: 21005, fs2024: true }).data, { fs2024: true });
    assert.equal(d.version, 21005);
    assert.ok(d.complete, 'reader consumed exactly the whole file');
    const a = d.aircraft[0];
    assert.deepEqual([a.plane, a.callsign, a.nickname, a.model, a.typerole], [true, 'ASGX', 'Pilot', 'Cessna 172 Wheels', 3]);
    assert.deepEqual([a.livery, a.icaoType, a.icaoAirline], ['Blue', 'C172', 'XY']);
    assert.equal(d.objectCount, 0);
  });
  await t.test('other builds: ICAO strings only, no livery', () => {
    const d = decode(conv(pts, { ...base, jfsVersion: 21005, fs2024: false }).data, { fs2024: false });
    assert.ok(d.complete);
    assert.deepEqual([d.aircraft[0].icaoType, d.aircraft[0].icaoAirline], ['C172', 'XY']);
    assert.equal(d.aircraft[0].livery, undefined);
  });
  await t.test('version 21003 has no trailing strings at all (readable by every build)', () => {
    for (const fs2024 of [true, false]) {
      const d = decode(conv(pts, { ...base, jfsVersion: 21003, fs2024 }).data, { fs2024 });
      assert.ok(d.complete);
      assert.equal(d.aircraft[0].icaoType, undefined);
    }
  });
  await t.test('version 21008 carries the static-CG field, contact point by default', () => {
    // 0 says "the altitude written is where the wheels touch", which the on-ground clamp makes true, and JoinFS
    // answers by adding the spawned model's own clearance so that model sits on the terrain whatever its size.
    const d = decode(conv(pts, { ...base, jfsVersion: 21008 }).data);
    assert.ok(d.complete);
    assert.equal(d.aircraft[0].positions[0].staticCgToGround, 0);

    const m = decode(conv(pts, { ...base, jfsVersion: 21008, groundClearanceM: 1.2 }).data);
    assert.ok(Math.abs(m.aircraft[0].positions[0].staticCgToGround * 0.3048 - 1.2) < 1e-4, 'metres are written as feet');

    // null = unknown: JoinFS then makes no ground-clearance correction at all
    const u = decode(conv(pts, { ...base, jfsVersion: 21008, groundClearanceM: null }).data);
    assert.ok(Number.isNaN(u.aircraft[0].positions[0].staticCgToGround));

    assert.equal(decode(conv(pts, { ...base, jfsVersion: 21005 }).data).aircraft[0].positions[0].staticCgToGround, undefined,
      'older layouts have no such field');
  });
  await t.test('frame count and timing follow the frame rate', () => {
    for (const hz of [5, 10, 20]) {
      const a = decode(conv(pts, { ...base, hz }).data).aircraft[0];
      assert.equal(a.positions.length, Math.floor(dur * hz) + 1);
      assert.equal(a.positions[0].t, 0);
      assert.ok(Math.abs(a.positions[1].t - 1 / hz) < 1e-9);
      assert.ok(a.positions.every((p, i, arr) => i === 0 || p.t > arr[i - 1].t), 'strictly increasing time');
    }
  });
  await t.test('the recording is deterministic', () => {
    const a = conv(pts, {}).data, b = conv(pts, {}).data;
    assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0);
  });
  await t.test('info summary', () => {
    const { info } = conv(pts, OFF);
    assert.equal(info.inputPoints, pts.length);
    assert.ok(Math.abs(info.durationS - dur) < 0.01);
    assert.ok(info.distanceKm > 44 && info.distanceKm < 49, 'distance ' + info.distanceKm);
    assert.ok(info.maxAltM > 770 && info.maxAltM < 780);
  });
});

test('motion and attitude', async (t) => {
  const fly = (steps, opt) => decode(conv(simulate(steps, opt), OFF).data).aircraft[0].positions;
  const mid = (p) => p.slice(Math.floor(p.length * 0.4), Math.floor(p.length * 0.6));

  await t.test('heading follows the course over ground and velocity is in the east/up/north frame', () => {
    for (const [hdg, east, north] of [[90, 1, 0], [0, 0, 1], [180, 0, -1], [270, -1, 0]]) {
      const pos = fly([{ dur: 20, v: 0 }, { dur: 200, v: 60, acc: 5, vz: 4 }], { heading: hdg });
      for (const f of mid(pos)) {
        assert.ok(angDiff(f.heading, hdg * Math.PI / 180) < 0.02, `heading ${hdg}: ${deg(f.heading)}`);
        assert.ok(Math.abs(f.vel[0] - 60 * east) < 1 && Math.abs(f.vel[2] - 60 * north) < 1 && Math.abs(f.vel[1] - 4) < 0.5, `velocity for heading ${hdg}: ${f.vel}`);
      }
    }
  });
  await t.test('climb = negative pitch (nose up), descent = positive', () => {
    const up = mid(fly([{ dur: 20, v: 0 }, { dur: 200, v: 60, acc: 5, vz: 5 }]));
    const want = -(Math.atan2(5, 60) + 2 * Math.PI / 180);
    assert.ok(up.every((f) => Math.abs(f.pitch - want) < 0.02), `climb pitch ${deg(up[0].pitch)} vs ${deg(want)}`);
    const down = fly([{ dur: 20, v: 0 }, { dur: 100, v: 60, acc: 5, vz: 8 }, { dur: 100, v: 60, vz: -5 }]).filter((f) => f.t > 130 && f.t < 200);
    assert.ok(down.every((f) => f.pitch > 0.03), `descent pitch ${deg(down[0].pitch)}`);
  });
  await t.test('left turn = positive bank, right turn = negative; magnitude from the coordinated-turn formula', () => {
    const want = Math.atan(60 * (3 * Math.PI / 180) / 9.80665);
    const left = mid(fly([{ dur: 20, v: 0 }, { dur: 30, v: 60, acc: 5, vz: 4 }, { dur: 120, v: 60, turn: -3, vz: 4 }]).slice(40));
    const right = mid(fly([{ dur: 20, v: 0 }, { dur: 30, v: 60, acc: 5, vz: 4 }, { dur: 120, v: 60, turn: 3, vz: 4 }]).slice(40));
    assert.ok(left.every((f) => Math.abs(f.bank - want) < 0.04), `left bank ${deg(left[0].bank)} vs ${deg(want)}`);
    assert.ok(right.every((f) => Math.abs(f.bank + want) < 0.04), `right bank ${deg(right[0].bank)}`);
  });
  await t.test('angular velocity: heading rate matches the commanded turn rate, pitch/bank rates settle near zero', () => {
    // angVel is [pitch-rate, heading-rate, bank-rate] rad/s (see the comment above angVelPitch in derive()).
    // Without this JoinFS's own playback has nothing to advance attitude by between its periodic updates, so
    // it freezes and then snaps - very visible in a sustained turn, which is exactly the case checked here.
    const wantRate = -3 * Math.PI / 180;
    const left = mid(fly([{ dur: 20, v: 0 }, { dur: 30, v: 60, acc: 5, vz: 4 }, { dur: 120, v: 60, turn: -3, vz: 4 }]).slice(40));
    for (const f of left) {
      assert.ok(Math.abs(f.angVel[1] - wantRate) < 0.01, `heading rate ${f.angVel[1]} vs ${wantRate}`);
      assert.ok(Math.abs(f.angVel[0]) < 0.01, `pitch rate ${f.angVel[0]} should be ~0 in a steady turn`);
      assert.ok(Math.abs(f.angVel[2]) < 0.01, `bank rate ${f.angVel[2]} should be ~0 once the turn is established`);
    }
  });
  await t.test('angular velocity is near zero in straight, wings-level flight', () => {
    const pos = mid(fly([{ dur: 20, v: 0 }, { dur: 200, v: 60, acc: 5, vz: 4 }]));
    assert.ok(pos.every((f) => f.angVel.every((v) => Math.abs(v) < 0.01)), 'angVel ~0 in cruise');
  });
  await t.test('bank is limited to 45 degrees', () => {
    const pos = fly([{ dur: 20, v: 0 }, { dur: 30, v: 80, acc: 5, vz: 4 }, { dur: 60, v: 80, turn: -20, vz: 4 }]);
    assert.ok(pos.every((f) => Math.abs(f.bank) <= Math.PI / 4 + 1e-6));
  });
  await t.test('parked = on ground with level attitude; flying = airborne', () => {
    const pos = decode(conv(patternFlight(), OFF).data).aircraft[0].positions;
    const parked = pos.filter((f) => f.t < 50);
    assert.ok(parked.every((f) => f.ground && f.pitch === 0 && f.bank === 0));
    const cruise = pos.filter((f) => f.t > 400 && f.t < 800);
    assert.ok(cruise.every((f) => !f.ground));
    const transitions = pos.filter((f, i) => i && f.ground !== pos[i - 1].ground).length;
    assert.equal(transitions, 2, 'one takeoff and one landing');
  });
  await t.test('a heading is held while stationary instead of spinning', () => {
    const pos = fly([{ dur: 30, v: 0 }, { dur: 30, v: 20, acc: 3 }], { heading: 135 });
    assert.ok(pos.slice(0, 20).every((f) => angDiff(f.heading, 135 * Math.PI / 180) < 0.05));
  });
  await t.test('position frames follow the input path', () => {
    const src = patternFlight();
    const pos = decode(conv(src, OFF).data).aircraft[0].positions;
    for (const q of [0.1, 0.3, 0.6, 0.9]) {
      const k = Math.round((src.length - 1) * q);
      const f = pos[k * 5];
      const p = src[k];
      const d = dist({ lat: deg(f.lat), lon: deg(f.lon) }, p);
      assert.ok(d < 1.5 && Math.abs(f.alt - p.ele) < 0.5, `point ${k}: ${d.toFixed(2)} m off`);
    }
  });
  await t.test('elevationScale multiplies every altitude before altitudeOffsetM shifts it', () => {
    // mid-cruise only: the on-ground clamp is a max(), not a pure linear operation, so it is not guaranteed to
    // scale exactly - this only claims the airborne portion of the track, which is the point of the option.
    const plain = mid(fly([{ dur: 20, v: 0 }, { dur: 200, v: 60, acc: 5, vz: 4 }], {}));
    const doubled = mid(decode(conv(simulate([{ dur: 20, v: 0 }, { dur: 200, v: 60, acc: 5, vz: 4 }]), { ...OFF, elevationScale: 2 }).data).aircraft[0].positions);
    const both = mid(decode(conv(simulate([{ dur: 20, v: 0 }, { dur: 200, v: 60, acc: 5, vz: 4 }]), { ...OFF, elevationScale: 2, altitudeOffsetM: 100 }).data).aircraft[0].positions);
    for (let i = 0; i < plain.length; i += 37) {
      assert.ok(Math.abs(doubled[i].alt - plain[i].alt * 2) < 1e-6, `x2 at ${i}: ${doubled[i].alt} vs ${plain[i].alt * 2}`);
      assert.ok(Math.abs(both[i].alt - (plain[i].alt * 2 + 100)) < 1e-6, `x2 then +100 at ${i}`);
    }
  });
});

test('gaps in the track', async (t) => {
  const P = (s, lat, lon, ele = 300) => ({ t: 1.8e9 + s, lat, lon, ele });
  await t.test('a long standstill is held in place, then moves in the last second', () => {
    const pos = decode(conv([P(0, 50, 10), P(300, 50.00001, 10), P(301, 50.00002, 10), P(302, 50.00003, 10)], OFF).data).aircraft[0].positions;
    const at = (s) => pos[Math.round(s * 5)];
    assert.ok(Math.abs(deg(at(150).lat) - 50) < 1e-7, 'still at the first point halfway through the gap');
    // Position smoothing is centred, so it sees the movement coming: the aircraft creeps by a fraction of a
    // metre over the half-window before it actually moves. 5e-6 deg is about half a metre.
    assert.ok(Math.abs(deg(at(299).lat) - 50) < 5e-6, 'barely moved one second before the track does');
  });
  await t.test('a long gap with movement (signal loss) is bridged in a straight line', () => {
    const pos = decode(conv([P(0, 50, 10, 500), P(1, 50.0001, 10, 500), P(121, 50.05, 10, 700), P(122, 50.0501, 10, 700)], OFF).data).aircraft[0].positions;
    const f = pos[Math.round(61 * 5)];
    assert.ok(Math.abs(deg(f.lat) - 50.025) < 0.003, 'midpoint ' + deg(f.lat));
    assert.ok(Math.abs(f.alt - 600) < 5);
  });
});

test('gear, flaps and lights', async (t) => {
  const HZ = 5;
  const run = (pts, opts = {}) => { const r = conv(pts, { hz: HZ, fs2024: false, jfsVersion: 21005, ...opts }); return { info: r.info, a: decode(r.data, { fs2024: false }).aircraft[0] }; };
  const vals = (s) => s.map((x) => x[1]);
  const flapsPct = (s) => s.map((x) => Math.round(x[1] * 100));

  await t.test('variable ids are the hashes of the lower-cased SimVar names', () => {
    assert.deepEqual(J._core._vuids, VU);
    assert.equal(J._core._hashString('gear handle position'), VU.gear);
  });

  await t.test('pattern flight: full sequence', () => {
    const { info, a } = run(patternFlight());
    const S = info.systems;
    assert.ok(S.liftoffS > 100 && S.touchdownS > S.liftoffS + 500, JSON.stringify(S));
    assert.deepEqual(vals(series(a, VU.gear)), [1, 0, 1]);
    // takeoff setting, up after the climb, then staged back down on the approach, up again when clear
    assert.deepEqual(flapsPct(series(a, VU.flaps)), [20, 0, 33, 67, 100, 0]);
    assert.deepEqual(vals(series(a, VU.strobe)), [0, 1, 0]);
    assert.deepEqual(vals(series(a, VU.nav)), [1]);
    assert.deepEqual(vals(series(a, VU.beacon)), [1]);
    assert.deepEqual(vals(series(a, VU.taxi)), [0, 1, 0, 1], 'taxi before the roll and after vacating');
    assert.deepEqual(vals(series(a, VU.landing)), [0, 1, 0], 'on for the roll, whole flight stays below 4000 ft, off after vacating');
    const g = series(a, VU.gear), f = series(a, VU.flaps);
    assert.equal(g[1][0], f[1][0], 'gear goes up together with the takeoff flaps');
    const full = f.find((x) => Math.round(x[1] * 100) === 100), last = f[f.length - 1];
    assert.ok(g[2][0] < full[0], 'gear comes down before full flaps');
    assert.ok(f[2][0] < g[2][0], 'the first approach flap stage comes before the gear');
    assert.ok(last[0] > S.touchdownS && Math.abs(last[0] - S.vacatedS) < 0.01, 'flaps come up when the runway is vacated');
  });

  await t.test('lights bit mask is consistent with the per-bit variables', () => {
    const { a } = run(patternFlight());
    for (const v of a.vars.filter((x) => x.type === 11)) {
      const e = v.entries;
      const mask = e[VU.nav] | (e[VU.beacon] << 1) | (e[VU.landing] << 2) | (e[VU.taxi] << 3) | (e[VU.strobe] << 4);
      assert.equal(e[VU.lightStates], mask, 'at t=' + v.t);
    }
  });

  await t.test('initial state is written at t=0 and repeated (the replay aircraft may spawn late)', () => {
    const { a } = run(patternFlight());
    const early = a.vars.filter((v) => v.t <= 3);
    assert.ok(early.length >= 8, 'several early snapshots: ' + early.length);
    assert.equal(a.vars[0].t, 0);
    assert.ok(a.vars.filter((v) => v.type === 12).every((v, i, arr) => i === 0 || v.t >= arr[i - 1].t));
  });

  await t.test('frames stay in chronological order across all frame types', () => {
    const r = conv(patternFlight(), {});
    const d = decode(r.data);
    assert.ok(d.complete);
    assert.equal(d.aircraft[0].frameCount, d.aircraft[0].positions.length + d.aircraft[0].vars.length);
  });

  await t.test('takeoff flaps: +200 ft below 140 kt, +1000 ft otherwise', () => {
    for (const [speed, expectFt] of [[60, 200], [75, 1000]]) {
      const pts = simulate([{ dur: 30, v: 0 }, { dur: 30, v: speed, acc: 3 }, { until: (s) => s.alt >= 320 + 450, max: 300, v: speed, vz: 5 }, { dur: 60, v: speed }]);
      const { info } = run(pts);
      const i = Math.round(info.systems.flapsRetractS);
      const ft = (pts[i].ele - pts[0].ele) / FT;
      assert.ok(Math.abs(ft - expectFt) < 40, `${speed} m/s: retracted at ${ft.toFixed(0)} ft, expected ${expectFt}`);
    }
  });

  await t.test('landing light: on at <= 4000 ft, off above 4300 ft, no flicker inside the band', () => {
    const A0 = 300, up = (ft) => A0 + ft * FT;
    const c1 = (up(4150) - A0) / 5, c2 = (up(6000) - up(4150)) / 5, d3 = (up(4150) - A0) / 4;
    const prof = (tt) => {
      if (tt < 120) return { v: 0, alt: A0 };
      if (tt < 160) return { v: 35 * (tt - 120) / 40, alt: A0 };
      tt -= 160;
      if (tt < c1) return { v: 40, alt: A0 + 5 * tt }; tt -= c1;
      if (tt < 200) return { v: 50, alt: up(4150) + 30 * Math.sin(tt / 8) }; tt -= 200;     // +-98 ft around 4150 ft
      if (tt < c2) return { v: 50, alt: up(4150) + 5 * tt }; tt -= c2;
      if (tt < 200) return { v: 60, alt: up(6000) }; tt -= 200;
      if (tt < c2) return { v: 50, alt: up(6000) - 5 * tt }; tt -= c2;
      if (tt < 200) return { v: 50, alt: up(4150) + 30 * Math.sin(tt / 8) }; tt -= 200;
      if (tt < d3) return { v: 45 - 15 * tt / d3, alt: up(4150) - 4 * tt }; tt -= d3;
      if (tt < 30) return { v: 30 - 25 * tt / 30, alt: A0 };
      return { v: 0, alt: A0 };
    };
    const pts = []; let d = 0;
    for (let s = 0; s <= 2600; s++) { const p = prof(s); pts.push({ t: 1.8e9 + s, lat: 50 + d / 111194.9, lon: 10, ele: p.alt }); d += p.v; }
    const { a } = run(pts);
    const land = series(a, VU.landing);
    assert.deepEqual(vals(land), [0, 1, 0, 1, 0], JSON.stringify(land));
    const heightFt = (s) => (pts[Math.min(pts.length - 1, Math.round(s))].ele - A0) / FT;
    assert.ok(heightFt(land[2][0]) > 4290, 'switched off at ' + heightFt(land[2][0]).toFixed(0) + ' ft');
    assert.ok(heightFt(land[3][0]) <= 4010, 'switched on again at ' + heightFt(land[3][0]).toFixed(0) + ' ft');
  });

  await t.test('flaps full needs speed <= touchdown speed + 20 kt AND the distance that matches the speed', () => {
    const A0 = 300, L = 40 * NM, lat0 = 48, lon0 = 9;
    const speedAt = (dTg) => (dTg > 7 * NM ? 60 : dTg > 3.5 * NM ? 35 + 25 * (dTg - 3.5 * NM) / (3.5 * NM) : 28 + 7 * (dTg / (3.5 * NM)));
    const pts = [], dArr = []; let d = 0, alt = A0, td = -1;
    for (let s = 0; s < 5000; s++) {
      let v;
      if (s < 100) v = 0; else if (s < 130) v = 35 * (s - 100) / 30;
      else if (td < 0) v = (L - d) > 13 * NM ? Math.min(60, 40 + (s - 130) * 0.5) : speedAt(L - d);
      else v = Math.max(0, 28 - (s - td) * 3);
      const dTg = L - d;
      if (s < 130) alt = A0; else if (td < 0) alt = dTg > 13 * NM ? Math.min(A0 + 700, alt + 6) : A0 + 700 * Math.max(0, dTg / (13 * NM)); else alt = A0;
      pts.push({ t: 1.8e9 + s, lat: lat0 + d / 111194.9, lon: lon0, ele: alt }); dArr.push(d);
      if (td < 0 && d + v >= L) td = s + 1;
      d += v;
      if (td >= 0 && v <= 0 && s > td + 20) break;
    }
    const { info } = run(pts);
    const S = info.systems, n = pts.length;
    const spd = (i) => (dArr[Math.min(n - 1, i + 1)] - dArr[Math.max(0, i - 1)]) / (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) / KT;
    const vTd = spd(td);
    const NEAR = J.DEFAULTS.flapsLandingNearNm, FAR = J.DEFAULTS.flapsLandingFarNm;
    let and = -1, or = -1;
    for (let i = 140; i < td; i++) {
      const dn = (dArr[td] - dArr[i]) / NM, v = spd(i);
      if (and < 0 && v <= vTd + 20 && dn <= (v < 100 ? NEAR : FAR)) and = i;
      if (or < 0 && (v <= vTd + 10 || (v < 100 ? dn <= NEAR : dn <= FAR))) or = i;
    }
    assert.ok(or < and - 100, 'scenario separates AND from OR (' + or + ' vs ' + and + ')');
    // touchdown is detected 8 m above the ground, i.e. slightly early, hence the tolerance
    assert.ok(Math.abs(S.flapsFullS - and) <= 12, `flaps full at ${S.flapsFullS} s, AND-rule says ${and} s`);
    const nmAtFull = (dArr[td] - dArr[Math.round(S.flapsFullS)]) / NM;
    assert.ok(Math.abs(nmAtFull - NEAR) < 0.4, `about ${NEAR} nm from touchdown: ` + nmAtFull.toFixed(2));
    const nmAtGear = (dArr[td] - dArr[Math.round(S.gearDownS)]) / NM;
    assert.ok(Math.abs((nmAtGear - nmAtFull) - 1) < 0.2, 'gear 1 nm before the flaps: ' + (nmAtGear - nmAtFull).toFixed(2));
  });

  await t.test('an aircraft on the ground is never written below the ground', () => {
    // The vertical noise of a real track dips below the field for a third of the on-ground samples. An altitude
    // commanded under the simulator's terrain sets its own penetration correction fighting ours every tick, seen
    // as the aircraft shivering while parked and through the takeoff roll - so the on-ground altitude is clamped
    // to the field reference. Noisy track: the clean fixtures have nothing to clamp.
    const pos = decode(conv(patternFlight({ noise: 0.8, seed: 11 }), OFF).data).aircraft[0].positions;
    const down = pos.filter((f) => f.ground);
    assert.ok(down.length > 50, 'the fixture has a ground phase: ' + down.length);
    // 1 cm covers the float32 rounding of the written GROUND ALTITUDE field; real penetration was ~2 m
    const worst = Math.min(...down.map((f) => f.alt - f.elevation));
    assert.ok(worst > -0.01, 'deepest on-ground excursion below the reference: ' + worst.toExponential(2) + ' m');

    // and the clamp must not flatten the rotation: the climb through the last on-ground samples into the first
    // airborne ones stays monotonic, with no step at the hand-over
    let lift = -1;
    for (let i = 1; i < pos.length; i++) if (pos[i - 1].ground && !pos[i].ground) { lift = i; break; }
    assert.ok(lift > 0, 'the fixture lifts off');
    for (let i = lift - 4; i <= lift + 4; i++) {
      assert.ok(pos[i].alt >= pos[i - 1].alt - 1e-9, 'altitude never drops across the ground/air hand-over');
    }
  });

  await t.test('control surfaces: neutral by default, derived from the manoeuvre on request', () => {
    const pts = patternFlight();
    const off = decode(conv(pts, OFF).data).aircraft[0].positions;
    assert.ok(off.every((f) => f.controls.every((c) => c === 0)), 'default writes every surface neutral');

    const on = decode(conv(pts, { ...OFF, controls: 'derived' }).data).aircraft[0].positions;
    // never on the ground: JoinFS feeds these to the simulator, where rudder drives nosewheel steering
    assert.ok(on.filter((f) => f.ground).every((f) => f.controls.every((c) => c === 0)), 'neutral while on the ground');
    // brakes are not inferred at all
    assert.ok(on.every((f) => f.controls[3] === 0 && f.controls[4] === 0), 'brakes stay neutral');
    assert.ok(on.every((f) => f.controls.every((c) => Math.abs(c) <= 1)), 'within full scale');
    const air = on.filter((f) => !f.ground);
    assert.ok(Math.max(...air.map((f) => Math.abs(f.controls[2]))) > 0.02, 'aileron actually moves in the air');

    // a deflection commands a rate, so the aileron reverses between rolling into a turn and rolling out of it
    let rollIn = 0, rollOut = 0;
    for (let i = 1; i < on.length; i++) {
      const d = on[i].bank - on[i - 1].bank;
      if (d < -1e-4) rollIn = on[i].controls[2];
      else if (d > 1e-4 && rollIn !== 0) { rollOut = on[i].controls[2]; break; }
    }
    assert.ok(rollIn * rollOut < 0, `aileron reverses on roll-out (in ${rollIn.toFixed(3)}, out ${rollOut.toFixed(3)})`);
  });

  await t.test('a track that starts and ends airborne: gear up, flaps 0, strobe on, no landing events', () => {
    const pts = Array.from({ length: 600 }, (_, i) => ({ t: 1.8e9 + i, lat: 50 + i * 50 / 111194.9, lon: 10, ele: 1500 + 100 * Math.sin(i / 60) }));
    const { info, a } = run(pts);
    assert.equal(info.systems.touchdownS, null);
    assert.equal(info.systems.liftoffS, null);
    assert.equal(series(a, VU.gear)[0][1], 0);
    assert.equal(flapsPct(series(a, VU.flaps))[0], 0);
    assert.equal(series(a, VU.strobe)[0][1], 1);
  });

  await t.test('options: off, custom flap values, thresholds', () => {
    const pts = patternFlight();
    const off = run(pts, { systems: 'off' });
    assert.equal(off.a.vars.length, 0);
    assert.equal(off.info.systems, null);
    // the landing stages are fractions of flapsLanding, so they scale with it
    const custom = run(pts, { flapsTakeoff: 0.3, flapsLanding: 0.9 });
    assert.deepEqual(flapsPct(series(custom.a, VU.flaps)), [30, 0, 30, 60, 90, 0]);
    // and an empty stage list restores the single movement straight to full
    const oneGo = run(pts, { flapsLandingSteps: [] });
    assert.deepEqual(flapsPct(series(oneGo.a, VU.flaps)), [20, 0, 100, 0]);
    const late = run(pts, { flapsUpAfterLandingKt: 1000 });
    assert.ok(late.info.systems.vacatedS < run(pts).info.systems.vacatedS + 1e-9);
  });

  await t.test('the position frames are unaffected by the systems option', () => {
    const pts = patternFlight();
    const a = decode(conv(pts, {}).data).aircraft[0].positions, b = decode(conv(pts, OFF).data).aircraft[0].positions;
    assert.equal(a.length, b.length);
    assert.deepEqual(a.slice(0, 50), b.slice(0, 50));
    assert.deepEqual(a.at(-1), b.at(-1));
  });

  await t.test('output for the reference flight has not changed (update this hash only for intended format changes)', () => {
    const hash = crypto.createHash('sha256').update(conv(patternFlight(), {}).data).digest('hex');
    assert.equal(hash, process.env.UPDATE_SNAPSHOT ? hash : SNAPSHOT_SHA256);
  });
});

const SNAPSHOT_SHA256 = '4aa1a0b96e397c03c0cccdd949d6a2c73a1811c6e1eada3edaf990987aefaf4d';

test('asynchronous conversion (worker path)', async (t) => {
  const text = toGpx(patternFlight());
  const opts = { callsign: 'ASYNC' };
  const sync = J.convert(text, opts, QuietParser).data;
  const same = (u8) => Buffer.compare(Buffer.from(u8.buffer, u8.byteOffset, u8.length), Buffer.from(sync.buffer, sync.byteOffset, sync.length)) === 0;

  await t.test('worker result is byte-identical to the synchronous result and reports progress', async () => {
    const progress = [];
    const r = await J.convertAsync(text, opts, { DomParser: QuietParser, WorkerCtor: FakeWorker, onProgress: (f) => progress.push(f) });
    assert.ok(same(r.data));
    assert.ok(progress.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= progress[i - 1])));
  });
  await t.test('falls back to the calling thread without a worker', async () => {
    assert.ok(same((await J.convertAsync(text, opts, { DomParser: QuietParser, useWorker: false })).data));
  });
  await t.test('falls back when the worker cannot start', async () => {
    class Broken { constructor() { this.timer = setTimeout(() => this.onerror && this.onerror({ preventDefault() {} }), 5); } postMessage() {} terminate() { clearTimeout(this.timer); } }
    assert.ok(same((await J.convertAsync(text, opts, { DomParser: QuietParser, WorkerCtor: Broken })).data));
  });
  await t.test('errors from inside the worker keep their type and code', async () => {
    const bad = gpx(tp('trkpt', 1, 1, 0, '2026-05-02T09:00:00Z') + tp('trkpt', 1, 1, 0, '2026-05-02T09:00:00Z'));
    await assert.rejects(J.convertAsync(bad, {}, { DomParser: QuietParser, WorkerCtor: FakeWorker }), (e) => e instanceof J.GpxError && e.code === 'fewDistinct');
  });
  await t.test('can be cancelled', async () => {
    const ac = new AbortController();
    const p = J.convertAsync(text, { hz: 20 }, { DomParser: QuietParser, WorkerCtor: FakeWorker, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, (e) => e.name === 'AbortError');
    const pre = new AbortController(); pre.abort();
    await assert.rejects(J.convertAsync(text, {}, { DomParser: QuietParser, signal: pre.signal }), (e) => e.name === 'AbortError');
  });
});
