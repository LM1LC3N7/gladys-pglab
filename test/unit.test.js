// -----------------------------------------------------------------------------
// The pure parts: topics, discovery and states (untrusted input), the
// configuration, the model, and the /data state.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeOutput, normalizeConfig, parseBrokerUrl, parseSafeOutputs } from '../src/config.js';
import { COVER_STATE } from '../src/constants.js';
import { buildModel, shutterState, strictNumber } from '../src/model.js';
import {
  SUBSCRIPTIONS,
  commandMessage,
  isName,
  layoutOf,
  normalizeMac,
  parseDiscovery,
  parseRelayState,
  parseSensor,
  parseShutterState,
  parseTopic,
} from '../src/protocol.js';
import { normalizeMemory, serializeMemory } from '../src/store.js';
import { BOARD_ID, BOARD_NAME, discovery } from './helpers/pglab.js';

const json = (value) => Buffer.from(JSON.stringify(value));
const externalIds = (type, id) => ({
  device: `ext:t:${type}:${id}`,
  feature: (role) => `ext:t:${type}:${id}:${role}`,
});

test('topics are matched exactly', () => {
  assert.deepEqual(parseTopic('pglab/discovery/DD53AC85/config'), {
    kind: 'discovery',
    id: 'DD53AC85',
  });
  assert.deepEqual(parseTopic('pglab/E-BOARD-1/relay/12/state'), {
    kind: 'relay',
    name: 'E-BOARD-1',
    index: 12,
  });
  assert.deepEqual(parseTopic('pglab/E-BOARD-1/shutter/0/state'), {
    kind: 'shutter',
    name: 'E-BOARD-1',
    index: 0,
  });
  assert.deepEqual(parseTopic('pglab/Board 1/sensor/value'), { kind: 'sensor', name: 'Board 1' });
  for (const bad of [
    'pglab/discovery/DD53AC85/config/x',
    'pglab/discovery/DD/53/config',
    'pglab/discovery/a+b/config',
    'pglab/E-BOARD-1/relay/012/state',
    'pglab/E-BOARD-1/relay/64/state',
    'pglab/E-BOARD-1/relay/-1/state',
    'pglab/E-BOARD-1/relay/1.0/state',
    'pglab/E-BOARD-1/shutter/32/state',
    'pglab/E-BOARD-1/relay/1/set',
    'pglab/E-BOARD-1/relay/1/state/x',
    'pglab/E-BOARD-1/sensor/values',
    'pglab/ board/sensor/value',
    'pglab/discovery/sensor/value',
    'other/E-BOARD-1/relay/1/state',
    `pglab/${'a'.repeat(300)}/sensor/value`,
    42,
  ]) {
    assert.equal(parseTopic(bad), undefined, String(bad));
  }
  assert.equal(SUBSCRIPTIONS.length, 4);
  assert.ok(SUBSCRIPTIONS.every((s) => s.startsWith('pglab/') && !s.includes('#')));
});

test('names that cannot go into a topic are refused', () => {
  assert.ok(isName('E-BOARD-DD53AC85'));
  assert.ok(isName('Garage 2'));
  for (const bad of [
    'a/b',
    'a+b',
    'a#',
    ' a',
    'a ',
    '',
    'a\u0000',
    'a\nb',
    'x'.repeat(65),
    'discovery',
  ]) {
    assert.equal(isName(bad), false, JSON.stringify(bad));
  }
});

