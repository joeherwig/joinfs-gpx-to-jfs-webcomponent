'use strict';
/**
 * Cross-platform test runner.
 *   node test/run.js             unit + component tests (fast, no browser)
 *   node test/run.js --browser   real-browser tests (needs the optional puppeteer-core + @sparticuz/chromium)
 *   node test/run.js --all       both
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const list = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
let files = [];
if (args.includes('--all')) files = [...list(__dirname), ...list(path.join(__dirname, 'browser'))];
else if (args.includes('--browser')) files = list(path.join(__dirname, 'browser'));
else files = list(__dirname);

const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
