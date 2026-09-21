'use strict';
/** UI behaviour of <joinfs-gpx-to-jfs> in jsdom. Appearance (CSS) is covered by the browser tests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { DOMParser } = require('@xmldom/xmldom');

const J = require('../src/joinfs-gpx-to-jfs.js');
const { patternFlight, toGpx } = require('./helpers/tracks.js');
const { FakeWorker } = require('./helpers/nodeWorker.js');
const { decode } = require('./helpers/jfs.js');

const SRC_DIR = path.join(__dirname, '..', 'src');
const SRC = fs.readFileSync(path.join(SRC_DIR, 'joinfs-gpx-to-jfs.js'), 'utf8');
const DE = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'joinfs-gpx-to-jfs.de.json'), 'utf8'));
const GPX = toGpx(patternFlight());
class QuietParser extends DOMParser { constructor() { super({ onError() {} }); } }
const core = (opts) => J.convert(GPX, opts, QuietParser);
const TAG = 'joinfs-gpx-to-jfs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 8000) { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await sleep(25); } }

/** a fresh jsdom window with the component loaded; fetch, Worker and Blob URLs are stubbed */
function mount(body, { url = 'https://example.test/', langs = ['en'], files = {}, worker = false, noStorage = false } = {}) {
  const calls = [];
  const dom = new JSDOM('<!doctype html>' + body, {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w.navigator, 'languages', { get: () => langs });
      Object.defineProperty(w.navigator, 'language', { get: () => langs[0] });
      w.fetch = async (u) => {
        calls.push(u);
        const f = files[u.split('/').pop()];
        return f === undefined ? { ok: false, status: 404, text: async () => 'nope' } : { ok: true, status: 200, text: async () => f };
      };
      const blobs = {}; let n = 0;
      w.URL.createObjectURL = (b) => { const id = 'blob:t' + (n++); blobs[id] = b; return id; };
      w.URL.revokeObjectURL = () => {};
      if (worker) {
        w.Worker = class extends FakeWorker {
          constructor(u) { super(u, (id) => new Promise((res) => { const fr = new w.FileReader(); fr.onload = () => res(fr.result); fr.readAsText(blobs[id]); })); }
        };
      }
      if (noStorage) Object.defineProperty(w, 'localStorage', { get() { throw new Error('blocked'); } });
    },
  });
  const w = dom.window;
  w.eval(SRC);
  return { w, calls, el: () => w.document.querySelector(TAG) };
}
const $ = (el, id) => el.shadowRoot.getElementById(id);
const hidden = (el, id) => $(el, id).hasAttribute('hidden');
const ALL_FIELDS = ['f-icao', 'f-callsign', 'f-model', 'f-livery', 'f-nick', 'f-build'];
const file = (w, name = 'Sample flight.gpx', data = GPX) => new w.File([data], name);
const blobBytes = (w, blob) => new Promise((r) => { const fr = new w.FileReader(); fr.onload = () => r(Buffer.from(fr.result)); fr.readAsArrayBuffer(blob); });
const ev = (w, type, extra) => Object.assign(new w.Event(type, { bubbles: true, cancelable: true }), extra || {});
const typeInto = (w, el, id, val) => { const i = $(el, id); i.value = val; i.dispatchEvent(ev(w, 'input')); };
const same = (blobBuf, u8) => Buffer.compare(blobBuf, Buffer.from(u8.buffer, u8.byteOffset, u8.length)) === 0;
async function convertViaUi(m, el, f = file(m.w)) {
  let detail = null;
  el.addEventListener('converted', (e) => { detail = e.detail; });
  el.loadFile(f);
  if (!el._auto) $(el, 'go').click();
  await waitFor(() => detail);
  return detail;
}

test('defaults and drop zone', () => {
  const m = mount(`<${TAG}></${TAG}>`); const el = m.el();
  assert.ok(ALL_FIELDS.every((id) => !hidden(el, id)), 'all fields visible by default');
  for (const [id, v] of [['icao', 'C172'], ['callsign', 'ASGX'], ['model', 'Cessna 172 Wheels']]) {
    assert.equal($(el, id).value, v); assert.equal($(el, id).placeholder, v, id + ' placeholder = default');
  }
  assert.equal($(el, 'drop-title').textContent, 'Drag & drop your GPX file here');
  assert.equal($(el, 'pick-label').textContent, 'Choose GPX file');
  assert.ok(!$(el, 'pick').hidden);
  assert.equal($(el, 'build').value, 'fs2024', 'JoinFS build defaults to MSFS 2024');
  assert.equal($(el, 'build').selectedOptions[0].textContent, 'MSFS 2024');
  assert.ok($(el, 'go').disabled, 'convert disabled until a file is chosen');
  assert.ok($(el, 'drop-icon').querySelector('svg'));
  assert.equal(m.calls.length, 0, 'an English browser does not request a locale file');
});

