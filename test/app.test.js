// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, and a fake broker playing the PG LAB boards. Timers are mocked: the
// debounces, the state flush, the command deadlines run when the test ticks.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PglabApp } from '../src/app.js';
import { ACTIONS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { SUBSCRIPTIONS } from '../src/protocol.js';
import { memoryStore } from '../src/store.js';
import { fakeConnector, settle } from './helpers/fakeMqtt.js';
import { BOARD_ID, BOARD_NAME, MAC, SELECTOR, discovery, ext, topic } from './helpers/pglab.js';

const START = 1_760_000_000_000;
const SECRET = 'S3cretPassw0rd';
const BASE = { broker_url: '192.168.1.50', username: 'gladys', password: SECRET };

/** A board answering its commands like a real one would (configurable). */
function board(options = {}) {
  const b = { echo: true, name: BOARD_NAME, ...options };
  b.responder = (t, payload, client) => {
    if (!b.echo) {
      return;
    }
    const relay = /^pglab\/(.+)\/relay\/(\d+)\/set$/.exec(t);
    if (relay && relay[1] === b.name) {
      client.deliver(topic.relay(relay[2], b.name), payload);
    }
    const shutter = /^pglab\/(.+)\/shutter\/(\d+)\/set$/.exec(t);
    if (shutter && shutter[1] === b.name) {
      const state = { OPEN: 'OPENING', CLOSE: 'CLOSING', STOP: 'OPEN' }[payload];
      client.deliver(topic.shutter(shutter[2], b.name), state);
    }
  };
  return b;
}

async function setup(t, { cfg = BASE, devices = [], memory = null, b = board() } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const gladys = createFakeGladys({ config: cfg, devices, selector: SELECTOR });
  const broker = fakeConnector(b.responder);
  const store = memoryStore(memory);
  const logs = [];
  const logger = {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m),
    debug: (m) => logs.push(m),
  };
  const app = new PglabApp({
    gladys,
    connect: broker.connect,
    now: () => Date.now(),
    store,
    logger,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { gladys, app, broker, store, b, tick, logs };
}

/** The broker connects and the board publishes its retained discovery. */
async function online(ctx, payload = discovery()) {
  const client = ctx.broker.clients.at(-1);
  client.open();
  await settle();
  client.deliver(topic.discovery(payload.id), payload, { retain: true });
  await ctx.tick(TIMINGS.rebuildDebounce);
  return client;
}

const discovered = (gladys, externalId) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
const featureOf = (device, role) =>
  device.features.find((f) => f.external_id === `${device.external_id}:${role}`);

async function create(ctx, externalId) {
  const device = discovered(ctx.gladys, externalId);
  assert.ok(device, `device ${externalId} offered`);
  await ctx.gladys.fake.deviceCreated(device);
  return device;
}

/** A command: the ack, once the fake timers ran far enough. */
async function command(ctx, device, role, value, { ticks = [0], feature } = {}) {
  const ack = ctx.gladys.fake.setValue(device, feature ?? featureOf(device, role), value);
  for (const ms of ticks) {
    await ctx.tick(ms);
  }
  return ack;
}

const sets = (client) => client.published.filter((p) => p.topic.endsWith('/set'));

test('connects, subscribes, offers the board, its shutters and relays', async (t) => {
  const ctx = await setup(t);
  const client = ctx.broker.clients[0];
  assert.equal(client.config.brokerUrl, 'mqtt://192.168.1.50');
  client.open();
  await settle();
  assert.deepEqual([...client.subscriptions], SUBSCRIPTIONS);
  assert.equal(client.published.length, 0, 'nothing published by the integration');
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /waiting for the PG LAB boards/);
  client.deliver(topic.discovery(), discovery(), { retain: true });
  await ctx.tick(TIMINGS.rebuildDebounce);
  const ids = ctx.gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(ids, [
    ext.board(),
    ext.shutter(0),
    ext.shutter(1),
    ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => ext.relay(n)),
  ]);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /1 PG LAB board\(s\), 15 device/);
  assert.deepEqual(ctx.store.data.boards[BOARD_ID], {
    name: BOARD_NAME,
    type: 'E-BOARD',
    mac: MAC,
    shutters: 2,
    boards: '11000000',
  });
  const relay = discovered(ctx.gladys, ext.relay(4));
  assert.equal(relay.name, `${BOARD_NAME} relais 4`);
  assert.deepEqual(
    relay.params.map((p) => p.name),
    ['PGLAB_ID', 'PGLAB_NAME', 'PGLAB_TYPE', 'PGLAB_RELAY'],
  );
});

