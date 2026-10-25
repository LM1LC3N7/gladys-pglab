// -----------------------------------------------------------------------------
// The MQTT connection to the broker of the user (Mosquitto, the broker of
// Gladys...): the only network access of the integration, and a single
// session at a time (src/app.js ends the previous client before a new one;
// the test button uses that same session).
//
// mqtt.js over a TCP or TLS socket built here, for two reasons:
//   - every packet the broker sends is bounded BEFORE it is buffered: the
//     fixed header announces its length, and a packet over 8 KB cuts the
//     connection at once (a retained message of 200 MB would otherwise be
//     read in full, again on every connection, and kill the container);
//   - MQTT 5 with `maximumPacketSize: 8192`: a broker that honours it (as
//     Mosquitto does) drops such a message instead of sending it, so the
//     connection is not even cut. A broker without MQTT 5 is used in 3.1.1
//     (src/app.js says so in the status); the guard still applies.
// The client reconnects by itself while the broker is unreachable; a
// refusal of the credentials stops it for good (src/app.js).
// Nothing is ever queued while offline (queueQoSZero: false): a command
// either leaves now or is refused.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import net, { isIP } from 'node:net';
import { Duplex, Transform } from 'node:stream';
import tls from 'node:tls';
import { MqttClient } from 'mqtt';
import { TIMINGS } from './constants.js';

/** The largest packet accepted from the broker (a discovery is a few hundred bytes). */
export const MAX_PACKET = 8192;

/** MQTT 3.1.1 / 5 CONNACK refusals worth a precise message. */
export const REFUSALS = {
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized',
  128: 'unspecified error',
  132: 'unsupported protocol version',
  133: 'client identifier not valid',
  134: 'bad user name or password',
  135: 'not authorized',
  136: 'server unavailable',
  137: 'server busy',
  138: 'banned',
};

/**
 * Cuts the stream as soon as a packet header announces more than `max`
 * bytes (or is malformed): the rest is never buffered. Packets are tracked
 * across chunks (header bytes, then the body skipped).
 */
export class PacketGuard extends Transform {
  constructor(max = MAX_PACKET) {
    super();
    this.max = max;
    this.skip = 0;
    this.header = [];
  }

  _transform(chunk, _encoding, callback) {
    let i = 0;
    // Where the packet being refused starts in this chunk: the packets before
    // it (a CONNACK in the same chunk...) are still delivered before the cut.
    let start = 0;
    const cut = (message) => {
      if (start > 0) {
        this.push(chunk.subarray(0, start));
      }
      callback(guardError(message));
    };
    while (i < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - i);
        this.skip -= n;
        i += n;
        continue;
      }
      if (this.header.length === 0) {
        start = i;
      }
      this.header.push(chunk[i]);
      i += 1;
      if (this.header.length === 1) {
        continue;
      }
      const last = this.header[this.header.length - 1];
      if (last & 0x80) {
        if (this.header.length >= 5) {
          return cut('malformed packet length');
        }
        continue;
      }
      let length = 0;
      let factor = 1;
      for (let k = 1; k < this.header.length; k += 1) {
        length += (this.header[k] & 0x7f) * factor;
        factor *= 128;
      }
      if (length + this.header.length > this.max) {
        return cut(`a message over ${this.max / 1024} KB`);
      }
      this.skip = length;
      this.header = [];
    }
    return callback(null, chunk);
  }
}

function guardError(message) {
  const err = new Error(message);
  err.code = 'PACKET_TOO_LARGE';
  return err;
}

/**
 * The socket to the broker, its incoming side behind the guard. `onOpen`
 * is called once the transport is open: TCP connected, or TLS connected and
 * its certificate accepted (only then may the credentials leave).
 */
export function guardedStream(config, { onOpen } = {}) {
  const options = { host: config.host, port: config.port };
  const socket = config.tls
    ? tls.connect({
        ...options,
        rejectUnauthorized: config.verifyCertificate,
        ...(isIP(config.host) === 0 ? { servername: config.host } : {}),
      })
    : net.connect(options);
  socket.once(config.tls ? 'secureConnect' : 'connect', () => onOpen?.());
  const guard = new PacketGuard();
  socket.pipe(guard);
  const stream = new Duplex({
    read() {
      guard.resume();
    },
    write(chunk, _encoding, callback) {
      socket.write(chunk, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(err, callback) {
      socket.destroy();
      guard.destroy();
      callback(err);
    },
  });
  guard.on('data', (chunk) => {
    if (!stream.push(chunk)) {
      guard.pause();
    }
  });
  guard.on('end', () => stream.push(null));
  guard.on('error', (err) => stream.destroy(err));
  socket.on('error', (err) => stream.destroy(err));
  socket.on('close', () => stream.destroy());
  return stream;
}

export function connectBroker(
  config,
  {
    protocolVersion = 5,
    reconnectPeriod = TIMINGS.reconnectPeriod,
    connectTimeout = TIMINGS.connectTimeout,
    onAttempt,
    onOpen,
    streamBuilder = () => {
      onAttempt?.();
      return guardedStream(config, { onOpen });
    },
  } = {},
) {
  return new MqttClient(streamBuilder, {
    username: config.username || undefined,
    password: config.password || undefined,
    // A random client id: two instances (a test and a restart) never kick each other out.
    clientId: `gladys_pglab_${randomBytes(4).toString('hex')}`,
    clean: true,
    keepalive: 60,
    connectTimeout,
    reconnectPeriod,
    // A CONNACK refusal is tried again like an unreachable broker, except the
    // credentials (src/app.js ends the client for good) and the protocol
    // version (src/app.js falls back to 3.1.1).
    reconnectOnConnackError: true,
    protocolVersion,
    ...(protocolVersion === 5 ? { properties: { maximumPacketSize: MAX_PACKET } } : {}),
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
  if (err.code === 'PACKET_TOO_LARGE') {
    return `the broker sent ${err.message}: connection cut`;
  }
  if (typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code)) {
    return err.code;
  }
  return String(err.message ?? err)
    .replace(/\/\/[^@/\s]*@/g, '//')
    .slice(0, 120);
}

/** The broker refused the credentials (or the client is not allowed). */
export const isRefusal = (err) =>
  err?.code !== undefined && [4, 5, 134, 135, 138].includes(err.code);

/** The broker does not speak MQTT 5 (3.1.1 brokers answer 1, MQTT 5 ones 132). */
export const isProtocolRefusal = (err) => err?.code === 1 || err?.code === 132;

/** The broker rejected the client identifier (counted like a CONNECT left unanswered). */
export const isIdentifierRefusal = (err) => err?.code === 2 || err?.code === 133;