test('JoinFS build: MSFS 2024 unless told otherwise', async () => {
  let m = mount(`<${TAG}></${TAG}>`);
  m.w.localStorage.setItem(TAG + ':v1', JSON.stringify({ build: 'bogus' }));
  const el = m.w.document.createElement(TAG); m.w.document.body.appendChild(el);
  assert.equal($(el, 'build').value, 'fs2024', 'an invalid stored value falls back to the default');
  assert.equal($(m.el(), 'build').value, 'fs2024');
  const d = await convertViaUi(m, m.el());
  const dec = decode(await blobBytes(m.w, d.blob), { fs2024: true });
  assert.ok(dec.complete, 'an untouched form writes the MSFS 2024 layout');
  const other = mount(`<${TAG} build="other"></${TAG}>`);
  assert.equal($(other.el(), 'build').value, 'other', 'other builds can still be chosen');
});

test('presets from attributes hide their fields', () => {
  const m = mount(`<${TAG} icao-type="b738" callsign="DLH1" model="Boeing 737-800"></${TAG}>`); const el = m.el();
  assert.ok(hidden(el, 'f-icao') && hidden(el, 'f-callsign') && hidden(el, 'f-model'));
  assert.ok(['f-livery', 'f-nick', 'f-build'].every((id) => !hidden(el, id)));
  assert.ok(!$(el, 'preset').hidden && /B738/.test($(el, 'preset').textContent) && /DLH1/.test($(el, 'preset').textContent), $(el, 'preset').textContent);
  assert.equal($(el, 'icao').value, 'B738', 'ICAO type is upper-cased');
  assert.ok($(el, 'reset'), 'reset stays while some fields remain');
});

test('URL parameters win over attributes; invalid values are ignored', () => {
  let m = mount(`<${TAG} callsign="ATTR" icao-type="C172"></${TAG}>`, { url: 'https://example.test/?icao=PA28&callsign=URLCS&model=Piper%20Archer&build=nope' });
  let el = m.el();
  assert.equal($(el, 'icao').value, 'PA28'); assert.equal($(el, 'callsign').value, 'URLCS'); assert.equal($(el, 'model').value, 'Piper Archer');
  assert.ok(hidden(el, 'f-icao') && hidden(el, 'f-callsign') && hidden(el, 'f-model'));
  assert.ok(!hidden(el, 'f-build'), 'an invalid build is ignored');
  el = mount(`<${TAG} icao-type="TOOLONG"></${TAG}>`).el(); assert.ok(!hidden(el, 'f-icao'));
  m = mount(`<${TAG} no-url-params></${TAG}>`, { url: 'https://example.test/?icao=PA28' }); el = m.el();
  assert.ok(!hidden(el, 'f-icao') && $(el, 'icao').value === 'C172', 'no-url-params');
});

test('editable keeps the fields and uses the values as defaults', () => {
  const el = mount(`<${TAG} editable icao-type="PA28" callsign="D-EABC"></${TAG}>`).el();
  assert.ok(!hidden(el, 'f-icao'));
  assert.equal($(el, 'icao').value, 'PA28'); assert.equal($(el, 'icao').placeholder, 'PA28');
  assert.ok($(el, 'preset').hidden);
});

test('everything preset: no fields, no convert button, converts on load', async () => {
  const m = mount(`<${TAG} icao-type="B738" callsign="DLH1" model="Boeing 737-800" livery="" nickname="Fritz" typerole="airliner" build="other" systems="full"></${TAG}>`, { worker: true });
  const el = m.el();
  assert.ok(ALL_FIELDS.every((id) => hidden(el, id)));
  assert.ok($(el, 'go').hidden && !$(el, 'reset'));
  const d = await convertViaUi(m, el);
  const got = await blobBytes(m.w, d.blob);
  const want = core({ icaoType: 'B738', callsign: 'DLH1', model: 'Boeing 737-800', nickname: 'Fritz', typerole: 3, jfsVersion: 21005, fs2024: false, systems: 'full' }).data;
  assert.ok(same(got, want), 'the blob equals the core output for the same options');
  assert.equal(d.filename, 'Sample_flight.jfs');
});