test('no board on the broker: said after a while', async (t) => {
  const ctx = await setup(t);
  ctx.broker.clients[0].open();
  await settle();
  await ctx.tick(TIMINGS.discoveryTimeout);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.fr,
    /aucune carte PG LAB ne s’est annoncée/,
  );
});

test('a relay not declared safe: read only, buttons off by default, then allowed', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(5));
  assert.deepEqual(
    relay.features.map((f) => `${f.category}/${f.type}/${f.read_only}`),
    ['unknown/binary/true', 'button/push/false', 'button/push/false'],
  );
  client.deliver(topic.relay(5), 'ON');
  await ctx.tick(TIMINGS.flushInterval);
  assert.equal(ctx.gladys.fake.lastState(`${ext.relay(5)}:state`), 1);
  let ack = await command(ctx, relay, 'turn-on', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /boutons « Allumer » \/ « Éteindre » sont désactivés/);
  ack = await command(ctx, relay, 'state', 1);
  assert.equal(ack.success, false, 'the state is read only');
  assert.equal(sets(client).length, 0);
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_output_buttons: true });
  await settle();
  assert.equal(ctx.broker.clients.length, 1, 'an option never reconnects');
  ack = await command(ctx, relay, 'turn-off', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(sets(client).at(-1), {
    topic: topic.relaySet(5),
    payload: 'OFF',
    qos: 0,
    retain: false,
  });
  ack = await command(ctx, relay, 'turn-on', 0);
  assert.equal(ack.success, false, 'a button takes 1 only');
});

test('a relay declared safe is a switch; no longer safe, its switch is refused', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: '4' } });
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  assert.deepEqual(
    relay.features.map((f) => `${f.category}/${f.type}`),
    ['switch/binary'],
  );
  let ack = await command(ctx, relay, 'power', 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(sets(client).at(-1).payload, 'ON');
  for (const bad of ['', null, 2, '1.5', 'on']) {
    ack = await command(ctx, relay, 'power', bad);
    assert.equal(ack.success, false, String(bad));
  }
  // No echo from the board: "sent, without confirmation", never "not sent".
  ctx.b.echo = false;
  ack = await command(ctx, relay, 'power', 0, { ticks: [0, TIMINGS.commandAnswerBy] });
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  ctx.b.echo = true;
  // The relay is no longer declared safe: the switch the user created is refused.
  await ctx.gladys.fake.configUpdated({ ...BASE, safe_outputs: '' });
  await ctx.tick(0);
  const count = sets(client).length;
  ack = await command(ctx, relay, 'power', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas déclaré sûr/);
  assert.equal(sets(client).length, count);
  // The switch is kept in the Discovery list (never a lost feature).
  const offered = discovered(ctx.gladys, ext.relay(4));
  assert.ok(featureOf(offered, 'power'));
  assert.ok(featureOf(offered, 'state'));
});

test('shutters: open, close and stop, never a switch', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  const shutter = await create(ctx, ext.shutter(1));
  assert.deepEqual(
    shutter.features.map((f) => `${f.category}/${f.type}/${f.min}/${f.max}`),
    ['shutter/state/-1/1'],
  );
  for (const [value, payload] of [
    [1, 'OPEN'],
    [-1, 'CLOSE'],
    [0, 'STOP'],
  ]) {
    const ack = await command(ctx, shutter, 'shutter', value);
    assert.equal(ack.success, true, `${payload}: ${ack.error}`);
    assert.deepEqual(
      [sets(client).at(-1).topic, sets(client).at(-1).payload],
      [topic.shutterSet(1), payload],
    );
  }
  const ack = await command(ctx, shutter, 'shutter', 2);
  assert.equal(ack.success, false);
  client.deliver(topic.shutter(1), 'CLOSED');
  await ctx.tick(TIMINGS.flushInterval);
  assert.equal(ctx.gladys.fake.lastState(`${ext.shutter(1)}:shutter`), -1);
});