test('a discovery is checked as pypglab does, and more', () => {
  const { board } = parseDiscovery(BOARD_ID, json(discovery()));
  assert.deepEqual(board, {
    id: BOARD_ID,
    name: BOARD_NAME,
    type: 'E-BOARD',
    mac: 'aa:bb:cc:dd:53:85',
    ip: '192.168.1.40',
    hw: '1.0.0',
    fw: '1.2.3',
    layout: { shutters: 2, boards: '11000000' },
  });
  assert.equal(
    parseDiscovery(BOARD_ID, json(discovery({ type: 'e-board' }))).board.type,
    'E-BOARD',
  );
  const cases = [
    [discovery(), 'OTHER', /differs from the topic/],
    [discovery({ id: 'a/b' }), 'a/b', /invalid id/],
    [discovery({ name: 'pglab/#' }), BOARD_ID, /name/],
    [discovery({ type: 'E-THING' }), BOARD_ID, /type/],
    [discovery({ manufacturer: 'Someone' }), BOARD_ID, /manufacturer/],
    [discovery({ mac: 'zz:bb:cc:dd:ee:ff' }), BOARD_ID, /MAC/],
    [discovery({ ip: '999.1.1.1' }), BOARD_ID, /IP/],
    [discovery({ fw: 'v1' }), BOARD_ID, /version/],
    [discovery({}, { shutters: 33, boards: '11111111' }), BOARD_ID, /shutters/],
    [discovery({}, { shutters: '2', boards: '11111111' }), BOARD_ID, /shutters/],
    [discovery({}, { shutters: 1.5, boards: '11111111' }), BOARD_ID, /shutters/],
    [discovery({}, { shutters: 0, boards: '1111111' }), BOARD_ID, /boards/],
    [discovery({}, { shutters: 0, boards: '11111112' }), BOARD_ID, /boards/],
    [discovery({ params: undefined }), BOARD_ID, /shutters/],
  ];
  for (const [payload, id, pattern] of cases) {
    assert.match(parseDiscovery(id, json(payload)).error, pattern, JSON.stringify(payload));
  }
  assert.match(parseDiscovery(BOARD_ID, Buffer.from('[1]')).error, /not an object/);
  assert.match(parseDiscovery(BOARD_ID, Buffer.from('{')).error, /not JSON/);
  assert.match(parseDiscovery(BOARD_ID, Buffer.alloc(5000, 32)).error, /too large/);
  // An inherited or __proto__ key is never read.
  const proto = Buffer.from(
    '{"__proto__":{"id":"DD53AC85"},"name":"x","type":"E-BOARD","manufacturer":"PG LAB Electronics"}',
  );
  assert.match(parseDiscovery(BOARD_ID, proto).error, /invalid id/);
  // An E-Switch has no outputs in pypglab 0.0.5: no params needed.
  const eswitch = parseDiscovery(BOARD_ID, json(discovery({ type: 'E-SWITCH', params: {} })));
  assert.equal(eswitch.board.layout, undefined);
});

test('the layout follows pypglab: shutters first, two relays each, per connected board', () => {
  assert.deepEqual(layoutOf({ shutters: 2, boards: '11000000' }), {
    shutters: [0, 1],
    relays: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  });
  assert.deepEqual(
    layoutOf({ shutters: 0, boards: '01000000' }).relays,
    [8, 9, 10, 11, 12, 13, 14, 15],
  );
  // Shutter 4 uses the relays 8 and 9, on the second board: not connected.
  assert.deepEqual(layoutOf({ shutters: 5, boards: '10000000' }), {
    shutters: [0, 1, 2, 3],
    relays: [],
  });
  assert.equal(layoutOf({ shutters: 32, boards: '11111111' }).relays.length, 0);
  assert.equal(layoutOf({ shutters: 0, boards: '11111111' }).relays.length, 64);
});

test('states are exact', () => {
  assert.equal(parseRelayState(Buffer.from('ON')), true);
  assert.equal(parseRelayState(Buffer.from('OFF')), false);
  for (const bad of ['on', ' ON', 'ON\n', '1', '', 'X'.repeat(600)]) {
    assert.equal(parseRelayState(Buffer.from(bad)), undefined, bad);
  }
  for (const s of ['OPENING', 'OPEN', 'CLOSING', 'CLOSED']) {
    assert.equal(parseShutterState(Buffer.from(s)), s);
  }
  assert.equal(parseShutterState(Buffer.from('STOP')), undefined);
  assert.deepEqual(parseSensor(json({ temp: 41.5, volt: 3, rtime: 100 })), {
    values: { temp: 41.5, volt: 3 },
    outOfRange: [],
  });
  assert.deepEqual(parseSensor(json({ temp: 900, volt: '3' })), {
    values: {},
    outOfRange: ['temp'],
  });
  assert.match(parseSensor(Buffer.from('12')).error, /not an object/);
});