test('conversion flow and download UX', async () => {
  const m = mount(`<${TAG}></${TAG}>`); const el = m.el();
  el.loadFile(file(m.w));
  assert.ok($(el, 'drop').classList.contains('has-file') && $(el, 'drop-title').textContent === 'Sample flight.gpx');
  assert.match($(el, 'drop-sub').textContent, /KB|MB/);
  assert.equal($(el, 'pick-label').textContent, 'Choose a different file');
  assert.ok(!$(el, 'go').disabled);
  const d = await convertViaUi(m, el, file(m.w));
  const a = $(el, 'out').querySelector('a.dl');
  assert.ok(a && a.getAttribute('download') === 'Sample_flight.jfs' && a.href.startsWith('blob:'), 'download link');
  assert.equal(el.shadowRoot.activeElement, a, 'the download link is focused');
  assert.match(a.textContent, /Download Sample_flight\.jfs/);
  assert.ok(a.querySelector('svg'));
  const txt = $(el, 'out').textContent;
  const minutes = (d.info.durationS / 60).toLocaleString(undefined, { maximumFractionDigits: 1 });
  assert.ok(txt.includes('Recording ready') && txt.includes(minutes + ' min') && txt.includes('Open Recording'), txt);
  assert.ok(same(await blobBytes(m.w, d.blob), core({}).data), 'default blob = converter defaults (C172 / ASGX / MSFS 2024)');
  typeInto(m.w, el, 'callsign', 'D-EXYZ');
  assert.ok(!$(el, 'out').querySelector('a.dl'), 'editing a setting removes the stale result');
  assert.ok(!$(el, 'go').disabled);
});

test('drop zone interactions', () => {
  const m = mount(`<${TAG}></${TAG}>`); const el = m.el(); const w = m.w; const drop = $(el, 'drop');
  drop.dispatchEvent(ev(w, 'dragenter'));
  assert.ok(drop.classList.contains('over') && $(el, 'drop-title').textContent === 'Drop to load this file');
  drop.dispatchEvent(ev(w, 'dragleave', { relatedTarget: null }));
  assert.ok(!drop.classList.contains('over') && $(el, 'drop-title').textContent === 'Drag & drop your GPX file here');
  drop.dispatchEvent(ev(w, 'dragenter'));
  drop.dispatchEvent(ev(w, 'drop', { dataTransfer: { files: [file(w, 'a.gpx')] } }));
  assert.ok(!drop.classList.contains('over') && drop.classList.contains('has-file') && $(el, 'drop-title').textContent === 'a.gpx');
  let clicked = 0; $(el, 'file').click = () => { clicked++; };
  drop.click(); $(el, 'pick').click();
  assert.equal(clicked, 2, 'zone click and button click each open the picker exactly once');
  el.loadFile(file(w, 'notes.txt'));
  assert.match($(el, 'out').textContent, /\.gpx/); assert.equal($(el, 'drop-title').textContent, 'a.gpx', 'wrong type rejected, previous file kept');
  const big = file(w, 'huge.gpx', 'x'); Object.defineProperty(big, 'size', { value: 60 * 1048576 });
  el.loadFile(big); assert.match($(el, 'out').textContent, /too large/);
});