test('states: retained ones, unknown names, relays outside the layout are ignored', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(6));
  const sensor = await create(ctx, ext.board());
  client.deliver(topic.relay(6), 'ON', { retain: true });
  client.deliver(topic.relay(6, 'OTHER'), 'ON');
  client.deliver(topic.relay(2), 'ON');
  client.deliver(topic.relay(6), 'on');
  await ctx.tick(TIMINGS.flushInterval);
  assert.equal(ctx.gladys.fake.lastState(`${relay.external_id}:state`), undefined);
  client.deliver(topic.sensor(), { temp: 42.5, volt: 3.3, rtime: 1000 });
  await ctx.tick(TIMINGS.flushInterval);
  assert.equal(ctx.gladys.fake.lastState(`${sensor.external_id}:temperature`), 42.5);
  assert.equal(ctx.gladys.fake.lastState(`${sensor.external_id}:voltage`), 3.3);
  // A measurement is throttled (60 s by default).
  client.deliver(topic.sensor(), { temp: 43 });
  await ctx.tick(TIMINGS.flushInterval);
  assert.equal(ctx.gladys.fake.lastState(`${sensor.external_id}:temperature`), 42.5);
  await ctx.tick(60_000);
  assert.equal(ctx.gladys.fake.lastState(`${sensor.external_id}:temperature`), 43);
});

test('a changed layout is never applied by itself: refused until a Scan', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: '4', allow_output_buttons: true } });
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  const shutter = await create(ctx, ext.shutter(0));
  // The board now says 3 shutters: relays 4 and 5 would drive shutter 2.
  client.deliver(topic.discovery(), discovery({}, { shutters: 3, boards: '11000000' }), {
    retain: true,
  });
  await ctx.tick(TIMINGS.rebuildDebounce);
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /configuration of E-BOARD-DD53AC85 changed/,
  );
  assert.equal(ctx.store.data.boards[BOARD_ID].shutters, 2, 'not accepted in /data');
  assert.ok(discovered(ctx.gladys, ext.relay(4)), 'the accepted layout is still offered');
  assert.equal(discovered(ctx.gladys, ext.shutter(2)), undefined);
  const before = sets(client).length;
  let ack = await command(ctx, relay, 'power', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre configuration/);
  ack = await command(ctx, shutter, 'shutter', 1);
  assert.equal(ack.success, false, 'opening refused');
  assert.equal(sets(client).length, before);
  // Stop and close are never held by it.
  ack = await command(ctx, shutter, 'shutter', 0);
  assert.equal(ack.success, true, ack.error);
  ack = await command(ctx, shutter, 'shutter', -1);
  assert.equal(ack.success, true, ack.error);
  // A Scan accepts it.
  await ctx.gladys.fake.scanRequest();
  await settle();
  assert.equal(ctx.store.data.boards[BOARD_ID].shutters, 3);
  assert.ok(discovered(ctx.gladys, ext.shutter(2)));
  assert.equal(discovered(ctx.gladys, ext.relay(4)), undefined);
});

test('after a restart, a layout that changed meanwhile is not accepted either', async (t) => {
  const memory = {
    refused: false,
    boards: {
      [BOARD_ID]: { name: BOARD_NAME, type: 'E-BOARD', mac: MAC, shutters: 0, boards: '10000000' },
    },
  };
  const ctx = await setup(t, { memory, cfg: { ...BASE, allow_output_buttons: true } });
  await online(ctx);
  // The accepted layout: relays 0-7, no shutter (the published one has 2 shutters).
  assert.ok(discovered(ctx.gladys, ext.relay(0)));
  assert.equal(discovered(ctx.gladys, ext.shutter(0)), undefined);
  const relay = await create(ctx, ext.relay(0));
  const ack = await command(ctx, relay, 'turn-on', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre configuration/);
});

