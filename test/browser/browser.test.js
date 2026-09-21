'use strict';
/**
 * Real-browser tests (headless Chromium): the full flow, drag and drop, lazy-loaded locale files over HTTP,
 * colour schemes and responsive layout. Skipped when puppeteer-core / @sparticuz/chromium are not installed
 * or Chromium cannot be started.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { serve } = require('../helpers/staticServer.js');

const ROOT = path.join(__dirname, '..', '..');
const SAMPLE = path.join(ROOT, 'demo', 'sample-track.gpx');
const LIGHT = 'rgb(255, 251, 254)', DARK = 'rgb(20, 18, 24)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, browser, unavailable = null;

test.before(async () => {
  try {
    const puppeteer = require('puppeteer-core');
    // CHROME_PATH points at a locally installed Chrome/Edge. @sparticuz/chromium carries a Linux binary only, so on
    // Windows and macOS that environment variable is the way to run these tests instead of skipping them.
    if (process.env.CHROME_PATH) {
      // --lang pins the UI language: the tests assert the built-in English texts, and a locally installed
      // Chrome usually runs in the user's own language, which the component would then lazy-load instead.
      browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox', '--lang=en-US'], headless: 'shell' });
    } else {
      const chromium = require('@sparticuz/chromium');
      const chrome = chromium.default || chromium;
      browser = await puppeteer.launch({ executablePath: await chrome.executablePath(), args: [...chrome.args, '--no-sandbox'], headless: 'shell' });
    }
  } catch (e) { unavailable = 'browser not available: ' + String(e.message).split('\n')[0]; }
  server = await serve(ROOT);
});
test.after(async () => { if (browser) await browser.close(); if (server) await server.close(); });

async function open(t, { scheme = 'light', width = 900, height = 900, mobile = false, path: p = '/demo/index.html', init } = {}) {
  if (unavailable) { t.skip(unavailable); return null; }
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  if (init) await page.evaluateOnNewDocument(init);
  await page.goto(server.url + p, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('joinfs-gpx-to-jfs') && document.querySelector('joinfs-gpx-to-jfs').shadowRoot);
  return page;
}
const sr = (page, fn, ...args) => page.evaluate((src, a) => new Function('sr', 'args', 'return (' + src + ')(sr, args)')(document.querySelector('joinfs-gpx-to-jfs').shadowRoot, a), fn.toString(), args);
async function uploadSample(page) {
  const input = await page.evaluateHandle(() => document.querySelector('joinfs-gpx-to-jfs').shadowRoot.getElementById('file'));
  await input.uploadFile(SAMPLE);
}
async function convert(page) {
  await uploadSample(page);
  await sr(page, (s) => s.getElementById('go').click());
  await page.waitForFunction(() => !!document.querySelector('joinfs-gpx-to-jfs').shadowRoot.querySelector('a.dl'), { timeout: 15000 });
}

test('upload, convert and download in a real browser (worker path)', async (t) => {
  const page = await open(t, { init: () => { window.__workers = 0; const W = window.Worker; window.Worker = function (...a) { window.__workers++; return new W(...a); }; } });
  if (!page) return;
  await convert(page);
  const r = await sr(page, async (s) => {
    const a = s.querySelector('a.dl');
    const buf = await (await fetch(a.href)).arrayBuffer();
    const dv = new DataView(buf);
    return { name: a.getAttribute('download'), size: buf.byteLength, version: dv.getInt16(0, true), aircraft: dv.getInt32(2, true), focused: s.activeElement === a, text: s.getElementById('out').textContent };
  });
  assert.equal(r.name, 'sample-track.jfs');
  assert.equal(r.version, 21008, 'the layout with the ICAO strings and the static-CG field');
  assert.equal(r.aircraft, 1);
  assert.ok(r.size > 500000, 'size ' + r.size);
  assert.ok(r.focused, 'download link is focused');
  assert.match(r.text, /Recording ready/);
  assert.ok(await page.evaluate(() => window.__workers) >= 1, 'a Web Worker (Blob URL) was used');
  await page.close();
});

test('drag and drop loads a file', async (t) => {
  const page = await open(t);
  if (!page) return;
  const r = await sr(page, async (s) => {
    const text = await (await fetch('/demo/sample-track.gpx')).text();
    const drop = s.getElementById('drop');
    const dt = new DataTransfer(); dt.items.add(new File([text], 'dropped.gpx', { type: 'application/gpx+xml' }));
    drop.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const over = { cls: drop.className, title: s.getElementById('drop-title').textContent };
    drop.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return { over, after: { cls: drop.className, title: s.getElementById('drop-title').textContent, go: s.getElementById('go').disabled } };
  });
  assert.match(r.over.cls, /over/); assert.equal(r.over.title, 'Drop to load this file');
  assert.match(r.after.cls, /has-file/); assert.equal(r.after.title, 'dropped.gpx'); assert.equal(r.after.go, false);
  await page.close();
});

test('locale files are lazy-loaded over HTTP in preference order', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const page = await browser.newPage();
  const requests = [];
  page.on('response', (res) => { if (/joinfs-gpx-to-jfs\.[\w-]+\.json$/.test(res.url())) requests.push([path.basename(res.url()), res.status()]); });
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'de-AT', 'en'] }));
  await page.goto(server.url + '/demo/index.html');
  await page.waitForFunction(() => document.querySelector('joinfs-gpx-to-jfs').shadowRoot.querySelector('.box').lang === 'de');
  assert.deepEqual(requests, [['joinfs-gpx-to-jfs.fr-FR.json', 404], ['joinfs-gpx-to-jfs.fr.json', 404], ['joinfs-gpx-to-jfs.de-AT.json', 404], ['joinfs-gpx-to-jfs.de.json', 200]]);
  assert.equal(await sr(page, (s) => s.querySelector('h2').textContent), 'GPX → JoinFS-Aufzeichnung');
  await page.close();
});

test('settings survive a reload', async (t) => {
  const page = await open(t);
  if (!page) return;
  await sr(page, (s) => { const i = s.getElementById('callsign'); i.value = 'D-EABC'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('joinfs-gpx-to-jfs').shadowRoot);
  assert.equal(await sr(page, (s) => s.getElementById('callsign').value), 'D-EABC');
  await page.close();
});

test('colour scheme follows the browser setting and can be forced', async (t) => {
  const cases = [['light', null, LIGHT], ['dark', null, DARK], ['light', 'dark', DARK], ['dark', 'light', LIGHT], ['dark', 'auto', DARK]];
  for (const [os, attr, want] of cases) {
    const page = await open(t, { scheme: os, width: 800 });
    if (!page) return;
    if (attr) await page.evaluate((a) => document.querySelector('joinfs-gpx-to-jfs').setAttribute('theme', a), attr);
    await sleep(50);
    const r = await sr(page, (s) => ({ bg: getComputedStyle(s.querySelector('.box')).backgroundColor, cs: getComputedStyle(s.host).colorScheme }));
    assert.equal(r.bg, want, `OS ${os}, theme=${attr}`);
    assert.equal(r.cs, attr === 'dark' ? 'dark' : attr === 'light' ? 'light' : 'light dark', 'color-scheme for native controls');
    await page.close();
  }
});

test('--gj-* variables override the palette in both schemes', async (t) => {
  for (const os of ['light', 'dark']) {
    const page = await open(t, { scheme: os });
    if (!page) return;
    await page.evaluate(() => document.querySelector('joinfs-gpx-to-jfs').style.setProperty('--gj-accent', '#008000'));
    assert.equal(await sr(page, (s) => getComputedStyle(s.querySelector('.drop .big')).color), 'rgb(0, 128, 0)', os);
    await page.close();
  }
});

test('responsive: no horizontal overflow from 320 to 1280 px, long file names stay inside the download button', async (t) => {
  for (const [w, os] of [[320, 'light'], [320, 'dark'], [375, 'light'], [768, 'dark'], [1280, 'light']]) {
    const page = await open(t, { scheme: os, width: w, height: 800, mobile: w < 500 });
    if (!page) return;
    await convert(page);
    const m = await sr(page, (s) => {
      const box = s.querySelector('.box').getBoundingClientRect();
      const inside = [...s.querySelectorAll('.box *')].filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
      const dl = s.querySelector('a.dl');
      return {
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        outside: inside.filter((r) => r.right > box.right + 0.5 || r.left < box.left - 0.5).length,
        dlFits: dl.scrollHeight <= dl.clientHeight + 1 && dl.scrollWidth <= dl.clientWidth + 1,
      };
    });
    assert.deepEqual(m, { docOverflow: false, outside: 0, dlFits: true }, `${w}px ${os}`);
    await page.close();
  }
});
