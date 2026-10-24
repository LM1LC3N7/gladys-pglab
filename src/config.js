// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password of
// the broker is kept here and in the MQTT client only: never logged, never in
// /data, never in a status or an error.
// -----------------------------------------------------------------------------

import { LIMITS, SENSOR_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  broker_url: '',
  username: '',
  password: '',
  verify_certificate: true,
  safe_outputs: '',
  allow_output_buttons: false,
  sensor_interval: SENSOR_INTERVAL.default,
  language: 'fr',
};

const SCHEMES = ['mqtt:', 'mqtts:', 'ws:', 'wss:', 'tcp:', 'ssl:'];

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';
/** Only `false` (or the text "false") turns off: a missing value keeps the safe default. */
const strictFalse = (value) => value === false || value === 'false';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The broker URL, completed: "192.168.1.10" -> "mqtt://192.168.1.10".
 * @returns {{ url: string } | { error: string }}
 */
export function parseBrokerUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { error: 'empty' };
  }
  if (text.length > 300) {
    return { error: 'invalid' };
  }
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `mqtt://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (!SCHEMES.includes(url.protocol) || !url.hostname) {
    return { error: 'invalid' };
  }
  if (url.username || url.password) {
    // Credentials belong to their own fields (the secret one is never shown again).
    return { error: 'credentials' };
  }
  return { url: url.toString().replace(/\/$/, '') };
}

/** At most this many entries in "Relays declared safe". */
export const SAFE_OUTPUTS_MAX = 500;

/**
 * The relays declared safe to switch: `<relay>` (the PGLAB_RELAY parameter of
 * the Discovery tab; it counts ONLY when a single board is known, relays
 * being numbered per board) or `<board id>:<relay>` (the PGLAB_ID
 * parameter), separated by commas, spaces or new lines. Anything else is
 * ignored and counted in `invalid` (never shown back: something else may
 * have been pasted there).
 */
export function parseSafeOutputs(raw) {
  const safe = new Set();
  let invalid = 0;
  const text = typeof raw === 'string' ? raw.slice(0, 20_000) : '';
  for (const entry of text.split(/[\s,;]+/)) {
    if (entry === '') {
      continue;
    }
    const match = /^(?:([A-Za-z0-9_-]{1,64}):)?(0|[1-9]\d?)$/.exec(entry);
    if (!match || Number(match[2]) >= LIMITS.relays || safe.size >= SAFE_OUTPUTS_MAX) {
      invalid += 1;
      continue;
    }
    safe.add(match[1] === undefined ? match[2] : `${match[1]}:${match[2]}`);
  }
  return { safe, invalid };
}

/**
 * Whether a relay (its board id and number) is declared safe. A number
 * without a board id counts only when a single board is known (`single`):
 * with several, "5" would make safe the relay 5 of every board.
 */
export const isSafeOutput = (safeOutputs, boardId, relay, { single = false } = {}) =>
  (single && safeOutputs.has(String(relay))) || safeOutputs.has(`${boardId}:${relay}`);

/** The entries without a board id: ambiguous, so applied nowhere, with several boards. */
export const ambiguousOutputs = (safeOutputs, single) =>
  single ? [] : [...safeOutputs].filter((entry) => !entry.includes(':'));

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value !== null && value !== undefined) {
      c[key] = value;
    }
  }
  const broker = parseBrokerUrl(c.broker_url);
  const interval = numberOf(c.sensor_interval);
  const password = typeof c.password === 'string' ? c.password : '';
  const outputs = parseSafeOutputs(c.safe_outputs);
  let problem = broker.error ? `broker:${broker.error}` : undefined;
  if (!problem && password.length > 1024) {
    problem = 'password';
  }
  return {
    /** Why the configuration cannot be used (shown in the status), else undefined. */
    problem,
    brokerUrl: broker.url,
    username: typeof c.username === 'string' ? c.username.trim().slice(0, 256) : '',
    password: problem ? '' : password,
    // TLS certificates are checked unless the user turns it off.
    verifyCertificate: !strictFalse(c.verify_certificate),
    safeOutputs: outputs.safe,
    invalidOutputs: outputs.invalid,
    allowOutputButtons: strictTrue(c.allow_output_buttons),
    sensorInterval:
      interval === undefined
        ? SENSOR_INTERVAL.default
        : Math.min(SENSOR_INTERVAL.max, Math.max(SENSOR_INTERVAL.min, Math.round(interval))),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What a reconnection to the broker depends on (compared in memory only, never stored). */
export const connectionKey = (config) =>
  JSON.stringify([
    config.problem ?? null,
    config.brokerUrl ?? null,
    config.username,
    config.password,
    config.verifyCertificate,
  ]);

/** The broker and the credentials only: other ones lift the stop on refused credentials. */
export const credentialsKey = (config) =>
  JSON.stringify([config.brokerUrl ?? null, config.username, config.password]);
