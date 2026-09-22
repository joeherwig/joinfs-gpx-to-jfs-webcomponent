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
  const want = core({ icaoType: 'B738', callsign: 'DLH1', model: 'Boeing 737-800', nickname: 'Fritz', typerole: 3, fs2024: false, systems: 'full' }).data;
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

test('frame rate: no field, set by attribute or URL parameter, stale stored values dropped', async () => {
  const m = mount(`<${TAG}></${TAG}>`);
  assert.equal($(m.el(), 'hz'), null, 'there is no frame-rate field');
  m.w.localStorage.setItem(TAG + ':v1', JSON.stringify({ hz: '20', callsign: 'KEEP' }));
  const el = m.w.document.createElement(TAG); m.w.document.body.appendChild(el);
  assert.equal($(el, 'callsign').value, 'KEEP');
  typeInto(m.w, el, 'nick', 'X');
  assert.ok(!('hz' in JSON.parse(m.w.localStorage.getItem(TAG + ':v1'))), 'not a remembered setting');
  assert.equal(mount(`<${TAG} hz="20"></${TAG}>`, { url: 'https://example.test/?hz=20' })
    .el().shadowRoot.querySelectorAll('.field:not([hidden])').length, 6, 'and it adds no field');

  // default stays 5 Hz
  let m2 = mount(`<${TAG}></${TAG}>`); let el2 = m2.el();
  typeInto(m2.w, el2, 'callsign', 'X');
  let d = await convertViaUi(m2, el2);
  assert.ok(same(await blobBytes(m2.w, d.blob), core({ callsign: 'X' }).data), 'default is 5 Hz');

  // 20 Hz via the attribute: four times the frames of the 5 Hz default
  m2 = mount(`<${TAG} hz="20"></${TAG}>`); el2 = m2.el();
  typeInto(m2.w, el2, 'callsign', 'X');
  d = await convertViaUi(m2, el2);
  assert.ok(same(await blobBytes(m2.w, d.blob), core({ callsign: 'X', hz: 20 }).data), 'the attribute reaches the converter');
  const five = decode(core({ callsign: 'X' }).data, { fs2024: true }).aircraft[0].positions.length;
  const twenty = decode(core({ callsign: 'X', hz: 20 }).data, { fs2024: true }).aircraft[0].positions.length;
  assert.ok(twenty > 3.5 * five, `20 Hz gives about four times the position frames (${five} -> ${twenty})`);

  // the URL parameter wins, and an unusable value falls back to the default
  m2 = mount(`<${TAG} hz="20"></${TAG}>`, { url: 'https://example.test/?hz=10' }); el2 = m2.el();
  typeInto(m2.w, el2, 'callsign', 'X');
  d = await convertViaUi(m2, el2);
  assert.ok(same(await blobBytes(m2.w, d.blob), core({ callsign: 'X', hz: 10 }).data), 'URL parameter wins');

  for (const bad of ['0', '31', 'nope', '']) {
    const mb = mount(`<${TAG} hz="${bad}"></${TAG}>`); const eb = mb.el();
    typeInto(mb.w, eb, 'callsign', 'X');
    const db = await convertViaUi(mb, eb);
    assert.ok(same(await blobBytes(mb.w, db.blob), core({ callsign: 'X' }).data), `hz="${bad}" falls back to the default`);
  }
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

test('altitude offset: shifts the whole track without disturbing ground detection', async () => {
  const el0 = mount(`<${TAG}></${TAG}>`).el();
  assert.equal($(el0, 'altitude-offset'), null, 'there is no altitude-offset field');

  let m = mount(`<${TAG} altitude-offset="-8"></${TAG}>`); let el = m.el();
  typeInto(m.w, el, 'callsign', 'X');
  let d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', altitudeOffsetM: -8 }).data), 'reaches the converter');

  const plain = decode(core({ callsign: 'X' }).data, { fs2024: true }).aircraft[0].positions;
  const moved = decode(core({ callsign: 'X', altitudeOffsetM: -8 }).data, { fs2024: true }).aircraft[0].positions;
  assert.equal(plain.length, moved.length);
  for (let i = 0; i < plain.length; i += 137) {
    assert.ok(Math.abs((plain[i].alt - 8) - moved[i].alt) < 1e-6, 'every altitude moves by exactly the offset');
    assert.ok(Math.abs((plain[i].elevation - 8) - moved[i].elevation) < 1e-6, 'the ground reference moves with it');
    assert.equal(plain[i].ground, moved[i].ground, 'on-ground state is unchanged');
  }
  assert.deepEqual(moved.map((f) => f.pitch), plain.map((f) => f.pitch), 'attitude is unchanged');

  // URL parameter, its short alias, and values that cannot be used
  m = mount(`<${TAG}></${TAG}>`, { url: 'https://example.test/?alt-offset=12.5' }); el = m.el();
  typeInto(m.w, el, 'callsign', 'X');
  d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', altitudeOffsetM: 12.5 }).data), 'alt-offset alias works');

  for (const bad of ['501', '-501', 'nope', '']) {
    const mb = mount(`<${TAG} altitude-offset="${bad}"></${TAG}>`); const eb = mb.el();
    typeInto(mb.w, eb, 'callsign', 'X');
    const db = await convertViaUi(mb, eb);
    assert.ok(same(await blobBytes(mb.w, db.blob), core({ callsign: 'X' }).data), `altitude-offset="${bad}" is ignored`);
  }
});

// 30 points, every value an exact multiple of 0.1, 8.7 m of range - the shape J.elevationLooksScaled looks for.
const scaledGpx = toGpx(Array.from({ length: 30 }, (_, i) => ({ t: 1.8e9 + i, lat: 50 + i * 0.0001, lon: 10, ele: 60 + i * 0.3 })));

// Clicks the already-visible Go button and waits for the result, without loadFile()'s own reload - which would
// wipe out whatever preview state (a confirmed checkbox, a typed elevation) the test just set up.
async function clickGo(w, el) {
  let detail = null;
  el.addEventListener('converted', (e) => { detail = e.detail; }, { once: true });
  $(el, 'go').click();
  await waitFor(() => detail);
  return detail;
}

test('elevation-scale warning: detected on load, never applied without the checkbox', async () => {
  const m = mount(`<${TAG}></${TAG}>`); const el = m.el();
  el.loadFile(file(m.w, 'scaled.gpx', scaledGpx));
  await waitFor(() => !hidden(el, 'ground'));
  const cb = el.shadowRoot.querySelector('#ground input[type=checkbox]');
  assert.ok(cb && !cb.checked, 'flagged, but unconfirmed by default');
  typeInto(m.w, el, 'callsign', 'X');

  const plainExpected = J.convert(scaledGpx, { callsign: 'X' }, QuietParser).data;
  let d = await clickGo(m.w, el);
  assert.ok(same(await blobBytes(m.w, d.blob), plainExpected), 'unconfirmed: scale is not applied');

  cb.click();
  assert.ok(cb.checked, 'the click itself is synchronous');
  d = await clickGo(m.w, el);
  const scaledExpected = J.convert(scaledGpx, { callsign: 'X', elevationScale: 10 }, QuietParser).data;
  assert.ok(same(await blobBytes(m.w, d.blob), scaledExpected), 'confirmed: x10 is applied');
  assert.ok(!same(await blobBytes(m.w, d.blob), plainExpected), 'and it is a real difference');

  // a normal, noisy track never triggers the warning - GPX (the default file() fixture) is not a fair check
  // here, its altitude is deterministic tenths-arithmetic (see the core-level test of the same name) and would
  // trigger the same test the bug's fingerprint does
  const m2 = mount(`<${TAG}></${TAG}>`); const el2 = m2.el();
  el2.loadFile(file(m2.w, 'noisy.gpx', toGpx(patternFlight({ noise: 0.6, seed: 42 }))));
  await sleep(50);
  assert.ok(hidden(el2, 'ground') || !el2.shadowRoot.querySelector('#ground input[type=checkbox]'), 'no warning for a normal track');
});

test('field-elevation picker: surfaces ground stretches, computes altitude-offset from what is entered', async () => {
  let m = mount(`<${TAG}></${TAG}>`); let el = m.el();
  assert.equal($(el, 'field-elev'), null, 'no picker before a file is loaded');
  el.loadFile(file(m.w));
  await waitFor(() => !hidden(el, 'ground'));
  const input = el.shadowRoot.querySelector('#field-elev');
  assert.ok(input, 'the departure stretch got an input');
  assert.equal(input.value, '', 'empty until the user types');

  const plain = decode(core({}).data, { fs2024: true }).aircraft[0].positions;
  const depFt = Math.round(plain[0].elevation / 0.3048);
  input.value = String(depFt + 100); input.dispatchEvent(ev(m.w, 'input'));
  typeInto(m.w, el, 'callsign', 'X');
  const d = await clickGo(m.w, el);
  const offsetM = (depFt + 100) * 0.3048 - plain[0].elevation;
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', altitudeOffsetM: offsetM }).data),
    'the entered elevation, converted to an altitude-offset, reaches the converter');

  // blank input: no correction, same as never having opened the picker
  m = mount(`<${TAG}></${TAG}>`); el = m.el();
  el.loadFile(file(m.w));
  await waitFor(() => !hidden(el, 'ground'));
  typeInto(m.w, el, 'callsign', 'X');
  const d2 = await clickGo(m.w, el);
  assert.ok(same(await blobBytes(m.w, d2.blob), core({ callsign: 'X' }).data), 'left blank, nothing changes');
});

// Wires w.fetch so a request to Open-Meteo returns a fixed elevation (metres), or fails if elevationM is null,
// while any other URL (locale files) keeps working exactly as mount() already set it up.
function mockElevation(w, elevationM) {
  const orig = w.fetch;
  w.fetch = async (u) => {
    if (String(u).includes('open-meteo.com')) {
      return elevationM === null ? { ok: false, status: 500, text: async () => 'nope' }
        : { ok: true, status: 200, text: async () => JSON.stringify({ elevation: [elevationM] }) };
    }
    return orig(u);
  };
}

test('"Look up online": one click sets the scale checkbox and fills the field-elevation input', async () => {
  // scaledGpx's departure is ~60.84 m raw / ~608.4 m x10 - mock a result close to the raw one
  let m = mount(`<${TAG}></${TAG}>`); let el = m.el();
  el.loadFile(file(m.w, 'scaled.gpx', scaledGpx));
  await waitFor(() => !hidden(el, 'ground'));
  assert.equal(m.calls.length, 0, 'no network call from loading the file alone');
  mockElevation(m.w, 61);
  let btn = [...el.shadowRoot.querySelectorAll('#ground button')].find((b) => b.textContent === 'Look up online');
  assert.ok(btn, 'the button is there');
  btn.click();
  await waitFor(() => el.shadowRoot.querySelector('#field-elev').value !== '');
  assert.equal(el.shadowRoot.querySelector('#field-elev').value, '200', 'field filled from the lookup, in feet');
  let cb = el.shadowRoot.querySelector('#ground input[type=checkbox]');
  assert.ok(!cb.checked, 'raw is the closer match, so the checkbox is not ticked');
  assert.match(el.shadowRoot.getElementById('ground').textContent, /200 ft/);

  // same file, a result close to the x10 value instead
  m = mount(`<${TAG}></${TAG}>`); el = m.el();
  el.loadFile(file(m.w, 'scaled.gpx', scaledGpx));
  await waitFor(() => !hidden(el, 'ground'));
  mockElevation(m.w, 610);
  btn = [...el.shadowRoot.querySelectorAll('#ground button')].find((b) => b.textContent === 'Look up online');
  btn.click();
  await waitFor(() => el.shadowRoot.querySelector('#field-elev').value !== '');
  assert.equal(el.shadowRoot.querySelector('#field-elev').value, '2001');
  cb = el.shadowRoot.querySelector('#ground input[type=checkbox]');
  assert.ok(cb.checked, 'x10 is the closer match, so the checkbox is ticked');
  typeInto(m.w, el, 'callsign', 'X');
  const d = await clickGo(m.w, el);
  // the field round-trips the lookup through whole feet, same as a person reading a dialog would, so it is not
  // exactly the raw 610 m looked up - the residual is the altitude-offset this produces, same as any other
  // field-elevation entry
  const scaledElevM = 60.84000000000001 * 10;
  const offsetM = 2001 * 0.3048 - scaledElevM;
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', elevationScale: 10, altitudeOffsetM: offsetM }).data),
    'and the scale, plus the small feet-rounding residual, reaches the converter');
});

