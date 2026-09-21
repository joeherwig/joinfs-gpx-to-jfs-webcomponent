'use strict';
/**
 * Measures how much a GPX track makes the replayed aircraft surge, and what `smooth-pos` costs to stop it.
 *
 *   node tools/track-noise.js <file.gpx> [--hz 20]
 *
 * The resampler interpolates through every source point, so GPS noise is amplified into a speed oscillation
 * rather than averaged away. The simulator drives the injected object from the velocity in the recording, so
 * that oscillation is what shows up as an aircraft surging fore and aft. This reports, for a range of
 * `smoothPosS` values, the remaining speed swing and how far the smoothing moved the flown path - so a value
 * can be chosen from the track in hand instead of a default tuned on a fixture.
 *
 * Reads only; it writes no files.
 */
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const J = require(path.join(__dirname, '..', 'src', 'joinfs-gpx-to-jfs.js'));
const { decode } = require(path.join(__dirname, '..', 'test', 'helpers', 'jfs.js'));

class QuietParser extends DOMParser { constructor() { super({ onError() {} }); } }

const R_EARTH = 6371008.8, KT = 0.514444;
const WINDOWS = [0, 1, 1.5, 2, 3, 4, 5];

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const hzArg = args.indexOf('--hz');
const hz = hzArg >= 0 ? Number(args[hzArg + 1]) : 20;
if (!file) {
  console.error('usage: node tools/track-noise.js <file.gpx> [--hz 20]');
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const source = J.parseGpx(text, QuietParser).pts;

function positions(smoothPosS) {
  const { data } = J.convert(text, { hz, smoothPosS, systems: 'off' }, QuietParser);
  return decode(data, { fs2024: true }).aircraft[0].positions;
}

/**
 * The surge the simulator follows: how far the speed swings *around its own trend*, not in total.
 * Climbing out and slowing down on final are real speed changes worth tens of knots; subtracting a
 * long moving average leaves only the oscillation, which is what is felt as surging.
 */
function surge(frames) {
  const airborne = frames.filter((f) => !f.ground);
  if (airborne.length < 3) return null;
  const v = [], times = [];
  for (let i = 1; i < airborne.length; i++) {
    const a = airborne[i - 1], b = airborne[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    v.push(Math.hypot((b.lat - a.lat) * R_EARTH, (b.lon - a.lon) * R_EARTH * Math.cos(a.lat), b.alt - a.alt) / dt);
    times.push(a.t);
  }
  const trendWin = (Math.max(1, Math.trunc(10 * hz)) | 1), half = (trendWin - 1) / 2;
  const residual = v.map((_, i) => {
    let sum = 0, count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) { sum += v[k]; count++; }
    return v[i] - sum / count;
  });
  const sorted = residual.map(Math.abs).sort((a, b) => a - b);
  let turns = 0;
  for (let i = 1; i < residual.length - 1; i++) if ((residual[i] - residual[i - 1]) * (residual[i + 1] - residual[i]) < 0) turns++;
  const span = times[times.length - 1] - times[0];
  return {
    // 2x the 95th percentile of |residual|: a peak-to-peak figure that ignores a couple of outliers
    swingKt: 2 * sorted[Math.trunc(sorted.length * 0.95)] / KT,
    oscHz: span > 0 ? turns / 2 / span : 0,
  };
}

/**
 * Largest distance the smoothing moved the track away from the unsmoothed one. Read it as an upper bound on
 * distortion, not as distortion: on a noisy track most of this is the noise being removed, which is the point.
 * It only means lost fidelity where the raw track was telling the truth - a flare, a tight turn.
 */
function shift(frames, raw) {
  let worst = 0;
  for (let i = 0; i < Math.min(frames.length, raw.length); i++) {
    const a = raw[i], b = frames[i];
    worst = Math.max(worst, Math.hypot((b.lat - a.lat) * R_EARTH, (b.lon - a.lon) * R_EARTH * Math.cos(a.lat), b.alt - a.alt));
  }
  return worst;
}

const gaps = [];
for (let i = 1; i < source.length; i++) gaps.push(source[i].t - source[i - 1].t);
gaps.sort((a, b) => a - b);

console.log(path.basename(file));
console.log('  ' + source.length + ' points, ' + ((source[source.length - 1].t - source[0].t) / 60).toFixed(1)
  + ' min, median spacing ' + gaps[gaps.length >> 1].toFixed(2) + ' s, output ' + hz + ' Hz');
console.log();
console.log('  smooth-pos    speed swing    oscillation    moved by');

const raw = positions(0);
let best = null;
for (const w of WINDOWS) {
  const frames = w === 0 ? raw : positions(w);
  const s = surge(frames);
  if (!s) { console.log('  (track has no airborne section to measure)'); break; }
  const d = w === 0 ? 0 : shift(frames, raw);
  if (best === null && s.swingKt <= 2) best = w;
  console.log('  ' + (w + ' s').padEnd(14) + (s.swingKt.toFixed(1) + ' kt').padStart(9)
    + (s.oscHz.toFixed(2) + ' Hz').padStart(15) + (d.toFixed(1) + ' m').padStart(14));
}

console.log();
console.log('  Speed swing is how far the speed moves around its own trend - the fore/aft surging.');
console.log('  "Moved by" is the largest distance from the unsmoothed track: an upper bound on lost');
console.log('  detail, most of which on a noisy track is the noise itself being removed.');
console.log();
if (best === null) {
  console.log('  Even ' + WINDOWS[WINDOWS.length - 1] + ' s leaves more than 2 kt. This track is rough enough that a boxcar cannot');
  console.log('  fix it without blurring real detail. Pick the largest window you can live with, and see');
  console.log('  the note in README about replacing the interpolating spline with a fitting one.');
} else if (best === 0) {
  console.log('  This track is already smooth; smooth-pos="0" is fine and keeps the path exact.');
} else {
  console.log('  smooth-pos="' + best + '" is the smallest window that brings the swing under 2 kt.');
  console.log('  If "moved by" in that row is large next to the precision you need on approach, step');
  console.log('  back a row and accept a little more surge.');
}
