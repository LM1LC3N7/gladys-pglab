// -----------------------------------------------------------------------------
// The PG LAB MQTT protocol, ported from pypglab 0.0.5 (MIT, PG LAB
// Electronics: const.py, device.py, validation.py, entity.py, relay.py,
// shutter.py, sensor.py) and from the discovery of Home Assistant's PG LAB
// integration (Apache-2.0: discovery.py). Pure: topics, parsers, messages.
//
// Topics (the board publishes, the integration only sends the `set` ones):
//   pglab/discovery/<id>/config        the board: { id, name, type, mac, ip,
//                                      manufacturer, hw, fw, params }
//   pglab/<name>/relay/<n>/state       "ON" | "OFF"
//   pglab/<name>/relay/<n>/set         "ON" | "OFF"            (command)
//   pglab/<name>/shutter/<n>/state     "OPENING" | "OPEN" | "CLOSING" | "CLOSED"
//   pglab/<name>/shutter/<n>/set       "OPEN" | "CLOSE" | "STOP" (command)
//   pglab/<name>/sensor/value          { temp, volt, rtime }
//
// Everything received is untrusted (anybody allowed on the broker may
// publish): payloads read bounded, the topic matched exactly (fixed number
// of levels, the index a plain number), the id of the discovery topic
// checked against the id of its payload, the name checked before it goes
// into a topic (no MQTT wildcard, no slash, no control character), only own
// keys of plain objects read, every value type-checked.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEVICE_TYPES, LIMITS, MANUFACTURER, TOPIC_PREFIX } from './constants.js';

export const TOPICS = {
  discovery: (id) => `${TOPIC_PREFIX}/discovery/${id}/config`,
  relayState: (name, index) => `${TOPIC_PREFIX}/${name}/relay/${index}/state`,
  relaySet: (name, index) => `${TOPIC_PREFIX}/${name}/relay/${index}/set`,
  shutterState: (name, index) => `${TOPIC_PREFIX}/${name}/shutter/${index}/state`,
  shutterSet: (name, index) => `${TOPIC_PREFIX}/${name}/shutter/${index}/set`,
  sensor: (name) => `${TOPIC_PREFIX}/${name}/sensor/value`,
};

/** What the integration subscribes to: nothing else ever reaches it. */
export const SUBSCRIPTIONS = [
  `${TOPIC_PREFIX}/discovery/+/config`,
  `${TOPIC_PREFIX}/+/relay/+/state`,
  `${TOPIC_PREFIX}/+/shutter/+/state`,
  `${TOPIC_PREFIX}/+/sensor/value`,
];

/** A board id, as it goes into a topic and an external id: letters, digits, "_" and "-". */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A board name, as it goes into a topic: no "/", "+", "#", no control character, no edge space. */
const NAME = /^[A-Za-z0-9_.-](?:[A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-])?$/;
const MAC =
  /^([0-9a-fA-F]{2})[-:]([0-9a-fA-F]{2})[-:]([0-9a-fA-F]{2})[-:]([0-9a-fA-F]{2})[-:]([0-9a-fA-F]{2})[-:]([0-9a-fA-F]{2})$/;
/** pypglab: "^([0-9]+)\.([0-9]+)\.([0-9]+)?$", bounded. */
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{0,6}$/;
const BOARDS = /^[01]{8}$/;
/** A relay or shutter number in a topic: 0 to 63, no leading zero, no sign. */
const INDEX = /^(?:0|[1-9]\d?)$/;

export const isId = (value) => typeof value === 'string' && ID.test(value);
export const isName = (value) =>
  typeof value === 'string' && NAME.test(value) && value !== 'discovery';

export const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** An own key of a plain object, else undefined. */
export const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A payload as text, bounded; `{ error }` when empty or too large. */
export function payloadText(payload, maxBytes) {
  if (payload === undefined || payload === null || payload.length === 0) {
    return { error: 'empty' };
  }
  if (payload.length > maxBytes) {
    return { error: 'too large' };
  }
  return { text: Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload) };
}

/** A parsed JSON object payload, bounded. */
export function parseJsonObject(payload, maxBytes) {
  const read = payloadText(payload, maxBytes);
  if (read.error) {
    return read;
  }
  let value;
  try {
    value = JSON.parse(read.text);
  } catch {
    return { error: 'not JSON' };
  }
  return isObject(value) ? { value } : { error: 'not an object' };
}

/**
 * A topic the integration subscribed to, matched exactly; undefined for
 * anything else (a deeper or shorter topic, an index such as "01" or "64").
 */
export function parseTopic(topic) {
  if (typeof topic !== 'string' || topic.length > 200) {
    return undefined;
  }
  const parts = topic.split('/');
  if (parts[0] !== TOPIC_PREFIX) {
    return undefined;
  }
  if (parts.length === 4 && parts[1] === 'discovery' && parts[3] === 'config') {
    return isId(parts[2]) ? { kind: 'discovery', id: parts[2] } : undefined;
  }
  if (!isName(parts[1])) {
    return undefined;
  }
  if (parts.length === 4 && parts[2] === 'sensor' && parts[3] === 'value') {
    return { kind: 'sensor', name: parts[1] };
  }
  if (
    parts.length === 5 &&
    (parts[2] === 'relay' || parts[2] === 'shutter') &&
    parts[4] === 'state' &&
    INDEX.test(parts[3])
  ) {
    const index = Number(parts[3]);
    const max = parts[2] === 'relay' ? LIMITS.relays : LIMITS.shutters;
    return index < max ? { kind: parts[2], name: parts[1], index } : undefined;
  }
  return undefined;
}