test('another MAC address for a known board: relays refused until a Scan', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: '4' } });
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  client.deliver(topic.discovery(), discovery({ mac: '11:22:33:44:55:66' }), { retain: true });
  await ctx.tick(TIMINGS.rebuildDebounce);
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Another MAC address/);
  let ack = await command(ctx, relay, 'power', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre adresse MAC/);
  await ctx.gladys.fake.scanRequest();
  await settle();
  assert.equal(ctx.store.data.boards[BOARD_ID].mac, '11:22:33:44:55:66');
  ack = await command(ctx, relay, 'power', 1);
  assert.equal(ack.success, true, ack.error);
});

test('two boards with the same name: states ignored, only stop and close leave', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: `${BOARD_ID}:4` } });
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  const shutter = await create(ctx, ext.shutter(0));
  client.deliver(topic.discovery('FAKE01'), discovery({ id: 'FAKE01', mac: '11:22:33:44:55:66' }), {
    retain: true,
  });
  await ctx.tick(TIMINGS.rebuildDebounce);
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Several boards are named/);
  client.deliver(topic.relay(4), 'ON');
  await ctx.tick(TIMINGS.flushInterval);
  assert.equal(ctx.gladys.fake.lastState(`${relay.external_id}:power`), undefined);
  const before = sets(client).length;
  for (const [device, role, value] of [
    [relay, 'power', 1],
    [shutter, 'shutter', 1],
  ]) {
    const ack = await command(ctx, device, role, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /Plusieurs cartes portent le nom/);
  }
  assert.equal(sets(client).length, before);
  for (const [value, payload] of [
    [0, 'STOP'],
    [-1, 'CLOSE'],
  ]) {
    const ack = await command(ctx, shutter, 'shutter', value, {
      ticks: [0, TIMINGS.commandAnswerBy],
    });
    assert.match(ack.error ?? '', /sans confirmation/, `${payload} leaves (its echo is ignored)`);
    assert.deepEqual(
      [sets(client).at(-1).topic, sets(client).at(-1).payload],
      [topic.shutterSet(0), payload],
    );
  }
});

test('a discovery never makes a relay a switch, even for a new board', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: '4' } });
  const client = await online(ctx);
  assert.equal(featureOf(discovered(ctx.gladys, ext.relay(4)), 'power').category, 'switch');
  // A second board appears: "4" is ambiguous now, so it applies nowhere.
  client.deliver(
    topic.discovery('B2'),
    discovery({ id: 'B2', name: 'E-BOARD-2', mac: '11:22:33:44:55:66' }),
    { retain: true },
  );
  await ctx.tick(TIMINGS.rebuildDebounce);
  assert.equal(discovered(ctx.gladys, ext.relay(4)).features[0].category, 'unknown');
  assert.equal(discovered(ctx.gladys, ext.relay(4, 'B2')).features[0].category, 'unknown');
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /Not applied in "Relays declared safe": 4/,
  );
  // It withdraws its discovery: "4" stays ambiguous (two boards were accepted).
  client.deliver(topic.discovery('B2'), '');
  await ctx.tick(TIMINGS.rebuildDebounce);
  assert.equal(discovered(ctx.gladys, ext.relay(4)).features[0].category, 'unknown');
});

test('invalid discoveries are counted, never shown, never trusted', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  client.deliver(topic.discovery('X1'), discovery({ id: 'X2' }));
  client.deliver(topic.discovery('X3'), 'not json');
  client.deliver(topic.discovery('X4'), discovery({ id: 'X4', manufacturer: 'Evil' }));
  await ctx.tick(TIMINGS.rebuildDebounce);
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /3 invalid discovery message\(s\) ignored/,
  );
  assert.deepEqual(Object.keys(ctx.store.data.boards), [BOARD_ID]);
});

