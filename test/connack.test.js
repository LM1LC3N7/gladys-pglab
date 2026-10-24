// -----------------------------------------------------------------------------
// The real mqtt.js (through src/mqtt.js) against local fake brokers
// (127.0.0.1, random port): CONNACK refusals, MQTT 5 and its fallback to
// 3.1.1, a CONNECT left unanswered, and a message too large for the guard.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PglabApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { MAX_PACKET, PacketGuard, connectBroker } from '../src/mqtt.js';
import { memoryStore } from '../src/store.js';

const require = createRequire(import.meta.url);
const mqttPacket = require('mqtt-packet');
const SECRET = 'S3cretPassw0rd';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake broker: `onConnect(packet, reply, socket)` answers each CONNECT. */
async function fakeBroker(onConnect) {
  const server = net.createServer((socket) => {
    server.connections_ += 1;
    const parser = mqttPacket.parser();
    parser.on('packet', (packet) => {
      if (packet.cmd === 'connect') {
        server.connects.push(packet);
        const reply = (p) =>
          socket.write(mqttPacket.generate(p, { protocolVersion: packet.protocolVersion }));
        onConnect(packet, reply, socket);
      }
    });
    socket.on('data', (data) => parser.parse(data));
    socket.on('error', () => {});
    socket.on('close', () => {
      server.closed += 1;
    });
  });
  server.connections_ = 0;
  server.closed = 0;
  server.connects = [];
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function run(t, server, { credentials = true, settleMs = 800 } = {}) {
  const cfg = {
    broker_url: `mqtt://127.0.0.1:${server.address().port}`,
    ...(credentials ? { username: 'gladys', password: SECRET } : {}),
  };
  const gladys = createFakeGladys({ config: cfg });
  const store = memoryStore(null);
  const logs = [];
  const log = (m) => logs.push(String(m));
  const app = new PglabApp({
    gladys,
    store,
    logger: { info: log, warn: log, error: log, debug: log },
    connect: (config, options) => connectBroker(config, { ...options, reconnectPeriod: 100 }),
  });
  registerHandlers(gladys, app);
  t.after(() => {
    app.stop();
    server.close();
  });
  await gladys.connect();
  await wait(settleMs);
  return { gladys, store, app, logs };
}

const refusing = (code) =>
  fakeBroker((packet, reply) =>
    reply(
      packet.protocolVersion === 5
        ? { cmd: 'connack', reasonCode: code, sessionPresent: false }
        : { cmd: 'connack', returnCode: code, sessionPresent: false },
    ),
  );

test('MQTT 5 with a maximum packet size of 8 KB', async (t) => {
  const server = await fakeBroker((packet, reply) =>
    reply({ cmd: 'connack', reasonCode: 0, sessionPresent: false }),
  );
  const { gladys } = await run(t, server);
  const connect = server.connects[0];
  assert.equal(connect.protocolVersion, 5);
  assert.equal(connect.properties.maximumPacketSize, MAX_PACKET);
  assert.match(gladys.fake.connectionStatus.message.en, /waiting for the PG LAB boards/);
});

test('CONNACK 136 (server unavailable) is tried again', async (t) => {
  const server = await refusing(136);
  const { store, gladys } = await run(t, server);
  assert.ok(server.connections_ >= 3, `${server.connections_} connection(s)`);
  assert.equal(store.data, null, 'no stop');
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable \(server unavailable\)/);
});

for (const code of [135, 134, 138]) {
  test(`CONNACK ${code}: a final stop, once, persisted, no secret`, async (t) => {
    const server = await refusing(code);
    const { store, gladys, app, logs } = await run(t, server, { settleMs: 1300 });
    assert.equal(server.connections_, 1);
    assert.equal(app.client, null);
    assert.equal(store.data.refused, true);
    const all = JSON.stringify([store.data, gladys.fake.connectionStatuses, logs]);
    assert.doesNotMatch(all, new RegExp(SECRET));
  });
}

test('a broker without MQTT 5 (CONNACK 1 of 3.1.1): MQTT 3.1.1, said in the status', async (t) => {
  const server = await fakeBroker((packet, reply, socket) =>
    packet.protocolVersion === 5
      ? socket.write(Buffer.from([0x20, 0x02, 0x00, 0x01]))
      : reply({ cmd: 'connack', returnCode: 0, sessionPresent: false }),
  );
  const { app } = await run(t, server);
  assert.deepEqual(
    server.connects.map((c) => c.protocolVersion),
    [5, 4],
  );
  assert.equal(app.client.connected, true);
  assert.equal(app.boardNotes().protocol3, true);
});

test('a broker closing after the CONNECT: final stop at the second time', async (t) => {
  const server = await fakeBroker((packet, reply, socket) => socket.destroy());
  const { store, gladys } = await run(t, server, { settleMs: 1500 });
  assert.equal(server.connects.length, 2, 'the password left twice, never more');
  assert.equal(store.data.refused, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /closed the connection without answering, twice/,
  );
});

test('without credentials, a broker closing after the CONNECT is tried again', async (t) => {
  const server = await fakeBroker((packet, reply, socket) => socket.destroy());
  const { store } = await run(t, server, { credentials: false, settleMs: 1200 });
  assert.ok(server.connects.length >= 3);
  assert.equal(store.data, null);
});

test('a message over 8 KB cuts the connection before it is read', async (t) => {
  let sent = 0;
  const server = await fakeBroker((packet, reply, socket) => {
    reply({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
    // A PUBLISH announcing 200 MB, then data as long as the socket takes it.
    socket.write(Buffer.from([0x30, 0x80, 0x80, 0xe8, 0x5f]));
    const chunk = Buffer.alloc(64 * 1024, 65);
    const pump = () => {
      if (!socket.destroyed && sent < 50 * 1024 * 1024) {
        sent += chunk.length;
        socket.write(chunk, pump);
      }
    };
    pump();
  });
  const before = process.memoryUsage().rss;
  const { gladys } = await run(t, server);
  assert.ok(sent < 20 * 1024 * 1024, `${sent} bytes pushed before the cut`);
  assert.ok(process.memoryUsage().rss - before < 100 * 1024 * 1024);
  assert.ok(server.closed >= 1);
  const messages = gladys.fake.connectionStatuses.map((s) => s.message?.en ?? '');
  assert.ok(
    messages.some((m) => /a message over 8 KB: connection cut/.test(m)),
    messages.join('\n'),
  );
});

test('the guard follows packets across chunks', async () => {
  const guard = new PacketGuard(100);
  const out = [];
  guard.on('data', (c) => out.push(c));
  const errors = [];
  guard.on('error', (e) => errors.push(e));
  // Two small packets split anywhere, then one announcing 200 bytes.
  const small = Buffer.from([0x30, 0x03, 1, 2, 3]);
  const stream = Buffer.concat([small, small]);
  guard.write(stream.subarray(0, 1));
  guard.write(stream.subarray(1, 7));
  guard.write(stream.subarray(7));
  assert.equal(Buffer.concat(out).length, 10);
  assert.equal(errors.length, 0);
  guard.write(Buffer.from([0x30, 0xc8]));
  guard.write(Buffer.from([0x01]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'PACKET_TOO_LARGE');
});

test('an unreachable broker (connection refused) is tried again, never stopped', async (t) => {
  const server = await fakeBroker(() => {});
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const fake = { address: () => ({ port }), close() {} };
  const { store, gladys } = await run(t, fake, { settleMs: 1200 });
  assert.equal(store.data, null);
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable \(ECONNREFUSED\)/);
});