test('commands only go to a valid topic with a known payload', () => {
  assert.deepEqual(commandMessage(BOARD_NAME, 'relay', 5, 'ON'), {
    topic: `pglab/${BOARD_NAME}/relay/5/set`,
    payload: 'ON',
  });
  assert.deepEqual(commandMessage(BOARD_NAME, 'shutter', 1, 'STOP'), {
    topic: `pglab/${BOARD_NAME}/shutter/1/set`,
    payload: 'STOP',
  });
  assert.throws(() => commandMessage('a/#', 'relay', 5, 'ON'));
  assert.throws(() => commandMessage(BOARD_NAME, 'relay', 5, 'OPEN'));
  assert.throws(() => commandMessage(BOARD_NAME, 'shutter', 1, 'ON'));
  assert.throws(() => commandMessage(BOARD_NAME, 'relay', 64, 'ON'));
});

test('MAC addresses are normalized', () => {
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('AA:BB:CC:DD:EE'), undefined);
});

test('configuration: broker, safe relays, options', () => {
  assert.deepEqual(parseBrokerUrl('192.168.1.2'), {
    url: 'mqtt://192.168.1.2',
    host: '192.168.1.2',
    port: 1883,
    tls: false,
  });
  assert.deepEqual(parseBrokerUrl('mqtts://broker.lan'), {
    url: 'mqtts://broker.lan',
    host: 'broker.lan',
    port: 8883,
    tls: true,
  });
  assert.equal(parseBrokerUrl('tcp://h:2000').url, 'mqtt://h:2000');
  assert.equal(parseBrokerUrl('ssl://[::1]').host, '::1');
  assert.deepEqual(parseBrokerUrl('mqtt://u:p@host'), { error: 'credentials' });
  // Nothing but scheme, host and port (the URL is logged); no WebSocket (the size guard).
  for (const bad of [
    'http://host',
    'ws://host',
    'wss://host',
    'mqtt://h/mqtt',
    'mqtt://h?token=x',
  ]) {
    assert.deepEqual(parseBrokerUrl(bad), { error: 'invalid' }, bad);
  }
  assert.equal(normalizeConfig({ broker_url: 'h', password: 'p' }).problem, 'user');
  assert.equal(
    normalizeConfig({ broker_url: 'h', username: 'u', password: 'p' }).problem,
    undefined,
  );
  const { safe, invalid } = parseSafeOutputs('4, 5;DD53AC85:9\nX:64 07 abc a/b:1');
  assert.deepEqual([...safe], ['4', '5', 'DD53AC85:9']);
  assert.equal(invalid, 4);
  assert.ok(isSafeOutput(safe, 'any', 4, { single: true }));
  assert.ok(!isSafeOutput(safe, 'any', 4, { single: false }));
  assert.ok(isSafeOutput(safe, 'DD53AC85', 9, { single: false }));
  const c = normalizeConfig({ broker_url: 'h', allow_output_buttons: 'yes', sensor_interval: '' });
  assert.equal(c.allowOutputButtons, false, 'only true allows');
  assert.equal(c.sensorInterval, 60);
  assert.equal(
    normalizeConfig({ broker_url: 'h', verify_certificate: null }).verifyCertificate,
    true,
  );
  assert.equal(normalizeConfig({ broker_url: 'h', sensor_interval: 9999 }).sensorInterval, 300);
  assert.equal(normalizeConfig({ broker_url: '' }).problem, 'broker:empty');
  assert.equal(normalizeConfig({ broker_url: 'h', password: 'x'.repeat(2000) }).password, '');
});

test('strict numbers: "" and null are not 0', () => {
  assert.equal(strictNumber(''), undefined);
  assert.equal(strictNumber(null), undefined);
  assert.equal(strictNumber('1'), 1);
  assert.equal(strictNumber(Number.NaN), undefined);
});