test('broker down: a command is refused, nothing queued', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: '4' } });
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  client.close();
  await settle();
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /lost/);
  const ack = await command(ctx, relay, 'power', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /annoncée|pas connecté/);
  assert.equal(sets(client).length, 0);
  // Reconnected: the boards are unknown until they announce themselves again.
  client.open();
  await settle();
  const again = await command(ctx, relay, 'power', 1);
  assert.equal(again.success, false);
  assert.match(again.error, /ne s’est pas annoncée/);
  client.deliver(topic.discovery(), discovery(), { retain: true });
  await settle();
  const ok = await command(ctx, relay, 'power', 1);
  assert.equal(ok.success, true, ok.error);
});

test('refused credentials: a final stop, persisted, no secret anywhere', async (t) => {
  const ctx = await setup(t);
  const client = ctx.broker.clients[0];
  client.refuse(5);
  await settle();
  assert.equal(client.ended, true);
  assert.equal(ctx.store.data.refused, true);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /refused the credentials \(not authorized\)/,
  );
  await ctx.tick(48 * 3600 * 1000);
  assert.equal(ctx.broker.clients.length, 1, 'never a new try by itself');
  // A Gladys reconnection keeps the stop.
  await ctx.gladys.fake.send('connected').catch(() => {});
  await ctx.app.gladysConnected(BASE);
  assert.equal(ctx.broker.clients.length, 1);
  const all = JSON.stringify([ctx.store.data, ctx.gladys.fake.connectionStatuses, ctx.logs]);
  assert.doesNotMatch(all, new RegExp(SECRET));
  assert.doesNotMatch(all, /"gladys"/);
});

test('refused credentials survive a restart; other credentials lift the stop', async (t) => {
  const ctx = await setup(t, { memory: { refused: true, boards: {} } });
  assert.equal(ctx.broker.clients.length, 0, 'stopped at start');
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /no new try by itself/);
  await ctx.gladys.fake.configUpdated({ ...BASE, verify_certificate: false });
  assert.equal(ctx.broker.clients.length, 0, 'same credentials: still stopped');
  await ctx.gladys.fake.configUpdated({ ...BASE, password: 'another one' });
  assert.equal(ctx.broker.clients.length, 1);
  assert.equal(ctx.store.data.refused, false);
});

test('the test button uses the one session, even after a refusal', async (t) => {
  const ctx = await setup(t, { memory: { refused: true, boards: {} } });
  assert.equal(ctx.broker.clients.length, 0);
  const answer = ctx.gladys.fake.action(ACTIONS.TEST);
  await settle();
  assert.equal(ctx.broker.clients.length, 1);
  const client = ctx.broker.clients[0];
  client.open();
  await settle();
  client.deliver(topic.discovery(), discovery(), { retain: true });
  await settle();
  const ack = await answer;
  assert.match(ack.data.message.en, /It works: 1 PG LAB board\(s\), 15 device/);
  assert.equal(ctx.store.data.refused, false, 'lifted by the success');
  // Connected: the button answers from the same session, no second client.
  await ctx.tick(TIMINGS.testCooldown);
  const second = await ctx.gladys.fake.action(ACTIONS.TEST);
  assert.match(second.data.message.en, /It works/);
  assert.equal(ctx.broker.clients.length, 1);
  // Too soon.
  const third = await ctx.gladys.fake.action(ACTIONS.TEST);
  assert.match(third.data.message.en, /Already tested/);
});

test('the test button reports refused credentials', async (t) => {
  const ctx = await setup(t, { memory: { refused: true, boards: {} } });
  const answer = ctx.gladys.fake.action(ACTIONS.TEST);
  await settle();
  ctx.broker.clients[0].refuse(4);
  await settle();
  const ack = await answer;
  assert.match(ack.data.message.en, /refused the credentials \(bad user name or password\)/);
  assert.equal(ctx.store.data.refused, true);
  const alive = ctx.broker.clients.filter((c) => !c.ended);
  assert.equal(alive.length, 0);
});

