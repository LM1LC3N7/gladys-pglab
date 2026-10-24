// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and saved again ("é"
// becoming "Ã" + "©", the apostrophe "’" becoming "â" + "€" + "™").
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
// Control characters on purpose: the test looks for them.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
  'src/app.js',
  'src/config.js',
  'src/model.js',
  'src/protocol.js',
  'src/store.js',
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    // No control character but new lines and tabs (a NUL makes git and GitHub see a binary file).
    const control = text.search(CONTROL);
    assert.equal(control, -1, `control character at offset ${control}`);
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

test('the control pattern catches what it should', () => {
  assert.match('(\u000000123:10)', CONTROL);
  assert.doesNotMatch('a\tb\r\nc', CONTROL);
});

test('the mojibake pattern catches what it should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('finâ€¦', MOJIBAKE, '… read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app… 24 °C', MOJIBAKE);
});

test('LICENSE names nobody', () => {
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /pypglab/);
  assert.match(notices, /Copyright \(c\) 2024 pglab-electronics/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /Home Assistant/);
});

test('cover.png is a PNG of 800×534', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});
