'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const J = require('../src/joinfs-gpx-to-jfs.js');
const SRC = path.join(__dirname, '..', 'src');
const EN = J.messages.en;
const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).sort();

const localeFiles = fs.readdirSync(SRC).filter((f) => /^joinfs-gpx-to-jfs\..+\.json$/.test(f));

test('locale files exist next to the script', () => {
  assert.ok(localeFiles.includes('joinfs-gpx-to-jfs.en.json') && localeFiles.includes('joinfs-gpx-to-jfs.de.json'), localeFiles.join());
});

test('the English template equals the built-in texts', () => {
  const en = JSON.parse(fs.readFileSync(path.join(SRC, 'joinfs-gpx-to-jfs.en.json'), 'utf8'));
  assert.deepEqual(en, EN);
});

for (const file of localeFiles) {
  test(`${file}: complete, consistent placeholders, no empty strings`, () => {
    const data = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'));
    const missing = Object.keys(EN).filter((k) => !(k in data));
    const extra = Object.keys(data).filter((k) => !(k in EN));
    assert.deepEqual(missing, [], 'missing keys');
    assert.deepEqual(extra, [], 'unknown keys');
    for (const k of Object.keys(EN)) {
      assert.equal(typeof data[k], 'string', k);
      assert.ok(data[k].trim().length > 0, k + ' is empty');
      assert.deepEqual(placeholders(data[k]), placeholders(EN[k]), `placeholders of ${k}`);
    }
  });
}

test('every error code the converter can raise has a translatable message', () => {
  for (const code of ['noParser', 'doctype', 'notXml', 'notGpx', 'noTime', 'fewPoints', 'fewDistinct', 'tooLarge', 'tooLong', 'badVersion']) {
    assert.ok(('err.' + code) in EN, code);
  }
});