test('settings are remembered in localStorage', async (t) => {
  const m = mount(`<${TAG}></${TAG}>`); const el = m.el(); const w = m.w;
  typeInto(w, el, 'icao', 'pa28'); typeInto(w, el, 'callsign', 'D-EABC'); typeInto(w, el, 'model', 'Piper Archer III'); typeInto(w, el, 'nick', 'Fritz');
  $(el, 'build').value = 'other'; $(el, 'build').dispatchEvent(ev(w, 'change'));
  const s = JSON.parse(w.localStorage.getItem(TAG + ':v1'));
  assert.deepEqual([s.icaoType, s.callsign, s.model, s.nickname, s.build], ['PA28', 'D-EABC', 'Piper Archer III', 'Fritz', 'other']);
  const el2 = w.document.createElement(TAG); w.document.body.appendChild(el2);
  assert.deepEqual(['icao', 'callsign', 'model', 'build'].map((id) => $(el2, id).value), ['PA28', 'D-EABC', 'Piper Archer III', 'other'], 'restored in a new instance');
  assert.ok($(el2, 'icao').placeholder === 'C172' && $(el2, 'callsign').placeholder === 'ASGX', 'placeholders stay the defaults');

  await t.test('invalid ICAO type is flagged and blocks the conversion', async () => {
    typeInto(w, el, 'icao', 'TOOLONG');
    assert.ok($(el, 'f-icao').classList.contains('invalid') && /2.4 letters/.test($(el, 'h-icao').textContent));
    el.loadFile(file(w)); $(el, 'go').click(); await sleep(20);
    assert.ok(/2.4 letters/.test($(el, 'out').textContent) && !$(el, 'out').querySelector('a.dl'));
  });
  await t.test('reset restores the defaults and clears the stored values', () => {
    $(el, 'reset').click();
    assert.deepEqual(['icao', 'callsign', 'model', 'build'].map((id) => $(el, id).value), ['C172', 'ASGX', 'Cessna 172 Wheels', 'fs2024']);
    assert.equal(w.localStorage.getItem(TAG + ':v1'), null);
  });
  await t.test('preset (hidden) values are never stored', () => {
    const m2 = mount(`<${TAG} callsign="LOCK"></${TAG}>`); typeInto(m2.w, m2.el(), 'icao', 'c172'); typeInto(m2.w, m2.el(), 'nick', 'Z');
    const s2 = JSON.parse(m2.w.localStorage.getItem(TAG + ':v1'));
    assert.ok(!('callsign' in s2) && s2.nickname === 'Z', JSON.stringify(s2));
  });
  await t.test('works when localStorage is blocked', () => {
    const m3 = mount(`<${TAG}></${TAG}>`, { noStorage: true }); const e3 = m3.el(); typeInto(m3.w, e3, 'callsign', 'X1');
    assert.equal($(e3, 'callsign').value, 'X1'); assert.equal($(e3, 'reset').previousElementSibling.textContent, '', 'no "remembered" note');
  });
  await t.test('stale stored values from a removed option fall back to the default', () => {
    const m4 = mount(`<${TAG}></${TAG}>`); m4.w.localStorage.setItem(TAG + ':v1', JSON.stringify({ build: 'fs2042', callsign: 'KEEP' }));
    const e4 = m4.w.document.createElement(TAG); m4.w.document.body.appendChild(e4);
    assert.ok($(e4, 'build').value === 'fs2024' && $(e4, 'callsign').value === 'KEEP');
    const e5 = mount(`<${TAG} build="fs2042"></${TAG}>`).el(); assert.ok(!hidden(e5, 'f-build') && $(e5, 'build').value === 'fs2024');
  });
});

test('the removed frame-rate setting: no field, stale values are ignored and dropped', () => {
  const m = mount(`<${TAG}></${TAG}>`);
  assert.equal($(m.el(), 'hz'), null, 'there is no frame-rate field');
  m.w.localStorage.setItem(TAG + ':v1', JSON.stringify({ hz: '20', callsign: 'KEEP' }));
  const el = m.w.document.createElement(TAG); m.w.document.body.appendChild(el);
  assert.equal($(el, 'callsign').value, 'KEEP');
  typeInto(m.w, el, 'nick', 'X');
  assert.ok(!('hz' in JSON.parse(m.w.localStorage.getItem(TAG + ':v1'))));
  assert.equal(mount(`<${TAG} hz="20"></${TAG}>`, { url: 'https://example.test/?hz=20' }).el().shadowRoot.querySelectorAll('.field:not([hidden])').length, 6, 'attribute and URL parameter hz do nothing');
});

test('aircraft systems: no field, always on unless the attribute turns it off', async () => {
  let m = mount(`<${TAG}></${TAG}>`); let el = m.el();
  assert.equal($(el, 'systems'), null, 'there is no aircraft-systems field');
  typeInto(m.w, el, 'callsign', 'X');
  assert.ok(!('systems' in JSON.parse(m.w.localStorage.getItem(TAG + ':v1'))), 'nothing to remember');
  const d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X' }).data), 'gear, flaps and lights by default');

  m = mount(`<${TAG} systems="off"></${TAG}>`); el = m.el();
  typeInto(m.w, el, 'callsign', 'X');
  const d2 = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d2.blob), core({ callsign: 'X', systems: 'off' }).data), 'systems="off" -> no variable frames');
  assert.equal(mount(`<${TAG} systems="off"></${TAG}>`, { url: 'https://example.test/?systems=full' })
    .el().shadowRoot.querySelectorAll('.field:not([hidden])').length, 6, 'and it hides no field');
});