test('"Look up online" also works for a normal track, with no checkbox involved', async () => {
  const m = mount(`<${TAG}></${TAG}>`); const el = m.el();
  el.loadFile(file(m.w));                                    // GPX: departure is 320 m = 1049.9 ft
  await waitFor(() => !hidden(el, 'ground'));
  assert.equal(el.shadowRoot.querySelector('#ground input[type=checkbox]'), null, 'no scale warning for this track');
  mockElevation(m.w, 300);
  const btn = [...el.shadowRoot.querySelectorAll('#ground button')].find((b) => b.textContent === 'Look up online');
  btn.click();
  await waitFor(() => el.shadowRoot.querySelector('#field-elev').value !== '');
  assert.equal(el.shadowRoot.querySelector('#field-elev').value, '984');
  typeInto(m.w, el, 'callsign', 'X');
  const d = await clickGo(m.w, el);
  // rounded through whole feet first, same as the field-elevation picker always does - not exactly the raw 300 m
  const offsetM = 984 * 0.3048 - 320;
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', altitudeOffsetM: offsetM }).data));
});

test('"Look up online": a failed lookup leaves everything untouched and says so', async () => {
  const m = mount(`<${TAG}></${TAG}>`); const el = m.el();
  el.loadFile(file(m.w));
  await waitFor(() => !hidden(el, 'ground'));
  const input = el.shadowRoot.querySelector('#field-elev');
  input.value = '500'; input.dispatchEvent(ev(m.w, 'input'));
  mockElevation(m.w, null);
  const btn = [...el.shadowRoot.querySelectorAll('#ground button')].find((b) => b.textContent === 'Look up online');
  btn.click();
  await waitFor(() => /Couldn.t look that up/.test(el.shadowRoot.getElementById('ground').textContent));
  assert.equal(el.shadowRoot.querySelector('#field-elev').value, '500', 'the typed value survives a failed lookup');
});

