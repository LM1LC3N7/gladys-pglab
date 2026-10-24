// -----------------------------------------------------------------------------
// The integration: ONE session with the MQTT broker of the user, where the
// PG LAB boards publish; their discoveries turned into Gladys devices
// (src/model.js); the states they publish, sent within the Gladys rate
// limit; the commands sent back; the transport badges and the "Test the
// connection" button. index.js only wires the SDK handlers (src/handlers.js).
//
// Failures (lessons of the previous waves):
//   - credentials refused by the broker: the client stops for good, a stop
//     persisted in /data, no automatic new try (not even after a restart);
//     saving other credentials or "Test the connection" tries again, and the
//     stop is lifted only once a connection succeeded;
//   - broker unreachable: mqtt.js tries again every 10 s (a local broker);
//   - a reconnection to Gladys keeps the MQTT client and the stop, and only
//     re-sends the status, the Discovery and the badges;
//   - what is known of the boards belongs to one broker session: emptied on
//     every connection, filled again by the retained discoveries.
//
// What a board publishes is never trusted to make something commandable:
//   - a relay is a switch only when the user declared it safe; otherwise a
//     read-only state and buttons, off by default;
//   - the layout (shutters, relays) and the MAC of a board are the ones the
//     user accepted (/data): the first discovery of an unknown board, or a
//     Scan in the Discovery tab. A discovery that changes them is not
//     applied; until a Scan, its relays and the opening of its shutters are
//     refused (stop and close are not);
//   - two boards with the same name (their topics are the same): their
//     states are ignored and every command but a stop refused.
//
// Commands: one message, never queued while the broker is down (a command
// leaves now or is refused), sent within 3.5 s of the click or refused
// unsent, confirmed by the state the board publishes back by 4.3 s, else
// "sent, without confirmation". Nothing ever waits in front of a stop.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { ambiguousOutputs, connectionKey, credentialsKey, normalizeConfig } from './config.js';
import { LIMITS, TIMINGS } from './constants.js';
import { ERRORS, T, TEST, word } from './i18n.js';
import { CommandRefusal, buildModel } from './model.js';
import { connectBroker, errorReason, isRefusal } from './mqtt.js';
import {
  SUBSCRIPTIONS,
  commandMessage,
  parseDiscovery,
  parseRelayState,
  parseSensor,
  parseShutterState,
  parseTopic,
} from './protocol.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, serializeMemory } from './store.js';

/** Publishes on the broker, as a promise (mqtt.js uses a callback). Never queued offline. */
const publish = (client, topic, payload) =>
  new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 0, retain: false }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

/** The layout of a discovery, as kept in /data. */
const layoutRecord = (board) => ({
  mac: board.mac,
  shutters: board.layout ? board.layout.shutters : null,
  boards: board.layout ? board.layout.boards : null,
});

/** A monotonic clock: the waits and silences never move with the wall clock. */
const monotonic = () => performance.now();