/** "AA-bb-..." -> "aa:bb:...", or undefined. */
export function normalizeMac(value) {
  const match = typeof value === 'string' ? MAC.exec(value) : null;
  return match ? match.slice(1).join(':').toLowerCase() : undefined;
}

/**
 * The relays and shutters an E-Board drives (pypglab Device.config): shutter
 * n uses the relays 2n and 2n+1 and exists when their extension board is
 * connected; the relays come after the shutters (2 x shutters to 63), each
 * when its extension board (8 relays) is connected.
 */
export function layoutOf({ shutters, boards }) {
  const connected = (relay) => boards[Math.floor(relay / 8)] === '1';
  const shutterList = [];
  for (let n = 0; n < shutters; n += 1) {
    if (connected(2 * n)) {
      shutterList.push(n);
    }
  }
  const relayList = [];
  for (let n = 2 * shutters; n < LIMITS.relays; n += 1) {
    if (connected(n)) {
      relayList.push(n);
    }
  }
  return { shutters: shutterList, relays: relayList };
}

/**
 * A discovery message, checked as pypglab does (every field required, the
 * manufacturer exact) and more: the id of the topic must be the id of the
 * payload, the name must be usable in a topic.
 * @returns {{ board } | { error }}
 */
export function parseDiscovery(topicId, payload) {
  const parsed = parseJsonObject(payload, LIMITS.discoveryBytes);
  if (parsed.error) {
    return parsed;
  }
  const raw = parsed.value;
  const id = own(raw, 'id');
  if (!isId(id)) {
    return { error: 'invalid id' };
  }
  if (id !== topicId) {
    return { error: 'id of the payload differs from the topic' };
  }
  const name = own(raw, 'name');
  if (!isName(name)) {
    return { error: 'name not usable in a topic' };
  }
  const typeText = own(raw, 'type');
  const type =
    typeof typeText === 'string'
      ? DEVICE_TYPES.find((t) => t.toLowerCase() === typeText.toLowerCase())
      : undefined;
  if (!type) {
    return { error: 'unknown type' };
  }
  if (own(raw, 'manufacturer') !== MANUFACTURER) {
    return { error: 'unexpected manufacturer' };
  }
  const mac = normalizeMac(own(raw, 'mac'));
  if (!mac) {
    return { error: 'invalid MAC address' };
  }
  const ip = own(raw, 'ip');
  if (typeof ip !== 'string' || ip.length > 45 || isIP(ip) === 0) {
    return { error: 'invalid IP address' };
  }
  const hw = own(raw, 'hw');
  const fw = own(raw, 'fw');
  if (typeof hw !== 'string' || !VERSION.test(hw) || typeof fw !== 'string' || !VERSION.test(fw)) {
    return { error: 'invalid version' };
  }
  const board = { id, name, type, mac, ip, hw, fw, layout: undefined };
  if (type === 'E-BOARD') {
    const params = own(raw, 'params');
    const shutters = own(params, 'shutters');
    const boards = own(params, 'boards');
    if (!Number.isInteger(shutters) || shutters < 0 || shutters > LIMITS.shutters) {
      return { error: 'invalid number of shutters' };
    }
    if (typeof boards !== 'string' || !BOARDS.test(boards)) {
      return { error: 'invalid boards' };
    }
    board.layout = { shutters, boards };
  }
  return { board };
}

/** A relay state: true (ON), false (OFF), or undefined. */
export function parseRelayState(payload) {
  const read = payloadText(payload, LIMITS.stateBytes);
  if (read.error) {
    return undefined;
  }
  return read.text === 'ON' ? true : read.text === 'OFF' ? false : undefined;
}

export const SHUTTER_STATES = ['OPENING', 'OPEN', 'CLOSING', 'CLOSED'];

/** A shutter state ("OPENING", "OPEN", "CLOSING", "CLOSED"), or undefined. */
export function parseShutterState(payload) {
  const read = payloadText(payload, LIMITS.stateBytes);
  return !read.error && SHUTTER_STATES.includes(read.text) ? read.text : undefined;
}

const SENSOR_RANGES = {
  temp: [-40, 125],
  volt: [0, 60],
};

/**
 * The status sensor of a board: { temp, volt } (each a finite number within
 * a plausible range, or undefined), or `{ error }`.
 */
export function parseSensor(payload) {
  const parsed = parseJsonObject(payload, LIMITS.stateBytes);
  if (parsed.error) {
    return parsed;
  }
  const values = {};
  const outOfRange = [];
  for (const [key, [low, high]] of Object.entries(SENSOR_RANGES)) {
    const value = own(parsed.value, key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value >= low && value <= high) {
        values[key] = value;
      } else {
        outOfRange.push(key);
      }
    }
  }
  return { values, outOfRange };
}

/** A command message: a relay ("ON" / "OFF") or a shutter ("OPEN" / "CLOSE" / "STOP"). */
export function commandMessage(name, kind, index, payload) {
  if (!isName(name) || !Number.isInteger(index) || index < 0 || index >= LIMITS.relays) {
    throw new Error('invalid command target');
  }
  const allowed = kind === 'relay' ? ['ON', 'OFF'] : ['OPEN', 'CLOSE', 'STOP'];
  if (!allowed.includes(payload)) {
    throw new Error('invalid command');
  }
  const topic = kind === 'relay' ? TOPICS.relaySet(name, index) : TOPICS.shutterSet(name, index);
  return { topic, payload };
}