test('"Look up online": overwrites whatever was already typed', async () => {
  const m = mount(`<${TAG}></${TAG}>`); const el = m.el();
  el.loadFile(file(m.w));
  await waitFor(() => !hidden(el, 'ground'));
  const input = el.shadowRoot.querySelector('#field-elev');
  input.value = '1'; input.dispatchEvent(ev(m.w, 'input'));
  mockElevation(m.w, 300);
  const btn = [...el.shadowRoot.querySelectorAll('#ground button')].find((b) => b.textContent === 'Look up online');
  btn.click();
  await waitFor(() => el.shadowRoot.querySelector('#field-elev').value === '984');
});

test('position smoothing and ground clearance reach the converter', async () => {
  let m = mount(`<${TAG}></${TAG}>`); let el = m.el();
  assert.equal($(el, 'smooth-pos'), null, 'neither adds a field');
  assert.equal($(el, 'ground-clearance'), null);
  typeInto(m.w, el, 'callsign', 'X');
  let d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X' }).data), 'defaults: 3 s smoothing, 0 m clearance, version 21008');
  assert.equal(decode(await blobBytes(m.w, d.blob), { fs2024: true }).version, 21008);

  m = mount(`<${TAG} smooth-pos="0" ground-clearance="1.2"></${TAG}>`); el = m.el();
  typeInto(m.w, el, 'callsign', 'X');
  d = await convertViaUi(m, el);
  assert.ok(same(await blobBytes(m.w, d.blob), core({ callsign: 'X', smoothPosS: 0, groundClearanceM: 1.2 }).data));

  // 'none' means unknown, which makes JoinFS skip its ground correction rather than guess
  m = mount(`<${TAG} ground-clearance="none"></${TAG}>`); el = m.el();
  typeInto(m.w, el, 'callsign', 'X');
  d = await convertViaUi(m, el);
  const cg = decode(await blobBytes(m.w, d.blob), { fs2024: true }).aircraft[0].positions[0].staticCgToGround;
  assert.ok(Number.isNaN(cg), 'ground-clearance="none" writes NaN');

  // smoothing genuinely reduces the frame-to-frame speed step, which is what JoinFS's linear
  // interpolation turns into a visible jolt
  const R = 6371008.8;
  const step = (opts) => {
    const p = decode(core(Object.assign({ callsign: 'X' }, opts)).data, { fs2024: true }).aircraft[0].positions.filter((f) => !f.ground);
    const v = [];
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      v.push(Math.hypot((b.lat - a.lat) * R, (b.lon - a.lon) * R * Math.cos(a.lat), b.alt - a.alt) / (b.t - a.t));
    }
    let sum = 0;
    for (let i = 1; i < v.length; i++) sum += Math.abs(v[i] - v[i - 1]);
    return sum / (v.length - 1);
  };
  assert.ok(step({}) < step({ smoothPosS: 0 }), 'smoothed track has smaller speed steps than the raw one');

  for (const bad of ['-1', '11', 'nope', '']) {
    const mb = mount(`<${TAG} smooth-pos="${bad}"></${TAG}>`); const eb = mb.el();
    typeInto(mb.w, eb, 'callsign', 'X');
    const db = await convertViaUi(mb, eb);
    assert.ok(same(await blobBytes(mb.w, db.blob), core({ callsign: 'X' }).data), `smooth-pos="${bad}" is ignored`);
  }
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
