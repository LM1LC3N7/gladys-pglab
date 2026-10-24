// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, SENSOR_INTERVAL, TIMINGS } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics, version 0.1.0 everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.0.0');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-pglab:${manifest.version}`);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-pglab/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('unofficial, never tested on a real installation, and said so', () => {
  const intro = fields.intro;
  assert.match(intro.description.en, /Unofficial, not affiliated with PG LAB Electronics/);
  assert.match(intro.description.fr, /Non officiel, sans lien avec PG LAB Electronics/);
  assert.match(intro.description.en, /Never tested with a real board/);
  assert.match(intro.description.fr, /Jamais testé avec une vraie carte/);
  assert.match(read('README.md'), /not affiliated with PG LAB Electronics/);
  assert.match(read('docs/en.md'), /never been tested with a real/i);
  assert.match(read('docs/fr.md'), /jamais été testée? avec une vraie/i);
});

test('the configuration matches the code', () => {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    if (fields[key].default !== undefined || !['', null].includes(value)) {
      assert.deepEqual(fields[key].default, value, key);
    }
  }
  for (const field of manifest.config_schema) {
    assert.ok(
      field.type === 'section' || Object.hasOwn(DEFAULT_CONFIG, field.key),
      `${field.key} is not read`,
    );
    assert.match(field.key, /^[a-z0-9_]+$/);
    if (field.placeholder !== undefined) {
      assert.equal(
        typeof field.placeholder,
        'object',
        `${field.key}: placeholder must be multi-language`,
      );
    }
  }
  assert.equal(fields.broker_url.required, true);
  assert.equal(fields.sensor_interval.min, SENSOR_INTERVAL.min);
  assert.equal(fields.sensor_interval.max, SENSOR_INTERVAL.max);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr']) {
      assert.ok(
        section.description[lang].length <= 1000,
        `${section.key}.${lang} over 1000 characters`,
      );
    }
    assert.ok((section.links ?? []).length <= 5);
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    ['fr', 'en'],
  );
});

test('relays are read only unless declared safe, buttons off by default', () => {
  assert.equal(fields.allow_output_buttons.type, 'boolean');
  assert.equal(fields.allow_output_buttons.default, false);
  assert.equal(fields.safe_outputs.default, '');
});

test('the broker of Gladys is explained: its host, never localhost', () => {
  assert.match(fields.intro.description.en, /mqtt:\/\/\{\{gladys_host\}\}:1883/);
  assert.match(fields.intro.description.fr, /mqtt:\/\/\{\{gladys_host\}\}:1883/);
  assert.match(fields.intro.description.en, /never localhost/);
  assert.match(read('docs/en.md'), /broker of Gladys/);
  assert.match(read('docs/fr.md'), /broker de Gladys/);
});

test('no secret field has a default', () => {
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.equal(Object.hasOwn(field, 'default'), false, field.key);
  }
});

test('the password is a secret, never said to be encrypted', () => {
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.password.default, undefined);
  assert.match(fields.password.description.fr, /gardé par Gladys dans sa base, jamais réaffiché/);
  assert.match(fields.password.description.en, /kept by Gladys in its database, never shown again/);
  for (const path of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'TODO.md',
    'CHANGELOG.md',
    'CLAUDE.md',
    'src/i18n.js',
  ]) {
    // "chiffres" (digits) is fine; "chiffré", "chiffrement" (encrypted) are not.
    assert.doesNotMatch(
      read(path),
      /chiffré|chiffrement|crypté|encrypt/i,
      `${path}: a secret is not encrypted`,
    );
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  const testAction = manifest.actions.find((a) => a.key === ACTIONS.TEST);
  assert.ok(
    testAction.timeout_seconds * 1000 > TIMINGS.connectTimeout + 1000 + TIMINGS.testTimeout + 5000,
    'the connection test answers before Gladys gives up',
  );
  assert.ok(testAction.timeout_seconds >= 5 && testAction.timeout_seconds <= 120);
});