// JoinFS reads the type-role byte from the recording as it is (Recorder -> Sim.UpdateAircraft -> Substitution.Match,
// +15 for a match but -240 for a mismatch without an exact ICAO type match), so the default must not guess.
test('type role: no field, unknown by default, attribute and URL parameter still set it', async () => {
  let m = mount(`<${TAG}></${TAG}>`); let el = m.el();
  assert.equal($(el, 'role'), null, 'there is no aircraft-type field');
  typeInto(m.w, el, 'callsign', 'X');
  assert.ok(!('typerole' in JSON.parse(m.w.localStorage.getItem(TAG + ':v1'))), 'nothing to remember');
  let d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', typerole: 0 }).data), 'default type role is 0 = unknown');

  m = mount(`<${TAG} typerole="rotorcraft"></${TAG}>`); el = m.el();
  typeInto(m.w, el, 'callsign', 'X');
  d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', typerole: 4 }).data), 'the attribute sets the byte');

  m = mount(`<${TAG} typerole="rotorcraft"></${TAG}>`, { url: 'https://example.test/?typerole=airliner' }); el = m.el();
  typeInto(m.w, el, 'callsign', 'X');
  d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', typerole: 3 }).data), 'the URL parameter wins');

  m = mount(`<${TAG} typerole="nope"></${TAG}>`); el = m.el();
  typeInto(m.w, el, 'callsign', 'X');
  d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', typerole: 0 }).data), 'an invalid value falls back to unknown');
});

test('hints can emphasise words with *asterisks*, rendered as <b> and never as markup', () => {
  const el = mount(`<${TAG}></${TAG}>`).el();
  const hint = $(el, 'h-model');
  assert.equal(hint.textContent, J.messages.en['hint.model'].replace(/\*/g, ''), 'the asterisks themselves are not shown');
  assert.deepEqual([...hint.querySelectorAll('b')].map((b) => b.textContent), ['replaying'], 'the marked word is bold');
  assert.equal($(el, 'h-callsign').querySelector('b'), null, 'a text without markers stays a plain text node');

  // a locale file must not be able to smuggle markup in
  const m2 = mount(`<${TAG}></${TAG}>`);
  const el2 = m2.el();
  el2._strings = Object.assign({}, J.messages.en, { 'hint.callsign': '<img src=x onerror=BOOM> *emphasis*' });
  el2.applyI18n();
  const h2 = $(el2, 'h-callsign');
  assert.equal(h2.querySelector('img'), null, 'no element is created from the text');
  assert.equal(h2.textContent, '<img src=x onerror=BOOM> emphasis');
  assert.deepEqual([...h2.querySelectorAll('b')].map((b) => b.textContent), ['emphasis']);
});

