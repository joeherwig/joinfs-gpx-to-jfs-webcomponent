/*
 * joinfs-gpx-to-jfs.js - convert GPX tracklogs to JoinFS recordings (.jfs) entirely in the browser.
 *
 * SPDX-License-Identifier: CC-BY-NC-SA-4.0
 * Copyright (c) 2026 the joinfs-gpx2jfs-converter-webcomponent authors. See LICENSE and NOTICE.md.
 *
 * No dependencies, classic script (also works from file://). Exposes:
 *   window.Gpx2Jfs = { convert, convertAsync, parseGpx, TYPEROLES, DEFAULTS, GpxError, messages }
 *   <joinfs-gpx-to-jfs> custom element (Shadow DOM)
 * The recording layout is documented in the README; tools/reference/gpx2jfs.py is an independent reference writer.
 * Units used by JoinFS: radians, metres, m/s; pitch + = nose DOWN, bank + = LEFT wing down;
 * velocity in world frame (X east, Y up, Z north).
 *
 * Threading: the XML is parsed on the page (DOMParser does not exist in workers); the heavy part
 * (resampling, attitude, binary writing) runs in a Web Worker created from a Blob of makeCore()
 * below, so no extra file is needed. If a worker cannot be started it falls back to the page thread.
 */
(function (root) {
  'use strict';

  // ==================================================================
  // Pure computation core. Must not reference anything outside itself:
  // its source text is also injected into the worker.
  // ==================================================================
  function makeCore() {
    'use strict';

    const G = 9.80665, R_EARTH = 6371008.8, KT = 0.514444;
    const DEG2RAD = Math.PI / 180.0, RAD2DEG = 180.0 / Math.PI;
    const FRAME_AIRCRAFT_POSITION = 1;
    // JoinFS type roles. 0 = unknown: JoinFS skips the type-role comparison entirely when either side is 0
    // (Substitution.Match: +15 for a match, -240 for a mismatch without an exact ICAO type match), so leaving it
    // unknown is safer than guessing - the ICAO type designator carries the model matching instead.
    const TYPEROLES = {
      unknown: 0,
      singleprop: 1, twinprop: 2, airliner: 3, rotorcraft: 4, glider: 5,
      fighter: 6, bomber: 7, fourprop: 8, airship: 9, balloon: 10,
    };
    // Defaults = standard MSFS 2024 Cessna 172. File version 21005 is the first that stores the ICAO strings.
    // fs2024 selects the JoinFS-FS2024 layout (livery + ICAO type + ICAO airline); false = other builds (ICAO strings only).
    const DEFAULTS = {
      hz: 5, model: 'Cessna 172 Wheels', typerole: 0, callsign: 'ASGX', nickname: '',
      pitchTrimDeg: 2, maxBankDeg: 45, groundAglM: 8, groundMaxKt: 90, gapS: 30, smoothS: 3,
      // Height above the field at which the aircraft is taken to be in contact with it. groundAglM above is a
      // generous threshold for deciding which *phase* of the flight a sample belongs to, and has to be, or GPS
      // noise would make that phase flicker. It must not be what goes into SIM ON GROUND: JoinFS forwards that
      // bit to the simulator, which then places the aircraft on the terrain itself and disregards the altitude
      // in the recording. With the phase threshold there, the aircraft stays pinned to the runway through the
      // first 8 m of the climb and is let go with a jump, and on approach it is put down 8 m early. This
      // tighter figure trims each ground stretch back to where the wheels actually are.
      groundContactM: 1.0,
      // Shifts every written altitude (and the ground reference with it, so AGL and the on-ground detection are
      // unchanged). A GPX carries whatever elevation datum its recorder used, which need not agree with the
      // simulator's terrain mesh; the difference shows up as an aircraft that sits above or below the ground.
      altitudeOffsetM: 0,
      // Low-pass the resampled track itself, in seconds; 0 disables it. The resampler interpolates *through* every
      // source point (cubic Hermite with Catmull-Rom tangents), so GPS noise is not averaged out but amplified:
      // each tangent is a difference of neighbouring points, and the spline overshoots between them. On a real
      // 1 Hz tracklog that produces a speed oscillation of several knots at about half the source sample rate,
      // which the simulator follows, because it drives the injected object from the velocity in this file. The
      // result is an aircraft that visibly surges fore and aft. Smoothing the positions removes it at the source;
      // the written velocity, being their derivative, becomes smooth with them. Costs path fidelity: the default
      // shifts the flown path by up to ~2 m on a noisy track, well inside its own GPS noise, but it also rounds
      // off genuinely sharp inputs such as a landing flare. Use tools/track-noise.js to pick a value for a
      // particular track.
      smoothPosS: 3,
      // Seconds over which pitch and bank fade between their on-ground value (level) and the value derived from
      // the track. Without it the attitude snaps by several degrees in a single frame the moment the on-ground
      // flag flips - at rotation, at touchdown, and repeatedly if the flag chatters near its threshold.
      groundBlendS: 2,
      // STATIC CG TO GROUND, in metres, written in file version 21008 and up: how far the recorded altitude sits
      // above the point where the wheels touch. A GPX does not say - it carries a receiver somewhere in a cabin,
      // not an aircraft geometry - so the default is null, written as NaN, which JoinFS reads as "unknown" and
      // skips its ground-clearance correction rather than guessing.
      //
      // Do NOT default this to 0. JoinFS cannot tell a declared 0 from an aircraft that genuinely sits flush on
      // the ground, so it adds the *substitute* model's full clearance on top of every altitude - the JoinFS
      // source names that as the cause of its "hovers meters above the ground" bug, and it does exactly that
      // here: the injected aircraft floats by however much the spawned model's gear is deep. Set it only when
      // the real figure for the recorded aircraft is known.
      groundClearanceM: null,
      jfsVersion: 21008, fs2024: true, icaoType: 'C172', icaoAirline: '', livery: '', maxPoints: 200000,
      // Aircraft systems (gear, flaps, lights) derived from the track. systems: 'full' | 'off'
      systems: 'full',
      flapsTakeoff: 0.2, flapsLanding: 1.0,                       // FLAPS HANDLE PERCENT (0..1)
      // Landing flaps come out in stages rather than in one movement, each stage triggered by airspeed: how far
      // the aircraft still is above its own touchdown speed, which is what a pilot actually flies to and which
      // scales itself to the aeroplane. Entries are [knots above touchdown speed, fraction of flapsLanding],
      // earliest first; the last stage is always full flaps at flapsLandingVtdMarginKt. Each stage still has to
      // pass the same distance-to-touchdown gate as full flaps, so slowing down en route does not lower them.
      // [] restores the single movement straight to full.
      flapsLandingSteps: [[40, 1 / 3], [30, 2 / 3]],
      // Shortest time between two flap movements. An aircraft that decelerates quickly meets several of the
      // speed thresholds within a second or two, which would read as one jump rather than a staged extension.
      flapsStageMinS: 20,
      flapsRetractAltFt: 200, flapsRetractFastAltFt: 1000, flapsRetractSpeedKt: 140,
      flapsLandingNearNm: 1.5, flapsLandingFarNm: 7, flapsLandingSpeedKt: 100, flapsLandingVtdMarginKt: 20,
      gearDownBeforeFlapsNm: 1, flapsUpAfterLandingKt: 30,
      lightLandingBelowFt: 4000, lightLandingHysteresisFt: 300, taxiMinKt: 3,
      groundDebounceS: 5, systemsRefreshS: 5,
    };

    // code + params let a UI translate the message; message stays English for logs / API users
    class GpxError extends Error {
      constructor(message, code, params) { super(message); this.name = 'GpxError'; this.code = code || 'error'; this.params = params || {}; }
    }

    const rad = (d) => d * DEG2RAD;
    const deg = (r) => r * RAD2DEG;
    const pmod = (x, m) => ((x % m) + m) % m;            // Python-style modulo
    const angleWrap = (a) => pmod(a + Math.PI, 2 * Math.PI) - Math.PI;

    function hav(a, b) {
      const p1 = rad(a.lat), p2 = rad(b.lat);
      const dphi = p2 - p1, dl = rad(b.lon - a.lon);
      const h = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
      return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function clean(pts) {
      pts = pts.slice().sort((a, b) => a.t - b.t);
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].t - out[out.length - 1].t > 1e-3) out.push(pts[i]);
      }
      return out;
    }

    function movingAvg(x, n) {
      if (n <= 1) return x.slice();
      const h = Math.floor(n / 2);
      const pre = [0];
      for (const v of x) pre.push(pre[pre.length - 1] + v);
      const L = x.length, out = new Array(L);
      for (let i = 0; i < L; i++) {
        const a = Math.max(0, i - h), b = Math.min(L, i + h + 1);
        out[i] = (pre[b] - pre[a]) / (b - a);
      }
      return out;
    }

    // Same, but the window stays centred: near the ends it shrinks on both sides instead of reaching only
    // inwards. For a steadily advancing quantity - a position - a one-sided window is not a smoother but a
    // displacement, pulling the first and last frames along the track by roughly (window / 4) * speed, which is
    // tens of metres for a few seconds of window at cruise. Shrinking symmetrically fades the smoothing out at
    // the ends rather than biasing them, at the cost of leaving the very first and last samples untouched.
    function movingAvgCentred(x, n) {
      if (n <= 1) return x.slice();
      const h = Math.floor(n / 2);
      const pre = [0];
      for (const v of x) pre.push(pre[pre.length - 1] + v);
      const L = x.length, out = new Array(L);
      for (let i = 0; i < L; i++) {
        const w = Math.min(h, i, L - 1 - i);
        out[i] = (pre[i + w + 1] - pre[i - w]) / (2 * w + 1);
      }
      return out;
    }

    function hermite(p0, p1, m0, m1, h, u) {
      const u2 = u * u, u3 = u * u * u;
      return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * m0
           + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * m1;
    }

    // ---- resampling (cubic Hermite, gap aware) --------------------
    function resample(pts, o, prog) {
      const n = pts.length, t0 = pts[0].t;
      const T = pts.map((p) => p.t - t0);
      const lat0 = rad(pts[0].lat), lon0 = rad(pts[0].lon);
      const kx = R_EARTH * Math.cos(lat0);
      const E = pts.map((p) => (rad(p.lon) - lon0) * kx);
      const N = pts.map((p) => (rad(p.lat) - lat0) * R_EARTH);
      const A = pts.map((p) => p.ele);

      const parked = [], longGap = [];
      for (let i = 0; i < n - 1; i++) {
        const dt = T[i + 1] - T[i];
        const d = Math.hypot(E[i + 1] - E[i], N[i + 1] - N[i]);
        parked.push(dt > o.gapS && d / dt < 1.5);
        longGap.push(dt > o.gapS);
      }

      function tangent(arr, i) {
        const leftOk = i > 0 && !longGap[i - 1];
        const rightOk = i < n - 1 && !longGap[i];
        if (leftOk && rightOk) return (arr[i + 1] - arr[i - 1]) / (T[i + 1] - T[i - 1]);
        if (rightOk) return (arr[i + 1] - arr[i]) / (T[i + 1] - T[i]);
        if (leftOk) return (arr[i] - arr[i - 1]) / (T[i] - T[i - 1]);
        return 0;
      }
      const mE = E.map((_, i) => tangent(E, i));
      const mN = N.map((_, i) => tangent(N, i));
      const mA = A.map((_, i) => tangent(A, i));

      const dtOut = 1 / o.hz, total = T[n - 1];
      const steps = Math.trunc(total / dtOut) + 1;
      const out = new Array(steps);
      let seg = 0;
      for (let k = 0; k < steps; k++) {
        if (prog && (k & 8191) === 0) prog(k / steps);
        const t = k * dtOut;
        while (seg < n - 2 && T[seg + 1] < t) seg++;
        const h = T[seg + 1] - T[seg];
        const u = Math.min(1, Math.max(0, (t - T[seg]) / h));
        let e, nn, a;
        if (parked[seg]) {
          const holdUntil = T[seg + 1] - Math.min(1, h);
          if (t <= holdUntil) { e = E[seg]; nn = N[seg]; a = A[seg]; }
          else {
            const v = (t - holdUntil) / (T[seg + 1] - holdUntil);
            e = E[seg] + (E[seg + 1] - E[seg]) * v;
            nn = N[seg] + (N[seg + 1] - N[seg]) * v;
            a = A[seg] + (A[seg + 1] - A[seg]) * v;
          }
        } else if (longGap[seg]) {
          e = E[seg] + (E[seg + 1] - E[seg]) * u;
          nn = N[seg] + (N[seg + 1] - N[seg]) * u;
          a = A[seg] + (A[seg + 1] - A[seg]) * u;
        } else {
          e = hermite(E[seg], E[seg + 1], mE[seg], mE[seg + 1], h, u);
          nn = hermite(N[seg], N[seg + 1], mN[seg], mN[seg + 1], h, u);
          a = hermite(A[seg], A[seg + 1], mA[seg], mA[seg + 1], h, u);
        }
        out[k] = [t, deg(lat0 + nn / R_EARTH), deg(lon0 + e / kx), a];
      }
      return out;
    }

    // ---- heading / pitch / bank -----------------------------------
    function derive(grid, o, prog) {
      const n = grid.length, dt = 1 / o.hz;
      const t = grid.map((g) => g[0]);
      const posWin = Math.max(1, Math.trunc(o.smoothPosS * o.hz)) | 1;
      const sm = (a) => (posWin > 1 ? movingAvgCentred(a, posWin) : a);
      const lat = sm(grid.map((g) => rad(g[1])));
      const lon = sm(grid.map((g) => rad(g[2])));
      const alt = sm(grid.map((g) => g[3] + o.altitudeOffsetM));

      const kx = lat.map((la) => R_EARTH * Math.cos(la));
      const E = new Array(n).fill(0), N = new Array(n).fill(0);
      for (let i = 1; i < n; i++) {
        E[i] = E[i - 1] + (lon[i] - lon[i - 1]) * kx[i];
        N[i] = N[i - 1] + (lat[i] - lat[i - 1]) * R_EARTH;
      }
      const diff = (arr) => {
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
          const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
          out[i] = b > a ? (arr[b] - arr[a]) / ((b - a) * dt) : 0;
        }
        return out;
      };
      // Two velocities, deliberately. vE/vN/vU is the plain derivative of the positions that get written, and it
      // is what goes into the file: the simulator drives the injected object from this field (zero it and the
      // aircraft drops out of the sky), so it has to be both accurate and smooth. It is smooth because the
      // positions it differentiates were denoised by smoothPosS, not because of any filter of its own - filtering
      // it separately only makes it disagree with its own positions. The smoothS-filtered vEs/vNs/vUs stay behind
      // for everything *derived*: heading, pitch, bank and the gear/flaps/lights rules, which want a steady signal
      // and are not required to agree with the position derivative.
      const vE = diff(E), vN = diff(N), vU = diff(alt);
      const win = Math.max(1, Math.trunc(o.smoothS * o.hz)) | 1;
      const vEs = movingAvg(vE, win), vNs = movingAvg(vN, win), vUs = movingAvg(vU, win);
      const gs = vEs.map((v, i) => Math.hypot(v, vNs[i]));
      if (prog) prog(0.4);

      // heading = course over ground; hold the last one when (almost) stationary
      let heading = new Array(n), last = null;
      for (let i = 0; i < n; i++) {
        if (gs[i] > 2.0) last = Math.atan2(vEs[i], vNs[i]);
        heading[i] = last === null ? NaN : last;
      }
      const firstValid = heading.find((h) => !Number.isNaN(h));
      heading = heading.map((h) => (Number.isNaN(h) ? (firstValid === undefined ? 0 : firstValid) : h));

      // heading rate -> coordinated-turn bank
      const unwrapped = [heading[0]];
      for (let i = 1; i < n; i++) unwrapped.push(unwrapped[i - 1] + angleWrap(heading[i] - unwrapped[i - 1]));
      const rate = movingAvg(diff(unwrapped), win);
      const maxB = rad(o.maxBankDeg);
      const bankRight = gs.map((g, i) => Math.max(-maxB, Math.min(maxB, Math.atan2(g * rate[i], G))));
      if (prog) prog(0.8);

      // Ground state, and the ground reference written as GROUND ALTITUDE.
      //
      // Two passes, because the two depend on each other. A provisional reference walking from the departure
      // altitude to the arrival one decides who is on the ground; then the reference is rebuilt to follow the
      // ground the aircraft is actually on: while it is down, the ground is exactly where the aircraft is, so
      // the reference *is* its altitude, and the airborne stretch in between is interpolated from the last
      // altitude on the ground to the next one. A single ramp across the whole flight cannot do that - an
      // airfield a few metres off the straight line between the first and last fix (a hill between two strips,
      // a parking spot below the runway) put that error straight into the written height above ground, and
      // JoinFS blends its own terrain reading against ours at full weight whenever height is near zero. That is
      // felt as the aircraft being heaved up or pushed down over the first hundred metres of the climb.
      const provisional = (i) => (n < 2 ? alt[0] : alt[0] + (alt[n - 1] - alt[0]) * (i / (n - 1)));
      const onGround = new Array(n);
      for (let i = 0; i < n; i++) onGround[i] = ((alt[i] - provisional(i)) <= o.groundAglM && gs[i] < o.groundMaxKt * KT) ? 0 : 1;

      // Each unbroken stretch on the ground gets one field elevation, a low percentile of the altitudes in it
      // rather than the altitude of its last sample: the on-ground flag only lets go at groundAglM, so that last
      // sample is already that far up and taking it would put the whole airborne reference - and with it every
      // height JoinFS computes on approach - the same distance too high. A percentile rather than the minimum so
      // one low GPS outlier cannot define an airfield.
      const groundRef = new Array(n);
      const stretches = [];
      for (let i = 0; i < n; i++) {
        if (onGround[i] !== 0) continue;
        const last = stretches[stretches.length - 1];
        if (last && last.end === i - 1) last.end = i;
        else stretches.push({ start: i, end: i });
      }
      for (const s of stretches) {
        const a = alt.slice(s.start, s.end + 1).sort((x, y) => x - y);
        s.elev = a[Math.trunc(a.length * 0.1)];
      }
      if (stretches.length === 0) {
        for (let i = 0; i < n; i++) groundRef[i] = provisional(i);
      } else {
        for (const s of stretches) for (let i = s.start; i <= s.end; i++) groundRef[i] = s.elev;
        for (let i = 0; i < stretches[0].start; i++) groundRef[i] = stretches[0].elev;
        for (let i = stretches[stretches.length - 1].end + 1; i < n; i++) groundRef[i] = stretches[stretches.length - 1].elev;
        // airborne: a straight line from the field it left to the field it is going to
        for (let k = 1; k < stretches.length; k++) {
          const a = stretches[k - 1], b = stretches[k];
          for (let i = a.end + 1; i < b.start; i++) {
            groundRef[i] = a.elev + (b.elev - a.elev) * ((i - a.end) / (b.start - a.end));
          }
        }
      }

      // Trim each ground stretch back to actual contact, now that there is a reference to measure against.
      // Only samples adjacent to an already-airborne one are reconsidered, and the change propagates inwards
      // from there, so this can only shorten a stretch from its ends - noise in the middle of a long taxi can
      // never punch a hole in it.
      for (let i = n - 2; i >= 0; i--) {
        if (onGround[i] === 0 && onGround[i + 1] === 1 && alt[i] - groundRef[i] > o.groundContactM) onGround[i] = 1;
      }
      for (let i = 1; i < n; i++) {
        if (onGround[i] === 0 && onGround[i - 1] === 1 && alt[i] - groundRef[i] > o.groundContactM) onGround[i] = 1;
      }

      // 0 on the ground, 1 airborne, ramped across the transition so the attitude never steps
      const airborne = movingAvg(onGround, Math.max(1, Math.trunc(o.groundBlendS * o.hz)) | 1);

      const samples = new Array(n);
      for (let i = 0; i < n; i++) {
        const ref = groundRef[i];
        const ground = onGround[i] === 0;
        const fpa = Math.atan2(vUs[i], Math.max(gs[i], 1.0));
        const w = airborne[i];
        const pitchUp = w * Math.max(-rad(30), Math.min(rad(30), fpa + rad(o.pitchTrimDeg)));
        const bankR = w * bankRight[i];
        samples[i] = {
          t: t[i], lat: lat[i], lon: lon[i], alt: alt[i],
          pitch: -pitchUp, bank: -bankR, heading: pmod(heading[i], 2 * Math.PI),
          vE: vE[i], vU: vU[i], vN: vN[i], gs: gs[i], ground, elevation: ref,
        };
      }
      return samples;
    }

    // ---- .jfs writer ----------------------------------------------
    const utf8 = new TextEncoder();

    function stringBytes(s) {
      const b = utf8.encode(s);
      let n = b.length;
      const prefix = [];
      for (;;) {                                   // .NET 7-bit encoded length
        const byte = n & 0x7f;
        n >>>= 7;
        if (n) prefix.push(byte | 0x80); else { prefix.push(byte); break; }
      }
      const out = new Uint8Array(prefix.length + b.length);
      out.set(prefix, 0); out.set(b, prefix.length);
      return out;
    }

    function writeJfs(samples, o, prog, sys) {
      const v = o.jfsVersion;
      if (v < 10023) throw new GpxError('jfsVersion must be >= 10023', 'badVersion');
      const head = [stringBytes(o.callsign), stringBytes(o.nickname), stringBytes(o.model)];
      const tail = [];
      if (o.fs2024 && v >= 21004) tail.push(stringBytes(o.livery));
      if ((o.fs2024 && v >= 21005) || (!o.fs2024 && v >= 21004)) tail.push(stringBytes(o.icaoType), stringBytes(o.icaoAirline));
      const len = (a) => a.reduce((s, x) => s + x.length, 0);
      const frameSize = 96 + (v >= 21008 ? 4 : 0);
      const cgFt = o.groundClearanceM === null || o.groundClearanceM === undefined ? NaN : o.groundClearanceM / 0.3048;
      const size = 2 + 4 + 1 + len(head) + 1 + 4 + samples.length * frameSize + (sys ? sys.bytes : 0) + len(tail) + 4;
      const buf = new ArrayBuffer(size), dv = new DataView(buf), u8 = new Uint8Array(buf);
      let p = 0;
      dv.setInt16(p, v, true); p += 2;
      dv.setInt32(p, 1, true); p += 4;                       // one aircraft
      dv.setUint8(p, 1); p += 1;                             // plane
      for (const b of head) { u8.set(b, p); p += b.length; }
      dv.setUint8(p, o.typerole); p += 1;
      dv.setInt32(p, samples.length + (sys ? sys.count : 0), true); p += 4;
      for (let k = 0; k < samples.length; k++) {
        if (prog && (k & 8191) === 0) prog(k / samples.length);
        const s = samples[k];
        dv.setUint8(p, FRAME_AIRCRAFT_POSITION); p += 1;
        dv.setFloat64(p, s.t, true); p += 8;
        dv.setFloat64(p, s.lat, true); p += 8;
        dv.setFloat64(p, s.lon, true); p += 8;
        dv.setFloat64(p, s.alt, true); p += 8;
        for (const f of [s.pitch, s.bank, s.heading, s.vE, s.vU, s.vN, 0, 0, 0, 0, 0, 0]) {
          dv.setFloat32(p, f, true); p += 4;
        }
        for (let i = 0; i < 5; i++) { dv.setInt16(p, 0, true); p += 2; }   // rudder, elevator, aileron, brakes
        dv.setFloat32(p, s.elevation, true); p += 4;
        dv.setUint8(p, s.ground ? 1 : 0); p += 1;
        if (v >= 21008) { dv.setFloat32(p, cgFt, true); p += 4; }
        const extra = sys && sys.byIdx.get(k);           // gear/flaps/lights frames share the sample's timestamp
        if (extra) { u8.set(extra, p); p += extra.length; }
      }
      for (const b of tail) { u8.set(b, p); p += b.length; }
      dv.setInt32(p, 0, true); p += 4;                       // no non-aircraft objects
      if (p !== size) throw new Error('internal size mismatch ' + p + ' vs ' + size);
      return u8;
    }

    // ---- gear / flaps / lights ------------------------------------------
    // JoinFS stores these as variable frames; the id is a hash of the SimVar name (Variables.cs / Node.cs HashString).
    function hashString(str) {
      let h1 = ((5381 << 16) + 5381) >>> 0, h2 = h1;
      for (let i = 0; i < str.length; i += 2) {
        h1 = (((h1 << 5) + h1) ^ str.charCodeAt(i)) >>> 0;
        if (i === str.length - 1) break;
        h2 = (((h2 << 5) + h2) ^ str.charCodeAt(i + 1)) >>> 0;
      }
      return (h1 + Math.imul(h2, 1566083941)) >>> 0;
    }
    const vuid = (name) => hashString(name.toLowerCase()) || 1;      // JoinFS lower-cases the SimVar name before hashing
    const VU = {
      gear: vuid('GEAR HANDLE POSITION'),              // integer 0/1
      flaps: vuid('FLAPS HANDLE PERCENT'),             // float 0..1
      lightStates: vuid('LIGHT STATES'),               // integer bit mask - this one drives the simulator
      nav: vuid('LIGHT STATES1'), beacon: vuid('LIGHT STATES2'),     // per-bit mirrors (name + mask value)
      landing: vuid('LIGHT STATES4'), taxi: vuid('LIGHT STATES8'),
      strobe: vuid('LIGHT STROBE'),                    // planes define strobe as its own variable
    };
    const FT = 0.3048, NM = 1852;

    // flip runs shorter than minLen so a flickering flag (GPS altitude noise) becomes one clean transition
    function debounceFlags(flags, minLen) {
      const out = flags.slice();
      for (let pass = 0; pass < 8; pass++) {
        let changed = false, i = 0;
        while (i < out.length) {
          let j = i;
          while (j < out.length && out[j] === out[i]) j++;
          if (j - i < minLen && !(i === 0 && j === out.length)) {
            const neighbour = i > 0 ? out[i - 1] : out[j];
            for (let k = i; k < j; k++) out[k] = neighbour;
            changed = true;
          }
          i = j;
        }
        if (!changed) break;
      }
      return out;
    }

    // Events are found once over the whole track and latched, so no per-sample hysteresis is needed.
    function planSystems(S, o) {
      const n = S.length, hz = o.hz;
      if (n < 2) return null;
      const kt = (i) => S[i].gs / KT;
      const stable = debounceFlags(S.map((s) => s.ground), Math.max(1, Math.round(o.groundDebounceS * hz)));
      const cum = new Array(n);
      cum[0] = 0;
      for (let i = 1; i < n; i++) {
        const dLat = S[i].lat - S[i - 1].lat, dLon = S[i].lon - S[i - 1].lon;
        cum[i] = cum[i - 1] + Math.hypot(dLat * R_EARTH, dLon * Math.cos((S[i].lat + S[i - 1].lat) / 2) * R_EARTH);
      }
      const hStart = (i) => (S[i].alt - S[0].alt) / FT;
      const onGround = stable[0];

      let liftoff = -1;
      if (stable[0]) { for (let i = 1; i < n; i++) if (!stable[i]) { liftoff = i; break; } }
      let touchdown = -1;
      for (let i = n - 1; i >= 1; i--) if (stable[i] && !stable[i - 1]) { touchdown = i; break; }
      if (touchdown <= liftoff) touchdown = -1;

      // takeoff flaps come up at +200 ft (speed < 140 kt when that height is reached) or at +1000 ft otherwise
      let retract = -1;
      if (liftoff >= 0) {
        let i = liftoff;
        while (i < n && hStart(i) < o.flapsRetractAltFt) i++;
        if (i < n) {
          if (kt(i) < o.flapsRetractSpeedKt) retract = i;
          else { let j = i; while (j < n && hStart(j) < o.flapsRetractFastAltFt) j++; if (j < n) retract = j; }
        }
      }

      // Landing flaps: each stage waits until the aircraft has slowed to within `margin` knots of the speed it
      // will actually touch down at, and until it is close enough that the slowdown can only be the approach
      // (3 nm below 100 kt, 7 nm at or above). Airborne, measured along track.
      let flapsFull = -1, gearDown = -1, vacated = -1;
      const flapSteps = [];
      if (touchdown >= 0) {
        const vTd = kt(touchdown);
        const firstAllowed = Math.max(liftoff + 1, retract >= 0 ? retract + 1 : 0);
        // `nearNm` only tightens the gate once the aircraft is slow: the intermediate stages are allowed further
        // out, because a first notch belongs on the approach, not on short final where full flaps belong.
        const findStage = (from, margin, nearNm) => {
          for (let i = Math.max(from, firstAllowed); i < touchdown; i++) {
            if (stable[i]) continue;
            const dNm = (cum[touchdown] - cum[i]) / NM;
            if (dNm > o.flapsLandingFarNm) continue;
            const v = kt(i);
            if (v <= vTd + margin && dNm <= (v < o.flapsLandingSpeedKt ? nearNm : o.flapsLandingFarNm)) return i;
          }
          return -1;
        };
        // stages on the way down, then full flaps - the margin for which is unchanged
        const steps = (Array.isArray(o.flapsLandingSteps) ? o.flapsLandingSteps : [])
          .filter(([margin]) => margin > o.flapsLandingVtdMarginKt)
          .slice().sort((a, b) => b[0] - a[0]);
        const gap = Math.max(1, Math.round(o.flapsStageMinS * hz));
        let from = firstAllowed;
        for (const [margin, fraction] of steps) {
          const idx = findStage(from, margin, o.flapsLandingFarNm);
          if (idx < 0) continue;
          flapSteps.push({ idx, flaps: o.flapsLanding * fraction });
          from = idx + gap;
        }
        flapsFull = findStage(from, o.flapsLandingVtdMarginKt, o.flapsLandingNearNm);
        if (flapsFull < 0) flapsFull = Math.max(touchdown - 1, 0);
        // a stage that would land on or after full flaps has nothing left to do
        while (flapSteps.length && flapSteps[flapSteps.length - 1].idx >= flapsFull) flapSteps.pop();
        let j = flapsFull;
        while (j > 0 && cum[flapsFull] - cum[j] < o.gearDownBeforeFlapsNm * NM) j--;
        gearDown = Math.max(j, liftoff + 1);
        for (let i = touchdown + 1; i < n; i++) if (kt(i) < o.flapsUpAfterLandingKt) { vacated = i; break; }
      }
      if (retract >= flapsFull && flapsFull >= 0) retract = -1;

      // lights
      let firstMove = -1;
      for (let i = 0; i < n; i++) if (kt(i) >= o.taxiMinKt) { firstMove = i; break; }
      let rollStart = -1;
      if (liftoff >= 0) { let i = liftoff - 1; while (i > 0 && kt(i) >= o.taxiMinKt) i--; rollStart = i; }

      const initial = {
        gear: onGround ? 1 : 0, flaps: onGround ? o.flapsTakeoff : 0,
        nav: 1, beacon: 1, landing: 0, taxi: 0, strobe: onGround ? 0 : 1,
      };
      const ev = [];
      const add = (idx, set) => { if (idx >= 0 && idx < n) ev.push({ idx, set }); };
      if (rollStart >= 0) {
        if (firstMove >= 0 && firstMove < rollStart) add(firstMove, { taxi: 1 });
        add(rollStart, { taxi: 0, strobe: 1 });
      }
      const gearUp = retract >= 0 && gearDown > retract;
      if (retract >= 0) add(retract, gearUp ? { flaps: 0, gear: 0 } : { flaps: 0 });
      // landing light: on at <= 4000 ft above the ground reference, off again above 4000 + 300 ft (hysteresis),
      // active from the start of the takeoff roll until the runway is vacated. The reference blends linearly
      // from the start to the touchdown elevation so it never jumps mid-flight.
      const endRef = touchdown < 0 ? S[0].alt : (stable[n - 1] ? S[n - 1].alt : S[touchdown].alt);     // end elevation as used for ground detection
      const refAlt = (i) => {
        if (touchdown < 0) return S[0].alt;
        if (!onGround) return endRef;
        return S[0].alt + (endRef - S[0].alt) * Math.min(1, cum[i] / Math.max(cum[touchdown], 1));
      };
      const mStart = rollStart >= 0 ? rollStart : (onGround ? -1 : 0);
      const mEnd = vacated >= 0 ? vacated - 1 : n - 1;
      if (mStart >= 0) {
        let lightOn = false;
        for (let i = mStart; i <= mEnd; i++) {
          const h = (S[i].alt - refAlt(i)) / FT;
          if (!lightOn && h <= o.lightLandingBelowFt) { lightOn = true; add(i, { landing: 1 }); }
          else if (lightOn && h > o.lightLandingBelowFt + o.lightLandingHysteresisFt) { lightOn = false; add(i, { landing: 0 }); }
        }
      }
      if (gearUp) add(gearDown, { gear: 1 });
      for (const s of flapSteps) add(s.idx, { flaps: s.flaps });
      if (flapsFull >= 0) add(flapsFull, { flaps: o.flapsLanding });
      if (vacated >= 0) add(vacated, { flaps: 0, strobe: 0, landing: 0, taxi: 1 });
      ev.sort((a, b) => a.idx - b.idx);
      const at = (i) => (i >= 0 ? Math.round((i / hz) * 10) / 10 : null);
      return { initial, ev, marks: { liftoffS: at(liftoff), flapsRetractS: at(retract), flapsFullS: at(flapsFull),
        flapsStepsS: flapSteps.map((s) => ({ atS: at(s.idx), flaps: s.flaps })),
        gearUpS: gearUp ? at(retract) : null, gearDownS: gearUp ? at(gearDown) : null, touchdownS: at(touchdown), vacatedS: at(vacated) } };
    }

    // one Integer + one Float variable frame per snapshot, aligned with a position sample
    function buildSystemFrames(plan, samples, o) {
      const n = samples.length, hz = o.hz;
      const idxs = new Set([0]);
      for (const e of plan.ev) idxs.add(e.idx);
      for (const sec of [0.5, 1, 2, 3]) { const i = Math.round(sec * hz); if (i < n) idxs.add(i); }   // the replay object may spawn late
      for (let sec = o.systemsRefreshS; Math.round(sec * hz) < n; sec += o.systemsRefreshS) idxs.add(Math.round(sec * hz));
      const order = Array.from(idxs).sort((a, b) => a - b);
      const st = Object.assign({}, plan.initial);
      let e = 0;
      const byIdx = new Map();
      let count = 0, bytes = 0;
      for (const idx of order) {
        while (e < plan.ev.length && plan.ev[e].idx <= idx) Object.assign(st, plan.ev[e++].set);
        const t = samples[idx].t;
        const ints = [];
        ints.push([VU.gear, st.gear]);                     // fixed-gear aircraft are expected to ignore the handle
        const mask = st.nav | (st.beacon << 1) | (st.landing << 2) | (st.taxi << 3) | (st.strobe << 4);
        ints.push([VU.lightStates, mask], [VU.nav, st.nav], [VU.beacon, st.beacon], [VU.landing, st.landing],
                  [VU.taxi, st.taxi], [VU.strobe, st.strobe]);
        const floats = [[VU.flaps, st.flaps]];
        const buf = new Uint8Array((1 + 8 + 2 + ints.length * 8) + (1 + 8 + 2 + floats.length * 8));
        const dv = new DataView(buf.buffer);
        let p = 0;
        dv.setUint8(p, 11); p += 1;                                  // FrameType.IntegerVariables
        dv.setFloat64(p, t, true); p += 8;
        dv.setUint16(p, ints.length, true); p += 2;
        for (const [id, val] of ints) { dv.setUint32(p, id, true); p += 4; dv.setInt32(p, val, true); p += 4; }
        dv.setUint8(p, 12); p += 1;                                  // FrameType.FloatVariables
        dv.setFloat64(p, t, true); p += 8;
        dv.setUint16(p, floats.length, true); p += 2;
        for (const [id, val] of floats) { dv.setUint32(p, id, true); p += 4; dv.setFloat32(p, val, true); p += 4; }
        byIdx.set(idx, buf);
        count += 2; bytes += buf.length;
      }
      return { byIdx, count, bytes };
    }

    // ---- points -> .jfs -------------------------------------------
    // onProgress(fraction 0..1) is optional.
    function convertPoints(rawPts, name, options, onProgress) {
      const o = Object.assign({}, DEFAULTS, options || {});
      const rep = (a, b) => (onProgress ? (x) => onProgress(a + (b - a) * x) : null);
      if (rawPts.length > o.maxPoints) throw new GpxError('Track too large (' + rawPts.length + ' points, limit ' + o.maxPoints + ')', 'tooLarge', { points: rawPts.length, limit: o.maxPoints });
      const pts = clean(rawPts);
      if (pts.length < 2) throw new GpxError('Track has fewer than 2 distinct timestamps', 'fewDistinct');
      const dur = pts[pts.length - 1].t - pts[0].t;
      if (dur * o.hz > 1500000) throw new GpxError('Track too long for the chosen frame rate', 'tooLong');
      const grid = resample(pts, o, rep(0, 0.35));
      const samples = derive(grid, o, rep(0.35, 0.6));
      const plan = o.systems === 'off' ? null : planSystems(samples, o);
      const sys = plan ? buildSystemFrames(plan, samples, o) : null;
      const data = writeJfs(samples, o, rep(0.6, 1), sys);
      let dist = 0, maxAlt = -Infinity;
      for (let i = 0; i < pts.length - 1; i++) dist += hav(pts[i], pts[i + 1]);
      for (const p of pts) maxAlt = Math.max(maxAlt, p.ele);
      let maxSp = 0;
      for (const s of samples) maxSp = Math.max(maxSp, Math.hypot(s.vE, s.vN));
      const r1 = (x) => Math.round(x * 10) / 10;
      return {
        data,
        info: {
          trackName: name, inputPoints: pts.length, frames: samples.length, durationS: r1(dur),
          distanceKm: Math.round(dist / 10) / 100, maxAltM: r1(maxAlt), maxSpeedKt: r1(maxSp / KT),
          bytes: data.length, jfsVersion: o.jfsVersion,
          systems: plan ? Object.assign({ variableFrames: sys.count }, plan.marks) : null,
        },
      };
    }

    return { convertPoints, GpxError, TYPEROLES, DEFAULTS, _hashString: hashString, _vuids: VU };
  }

  // Folder this script was loaded from (with trailing slash) - locale files are looked up next to it.
  const SCRIPT_BASE = (function () {
    try {
      const d = root.document, s = d && d.currentScript;
      if (s && s.src) return s.src.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
      if (d && d.baseURI) return new URL('.', d.baseURI).href;
    } catch (_) { /* fall through */ }
    return '';
  })();

  const core = makeCore();
  const { GpxError, TYPEROLES, DEFAULTS } = core;

  // ==================================================================
  // GPX parsing (needs DOMParser -> stays on the page thread)
  // ==================================================================
  function parseTime(s) {
    s = s.trim();
    if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) s += 'Z';        // no zone -> assume UTC (like the Python version)
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms / 1000;
  }

  function localName(node) {
    return (node.localName || node.nodeName || '').replace(/^.*:/, '');
  }

  function parseGpx(text, DomParser) {
    const DP = DomParser || root.DOMParser;
    if (!DP) throw new GpxError('No XML parser available', 'noParser');
    if (text.slice(0, 4096).toUpperCase().includes('<!DOCTYPE') || text.toUpperCase().includes('<!ENTITY')) {
      throw new GpxError('DOCTYPE/ENTITY declarations are not allowed in GPX uploads', 'doctype');
    }
    let doc;
    try { doc = new DP().parseFromString(text, 'application/xml'); }
    catch (e) { throw new GpxError('Not a valid XML/GPX file: ' + e.message, 'notXml'); }
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) {
      throw new GpxError('Not a valid XML/GPX file', 'notXml');
    }
    if (localName(doc.documentElement) !== 'gpx') throw new GpxError('Root element is not <gpx>', 'notGpx');

    const all = (tag) => Array.from(doc.getElementsByTagNameNS ? doc.getElementsByTagNameNS('*', tag)
                                                             : doc.getElementsByTagName(tag));

    let name = '';
    for (const el of all('name')) {
      const t = (el.textContent || '').trim();
      if (t) { name = t; break; }
    }

    function collect(tag) {
      const out = [];
      let missingTime = 0;
      for (const el of all(tag)) {
        const lat = parseFloat(el.getAttribute('lat'));
        const lon = parseFloat(el.getAttribute('lon'));
        if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
        let ele = NaN, ts = null;
        for (let c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          const ln = localName(c);
          if (ln === 'ele' && c.textContent) ele = parseFloat(c.textContent);
          else if (ln === 'time' && c.textContent) ts = parseTime(c.textContent);
        }
        if (ts === null) { missingTime++; continue; }
        out.push({ t: ts, lat, lon, ele });
      }
      if (missingTime && !out.length) throw new GpxError('GPX has no <time> elements - a timed track is required for a replay', 'noTime');
      return out;
    }

    let pts = collect('trkpt');
    if (!pts.length) pts = collect('rtept');
    if (pts.length < 2) throw new GpxError('GPX needs at least 2 timed track points', 'fewPoints');

    if (pts.every((p) => Number.isNaN(p.ele))) {
      pts.forEach((p) => { p.ele = 0; });
    } else {
      let last = pts.find((p) => !Number.isNaN(p.ele)).ele;
      for (const p of pts) {
        if (Number.isNaN(p.ele)) p.ele = last; else last = p.ele;
      }
    }
    return { pts, name };
  }

  // ==================================================================
  // Public API
  // ==================================================================

  /** Synchronous conversion on the calling thread. */
  function convert(gpxText, options, DomParser) {
    const { pts, name } = parseGpx(gpxText, DomParser);
    return core.convertPoints(pts, name, options);
  }

  function workerSource() {
    return '"use strict";\n'
      + 'const core = (' + makeCore.toString() + ')();\n'
      + 'self.onmessage = function (e) {\n'
      + '  const m = e.data;\n'
      + '  try {\n'
      + '    const a = m.pts, pts = new Array(a.length / 4);\n'
      + '    for (let i = 0; i < pts.length; i++) pts[i] = { t: a[4*i], lat: a[4*i+1], lon: a[4*i+2], ele: a[4*i+3] };\n'
      + '    let lastPost = 0;\n'
      + '    const r = core.convertPoints(pts, m.name, m.options, function (f) {\n'
      + '      const now = Date.now();\n'
      + '      if (now - lastPost > 50) { lastPost = now; self.postMessage({ type: "progress", fraction: f }); }\n'
      + '    });\n'
      + '    self.postMessage({ type: "done", buffer: r.data.buffer, info: r.info }, [r.data.buffer]);\n'
      + '  } catch (err) {\n'
      + '    self.postMessage({ type: "error", gpx: err instanceof core.GpxError, message: String(err && err.message || err), code: err && err.code, params: err && err.params });\n'
      + '  }\n'
      + '};\n';
  }

  /**
   * Asynchronous conversion. Parses on the calling thread, computes in a Web Worker
   * (falls back to the calling thread if no worker can be started).
   * opts: { onProgress(fraction), signal (AbortSignal), DomParser, WorkerCtor, useWorker }
   * Resolves to { data: Uint8Array, info }.
   */
  function convertAsync(gpxText, options, opts) {
    opts = opts || {};
    const o = Object.assign({}, DEFAULTS, options || {});
    return new Promise((resolve, reject) => {
      if (opts.signal && opts.signal.aborted) return reject(abortError());
      let parsed;
      try { parsed = parseGpx(gpxText, opts.DomParser); } catch (e) { return reject(e); }
      const { pts, name } = parsed;

      const runHere = () => {
        try { resolve(core.convertPoints(pts, name, o, null)); } catch (e) { reject(e); }
      };
      const WorkerCtor = opts.WorkerCtor || root.Worker;
      const URLc = root.URL;
      if (opts.useWorker === false || !WorkerCtor || typeof Blob === 'undefined' || !URLc || !URLc.createObjectURL) {
        return runHere();
      }

      let worker, url, finished = false;
      const onAbort = () => { if (finished) return; cleanup(); reject(abortError()); };
      const cleanup = () => {
        finished = true;
        try { worker.terminate(); } catch (_) { /* ignore */ }
        try { URLc.revokeObjectURL(url); } catch (_) { /* ignore */ }
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };
      try {
        url = URLc.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
        worker = new WorkerCtor(url);
      } catch (e) { return runHere(); }

      if (opts.signal) opts.signal.addEventListener('abort', onAbort);
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (finished) return;
        if (m.type === 'progress') { if (opts.onProgress) opts.onProgress(m.fraction); }
        else if (m.type === 'done') { cleanup(); resolve({ data: new Uint8Array(m.buffer), info: m.info }); }
        else if (m.type === 'error') { cleanup(); reject(m.gpx ? new GpxError(m.message, m.code, m.params) : new Error(m.message)); }
      };
      worker.onerror = (ev) => {                       // worker could not run at all (CSP, sandbox, ...)
        if (finished) return;
        if (ev && ev.preventDefault) ev.preventDefault();
        cleanup();
        runHere();
      };

      const arr = new Float64Array(pts.length * 4);
      for (let i = 0; i < pts.length; i++) {
        arr[4 * i] = pts[i].t; arr[4 * i + 1] = pts[i].lat; arr[4 * i + 2] = pts[i].lon; arr[4 * i + 3] = pts[i].ele;
      }
      worker.postMessage({ pts: arr, name, options: o }, [arr.buffer]);
    });
  }

  function abortError() {
    const e = new Error('Cancelled');
    e.name = 'AbortError';
    return e;
  }

  const api = { convert, convertAsync, parseGpx, TYPEROLES, DEFAULTS, GpxError, _workerSource: workerSource, _core: core };
  root.Gpx2Jfs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ==================================================================
  // UI strings. English is built in and is the fallback for every missing key.
  // Other languages are lazy-loaded from  joinfs-gpx-to-jfs.<locale>.json  next to this script.
  // ==================================================================
  const EN = {
    'title': 'GPX \u2192 JoinFS recording',
    'privacy': 'Runs entirely in your browser \u2013 the file is not uploaded anywhere.',
    'drop.title': 'Drag & drop your GPX file here',
    'drop.hint': 'GPX tracklog with timestamps (.gpx)',
    'drop.or': 'or',
    'drop.choose': 'Choose GPX file',
    'drop.chooseOther': 'Choose a different file',
    'drop.over': 'Drop to load this file',
    'drop.loaded': 'Ready \u2013 click here or drop another file to replace it',
    'drop.aria': 'Drop area for a GPX file',
    'file.tooLarge': 'The file is too large (maximum {max} MB).',
    'file.notGpx': 'Please choose a .gpx file.',
    'file.readError': 'The file could not be read.',
    'field.icao': 'ICAO type designator',
    'hint.icao': 'e.g. C172 (2\u20134 letters or digits)',
    'err.icaoInvalid': 'The ICAO type designator must be 2\u20134 letters or digits (e.g. C172).',
    'field.callsign': 'Callsign',
    'hint.callsign': 'Tail number or airline flight number \u2013 e.g. D-EJOE or DLH1234, shown to other pilots.',
    'field.model': 'Model title',
    'hint.model': 'Exact aircraft title as installed in the *replaying* simulator \u2013 it lets JoinFS replay that exact model and livery if available instead of substituting a similar aircraft.',
    'field.livery': 'Livery',
    'hint.livery': '*MSFS 2024 builds only* \u2013 exact livery name; together with the model title it selects the precise aircraft. Leave empty if unsure.',
    'field.nickname': 'Pilot name',
    'field.build': 'JoinFS build',
    'hint.build': 'Recordings differ between builds \u2013 pick the one you replay with.',
    'build.fs2024': 'MSFS 2024',
    'build.other': 'MSFS 2020 / FSX / P3D / X-Plane',
    'preset.title': 'Preset by this page',
    'btn.convert': 'Convert',
    'btn.cancel': 'Cancel',
    'btn.reset': 'Reset to defaults',
    'storage.note': 'Your entries are remembered in this browser.',
    'status.reading': 'Reading file\u2026',
    'status.converting': 'Converting\u2026',
    'status.cancelled': 'Cancelled.',
    'result.title': 'Recording ready',
    'result.summary': '{points} points \u2192 {frames} frames \u00b7 {minutes} min \u00b7 {km} km \u00b7 {mb} MB',
    'result.download': 'Download {file}',
    'result.next': 'Next step: in the JoinFS Recorder choose File | Open Recording\u2026 and select the downloaded file.',
    'err.failed': 'Conversion failed: {message}',
    'err.noParser': 'This browser cannot read XML files.',
    'err.doctype': 'DOCTYPE/ENTITY declarations are not allowed in GPX files.',
    'err.notXml': 'This is not a valid GPX (XML) file.',
    'err.notGpx': 'This XML file is not a GPX file.',
    'err.noTime': 'The GPX file has no timestamps \u2013 a timed track is required for a replay.',
    'err.fewPoints': 'The GPX file needs at least 2 track points with timestamps.',
    'err.fewDistinct': 'The track has fewer than 2 distinct timestamps.',
    'err.tooLarge': 'The track is too large ({points} points, limit {limit}).',
    'err.tooLong': 'The track is too long for the chosen frame rate.',
    'err.badVersion': 'Unsupported recording version.',
  };

  const ICON = {
    upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 15.01l1.41 1.41L11 14.84V19h2v-4.16l1.59 1.59L16 15.01 12.01 11 8 15.01z"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
  };

  // ==================================================================
  // <joinfs-gpx-to-jfs> custom element (Material Design)
  //
  // Attributes / URL parameters (URL wins over attribute):
  //   icao-type | ?icao   callsign   model   nickname   build
  //   A valid value PRESETS the setting and hides its input field. Add the boolean attribute `editable`
  //   to keep the fields visible and use the values only as defaults instead.
  //   typerole  systems  hz  altitude-offset  smooth-pos  ground-clearance
  //                     no input field at all - attribute / URL parameter or the default (see HIDDEN)
  //   no-url-params   ignore URL parameters          auto-convert   convert as soon as a file is loaded
  //   lang | ?lang    force a UI language            locale-base    folder of the locale files (default: folder of this script)
  //   storage-key     localStorage key (default joinfs-gpx-to-jfs:v1)
  // ==================================================================
  const api2 = root.Gpx2Jfs;
  api2.messages = { en: EN };

  if (typeof HTMLElement !== 'undefined' && typeof customElements !== 'undefined' && !customElements.get('joinfs-gpx-to-jfs')) {
    const BUILDS = ['fs2024', 'other'];
    const ICAO_RE = /^[A-Z0-9]{2,4}$/;
    const MAX_MB = 50;
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // setting key -> element id of its input
    const IDS = { icaoType: 'icao', callsign: 'callsign', model: 'model', livery: 'livery', nickname: 'nick', build: 'build' };
    const FIELDS = Object.keys(IDS);
    // Settings without an input field: they are taken from attribute / URL parameter or left at their default.
    // `typerole` because JoinFS reads the byte from the recording verbatim and a wrong guess actively hurts model
    // matching (see TYPEROLES); `unknown` lets the ICAO type designator do the work. `systems` because deriving
    // gear, flaps and lights is what the converter is for - `off` stays available for the reference writer and as
    // an escape hatch, but it is not a question to put to the user.
    // `hz` is here too: the output frame rate is a property of the file, not something to ask a pilot about, but
    // 5 Hz is not right for everyone (a 20 Hz recording is four times the frames and four times the size).
    const HIDDEN = ['typerole', 'systems', 'hz', 'altitudeOffset', 'smoothPos', 'groundClearance'];
    const KEYS = FIELDS.concat(HIDDEN);
    const BASE_DEFAULTS = {
      icaoType: DEFAULTS.icaoType, callsign: DEFAULTS.callsign, model: DEFAULTS.model, livery: '', nickname: '',
      typerole: 'unknown', systems: 'full', build: 'fs2024', hz: String(DEFAULTS.hz),
      altitudeOffset: String(DEFAULTS.altitudeOffsetM),
      smoothPos: String(DEFAULTS.smoothPosS),
      groundClearance: DEFAULTS.groundClearanceM === null ? 'none' : String(DEFAULTS.groundClearanceM),
    };
    // A blank attribute is not a value: Number('') is 0, which would silently turn a numeric setting into
    // "0" rather than leaving it at its default. Reject it before the range check.
    const num = (lo, hi) => (v) => {
      v = String(v).trim();
      if (v === '') return undefined;
      const n = Number(v);
      return (Number.isFinite(n) && n >= lo && n <= hi) ? String(n) : undefined;
    };
    // returns a clean value or undefined (= not usable)
    const SANITIZE = {
      icaoType: (v) => { v = String(v).trim().toUpperCase(); return ICAO_RE.test(v) ? v : undefined; },
      callsign: (v) => { v = String(v).trim().slice(0, 16); return v || undefined; },
      model: (v) => { v = String(v).trim().slice(0, 128); return v || undefined; },
      // '' is a legitimate value for both: an empty livery is what "no particular livery" looks like in the file
      livery: (v) => String(v).trim().slice(0, 128),
      nickname: (v) => String(v).trim().slice(0, 32),
      typerole: (v) => (has(TYPEROLES, String(v)) ? String(v) : undefined),
      build: (v) => (BUILDS.includes(String(v)) ? String(v) : undefined),
      systems: (v) => (['full', 'off'].includes(String(v)) ? String(v) : undefined),
      // 1-30 Hz; the converter still refuses a track that would blow up the frame count (err.tooLong)
      hz: num(1, 30),
      // metres, +/- 500: enough for any terrain-datum mismatch, small enough that a typo cannot send a track into orbit
      altitudeOffset: num(-500, 500),
      smoothPos: num(0, 10),
      // 'none' writes NaN: JoinFS then treats the clearance as unknown and makes no ground correction at all
      groundClearance: (v) => (String(v).trim() === 'none' ? 'none' : num(0, 20)(v)),
    };
    const PARAM_NAMES = {
      icaoType: ['icao', 'icao-type'], callsign: ['callsign'], model: ['model'], livery: ['livery'], nickname: ['nickname'],
      typerole: ['typerole'], build: ['build'], systems: ['systems'], hz: ['hz'],
      altitudeOffset: ['altitude-offset', 'alt-offset'],
      smoothPos: ['smooth-pos'], groundClearance: ['ground-clearance'],
    };
    const ATTR_NAMES = {
      icaoType: 'icao-type', callsign: 'callsign', model: 'model', livery: 'livery', nickname: 'nickname',
      typerole: 'typerole', build: 'build', systems: 'systems', hz: 'hz', altitudeOffset: 'altitude-offset',
      smoothPos: 'smooth-pos', groundClearance: 'ground-clearance',
    };

    async function fetchLocale(url) {
      if (typeof root.fetch !== 'function') return null;
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), 4000) : null;
      try {
        const res = await root.fetch(url, { signal: ac ? ac.signal : undefined, credentials: 'same-origin' });
        if (!res.ok) return null;
        const data = JSON.parse(await res.text());               // a SPA/404 page served as 200 fails here -> counts as "not found"
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const out = {};
        for (const k of Object.keys(data)) if (typeof data[k] === 'string') out[k] = data[k];
        return Object.keys(out).length ? out : null;
      } catch (_) { return null; } finally { if (timer) clearTimeout(timer); }
    }

    // Material 3 baseline palettes. Every colour goes through --_x custom properties, which fall back to the public --gj-x overrides.
    const LIGHT = `--_accent:var(--gj-accent,#6750a4);--_on-accent:var(--gj-on-accent,#fff);--_bg:var(--gj-bg,#fffbfe);
  --_fg:var(--gj-fg,#1d1b20);--_muted:var(--gj-muted,#49454f);--_outline:var(--gj-outline,#79747e);--_border:var(--gj-border,#cac4d0);
  --_placeholder:var(--gj-placeholder,#76717b);--_error:var(--gj-error,#b3261e);--_container:var(--gj-container,#e8def8);
  --_on-container:var(--gj-on-container,#1d192b);--_error-container:var(--gj-error-container,#f9dedc);--_on-error-container:var(--gj-on-error-container,#410e0b);`;
    const DARK = `--_accent:var(--gj-accent,#d0bcff);--_on-accent:var(--gj-on-accent,#381e72);--_bg:var(--gj-bg,#141218);
  --_fg:var(--gj-fg,#e6e0e9);--_muted:var(--gj-muted,#cac4d0);--_outline:var(--gj-outline,#938f99);--_border:var(--gj-border,#49454f);
  --_placeholder:var(--gj-placeholder,#938f99);--_error:var(--gj-error,#f2b8b5);--_container:var(--gj-container,#4a4458);
  --_on-container:var(--gj-on-container,#e8def8);--_error-container:var(--gj-error-container,#8c1d18);--_on-error-container:var(--gj-on-error-container,#f9dedc);`;

    const CSS = `
:host{display:block;max-width:var(--gj-max-width,34rem);font:16px/1.5 Roboto,system-ui,-apple-system,"Segoe UI",sans-serif;
  color-scheme:light dark;${LIGHT}color:var(--_fg)}
/* colour scheme: follows the browser/OS preference; the attribute theme="light" | "dark" forces one */
@media (prefers-color-scheme:dark){:host(:not([theme="light"])){${DARK}}}
:host([theme="dark"]){color-scheme:dark;${DARK}}
:host([theme="light"]){color-scheme:light}
[hidden]{display:none!important}
.box{background:var(--_bg);border:1px solid var(--_border);border-radius:12px;padding:clamp(1rem,4.5vw,1.25rem) clamp(1rem,4.5vw,1.25rem) 1rem}
h2{margin:0 0 .25rem;font-size:1.375rem;font-weight:400;line-height:1.75rem}
p{margin:0}
.note{color:var(--_muted);font-size:.875rem}
svg{fill:currentColor}
/* ---- drop zone ---- */
.drop{margin-top:1.25rem;padding:1.5rem 1rem 1.25rem;text-align:center;cursor:pointer;
  border:2px dashed var(--_outline);border-radius:12px;
  background:rgba(103,80,164,.05);background:color-mix(in srgb,var(--_accent) 6%,transparent);
  transition:background .15s,border-color .15s}
.drop:hover{border-color:var(--_accent)}
.drop.over{border-style:solid;border-color:var(--_accent);background:rgba(103,80,164,.14);background:color-mix(in srgb,var(--_accent) 14%,transparent)}
.drop.has-file{border-style:solid;border-color:var(--_accent)}
.drop .big{width:48px;height:48px;color:var(--_accent)}
#drop-icon{display:block;width:48px;height:48px;margin:0 auto;line-height:0}
.drop-title{margin-top:.25rem;font-size:1.0625rem;font-weight:500;overflow-wrap:anywhere}
.drop-sub{margin-top:.125rem;font-size:.875rem;color:var(--_muted)}
.drop-or{margin:.75rem 0 .5rem;font-size:.75rem;letter-spacing:.5px;text-transform:uppercase;color:var(--_muted)}
.drop .pick{margin-top:.75rem}
.drop:not(.has-file) .pick{margin-top:0}
/* ---- outlined text field: the label sits permanently in the notch so the placeholder stays readable ----
   Label, border and hint are held at 80% so the value the user typed stays the most prominent thing in the field.
   They are dimmed with color-mix rather than opacity so that the label keeps its opaque background (it has to
   cut the notch out of the border) and so that the focus / invalid rules below can simply override the colour. */
.field{position:relative;margin-top:1.5rem}
.field input,.field select{display:block;width:100%;height:56px;box-sizing:border-box;margin:0;padding:0 16px;
  font:inherit;color:var(--_fg);background:transparent;border:1px solid var(--_outline);border-radius:4px;outline:none;
  border-color:color-mix(in srgb,var(--_outline) 60%,transparent);
  transition:border-color .15s,box-shadow .15s}
.field select{appearance:none;-webkit-appearance:none;padding-right:44px;cursor:pointer}
.field select option{color:var(--_fg);background:var(--_bg)}
.field.sel::after{content:"";position:absolute;right:18px;top:20px;width:7px;height:7px;border:solid var(--_muted);
  border-width:0 2px 2px 0;transform:rotate(45deg);pointer-events:none}
.field label{position:absolute;left:12px;top:-9px;padding:0 4px;font-size:.75rem;line-height:1rem;color:var(--_muted);
  color:color-mix(in srgb,var(--_muted) 60%,transparent);
  background:var(--_bg);pointer-events:none;transition:color .15s}
.field input::placeholder{color:var(--_placeholder);opacity:1}
.field input:hover,.field select:hover{border-color:var(--_fg)}
.field input:focus,.field select:focus{border-color:var(--_accent);box-shadow:0 0 0 1px var(--_accent)}
.field:focus-within label{color:var(--_accent)}
.field.invalid input{border-color:var(--_error);box-shadow:0 0 0 1px var(--_error)}
.field.invalid label,.field.invalid .hint{color:var(--_error)}
.hint{margin:4px 16px 0;font-size:.75rem;line-height:1rem;color:var(--_muted);
  color:color-mix(in srgb,var(--_muted) 60%,transparent)}
.uc{text-transform:uppercase}.uc::placeholder{text-transform:uppercase}
.preset{margin-top:1.25rem;padding:.5rem .75rem;border-radius:8px;font-size:.875rem;color:var(--_muted);background:rgba(103,80,164,.08);background:color-mix(in srgb,var(--_accent) 9%,transparent)}
.preset b{font-weight:500;color:var(--_fg)}
/* ---- buttons ---- */
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;box-sizing:border-box;height:40px;margin:1.5rem 0 0;
  padding:0 24px;font:inherit;font-size:.875rem;font-weight:500;letter-spacing:.1px;color:var(--_on-accent);background:var(--_accent);
  border:0;border-radius:20px;cursor:pointer;text-decoration:none;transition:box-shadow .15s,opacity .15s}
.btn svg{width:18px;height:18px;flex:none}
.btn:hover{box-shadow:0 1px 3px 1px rgba(0,0,0,.2)}
.btn:focus-visible,.text:focus-visible{outline:2px solid var(--_accent);outline-offset:2px}
.btn[disabled]{opacity:.38;cursor:default;box-shadow:none}
.btn.sec{margin-top:.75rem;color:var(--_accent);background:transparent;border:1px solid var(--_outline)}
.btn.tonal{display:inline-flex;width:auto;margin:0;padding:0 24px 0 16px;color:var(--_on-container);background:var(--_container)}
.btn.dl{height:auto;min-height:52px;padding:12px 24px;margin-top:1rem;border-radius:26px;font-size:1rem;box-shadow:0 1px 3px 1px rgba(0,0,0,.18)}
.btn.dl span{min-width:0;overflow-wrap:anywhere;text-align:center}
.btn.dl svg{width:24px;height:24px}
.foot{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:.25rem .5rem;margin-top:1rem;font-size:.75rem;color:var(--_muted)}
.text{font:inherit;font-size:.875rem;font-weight:500;color:var(--_accent);background:none;border:0;padding:6px 8px;border-radius:16px;cursor:pointer}
.text:hover{background:rgba(103,80,164,.1);background:color-mix(in srgb,var(--_accent) 10%,transparent)}
progress{width:100%;height:4px;margin-top:.5rem;accent-color:var(--_accent)}
/* ---- results ---- */
.msg{margin-top:1.25rem;padding:.75rem 1rem;border-radius:8px;font-size:.875rem}
.err{background:var(--_error-container);color:var(--_on-error-container)}
.result{margin-top:1.25rem;padding:1rem;border-radius:12px;background:var(--_container);color:var(--_on-container)}
.result-head{display:flex;gap:12px;align-items:center}
.result-head svg{width:32px;height:32px;flex:none;color:var(--_accent)}
.result-title{font-weight:500}
.result .note{color:var(--_on-container);opacity:.85}
.result .next{margin-top:.75rem}
/* touch screens: larger targets */
@media (pointer:coarse){.btn{height:48px}.text{padding:10px 12px}}`;

    class JoinfsGpxToJfs extends HTMLElement {
      // ---------------- i18n ----------------
      // A translated text may mark words for emphasis with *asterisks*. They become <b> elements built from text
      // nodes - never innerHTML - so a locale file can add emphasis but can never inject markup. Translators are
      // free to move the emphasis to whichever word carries it in their language.
      setText(node, s) {
        s = String(s);
        if (!s.includes('*')) { node.textContent = s; return; }
        node.textContent = '';
        s.split('*').forEach((part, i) => {
          if (part === '') return;
          if (i % 2) { const b = document.createElement('b'); b.textContent = part; node.appendChild(b); }
          else node.appendChild(document.createTextNode(part));
        });
      }

      t(key, vars) {
        let s = (this._strings && typeof this._strings[key] === 'string') ? this._strings[key] : (has(EN, key) ? EN[key] : key);
        if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (has(vars, n) ? vars[n] : m));
        return s;
      }

      num(n, opts) {
        try { return n.toLocaleString(this._locale === 'en' ? undefined : this._locale, opts); }
        catch (_) { return n.toLocaleString(undefined, opts); }
      }

      applyI18n() {
        const sr = this.shadowRoot;
        if (!sr) return;
        sr.querySelectorAll('[data-i18n]').forEach((n) => { this.setText(n, this.t(n.getAttribute('data-i18n'))); });
        sr.querySelectorAll('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', this.t(n.getAttribute('data-i18n-aria'))); });
        const box = sr.querySelector('.box');
        if (box) box.lang = this._locale;
        this.updateDrop();
        this.renderPreset();
        this.validate();
      }

      async loadLocale() {
        const q = this.urlParams();
        const forced = q.get('lang') || this.getAttribute('lang');
        const nav = root.navigator || {};
        const prefs = forced ? [forced]
          : (nav.languages && nav.languages.length ? Array.from(nav.languages) : (nav.language ? [nav.language] : []));
        let base = this.getAttribute('locale-base') || SCRIPT_BASE;
        if (base && !base.endsWith('/')) base += '/';
        const seen = new Set();
        for (const tag of prefs) {
          if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(tag)) continue;     // also keeps ?lang= from escaping the folder
          const primary = tag.split('-')[0].toLowerCase();
          if (primary === 'en') return;                                              // built-in English wins as soon as it is preferred
          for (const cand of (tag.includes('-') ? [tag, primary] : [tag])) {
            if (seen.has(cand.toLowerCase())) continue;
            seen.add(cand.toLowerCase());
            const strings = await fetchLocale(base + 'joinfs-gpx-to-jfs.' + cand + '.json');
            if (strings) {
              this._strings = strings;
              this._locale = cand;
              this.applyI18n();
              this.dispatchEvent(new CustomEvent('locale-loaded', { detail: { locale: cand }, bubbles: true, composed: true }));
              return;
            }
          }
        }
        // none of the preferred languages available -> stay on English
      }

      // ---------------- presets (attributes + URL parameters) ----------------
      urlParams() {
        if (this.hasAttribute('no-url-params')) return new URLSearchParams('');
        try { return new URLSearchParams(root.location ? root.location.search : ''); } catch (_) { return new URLSearchParams(''); }
      }

      readProvided() {
        const q = this.urlParams();
        const out = {};
        for (const k of KEYS) {
          let raw = null;
          for (const n of PARAM_NAMES[k]) { if (q.has(n)) { raw = q.get(n); break; } }
          if (raw === null) raw = this.getAttribute(ATTR_NAMES[k]);
          if (raw === null) continue;
          const v = SANITIZE[k](raw);
          if (v !== undefined) out[k] = v;
        }
        return out;
      }

      // ---------------- persistence (localStorage, guarded: may be blocked or unavailable) ----------------
      get storageKey() { return this.getAttribute('storage-key') || 'joinfs-gpx-to-jfs:v1'; }

      rawPrefs() {
        try { const p = JSON.parse(root.localStorage.getItem(this.storageKey)); return p && typeof p === 'object' ? p : {}; }
        catch (_) { return {}; }
      }

      loadPrefs() {
        const p = this.rawPrefs(), out = {};
        for (const k of FIELDS) { if (has(p, k)) { const v = SANITIZE[k](p[k]); if (v !== undefined) out[k] = v; } }
        return out;
      }

      savePrefs() {
        try {
          const cur = this.rawPrefs(), v = this.readValues();
          for (const k of this._visible) cur[k] = v[k];                // preset (hidden) values are never stored
          for (const k of Object.keys(cur)) if (!FIELDS.includes(k)) delete cur[k];   // settings that no longer exist
          root.localStorage.setItem(this.storageKey, JSON.stringify(cur));
        } catch (_) { /* ignore */ }
      }

      storageAvailable() {
        try {
          const k = this.storageKey + ':probe';
          root.localStorage.setItem(k, '1'); root.localStorage.removeItem(k);
          return true;
        } catch (_) { return false; }
      }

      // ---------------- form values ----------------
      $(id) { return this.shadowRoot.getElementById(id); }

      readValues() {
        const v = {};
        for (const k of FIELDS) v[k] = this.$(IDS[k]).value.trim();
        v.icaoType = v.icaoType.toUpperCase();
        return v;
      }

      validate() {
        if (!this._visible || !this._visible.includes('icaoType')) return true;
        const v = this.$('icao').value.trim().toUpperCase();
        const bad = v !== '' && !ICAO_RE.test(v);
        this.$('f-icao').classList.toggle('invalid', bad);
        this.setText(this.$('h-icao'), this.t(bad ? 'err.icaoInvalid' : 'hint.icao'));
        return !bad;
      }

      renderPreset() {
        const el = this.$('preset');
        if (!el) return;
        const items = [['icaoType', 'field.icao'], ['callsign', 'field.callsign'], ['model', 'field.model']]
          .filter(([k]) => has(this._locked, k));
        el.hidden = items.length === 0;
        el.textContent = '';
        if (!items.length) return;
        const head = document.createElement('b');
        head.textContent = this.t('preset.title') + ': ';
        el.appendChild(head);
        el.appendChild(document.createTextNode(items.map(([k, lbl]) => this.t(lbl) + ' ' + this._locked[k]).join(' \u00b7 ')));
      }

      // ---------------- lifecycle ----------------
      connectedCallback() {
        if (this._ready) return;
        this._ready = true;
        this._locale = 'en';
        this._strings = null;

        const provided = this.readProvided();
        const editable = this.hasAttribute('editable');
        this._locked = editable ? {} : provided;
        const defs = this._defaults = Object.assign({}, BASE_DEFAULTS, editable ? provided : {});
        this._visible = FIELDS.filter((k) => !has(this._locked, k));
        // no input field, so `editable` does not apply: attribute / URL parameter, otherwise the default
        this._fixed = {};
        for (const k of HIDDEN) this._fixed[k] = has(provided, k) ? provided[k] : BASE_DEFAULTS[k];
        const start = Object.assign({}, defs, this.loadPrefs(), this._locked);
        for (const k of FIELDS) { if (has(this._locked, k)) start[k] = this._locked[k]; }

        // The recording only has a livery slot in the MSFS 2024 layout, so the field is pointless for the other
        // builds: it starts hidden there and syncLivery() follows the build select while the user changes it.
        const hides = (k) => has(this._locked, k) || (k === 'livery' && start.build !== 'fs2024');
        const wrap = (k, inner) => '<div class="field' + (inner.sel ? ' sel' : '') + '" id="f-' + IDS[k] + '"'
          + (hides(k) ? ' hidden' : '') + '>' + inner.html + '</div>';
        const text = (k, opts) => wrap(k, {
          html: '<input id="' + IDS[k] + '" type="text" autocomplete="off" spellcheck="false" maxlength="' + opts.max + '"'
            + (opts.uc ? ' class="uc"' : '') + ' value="' + esc(start[k]) + '" placeholder="' + esc(defs[k]) + '">'
            + '<label for="' + IDS[k] + '" data-i18n="field.' + opts.name + '"></label>'
            + (opts.hint ? '<p class="hint" id="h-' + IDS[k] + '" data-i18n="hint.' + opts.name + '"></p>' : ''),
        });
        const select = (k, name, options, hint) => wrap(k, {
          sel: true,
          html: '<select id="' + IDS[k] + '">' + options.map(([val, key, plain]) => '<option value="' + esc(val) + '"'
            + (val === start[k] ? ' selected' : '') + (key ? ' data-i18n="' + key + '"' : '') + '>' + esc(plain || '') + '</option>').join('')
            + '</select><label for="' + IDS[k] + '" data-i18n="field.' + name + '"></label>'
            + (hint ? '<p class="hint" data-i18n="' + hint + '"></p>' : ''),
        });

        // a field that is hidden because it does not apply must not keep the Convert button alive
        const shown = this._visible.filter((k) => !hides(k));
        const auto = this.hasAttribute('auto-convert') || shown.length === 0;
        this._auto = auto;
        const stored = shown.length > 0 && this.storageAvailable();
        this.attachShadow({ mode: 'open' }).innerHTML = '<style>' + CSS + '</style>'
          + '<div class="box" part="box">'
          + '<h2 data-i18n="title"></h2><p class="note" data-i18n="privacy"></p>'
          + '<input type="file" id="file" hidden accept=".gpx,.xml,application/gpx+xml,text/xml,application/xml">'
          + '<div class="drop" id="drop" part="dropzone" role="group" data-i18n-aria="drop.aria">'
          +   '<span class="big" id="drop-icon"></span>'
          +   '<p class="drop-title" id="drop-title"></p><p class="drop-sub" id="drop-sub"></p>'
          +   '<p class="drop-or" id="drop-or" data-i18n="drop.or"></p>'
          +   '<button type="button" class="btn tonal pick" id="pick">' + ICON.upload + '<span id="pick-label"></span></button>'
          + '</div>'
          + '<p class="preset" id="preset" hidden></p>'
          + text('icaoType', { name: 'icao', hint: true, max: 4, uc: true })
          + text('callsign', { name: 'callsign', hint: true, max: 16 })
          + text('model', { name: 'model', hint: true, max: 128 })
          + text('livery', { name: 'livery', hint: true, max: 128 })
          + text('nickname', { name: 'nickname', max: 32 })
          + select('build', 'build', [['fs2024', 'build.fs2024'], ['other', 'build.other']], 'hint.build')
          + '<button class="btn" id="go" disabled' + (auto ? ' hidden' : '') + ' data-i18n="btn.convert"></button>'
          + '<div id="out" role="status" aria-live="polite"></div>'
          + (shown.length ? '<div class="foot"><span' + (stored ? ' data-i18n="storage.note"' : '') + '></span>'
            + '<button class="text" id="reset" type="button" data-i18n="btn.reset"></button></div>' : '')
          + '</div>';
        this._file = null;
        this._over = false;
        const input = this.$('file'), drop = this.$('drop');
        input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) this.loadFile(f); });
        drop.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
        this.$('go').addEventListener('click', () => this.run());
        drop.addEventListener('dragenter', (e) => { e.preventDefault(); this._over = true; this.updateDrop(); });
        drop.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          if (!this._over) { this._over = true; this.updateDrop(); }
        });
        drop.addEventListener('dragleave', (e) => {
          if (e.relatedTarget && drop.contains(e.relatedTarget)) return;
          this._over = false; this.updateDrop();
        });
        drop.addEventListener('drop', (e) => {
          e.preventDefault();
          this._over = false; this.updateDrop();
          const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          if (f) this.loadFile(f);
        });
        const onEdit = (e) => {
          if (e.target.id === 'file') return;
          this.syncLivery();
          this.validate();
          this.savePrefs();
          if (this._hasResult) this.$('out').textContent = '', this._hasResult = false;     // settings changed -> result is stale
        };
        this.shadowRoot.addEventListener('input', onEdit);
        this.shadowRoot.addEventListener('change', onEdit);
        const reset = this.$('reset');
        if (reset) reset.addEventListener('click', () => {
          for (const k of this._visible) {
            const el = this.$(IDS[k]);
            el.value = defs[k];
          }
          try {
            const cur = this.rawPrefs();
            for (const k of this._visible) delete cur[k];
            if (Object.keys(cur).length) root.localStorage.setItem(this.storageKey, JSON.stringify(cur));
            else root.localStorage.removeItem(this.storageKey);
          } catch (_) { /* ignore */ }
          this.validate();
        });

        this.syncLivery();
        this.applyI18n();
        this.loadLocale();
      }

      // The livery string is part of the MSFS 2024 recording layout only; for the other builds the field would be
      // a setting with no effect, so it is hidden. A preset livery stays hidden either way. The value is kept, so
      // switching the build back brings it up again; the converter ignores it for the other builds regardless.
      syncLivery() {
        const f = this.$('f-livery'), build = this.$('build');
        if (!f || !build || has(this._locked, 'livery')) return;
        f.hidden = build.value !== 'fs2024';
      }

      // ---------------- drop zone state ----------------
      updateDrop() {
        const drop = this.$('drop');
        if (!drop) return;
        const f = this._file, over = !!this._over;
        drop.classList.toggle('over', over);
        drop.classList.toggle('has-file', !!f && !over);
        this.$('drop-icon').innerHTML = (f && !over) ? ICON.check : ICON.upload;
        this.$('drop-icon').firstChild.setAttribute('class', 'big');
        this.$('drop-title').textContent = over ? this.t('drop.over') : (f ? f.name : this.t('drop.title'));
        this.$('drop-sub').textContent = f ? this.num(f.size / 1048576 >= 1 ? f.size / 1048576 : f.size / 1024, { maximumFractionDigits: 1 })
          + (f.size / 1048576 >= 1 ? ' MB' : ' KB') + ' \u00b7 ' + this.t('drop.loaded') : this.t('drop.hint');
        this.$('drop-or').hidden = !!f;
        this.$('pick-label').textContent = this.t(f ? 'drop.chooseOther' : 'drop.choose');
      }

      showError(text) {
        const out = this.$('out');
        out.textContent = '';
        const d = document.createElement('div');
        d.className = 'msg err';
        d.textContent = text;
        out.appendChild(d);
      }

      /** Load a File object (also used by the picker and drop). Returns false if it was rejected. */
      loadFile(file) {
        if (!file) return false;
        if (this._abort) { this._abort.abort(); this._abort = null; }   // a new file cancels a running conversion
        this._hasResult = false;
        if (!/\.(gpx|xml)$/i.test(file.name)) { this.showError(this.t('file.notGpx')); return false; }
        if (file.size > MAX_MB * 1048576) { this.showError(this.t('file.tooLarge', { max: MAX_MB })); return false; }
        this._file = file;
        this.$('out').textContent = '';
        this.$('go').disabled = false;
        this.updateDrop();
        if (this._auto) this.run();
        return true;
      }

      readText(file) {
        return new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(new Error(this.t('file.readError')));
          r.readAsText(file);
        });
      }

      /** optional attributes flaps-takeoff / flaps-landing (0..1): FLAPS HANDLE PERCENT used for takeoff and landing */
      flapOptions() {
        const out = {};
        for (const [attr, key] of [['flaps-takeoff', 'flapsTakeoff'], ['flaps-landing', 'flapsLanding']]) {
          const v = parseFloat(this.getAttribute(attr));
          if (v >= 0 && v <= 1) out[key] = v;
        }
        return out;
      }

      errorText(e) {
        if (e && e.name === 'GpxError' && has(EN, 'err.' + e.code)) return this.t('err.' + e.code, e.params);
        return this.t('err.failed', { message: (e && e.message) || String(e) });
      }

      async run() {
        const out = this.$('out');
        if (!this._file) return;
        if (!this.validate()) { this.showError(this.t('err.icaoInvalid')); return; }
        const file = this._file, d = this._defaults, v = this.readValues();
        const abort = new AbortController();
        this._abort = abort;
        this._hasResult = false;
        this.$('go').disabled = true;
        out.textContent = '';
        const msg = document.createElement('p');
        msg.className = 'note'; msg.style.marginTop = '1.25rem'; msg.textContent = this.t('status.reading');
        const prog = document.createElement('progress');
        prog.max = 1; prog.value = 0;
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'btn sec'; cancel.textContent = this.t('btn.cancel');
        cancel.addEventListener('click', () => abort.abort());
        out.append(msg, prog, cancel);
        try {
          const text = await this.readText(file);
          if (abort.signal.aborted) throw abortError();
          msg.textContent = this.t('status.converting');
          const { data, info } = await convertAsync(text, {
            icaoType: v.icaoType || d.icaoType,
            callsign: v.callsign || d.callsign,
            model: v.model || d.model,
            livery: v.livery,
            nickname: v.nickname,
            typerole: TYPEROLES[this._fixed.typerole],
            jfsVersion: DEFAULTS.jfsVersion,         // 21008: ICAO strings plus the static-CG field
            fs2024: v.build === 'fs2024',
            systems: this._fixed.systems,
            hz: Number(this._fixed.hz),
            altitudeOffsetM: Number(this._fixed.altitudeOffset),
            smoothPosS: Number(this._fixed.smoothPos),
            groundClearanceM: this._fixed.groundClearance === 'none' ? null : Number(this._fixed.groundClearance),
            ...this.flapOptions(),
          }, { signal: abort.signal, onProgress: (f) => { prog.value = f; } });
          const stem = file.name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'recording';
          const filename = stem + '.jfs';
          if (this._url) URL.revokeObjectURL(this._url);
          const blob = new Blob([data], { type: 'application/octet-stream' });
          this._url = URL.createObjectURL(blob);
          const link = this.showResult(info, filename, this._url);
          this._hasResult = true;
          this.dispatchEvent(new CustomEvent('converted', { detail: { info, blob, filename }, bubbles: true, composed: true }));
          if (link.focus) link.focus();              // Enter/Space downloads right away; also scrolls the button into view
        } catch (e) {
          if (this._abort !== abort) return;                    // superseded by a newer file / run
          if (e && e.name === 'AbortError') {
            out.textContent = '';
            const p = document.createElement('p');
            p.className = 'note'; p.style.marginTop = '1.25rem'; p.textContent = this.t('status.cancelled');
            out.appendChild(p);
          } else this.showError(this.errorText(e));
        } finally {
          if (this._abort === abort) this.$('go').disabled = !this._file;
        }
      }

      showResult(info, filename, url) {
        const out = this.$('out');
        out.textContent = '';
        const card = document.createElement('div');
        card.className = 'result';
        const head = document.createElement('div');
        head.className = 'result-head';
        head.innerHTML = ICON.check;
        const txt = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'result-title'; title.textContent = this.t('result.title');
        const sum = document.createElement('div');
        sum.className = 'note';
        sum.textContent = this.t('result.summary', {
          points: this.num(info.inputPoints), frames: this.num(info.frames),
          minutes: this.num(info.durationS / 60, { maximumFractionDigits: 1 }),
          km: this.num(info.distanceKm, { maximumFractionDigits: 1 }),
          mb: this.num(info.bytes / 1048576, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
        });
        txt.append(title, sum);
        head.appendChild(txt);
        const a = document.createElement('a');
        a.className = 'btn dl'; a.href = url; a.download = filename;
        a.innerHTML = ICON.download;
        const label = document.createElement('span');
        label.textContent = this.t('result.download', { file: filename });
        a.appendChild(label);
        const next = document.createElement('p');
        next.className = 'note next'; next.textContent = this.t('result.next');
        card.append(head, a, next);
        out.appendChild(card);
        return a;
      }
    }
    customElements.define('joinfs-gpx-to-jfs', JoinfsGpxToJfs);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