test('one session at a time: a new configuration ends the previous client', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  await ctx.gladys.fake.configUpdated({ ...BASE, broker_url: '192.168.1.51' });
  await ctx.gladys.fake.configUpdated({ ...BASE, broker_url: '192.168.1.52' });
  assert.equal(ctx.broker.clients.length, 3);
  assert.equal(ctx.broker.clients.filter((c) => !c.ended).length, 1);
});

test('a Gladys reconnection sends the status and the Discovery again', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  const discoveries = ctx.gladys.fake.bodies('POST', '/discovered_device').length;
  await ctx.app.gladysConnected(BASE);
  assert.ok(ctx.gladys.fake.connectionStatuses.length > statuses);
  assert.ok(ctx.gladys.fake.bodies('POST', '/discovered_device').length > discoveries);
  assert.equal(ctx.broker.clients.length, 1, 'the MQTT client is kept');
});

test('300 states per minute at most, whatever the board publishes', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  for (let n = 4; n < 16; n += 1) {
    await create(ctx, ext.relay(n));
  }
  const before = ctx.gladys.fake.states.length;
  for (let i = 0; i < 2000; i += 1) {
    client.deliver(topic.relay(4 + (i % 12)), i % 2 ? 'ON' : 'OFF');
    if (i % 12 === 11) {
      await ctx.tick(100);
    }
  }
  await ctx.tick(60_000 - 20_000);
  assert.ok(ctx.gladys.fake.states.length - before <= 300);
});

test('transport badges: unreachable until the board publishes, and after a silence', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  const badge = () =>
    ctx.gladys.fake.transports.filter((x) => x.device_external_id === relay.external_id).at(-1)
      ?.transport;
  assert.equal(badge(), DEVICE_TRANSPORTS.UNREACHABLE, 'a retained discovery proves nothing');
  client.deliver(topic.sensor(), { temp: 30 });
  await ctx.tick(TIMINGS.badgeInterval);
  assert.equal(badge(), DEVICE_TRANSPORTS.LOCAL);
  await ctx.tick(TIMINGS.silence + TIMINGS.badgeInterval);
  assert.equal(badge(), DEVICE_TRANSPORTS.UNREACHABLE);
});

// --- Review r1 --------------------------------------------------------------------

test('stop and close are routed from /data: before any announcement, and after a withdrawal', async (t) => {
  const memory = {
    refused: false,
    boards: {
      [BOARD_ID]: { name: BOARD_NAME, type: 'E-BOARD', mac: MAC, shutters: 2, boards: '11000000' },
    },
  };
  const shutterDevice = {
    name: 'Volet',
    external_id: ext.shutter(0),
    features: [
      {
        name: 'Ouvrir / fermer',
        external_id: `${ext.shutter(0)}:shutter`,
        category: 'shutter',
        type: 'state',
        min: -1,
        max: 1,
        read_only: false,
      },
    ],
  };
  const ctx = await setup(t, { memory, devices: [shutterDevice] });
  const client = ctx.broker.clients[0];
  client.open();
  await settle();
  // Connected, no announcement yet: the stop and the close leave; the opening does not.
  for (const [value, payload] of [
    [0, 'STOP'],
    [-1, 'CLOSE'],
  ]) {
    const ack = await command(ctx, shutterDevice, 'shutter', value);
    assert.equal(ack.success, true, `${payload}: ${ack.error}`);
    assert.deepEqual(
      [sets(client).at(-1).topic, sets(client).at(-1).payload],
      [topic.shutterSet(0), payload],
    );
  }
  let ack = await command(ctx, shutterDevice, 'shutter', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /ne s’est pas annoncée/);
  // The board announces, then withdraws its discovery: the stop still leaves.
  client.deliver(topic.discovery(), discovery(), { retain: true });
  await settle();
  client.deliver(topic.discovery(), '');
  await ctx.tick(TIMINGS.rebuildDebounce);
  ack = await command(ctx, shutterDevice, 'shutter', 0);
  assert.equal(ack.success, true, ack.error);
  // Broker down: refused with the right reason.
  client.close();
  await settle();
  ack = await command(ctx, shutterDevice, 'shutter', 0);
  assert.match(ack.error, /broker MQTT n’est pas connecté/);
});

