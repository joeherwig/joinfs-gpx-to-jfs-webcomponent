'use strict';
/**
 * Cross-check against an independent implementation: tools/reference/gpx2jfs.py writes the same recordings
 * (position frames and file layout; it does not do gear/flaps/lights, so the systems option is off here).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DOMParser } = require('@xmldom/xmldom');

const J = require('../src/joinfs-gpx-to-jfs.js');
const { patternFlight, toGpx, simulate } = require('./helpers/tracks.js');

class QuietParser extends DOMParser { constructor() { super({ onError() {} }); } }
const python = ['python3', 'python'].find((cmd) => { try { return spawnSync(cmd, ['--version']).status === 0; } catch (_) { return false; } });
const script = path.join(__dirname, '..', 'tools', 'reference', 'gpx2jfs.py');

const flights = {
  'pattern flight': patternFlight(),
  'noisy pattern flight': patternFlight({ noise: 1, seed: 7 }),
  'takeoff and climb only': simulate([{ dur: 40, v: 0 }, { dur: 30, v: 45, acc: 2 }, { dur: 120, v: 55, vz: 4, turn: 1 }]),
};
const layouts = [
  { name: 'MSFS 2024, version 21005', args: ['--jfs-version', '21005', '--fs2024'], opts: { jfsVersion: 21005, fs2024: true } },
  { name: 'other builds, version 21005', args: ['--jfs-version', '21005'], opts: { jfsVersion: 21005, fs2024: false } },
  { name: 'version 21003', args: ['--jfs-version', '21003'], opts: { jfsVersion: 21003, fs2024: false } },
];

for (const [flightName, pts] of Object.entries(flights)) {
  for (const layout of layouts) {
    test(`${flightName}, ${layout.name}: byte-identical to the Python reference`, { skip: !python && 'python is not installed' }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfs-'));
      try {
        const gpxFile = path.join(dir, 'in.gpx'), out = path.join(dir, 'out.jfs');
        const text = toGpx(pts);
        fs.writeFileSync(gpxFile, text);
        const r = spawnSync(python, [script, gpxFile, '-o', out, '--model', 'Cessna 172 Wheels', '--callsign', 'ASGX', '--nickname', 'Pilot',
          '--icao-type', 'C172', '--typerole', 'singleprop', '--hz', '5', ...layout.args], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        const js = J.convert(text, { systems: 'off', model: 'Cessna 172 Wheels', callsign: 'ASGX', nickname: 'Pilot', icaoType: 'C172', typerole: 1, hz: 5, ...layout.opts }, QuietParser).data;
        const ref = fs.readFileSync(out);
        assert.equal(js.length, ref.length, 'same size');
        assert.equal(Buffer.compare(Buffer.from(js.buffer, js.byteOffset, js.length), ref), 0, 'same bytes');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
