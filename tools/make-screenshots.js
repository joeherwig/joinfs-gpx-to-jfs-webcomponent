'use strict';
/**
 * Regenerates docs/screenshots/*.png with headless Chromium (needs the optional packages puppeteer-core and
 * @sparticuz/chromium): the component with and without input fields, in light and dark theme, before and after a
 * conversion, plus two overview images.
 */
const fs = require('fs');
const path = require('path');
const { serve } = require('../test/helpers/staticServer.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const SAMPLE = path.join(ROOT, 'demo', 'sample-track.gpx');
const PRESET = '?icao=C172&callsign=ASGX&model=Cessna%20172%20Wheels&livery=&nickname=&build=fs2024';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VARIANTS = [['fields', ''], ['preset', PRESET]];
const SCHEMES = ['light', 'dark'];
const STATES = ['initial', 'converted'];

(async () => {
  const puppeteer = require('puppeteer-core');
  // CHROME_PATH points at a locally installed Chrome/Edge. @sparticuz/chromium carries a Linux binary only, so on
  // Windows and macOS that environment variable is the way to regenerate the screenshots. --lang keeps them English.
  let browser;
  if (process.env.CHROME_PATH) {
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox', '--lang=en-US'], headless: 'shell' });
  } else {
    const chromium = require('@sparticuz/chromium');
    const chrome = chromium.default || chromium;
    browser = await puppeteer.launch({ executablePath: await chrome.executablePath(), args: [...chrome.args, '--no-sandbox'], headless: 'shell' });
  }
  const server = await serve(ROOT);
  fs.mkdirSync(OUT, { recursive: true });
  const files = {};

  for (const [variant, query] of VARIANTS) {
    for (const scheme of SCHEMES) {
      for (const state of STATES) {
        const page = await browser.newPage();
        await page.setViewport({ width: 620, height: 900, deviceScaleFactor: 2 });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
        await page.goto(server.url + '/demo/index.html' + query, { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelector('joinfs-gpx-to-jfs').shadowRoot);
        if (state === 'converted') {
          const input = await page.evaluateHandle(() => document.querySelector('joinfs-gpx-to-jfs').shadowRoot.getElementById('file'));
          await input.uploadFile(SAMPLE);
          if (variant === 'fields') await page.evaluate(() => document.querySelector('joinfs-gpx-to-jfs').shadowRoot.getElementById('go').click());
          await page.waitForFunction(() => !!document.querySelector('joinfs-gpx-to-jfs').shadowRoot.querySelector('a.dl'), { timeout: 15000 });
        }
        await sleep(400);
        const r = await page.evaluate(() => { const b = document.querySelector('joinfs-gpx-to-jfs').getBoundingClientRect(); return { x: b.x, y: b.y + scrollY, w: b.width, h: b.height }; });
        const file = path.join(OUT, `${variant}-${state}-${scheme}.png`);
        await page.screenshot({ path: file, clip: { x: r.x - 20, y: r.y - 20, width: r.w + 40, height: r.h + 40 }, captureBeyondViewport: true });
        files[`${variant}-${state}-${scheme}`] = file;
        await page.close();
      }
    }
  }

  // overview images: one row per state, four columns (with fields light/dark, without fields light/dark)
  for (const state of STATES) {
    const cols = [['fields', 'light', 'With input fields', 'light theme'], ['fields', 'dark', 'With input fields', 'dark theme'],
                  ['preset', 'light', 'Preset, no input fields', 'light theme'], ['preset', 'dark', 'Preset, no input fields', 'dark theme']];
    const cell = ([v, s, t1, t2]) => `<figure class="${s}"><figcaption><b>${t1}</b><br>${t2}</figcaption><img src="data:image/png;base64,${fs.readFileSync(files[`${v}-${state}-${s}`]).toString('base64')}"></figure>`;
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:24px;background:#8d8a94;font:15px/1.4 system-ui,sans-serif}
      .row{display:flex;gap:24px;align-items:flex-start}
      figure{margin:0;border-radius:12px;overflow:hidden;background:#fff}
      figure.dark{background:#0f0d13;color:#e6e0e9} figure.light{background:#f4eff4;color:#1d1b20}
      figcaption{padding:12px 16px;text-align:center}
      img{display:block;width:310px;height:auto}
    </style><div class="row">${cols.map(cell).join('')}</div>`;
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    const box = await page.evaluate(() => { const r = document.querySelector('.row').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    await page.screenshot({ path: path.join(OUT, `overview-${state}.png`), clip: { x: 0, y: 0, width: box.w + 48, height: box.h + 48 }, captureBeyondViewport: true });
    await page.close();
  }
  await server.close();
  await browser.close();
  console.log('wrote', fs.readdirSync(OUT).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
