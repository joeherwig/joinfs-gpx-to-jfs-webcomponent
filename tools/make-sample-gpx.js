'use strict';
/** Regenerates demo/sample-track.gpx: a synthetic, slightly noisy 23 minute local flight (not real data). */
const fs = require('fs');
const path = require('path');
const { patternFlight, toGpx } = require('../test/helpers/tracks.js');

const out = path.join(__dirname, '..', 'demo', 'sample-track.gpx');
fs.writeFileSync(out, toGpx(patternFlight({ noise: 0.6, seed: 42 }), { name: 'Synthetic sample flight', creator: 'joinfs-gpx2jfs-converter-webcomponent (synthetic sample)' }));
console.log('wrote', out);