test('the model: relays read only unless declared safe, shutters never switches', () => {
  const board = {
    id: BOARD_ID,
    name: BOARD_NAME,
    type: 'E-BOARD',
    mac: 'aa:bb:cc:dd:53:85',
    ip: '192.168.1.40',
    fw: '1.2.3',
    layout: { shutters: 1, boards: '10000000' },
  };
  const model = buildModel({
    externalIds,
    boards: [board],
    safeOutputs: new Set(['2']),
    single: true,
  });
  const ids = model.devices.map((d) => d.external_id);
  assert.deepEqual(ids, [
    `ext:t:board:${BOARD_ID}`,
    `ext:t:shutter:${BOARD_ID}-0`,
    ...[2, 3, 4, 5, 6, 7].map((n) => `ext:t:relay:${BOARD_ID}-${n}`),
  ]);
  const byId = Object.fromEntries(model.devices.map((d) => [d.external_id, d]));
  const roles = (id) => byId[id].features.map((f) => `${f.category}/${f.type}`);
  assert.deepEqual(roles(`ext:t:relay:${BOARD_ID}-2`), ['switch/binary']);
  assert.deepEqual(roles(`ext:t:relay:${BOARD_ID}-3`), [
    'unknown/binary',
    'button/push',
    'button/push',
  ]);
  assert.deepEqual(roles(`ext:t:shutter:${BOARD_ID}-0`), ['shutter/state']);
  assert.deepEqual(roles(`ext:t:board:${BOARD_ID}`), [
    'device-temperature-sensor/decimal',
    'energy-sensor/voltage',
  ]);
  for (const device of model.devices) {
    for (const f of device.features) {
      assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max) && f.min <= f.max);
      assert.ok(!(f.category === 'switch' && device.external_id.includes(':shutter:')));
    }
  }
  // With several boards, a plain number applies nowhere.
  const two = buildModel({
    externalIds,
    boards: [board],
    safeOutputs: new Set(['2']),
    single: false,
  });
  assert.equal(
    two.devices.find((d) => d.external_id === `ext:t:relay:${BOARD_ID}-2`).features[0].category,
    'unknown',
  );
  // An E-Switch offers nothing (no outputs in pypglab 0.0.5).
  assert.equal(
    buildModel({ externalIds, boards: [{ ...board, type: 'E-SWITCH', layout: null }] }).devices
      .length,
    0,
  );
});

test('shutter states map to the Gladys cover states', () => {
  assert.equal(shutterState('OPEN'), COVER_STATE.OPEN);
  assert.equal(shutterState('OPENING'), COVER_STATE.OPEN);
  assert.equal(shutterState('CLOSED'), COVER_STATE.CLOSE);
  assert.equal(shutterState('CLOSING'), COVER_STATE.CLOSE);
  assert.equal(shutterState('X'), undefined);
});

test('/data: bounded, only known keys, never a secret', () => {
  const B = {
    name: BOARD_NAME,
    type: 'E-BOARD',
    mac: 'aa:bb:cc:dd:53:85',
    shutters: 2,
    boards: '11000000',
  };
  const raw = {
    refused: true,
    password: 'S3cret',
    boards: {
      DD53AC85: { ...B, extra: 1 },
      'bad/id': B,
      BAD1: { ...B, mac: 'nope' },
      BAD2: { ...B, shutters: 40 },
      BAD3: { ...B, name: 'a/#' },
      BAD4: { ...B, type: 'E-THING' },
      BAD5: { mac: B.mac, shutters: 2, boards: '11000000' },
      SW: { ...B, type: 'E-SWITCH', mac: 'aa:bb:cc:dd:53:86', shutters: null, boards: null },
    },
  };
  const memory = normalizeMemory(raw);
  assert.equal(memory.refused, true);
  assert.deepEqual([...memory.boards.keys()], ['DD53AC85', 'SW']);
  const out = serializeMemory(memory);
  assert.doesNotMatch(JSON.stringify(out), /S3cret|extra/);
  assert.equal(normalizeMemory(JSON.parse('{"__proto__":{"refused":true}}')).refused, false);
  const many = { boards: {} };
  for (let i = 0; i < 100; i += 1) {
    many.boards[`B${i}`] = B;
  }
  assert.equal(normalizeMemory(many).boards.size, 64);
});

test('device names stay distinct with a long board name', () => {
  const name = `B${'x'.repeat(61)}`;
  const model = buildModel({
    externalIds,
    boards: [
      {
        id: BOARD_ID,
        name,
        type: 'E-BOARD',
        mac: 'aa:bb:cc:dd:53:85',
        layout: { shutters: 1, boards: '10000000' },
      },
    ],
  });
  const names = model.devices.map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((n) => n.length <= 60));
  assert.ok(names.includes(`${name.slice(0, 60 - ' relais 7'.length)} relais 7`));
});