test('another type for the same id: devices kept, stop and close allowed, a precise reason', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: '4' } });
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  const shutter = await create(ctx, ext.shutter(0));
  client.deliver(topic.discovery(), discovery({ type: 'E-SWITCH' }), { retain: true });
  await ctx.tick(TIMINGS.rebuildDebounce);
  assert.ok(discovered(ctx.gladys, ext.relay(4)), 'the accepted devices stay offered');
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /changed \(type, shutters or relays\)/);
  let ack = await command(ctx, relay, 'power', 1);
  assert.match(ack.error, /autre configuration \(type, volets ou relais\)/);
  ack = await command(ctx, shutter, 'shutter', 1);
  assert.match(ack.error, /autre configuration/);
  for (const value of [0, -1]) {
    ack = await command(ctx, shutter, 'shutter', value);
    assert.equal(ack.success, true, ack.error);
  }
  assert.equal(ctx.store.data.boards[BOARD_ID].type, 'E-BOARD');
});

test('another name is applied only by a Scan; stop and close go under both names', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: `${BOARD_ID}:4` } });
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  const shutter = await create(ctx, ext.shutter(0));
  ctx.b.name = 'garage';
  client.deliver(topic.discovery(), discovery({ name: 'garage' }), { retain: true });
  await ctx.tick(TIMINGS.rebuildDebounce);
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /E-BOARD-DD53AC85 → garage/);
  const before = sets(client).length;
  let ack = await command(ctx, relay, 'power', 1);
  assert.match(ack.error, /autre nom/);
  ack = await command(ctx, shutter, 'shutter', 1);
  assert.match(ack.error, /autre nom/);
  assert.equal(sets(client).length, before, 'nothing sent to pglab/garage/...');
  ack = await command(ctx, shutter, 'shutter', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    sets(client)
      .slice(before)
      .map((p) => p.topic)
      .sort(),
    [topic.shutterSet(0), topic.shutterSet(0, 'garage')].sort(),
  );
  await ctx.gladys.fake.scanRequest();
  await settle();
  assert.equal(ctx.store.data.boards[BOARD_ID].name, 'garage');
  ack = await command(ctx, relay, 'power', 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(sets(client).at(-1).topic, topic.relaySet(4, 'garage'));
});

test('a flood of invalid discoveries: two status posts at most', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  await ctx.tick(TIMINGS.statusRefresh);
  const before = ctx.gladys.fake.connectionStatuses.length;
  for (let i = 0; i < 1000; i += 1) {
    client.deliver(topic.discovery(), discovery({ manufacturer: `X${i}` }));
  }
  await ctx.tick(TIMINGS.statusRefresh);
  await ctx.tick(TIMINGS.statusRefresh);
  const posts = ctx.gladys.fake.connectionStatuses.length - before;
  assert.ok(posts >= 1 && posts <= 2, `${posts} posts`);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /1000 invalid discovery/);
});

test('a discovery repeated every second never delays the devices', async (t) => {
  const ctx = await setup(t);
  const client = ctx.broker.clients[0];
  client.open();
  await settle();
  for (let i = 0; i < 3; i += 1) {
    client.deliver(topic.discovery(), discovery());
    client.deliver(
      topic.discovery('B2'),
      discovery({ id: 'B2', name: `E-${i}`, mac: '11:22:33:44:55:66' }),
    );
    await ctx.tick(700);
  }
  assert.ok(discovered(ctx.gladys, ext.relay(4)), 'built 1.5 s after the first one');
});