export class PglabApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'pglab' }),
    connect = connectBroker,
    now = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.config = normalizeConfig();
    this.connKey = undefined;
    this.credKey = undefined;
    this.memory = undefined;
    this.client = null;
    this.generation = 0;
    this.started = false;
    this.resetSession();
    this.model = buildModel({ boards: [] });
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    /** deviceId -> transport last published */
    this.transports = new Map();
    /** featureId -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    this.timersById = {};
    this.waiters = new Set();
    this.warned = new Set();
    this.lastTest = -Infinity;
    this.lastError = undefined;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
  }

  /** What belongs to one broker session: back to "unknown" on every connection. */
  resetSession() {
    /** board id -> the board of its latest valid discovery in this session */
    this.boards = new Map();
    /** board id -> when it last published something useful (not retained) */
    this.lastSeen = new Map();
    /** discovery messages refused in this session */
    this.rejected = 0;
    /** no board announced itself within the wait after the connection */
    this.silentBroker = false;
  }

  // --- Memory (/data) ----------------------------------------------------------

  async loadMemory() {
    if (!this.memory) {
      this.memory = normalizeMemory(await this.store.load().catch(() => null));
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(serializeMemory(this.memory));
    } catch (err) {
      this.logger.warn(`Saving the state in /data failed: ${err.message}`);
    }
  }

  // --- Timers ------------------------------------------------------------------

  later(name, delay, fn) {
    this.timers.clearTimeout(this.timersById[name]);
    const generation = this.generation;
    this.timersById[name] = this.timers.setTimeout(() => {
      this.timersById[name] = undefined;
      if (generation === this.generation) {
        Promise.resolve()
          .then(fn)
          .catch((err) => this.logger.error(`${name} failed: ${err.message}`));
      }
    }, delay);
  }

  clearTimers() {
    for (const id of Object.values(this.timersById)) {
      this.timers.clearTimeout(id);
    }
    this.timersById = {};
  }

  // --- Lifecycle -----------------------------------------------------------------

  /** Gladys (re)connected: the status, the Discovery and the badges again, the client kept. */
  async gladysConnected(raw) {
    const next = normalizeConfig(raw);
    if (this.started && connectionKey(next) === this.connKey) {
      this.applySoft(next, raw);
      this.lastStatus = undefined;
      this.publishedDevices = undefined;
      this.transports.clear();
      this.refreshCreated();
      // The last status again (connecting, lost, a stop...), then what is known now.
      if (this.lastStatusArgs) {
        await this.setStatus(...this.lastStatusArgs);
      }
      await this.updateStatus();
      await this.rebuild({ force: true });
      return;
    }
    await this.start(raw);
  }

  /** Saved by the user: options apply at once; a new broker or new credentials reconnect. */
  async configUpdated(raw) {
    const next = normalizeConfig(raw);
    if (this.started && connectionKey(next) === this.connKey) {
      const before = this.config;
      this.applySoft(next, raw);
      if (
        before.language !== next.language ||
        [...before.safeOutputs].sort().join() !== [...next.safeOutputs].sort().join()
      ) {
        // Names, or which relays are switches: the devices are built again.
        await this.rebuild();
      } else {
        await this.updateStatus();
      }
      return;
    }
    await this.start(raw);
  }

  applySoft(next, raw) {
    // The raw configuration too: a later restart (the test button) uses the latest one.
    this.rawConfig = raw ?? {};
    this.config = next;
    this.publisher.configure({
      intervalSeconds: next.sensorInterval,
      throttled: this.model.throttled,
    });
  }

  /**
   * (Re)starts the single session. `force`: the user asked (test button),
   * so a stop on refused credentials does not hold it.
   */
  async start(raw = {}, { force = false } = {}) {
    await this.loadMemory();
    this.stop();
    this.started = true;
    this.rawConfig = raw ?? {};
    this.config = normalizeConfig(raw);
    this.connKey = connectionKey(this.config);
    this.wasConnected = false;
    this.lastError = undefined;
    const credentials = credentialsKey(this.config);
    if (this.credKey !== undefined && credentials !== this.credKey && this.memory.refused) {
      // Other credentials (or another broker): the stop on the refused ones is lifted.
      this.memory.refused = false;
      await this.saveMemory();
    }
    this.credKey = credentials;
    this.resetSession();
    this.model = buildModel({ boards: [] });
    this.publishedDevices = undefined;
    this.lastStatus = undefined;
    this.transports.clear();
    this.lastValues.clear();
    this.refreshCreated();
    if (this.config.problem) {
      await this.setStatus(false, T.problem(this.config.problem));
      return;
    }
    if (this.memory.refused && !force) {
      await this.setStatus(false, T.stopped);
      return;
    }
    await this.connectNow();
  }

  async connectNow() {
    const generation = this.generation;
    await this.setStatus(false, T.connecting);
    if (generation !== this.generation) {
      return;
    }
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: this.model.throttled,
    });
    this.publisher.start();
    // One session only: the previous client was ended by stop().
    let client;
    try {
      client = this.connect(this.config);
    } catch (err) {
      this.lastError = errorReason(err);
      await this.setStatus(false, T.unreachable(this.lastError));
      return;
    }
    this.client = client;
    const current = () => generation === this.generation && this.client === client;
    client.on('connect', () => {
      if (current()) {
        this.onConnect().catch((err) => this.logger.error(`After connection: ${err.message}`));
      }
    });
    client.on('message', (topic, payload, packet) => {
      if (current()) {
        this.onMessage(topic, payload, packet);
      }
    });
    client.on('error', (err) => {
      if (!current()) {
        return;
      }
      const reason = errorReason(err);
      this.lastError = reason;
      if (isRefusal(err)) {
        this.onRefused(reason).catch((e) => this.logger.error(`After a refusal: ${e.message}`));
        return;
      }
      this.warnOnce(`broker:${reason}`, `MQTT broker: ${reason}`);
      this.notify('session', { error: reason }, { all: true });
      this.setStatus(false, T.unreachable(reason));
    });
    client.on('close', () => {
      if (current() && this.wasConnected) {
        this.failWaiters();
        // The boards are unknown until the next session announces them again.
        this.resetSession();
        this.setStatus(false, T.lost);
        this.publishAllTransports().catch(() => {});
      }
    });
  }

  /** The broker refused the credentials: stop for good (persisted), no automatic new try. */
  async onRefused(reason) {
    this.logger.warn(`MQTT broker refused the connection: ${reason}`);
    // The test button learns why before the waiters of the session are settled.
    this.notify('session', { refused: reason }, { all: true });
    this.endClient();
    this.publisher.stop();
    this.memory.refused = true;
    await this.saveMemory();
    await this.setStatus(false, T.refused(reason));
  }

  endClient() {
    if (this.client) {
      this.client.removeAllListeners?.();
      this.client.on?.('error', () => {});
      this.client.end(true);
      this.client = null;
    }
    this.failWaiters();
  }

  stop() {
    this.generation += 1;
    this.clearTimers();
    this.publisher.stop();
    this.endClient();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.lastStatusArgs = [connected, message];
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  warnOnce(key, message) {
    if (this.warned.size < 200 && !this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  async onConnect() {
    this.logger.info(`Connected to the MQTT broker ${this.config.brokerUrl}`);
    this.wasConnected = true;
    this.lastError = undefined;
    this.resetSession();
    if (this.memory.refused) {
      // The credentials work: the stop is lifted.
      this.memory.refused = false;
      await this.saveMemory();
    }
    // A clean session: subscribe again; the boards' retained discoveries come back.
    this.client.subscribe(SUBSCRIPTIONS, { qos: 0 }, (err) => {
      if (err) {
        this.logger.warn(`Subscription failed: ${err.message}`);
      }
    });
    this.notify('session', { connected: true }, { all: true });
    await this.updateStatus();
    this.later('rebuild', TIMINGS.discoveryTimeout, () => this.rebuild());
    this.later('discovery', TIMINGS.discoveryTimeout, () => {
      this.silentBroker = true;
      return this.updateStatus();
    });
    this.badgeLoop();
  }

  badgeLoop() {
    this.later('badges', TIMINGS.badgeInterval, async () => {
      await this.publishAllTransports();
      this.badgeLoop();
    });
  }

  /** What the boards of this session say about themselves, for the status. */
  boardNotes() {
    const pending = [];
    const conflicts = [];
    let unsupported = 0;
    for (const board of this.boards.values()) {
      if (board.type !== 'E-BOARD') {
        unsupported += 1;
      }
      if (this.isPending(board)) {
        pending.push(board.name);
      }
      if (this.isConflict(board)) {
        conflicts.push(board.name);
      }
    }
    const sharedNames = [...this.nameOwners()]
      .filter(([, ids]) => ids.length > 1)
      .map(([name]) => name);
    return {
      invalid: this.config.invalidOutputs,
      ambiguous: ambiguousOutputs(this.config.safeOutputs, this.single()),
      pending,
      conflicts,
      sharedNames,
      unsupported,
      rejected: this.rejected,
    };
  }

  /** The status from what is known now. */
  async updateStatus() {
    if (this.config.problem) {
      return this.setStatus(false, T.problem(this.config.problem));
    }
    if (!this.client?.connected) {
      return undefined;
    }
    if (this.boards.size === 0) {
      return this.setStatus(false, this.silentBroker ? T.noBoard : T.waiting);
    }
    return this.setStatus(
      true,
      T.connected(this.boards.size, this.model.devices.length, this.boardNotes()),
    );
  }

  // --- Boards ------------------------------------------------------------------------

  accepted(board) {
    return this.memory?.boards.get(board.id);
  }

  /** The board published another layout than the accepted one. */
  isPending(board) {
    const accepted = this.accepted(board);
    const now = layoutRecord(board);
    return (
      accepted !== undefined &&
      (accepted.shutters !== now.shutters || accepted.boards !== now.boards)
    );
  }

  /** Another MAC address answers for the board. */
  isConflict(board) {
    const accepted = this.accepted(board);
    return accepted !== undefined && accepted.mac !== board.mac;
  }

  /** name -> the ids of the boards of this session using it. */
  nameOwners() {
    const owners = new Map();
    for (const board of this.boards.values()) {
      owners.set(board.name, [...(owners.get(board.name) ?? []), board.id]);
    }
    return owners;
  }

  /** The board of a name in a topic: only when exactly one board of this session uses it. */
  boardByName(name) {
    let found;
    for (const board of this.boards.values()) {
      if (board.name === name) {
        if (found) {
          return undefined;
        }
        found = board;
      }
    }
    return found;
  }

  /** One board only was ever accepted: a relay number alone then counts. */
  single() {
    return (this.memory?.boards.size ?? 0) === 1;
  }

  /** The boards of this session with the layout the user accepted. */
  modelBoards() {
    const boards = [];
    for (const board of this.boards.values()) {
      const accepted = this.accepted(board);
      if (accepted) {
        boards.push({
          ...board,
          layout:
            accepted.boards === null
              ? null
              : { shutters: accepted.shutters, boards: accepted.boards },
        });
      }
    }
    return boards;
  }

  // --- Messages --------------------------------------------------------------------

  onMessage(topic, payload, packet) {
    const info = parseTopic(topic);
    if (!info) {
      return;
    }
    if (info.kind === 'discovery') {
      this.onDiscovery(info.id, payload, packet?.retain === true);
      return;
    }
    if (packet?.retain) {
      // Kept by the broker, maybe from long ago (the board stopped since): not a current state.
      return;
    }
    const board = this.boardByName(info.name);
    if (!board) {
      return;
    }
    if (info.kind === 'sensor') {
      const parsed = parseSensor(payload);
      if (parsed.error) {
        this.warnOnce(`sensor:${board.id}`, `Sensor of ${board.id} ignored: ${parsed.error}`);
        return;
      }
      if (parsed.outOfRange.length > 0) {
        this.warnOnce(
          `range:${board.id}`,
          `Sensor of ${board.id}: ${parsed.outOfRange.join(', ')} out of range, ignored`,
        );
      }
      this.lastSeen.set(board.id, this.now());
      this.recordTarget(`${board.id}/sensor/0`, parsed.values);
      return;
    }
    const state = info.kind === 'relay' ? parseRelayState(payload) : parseShutterState(payload);
    if (state === undefined) {
      this.warnOnce(
        `state:${board.id}/${info.kind}`,
        `A ${info.kind} state of ${board.id} ignored`,
      );
      return;
    }
    const text = typeof state === 'boolean' ? (state ? 'ON' : 'OFF') : state;
    const key = `${board.id}/${info.kind}/${info.index}`;
    this.lastSeen.set(board.id, this.now());
    this.notify(key, text);
    this.recordTarget(key, text);
  }

  onDiscovery(id, payload, retained) {
    if (!payload || payload.length === 0) {
      // The board withdrew its discovery (the retained message was cleared).
      if (this.boards.delete(id)) {
        this.lastSeen.delete(id);
        this.later('rebuild', TIMINGS.rebuildDebounce, () => this.rebuild());
      }
      return;
    }
    const parsed = parseDiscovery(id, payload);
    if (parsed.error) {
      this.rejected += 1;
      this.warnOnce(
        `discovery:${id}:${parsed.error}`,
        `Discovery of ${id} ignored: ${parsed.error}`,
      );
      this.updateStatus().catch(() => {});
      return;
    }
    const board = parsed.board;
    if (!this.boards.has(id) && this.boards.size >= LIMITS.boards) {
      this.rejected += 1;
      this.warnOnce('boards:max', `More than ${LIMITS.boards} boards: ${id} ignored`);
      return;
    }
    if (!this.memory.boards.has(id)) {
      if (this.memory.boards.size >= LIMITS.boards) {
        this.rejected += 1;
        this.warnOnce('layouts:max', `More than ${LIMITS.boards} boards known: ${id} ignored`);
        return;
      }
      // A board never seen: its layout is accepted as it is announced (the user then
      // chooses what to create in the Discovery tab). Later changes need a Scan.
      this.memory.boards.set(id, layoutRecord(board));
      this.saveMemory();
      this.logger.info(`New PG LAB board ${id} (${board.type})`);
    }
    this.boards.set(id, board);
    if (!retained) {
      this.lastSeen.set(id, this.now());
    }
    this.notify('discovery', board, { all: true });
    this.later('rebuild', TIMINGS.rebuildDebounce, () => this.rebuild());
  }

  /** The values of a relay, a shutter or the sensor of a board, to its features. */
  recordTarget(key, value) {
    for (const featureId of this.model.targets.get(key) ?? []) {
      const feature = this.model.features.get(featureId);
      const state = feature?.spec.read?.(value);
      if (typeof state === 'number' && Number.isFinite(state)) {
        this.record(featureId, { state });
      }
    }
  }

  // --- Devices -----------------------------------------------------------------------

  async rebuild({ force = false } = {}) {
    this.model = buildModel({
      externalIds: (type, id) => this.gladys.externalIds(type, id),
      boards: this.modelBoards(),
      language: this.config.language,
      safeOutputs: this.config.safeOutputs,
      single: this.single(),
    });
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: this.model.throttled,
    });
    const devices = this.keepCreatedFeatures(this.model.devices);
    const json = JSON.stringify(devices);
    if (force || json !== this.publishedDevices) {
      this.publishedDevices = json;
      await this.gladys
        .publishDiscoveredDevices(devices)
        .catch((err) => this.logger.warn(`Publishing the devices failed: ${err.message}`));
    }
    await this.updateStatus();
    await this.publishAllTransports();
  }

  /**
   * A device the user created never loses a feature (the core would mark it
   * changed and "Update" would drop the history): the features of the created
   * device that the new build lacks are kept as they are.
   */
  keepCreatedFeatures(devices) {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    return devices.map((device) => {
      const old = created.get(device.external_id);
      if (!old) {
        return device;
      }
      const ids = new Set(device.features.map((f) => f.external_id));
      const kept = (old.features ?? [])
        .filter((f) => typeof f.external_id === 'string' && !ids.has(f.external_id))
        .map((f) => {
          const copy = {};
          for (const key of [
            'name',
            'external_id',
            'category',
            'type',
            'unit',
            'min',
            'max',
            'read_only',
            'has_feedback',
            'keep_history',
          ]) {
            if (f[key] !== undefined && f[key] !== null) {
              copy[key] = f[key];
            }
          }
          return copy;
        });
      return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
    });
  }

  /** Keeps the value, and sends it when the device exists in Gladys. */
  record(featureId, value) {
    this.lastValues.set(featureId, value);
    if (this.created.has(featureId)) {
      this.publisher.push(featureId, value);
    }
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    for (const f of device?.features ?? []) {
      const value = this.lastValues.get(f.external_id);
      if (value) {
        this.publisher.push(f.external_id, value);
      }
    }
    await this.publishAllTransports().catch(() => {});
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /**
   * Scan (Discovery tab): the user accepts what the boards announce now (a
   * changed layout or MAC included), and the broker sends the retained
   * discoveries again.
   */
  async scan() {
    let changed = false;
    for (const board of this.boards.values()) {
      if (this.isPending(board) || this.isConflict(board)) {
        this.logger.info(`Accepting the new configuration of the PG LAB board ${board.id}`);
        this.memory.boards.set(board.id, layoutRecord(board));
        changed = true;
      }
    }
    if (changed) {
      await this.saveMemory();
    }
    if (this.client?.connected) {
      this.client.subscribe([SUBSCRIPTIONS[0]], { qos: 0 }, () => {});
    }
    await this.rebuild({ force: true });
  }

  // --- Transport badge -------------------------------------------------------------------

  transportOf(deviceId) {
    const boardId = this.model.deviceOf.get(deviceId);
    const seen = this.lastSeen.get(boardId);
    const reachable =
      boardId !== undefined &&
      Boolean(this.client?.connected) &&
      this.boards.has(boardId) &&
      seen !== undefined &&
      this.now() - seen < TIMINGS.silence;
    return reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
  }

  async publishAllTransports() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const transport = this.transportOf(device.external_id);
      if (this.transports.get(device.external_id) !== transport) {
        this.transports.set(device.external_id, transport);
        entries.push({ external_id: device.external_id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  // --- Waiting for a message ---------------------------------------------------------------

  /** Resolves with the message of `key` matching `predicate`, false at `deadline`. */
  waitFor(key, predicate, deadline) {
    let waiter;
    const promise = new Promise((resolve) => {
      waiter = { key, predicate, resolve };
      waiter.timer = this.timers.setTimeout(
        () => this.settleWaiter(waiter, false),
        Math.max(0, deadline - this.now()),
      );
    });
    this.waiters.add(waiter);
    return { promise, cancel: () => this.settleWaiter(waiter, false) };
  }

  settleWaiter(waiter, result) {
    if (this.waiters.delete(waiter)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }

  /**
   * A message of `key`: settles the OLDEST waiter it matches (a state serves
   * one command only), or every matching one with `all`.
   */
  notify(key, message, { all = false } = {}) {
    for (const waiter of [...this.waiters]) {
      if (waiter.key === key && waiter.predicate(message)) {
        this.settleWaiter(waiter, message);
        if (!all) {
          return;
        }
      }
    }
  }

  /** Settles every waiter (the connection is gone). */
  failWaiters() {
    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter, false);
    }
  }

  // --- Commands --------------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const entry = this.model.features.get(feature?.external_id);
    if (!entry) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const { spec } = entry;
    if (spec.refusal) {
      // A switch kept from before, of a relay no longer declared safe.
      throw this.refusal(ERRORS[spec.refusal]);
    }
    if (spec.readOnly || typeof spec.write !== 'function') {
      throw this.refusal(ERRORS.readOnly);
    }
    if (spec.gate === 'outputButtons' && !this.config.allowOutputButtons) {
      throw this.refusal(ERRORS.buttonsDisabled);
    }
    let command;
    try {
      command = spec.write(value);
    } catch (err) {
      if (err instanceof CommandRefusal) {
        throw this.refusal(ERRORS[err.refusal] ?? ERRORS.badValue);
      }
      throw err;
    }
    const board = this.boards.get(entry.boardId);
    if (!board) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const stop = command.payload === 'STOP';
    if (!stop && this.nameOwners().get(board.name)?.length > 1) {
      // The topic of this board is the topic of another one too.
      throw this.refusal(ERRORS.nameShared);
    }
    if (!command.protective) {
      if (this.isPending(board)) {
        throw this.refusal(ERRORS.layoutChanged);
      }
      if (this.isConflict(board)) {
        throw this.refusal(ERRORS.identityChanged);
      }
    }
    const client = this.client;
    if (!client?.connected) {
      throw this.refusal(ERRORS.notConnected);
    }
    if (this.now() > received + TIMINGS.commandSendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const message = commandMessage(board.name, entry.kind, entry.index, command.payload);
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The confirmation is awaited from before the publication (a fast board).
    const confirmation = this.waitFor(
      `${board.id}/${entry.kind}/${entry.index}`,
      (state) => command.confirms.includes(state),
      answerBy,
    );
    this.logger.debug(`PG LAB ${board.id} ${entry.kind} ${entry.index}: ${command.payload}`);
    try {
      await this.send(client, message, answerBy);
    } catch (err) {
      confirmation.cancel();
      throw err;
    }
    if (!(await confirmation.promise)) {
      throw this.refusal(ERRORS.sentUnconfirmed);
    }
  }

  /** Publishes a command; the ack never waits past `answerBy`. */
  async send(client, message, answerBy) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('late'), Math.max(0, answerBy - this.now()));
    });
    let result;
    try {
      result = await Promise.race([
        publish(client, message.topic, message.payload).then(() => 'sent'),
        late,
      ]);
    } catch (err) {
      // The packet may have been written before the error: never "not sent".
      this.logger.warn(`Command to ${message.topic}: ${errorReason(err)}`);
      result = 'failed';
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (result !== 'sent') {
      throw this.refusal(ERRORS.sentUnconfirmed);
    }
  }

  // --- Configuration screen button ---------------------------------------------------------

  /**
   * Uses the ONE session with the saved configuration: when it is not
   * connected (or the configuration changed), the session is started again
   * (even after refused credentials: the user asked), then the boards that
   * announced themselves are counted. At most every 10 s.
   */
  async testConnection() {
    // The cooldown first: a burst of clicks never reaches the broker either.
    if (this.now() - this.lastTest < TIMINGS.testCooldown) {
      return TEST.tooSoon;
    }
    this.lastTest = this.now();
    // The saved configuration as it is now (never an older copy).
    const raw = await this.gladys.getConfig().catch(() => this.rawConfig ?? {});
    const config = normalizeConfig(raw);
    if (config.problem) {
      return T.problem(config.problem);
    }
    const deadline = this.now() + TIMINGS.connectTimeout + 1000;
    if (!(this.started && connectionKey(config) === this.connKey && this.client?.connected)) {
      await this.start(raw, { force: true });
      if (!this.client) {
        return this.memory.refused
          ? TEST.refused(this.lastError ?? 'refused')
          : T.unreachable(this.lastError ?? 'error');
      }
      if (!this.client.connected) {
        const session = this.waitFor('session', () => true, deadline);
        const outcome = await session.promise;
        if (outcome?.refused) {
          return TEST.refused(outcome.refused);
        }
        if (!outcome?.connected) {
          return T.unreachable(outcome?.error ?? 'timeout');
        }
      }
    }
    if (this.boards.size === 0) {
      const discovery = this.waitFor('discovery', () => true, this.now() + TIMINGS.testTimeout);
      await discovery.promise;
    }
    if (this.boards.size === 0) {
      return T.noBoard;
    }
    const model = buildModel({
      externalIds: (type, id) => this.gladys.externalIds(type, id),
      boards: this.modelBoards(),
      safeOutputs: this.config.safeOutputs,
      single: this.single(),
    });
    return TEST.ok(this.boards.size, model.devices.length);
  }
}
