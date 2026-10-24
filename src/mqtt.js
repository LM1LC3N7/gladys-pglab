// -----------------------------------------------------------------------------
// The MQTT connection to the broker of the user (Mosquitto, the broker of
// Gladys...): the only network access of the integration, and a single
// session at a time (src/app.js ends the previous client before a new one;
// the test button uses that same session).
//
// A thin factory over mqtt.js, so the tests can hand a fake client to the
// app. The client reconnects by itself while the broker is unreachable; a
// refusal of the credentials stops it for good (src/app.js).
// Nothing is ever queued while offline (queueQoSZero: false): a command
// either leaves now or is refused, it never leaves minutes later.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import mqtt from 'mqtt';
import { TIMINGS } from './constants.js';

/** MQTT 3.1.1 / 5 CONNACK refusals worth a precise message. */
export const REFUSALS = {
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized',
  134: 'bad user name or password',
  135: 'not authorized',
};

export function connectBroker(
  config,
  { connect = mqtt.connect, reconnectPeriod = TIMINGS.reconnectPeriod } = {},
) {
  return connect(config.brokerUrl, {
    username: config.username || undefined,
    password: config.password || undefined,
    // A random client id: two instances (a test and a restart) never kick each other out.
    clientId: `gladys_pglab_${randomBytes(4).toString('hex')}`,
    clean: true,
    keepalive: 60,
    connectTimeout: TIMINGS.connectTimeout,
    reconnectPeriod,
    // A CONNACK refusal (1-3: protocol, identifier, server unavailable) is tried
    // again like an unreachable broker; 4, 5, 134 and 135 (credentials) end the
    // client in src/app.js, for good.
    reconnectOnConnackError: true,
    rejectUnauthorized: config.verifyCertificate,
    protocolVersion: 4,
    resubscribe: false,
    queueQoSZero: false,
  });
}

/** A readable reason for a connection error (never the password). */
export function errorReason(err) {
  if (!err) {
    return 'unknown error';
  }
  if (err.code !== undefined && REFUSALS[err.code]) {
    return REFUSALS[err.code];
  }
  if (typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code)) {
    return err.code;
  }
  return String(err.message ?? err)
    .replace(/\/\/[^@/\s]*@/g, '//')
    .slice(0, 120);
}

/** The broker refused the credentials (or the client is not allowed). */
export const isRefusal = (err) => err?.code !== undefined && [4, 5, 134, 135].includes(err.code);