test('boards seen in passing: over 64, said in the status; a Scan forgets them', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  await create(ctx, ext.relay(4));
  for (let i = 0; i < 70; i += 1) {
    const id = `P${i}`;
    client.deliver(
      topic.discovery(id),
      discovery({ id, name: `pass-${i}`, mac: '11:22:33:44:55:66' }),
    );
    client.deliver(topic.discovery(id), '');
  }
  await ctx.tick(TIMINGS.rebuildDebounce);
  assert.equal(Object.keys(ctx.store.data.boards).length, 64);
  client.deliver(topic.discovery('NEWBOARD'), discovery({ id: 'NEWBOARD', name: 'new-one' }));
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /1 new board\(s\) ignored.*Scan/);
  await ctx.gladys.fake.scanRequest();
  await settle();
  assert.deepEqual(Object.keys(ctx.store.data.boards).sort(), [BOARD_ID]);
  // The new board announces itself again (the broker resends the retained ones): accepted.
  client.deliver(topic.discovery('NEWBOARD'), discovery({ id: 'NEWBOARD', name: 'new-one' }));
  await ctx.tick(TIMINGS.rebuildDebounce);
  assert.ok(ctx.store.data.boards.NEWBOARD);
  assert.ok(discovered(ctx.gladys, ext.relay(4, 'NEWBOARD')));
});

test('a CONNECT left unanswered twice with credentials: final stop, a reason each time', async (t) => {
  const ctx = await setup(t);
  ctx.broker.clients[0].unanswered();
  await settle();
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /closed the connection without answering/,
  );
  assert.equal(ctx.store.data, null, 'not yet');
  ctx.broker.clients[0].unanswered({ timeout: true });
  await settle();
  assert.equal(ctx.store.data.refused, true);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /no answer from the broker.*twice/);
  assert.equal(ctx.broker.clients[0].ended, true);
  await ctx.tick(3600_000);
  assert.equal(ctx.broker.clients.length, 1);
});

test('a CONNECT without credentials left unanswered: tried again, never stopped', async (t) => {
  const ctx = await setup(t, { cfg: { broker_url: '192.168.1.50' } });
  for (let i = 0; i < 3; i += 1) {
    ctx.broker.clients[0].unanswered();
    await settle();
  }
  assert.equal(ctx.store.data, null);
  assert.equal(ctx.broker.clients[0].ended, false);
});

test('a broker without MQTT 5: MQTT 3.1.1, said in the status', async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.broker.clients[0].options.protocolVersion, 5);
  const err = new Error('Connection refused: Unsupported Protocol Version');
  err.code = 132;
  ctx.broker.clients[0].emit('error', err);
  await settle();
  assert.equal(ctx.broker.clients.length, 2);
  assert.equal(ctx.broker.clients[0].ended, true);
  assert.equal(ctx.broker.clients[1].options.protocolVersion, 4);
  await online(ctx);
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /does not support MQTT 5/);
});

test('a relay taken by a shutter after a Scan: its own reason', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: '4' } });
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  client.deliver(topic.discovery(), discovery({}, { shutters: 3, boards: '11000000' }), {
    retain: true,
  });
  await ctx.tick(TIMINGS.rebuildDebounce);
  await ctx.gladys.fake.scanRequest();
  await settle();
  const ack = await command(ctx, relay, 'power', 1, { feature: relay.features[0] });
  assert.match(ack.error, /ne fait pas \(ou plus\) partie de la configuration acceptée/);
});

test('the transport badge turns local as soon as the board publishes', async (t) => {
  const ctx = await setup(t);
  const client = await online(ctx);
  const relay = await create(ctx, ext.relay(4));
  client.deliver(topic.sensor(), { temp: 30 });
  await settle();
  const last = ctx.gladys.fake.transports
    .filter((x) => x.device_external_id === relay.external_id)
    .at(-1);
  assert.equal(last.transport, DEVICE_TRANSPORTS.LOCAL);
});

test('a declared safe relay of an unknown board id is named in the status', async (t) => {
  const ctx = await setup(t, { cfg: { ...BASE, safe_outputs: 'E-BOARD-DD53AC85:5' } });
  await online(ctx);
  await ctx.tick(TIMINGS.statusRefresh);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /no accepted board has the id E-BOARD-DD53AC85/,
  );
});