test('livery: written on the MSFS 2024 layout, hidden and absent on the others', async () => {
  let m = mount(`<${TAG}></${TAG}>`); let el = m.el();
  assert.equal($(el, 'livery').value, '', 'empty by default, so nothing changes for anyone who ignores it');
  assert.ok(!hidden(el, 'f-livery'), 'shown for the MSFS 2024 build');
  typeInto(m.w, el, 'callsign', 'X'); typeInto(m.w, el, 'livery', 'Lufthansa');
  assert.equal(JSON.parse(m.w.localStorage.getItem(TAG + ':v1')).livery, 'Lufthansa', 'remembered like the other fields');
  const d = await convertViaUi(m, el);
  const bytes = await blobBytes(m.w, d.blob);
  assert.ok(same(bytes, core({ callsign: 'X', livery: 'Lufthansa' }).data), 'reaches the converter');
  assert.ok(bytes.includes(Buffer.from('Lufthansa', 'utf8')), 'and lands in the recording');

  await test('switching the build hides and restores it, keeping the value', () => {
    $(el, 'build').value = 'other'; $(el, 'build').dispatchEvent(ev(m.w, 'change'));
    assert.ok(hidden(el, 'f-livery'), 'no livery slot in the other layouts, so no field');
    assert.equal($(el, 'livery').value, 'Lufthansa', 'the value is kept');
    $(el, 'build').value = 'fs2024'; $(el, 'build').dispatchEvent(ev(m.w, 'change'));
    assert.ok(!hidden(el, 'f-livery'), 'and comes back');
  });

  // preset on a build that has no livery slot: hidden, and nothing of it reaches the file
  const m2 = mount(`<${TAG} build="other" livery="Lufthansa"></${TAG}>`); const el2 = m2.el();
  assert.ok(hidden(el2, 'f-livery'));
  typeInto(m2.w, el2, 'callsign', 'X');
  const d2 = await convertViaUi(m2, el2);
  const other = await blobBytes(m2.w, d2.blob);
  assert.ok(same(other, core({ callsign: 'X', livery: 'Lufthansa', fs2024: false }).data));
  assert.ok(!other.includes(Buffer.from('Lufthansa', 'utf8')), 'other builds have no livery string');

  const preset = mount(`<${TAG} livery="Austrian"></${TAG}>`).el();
  assert.ok(hidden(preset, 'f-livery') && $(preset, 'livery').value === 'Austrian', 'the attribute presets and hides it');

  // everything preset except the livery, on a build that cannot use it -> nothing left to ask, so no Convert button
  const auto = mount(`<${TAG} icao-type="B738" callsign="DLH1" model="B738" nickname="" build="other"></${TAG}>`).el();
  assert.ok(hidden(auto, 'f-livery') && $(auto, 'go').hidden, 'a field that cannot apply does not keep Convert alive');
});

test('flap attributes reach the converter', async () => {
  const m = mount(`<${TAG} flaps-takeoff="0.3" flaps-landing="0.8" nickname="" callsign="A" model="M" icao-type="C172" build="fs2024"></${TAG}>`);
  const d2 = await convertViaUi(m, m.el());
  assert.ok(same(await blobBytes(m.w, d2.blob), core({ callsign: 'A', model: 'M', flapsTakeoff: 0.3, flapsLanding: 0.8 }).data), 'flaps-takeoff / flaps-landing reach the converter');
});

test('the generated recording decodes with the chosen aircraft', async () => {
  const m = mount(`<${TAG} icao-type="PA28" callsign="D-EABC" model="Piper Archer" nickname="Fritz" typerole="singleprop" build="fs2024" systems="off"></${TAG}>`);
  const d = await convertViaUi(m, m.el());
  const dec = decode(await blobBytes(m.w, d.blob), { fs2024: true });
  assert.ok(dec.complete);
  const a = dec.aircraft[0];
  assert.deepEqual([a.callsign, a.nickname, a.model, a.icaoType], ['D-EABC', 'Fritz', 'Piper Archer', 'PA28']);
});

