// -----------------------------------------------------------------------------
// The real mqtt.js against a local fake broker (127.0.0.1, random port) that
// answers CONNACK with a refusal code: 1-3 are tried again like an
// unreachable broker, 4-5 (credentials) stop the client for good, persisted.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PglabApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { connectBroker } from '../src/mqtt.js';
import { memoryStore } from '../src/store.js';

const require = createRequire(import.meta.url);
const mqttPacket = require('mqtt-packet');

async function refusingBroker(returnCode) {
  const server = net.createServer((socket) => {
    server.connections_ += 1;
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    parser.on('packet', (packet) => {
      if (packet.cmd === 'connect') {
        socket.write(mqttPacket.generate({ cmd: 'connack', returnCode, sessionPresent: false }));
      }
    });
    socket.on('data', (data) => parser.parse(data));
    socket.on('error', () => {});
  });
  server.connections_ = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function run(t, returnCode) {
  const server = await refusingBroker(returnCode);
  const cfg = {
    broker_url: `mqtt://127.0.0.1:${server.address().port}`,
    username: 'gladys',
    password: 'S3cretPassw0rd',
  };
  const gladys = createFakeGladys({ config: cfg });
  const store = memoryStore(null);
  const app = new PglabApp({
    gladys,
    store,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connect: (config) => connectBroker(config, { reconnectPeriod: 100 }),
  });
  registerHandlers(gladys, app);
  t.after(() => {
    app.stop();
    server.close();
  });
  await gladys.connect();
  await new Promise((resolve) => setTimeout(resolve, 800));
  return { server, gladys, store, app };
}

test('CONNACK 3 (server unavailable) is tried again', async (t) => {
  const { server, store, gladys } = await run(t, 3);
  assert.ok(server.connections_ >= 3, `${server.connections_} connection(s)`);
  assert.equal(store.data, null, 'no stop');
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable \(server unavailable\)/);
});

test('CONNACK 5 (not authorized) stops, once, persisted, no secret', async (t) => {
  const { server, store, gladys, app } = await run(t, 5);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(server.connections_, 1);
  assert.equal(app.client, null);
  assert.equal(store.data.refused, true);
  const all = JSON.stringify([store.data, gladys.fake.connectionStatuses]);
  assert.doesNotMatch(all, /S3cretPassw0rd/);
});
