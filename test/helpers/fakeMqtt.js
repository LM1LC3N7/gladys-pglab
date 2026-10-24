// A fake mqtt.js client: what the app subscribed to and published, and the
// broker side (connect, deliver a message, refuse, fail). `responder` plays
// the Qbus gateway: it is called on every publish and may deliver answers.

import { EventEmitter } from 'node:events';

export class FakeMqttClient extends EventEmitter {
  constructor(config, responder) {
    super();
    this.config = config;
    this.responder = responder;
    this.connected = false;
    this.subscriptions = new Set();
    this.published = [];
    this.ended = false;
    this.publishError = undefined;
  }

  subscribe(topics, options, callback) {
    for (const topic of [].concat(topics)) {
      this.subscriptions.add(topic);
    }
    callback?.(null, []);
  }

  unsubscribe(topics) {
    for (const topic of [].concat(topics)) {
      this.subscriptions.delete(topic);
    }
  }

  publish(topic, payload, options, callback) {
    if (this.publishError) {
      callback?.(this.publishError);
      return;
    }
    this.published.push({ topic, payload: String(payload), ...options });
    this.responder?.(topic, String(payload), this);
    callback?.();
  }

  end() {
    this.ended = true;
    this.connected = false;
  }

  // --- The broker side ---
  open() {
    this.options?.onOpen?.();
    this.emit('packetsend', { cmd: 'connect' });
    this.emit('packetreceive', { cmd: 'connack' });
    this.connected = true;
    this.emit('connect');
  }

  close() {
    this.connected = false;
    this.emit('close');
  }

  /** The broker takes the CONNECT and closes (or times out) without CONNACK. */
  unanswered({ timeout = false } = {}) {
    this.options?.onAttempt?.();
    this.options?.onOpen?.();
    this.emit('packetsend', { cmd: 'connect' });
    if (timeout) {
      this.emit('error', new Error('connack timeout'));
    }
    this.connected = false;
    this.emit('close');
  }

  refuse(code = 5) {
    this.options?.onOpen?.();
    this.emit('packetsend', { cmd: 'connect' });
    this.emit('packetreceive', { cmd: 'connack' });
    const err = new Error('Connection refused: Not authorized');
    err.code = code;
    this.emit('error', err);
    this.emit('close');
  }

  deliver(topic, payload, packet = { retain: false }) {
    this.emit(
      'message',
      topic,
      Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
      packet,
    );
  }

  /** The commands sent to outputs (setState topics), parsed. */
  commands() {
    return this.published
      .filter((p) => p.topic.endsWith('/setState'))
      .map((p) => ({ topic: p.topic, body: JSON.parse(p.payload) }));
  }
}

/** A connect function for the app, keeping every client it creates. */
export function fakeConnector(responder) {
  const clients = [];
  const connector = {
    clients,
    responder,
    connect: (config, options = {}) => {
      const client = new FakeMqttClient(config, (...args) => connector.responder?.(...args));
      client.options = options;
      options.onAttempt?.();
      clients.push(client);
      return client;
    },
  };
  return connector;
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