test('languages: lazy-loaded locale files with English fallback', async (t) => {
  const files = { 'joinfs-gpx-to-jfs.de.json': JSON.stringify(DE) };
  const names = (m) => m.calls.map((u) => u.split('/').pop());

  await t.test('preferred languages are tried in order, first hit wins', async () => {
    const m = mount(`<${TAG}></${TAG}>`, { langs: ['fr-CA', 'fr', 'de-AT', 'de', 'en'], files }); const el = m.el();
    await waitFor(() => el.shadowRoot.querySelector('.box').lang === 'de');
    assert.deepEqual(names(m), ['joinfs-gpx-to-jfs.fr-CA.json', 'joinfs-gpx-to-jfs.fr.json', 'joinfs-gpx-to-jfs.de-AT.json', 'joinfs-gpx-to-jfs.de.json']);
    assert.equal(m.calls[0], 'https://example.test/joinfs-gpx-to-jfs.fr-CA.json', 'folder of the page when the script folder is unknown');
    assert.equal(el.shadowRoot.querySelector('h2').textContent, DE.title);
    assert.equal($(el, 'drop-title').textContent, DE['drop.title']); assert.equal($(el, 'pick-label').textContent, DE['drop.choose']);
    assert.equal($(el, 'go').textContent, DE['btn.convert']);
    assert.equal(el.shadowRoot.querySelector('label[for=icao]').textContent, DE['field.icao']);
    assert.equal(el.shadowRoot.querySelector('label[for=build]').textContent, DE['field.build']);
    assert.equal($(el, 'build').options[0].textContent, DE['build.fs2024']);
  });
  await t.test('results and errors are translated', async () => {
    const m = mount(`<${TAG}></${TAG}>`, { langs: ['de'], files }); const el = m.el();
    await waitFor(() => el.shadowRoot.querySelector('.box').lang === 'de');
    el.loadFile(new m.w.File(['not xml'], 'x.gpx')); $(el, 'go').click();
    await waitFor(() => $(el, 'out').textContent === DE['err.notXml']);
    const d = await convertViaUi(m, el);
    const txt = $(el, 'out').textContent;
    assert.match($(el, 'out').querySelector('a.dl').textContent, /herunterladen/);
    assert.ok(txt.includes('Aufzeichnung fertig') && txt.includes((d.info.durationS / 60).toLocaleString('de', { maximumFractionDigits: 1 }) + ' Min.'), txt);
  });
  await t.test('an unknown language followed by English stays English and stops there', async () => {
    const m = mount(`<${TAG}></${TAG}>`, { langs: ['xx', 'en-US', 'de'], files }); await sleep(40);
    assert.equal(m.calls.length, 1); assert.equal($(m.el(), 'drop-title').textContent, 'Drag & drop your GPX file here');
  });
  await t.test('English first: no request at all', async () => {
    const m = mount(`<${TAG}></${TAG}>`, { langs: ['en-GB', 'de'], files }); await sleep(40); assert.equal(m.calls.length, 0);
  });
  await t.test('a non-JSON answer (SPA fallback page) counts as missing', async () => {
    const m = mount(`<${TAG}></${TAG}>`, { langs: ['de'], files: { 'joinfs-gpx-to-jfs.de.json': '<!doctype html><html>index</html>' } }); await sleep(40);
    assert.equal($(m.el(), 'drop-title').textContent, 'Drag & drop your GPX file here');
  });
  await t.test('lang attribute / ?lang= force a language; locale-base sets the folder; path tricks are ignored', async () => {
    let m = mount(`<${TAG}></${TAG}>`, { url: 'https://example.test/?lang=de', langs: ['en'], files }); await sleep(40);
    assert.equal(m.el().shadowRoot.querySelector('h2').textContent, DE.title);
    m = mount(`<${TAG} lang="de" locale-base="/i18n"></${TAG}>`, { langs: ['en'], files: {} }); await sleep(40);
    assert.equal(m.calls[0], '/i18n/joinfs-gpx-to-jfs.de.json');
    m = mount(`<${TAG}></${TAG}>`, { url: 'https://example.test/?lang=../../etc/passwd', langs: ['en'], files }); await sleep(40);
    assert.equal(m.calls.length, 0);
  });
  await t.test('a partial translation falls back to English key by key', async () => {
    const m = mount(`<${TAG}></${TAG}>`, { langs: ['de'], files: { 'joinfs-gpx-to-jfs.de.json': JSON.stringify({ title: 'Nur Titel' }) } }); await sleep(40);
    assert.equal(m.el().shadowRoot.querySelector('h2').textContent, 'Nur Titel'); assert.equal($(m.el(), 'go').textContent, 'Convert');
  });
  await t.test('the preset summary is translated', async () => {
    const m = mount(`<${TAG} icao-type="C172"></${TAG}>`, { langs: ['de'], files }); await sleep(40);
    assert.match($(m.el(), 'preset').textContent, /Von dieser Seite vorgegeben: ICAO-Typkennung C172/);
  });
  await t.test('the folder of the script is used when it is loaded with <script src>', async () => {
    const calls = [];
    const dom = await JSDOM.fromFile(path.join(__dirname, '..', 'demo', 'index.html'), {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      beforeParse(w) {
        Object.defineProperty(w.navigator, 'languages', { get: () => ['de'] });
        w.fetch = async (u) => { calls.push(u); return { ok: true, text: async () => JSON.stringify(DE) }; };
      },
    });
    await waitFor(() => calls.length > 0);
    assert.equal(calls[0], pathToFileURL(SRC_DIR).href + '/joinfs-gpx-to-jfs.de.json');
    const el = dom.window.document.querySelector(TAG);
    await waitFor(() => el.shadowRoot.querySelector('h2').textContent === DE.title);
    assert.ok(el.shadowRoot.getElementById('drop'), 'the demo page works even though localStorage is unavailable on file://');
    dom.window.close();
  });
});
