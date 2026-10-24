// -----------------------------------------------------------------------------
// The integration: ONE session with the MQTT broker of the user, where the
// PG LAB boards publish; their discoveries turned into Gladys devices
// (src/model.js); the states they publish, sent within the Gladys rate
// limit; the commands sent back; the transport badges and the "Test the
// connection" button. index.js only wires the SDK handlers (src/handlers.js).
//
// Failures (lessons of the previous waves):
//   - credentials refused by the broker (CONNACK 4, 5, 134, 135, 138), or a
//     CONNECT carrying credentials left unanswered (connection closed or no
//     CONNACK in time) twice in a row: the client stops for good, a stop
//     persisted in /data, no automatic new try (not even after a restart);
//     saving other credentials or "Test the connection" tries again, and the
//     stop is lifted only once a connection succeeded;
//   - broker unreachable: mqtt.js tries again every 10 s (a local broker),
//     the status says why;
//   - a broker without MQTT 5: 3.1.1, said in the status;
//   - a reconnection to Gladys keeps the MQTT client and the stop, and only
//     re-sends the status, the Discovery and the badges.
//
// What a board publishes is never trusted to make something commandable:
//   - a relay is a switch only when the user declared it safe; otherwise a
//     read-only state and buttons, off by default;
//   - the configuration of each board (name, type, MAC, shutters, relays)
//     is the one the user accepted (/data): the first discovery of an
//     unknown board, or a Scan in the Discovery tab. The devices and the
//     routing of the commands come from it, from the start (before any
//     announcement). A discovery that changes it is not applied; until a
//     Scan, the relays and the opening of the shutters of that board are
//     refused;
//   - two boards with the same name (their topics are the same): their
//     states are ignored, relays and openings refused.
// The stop and the close of a shutter of an accepted configuration are
// refused only when the broker is not connected (or the value is not a
// command): they go under the accepted name, and also under the announced
// one when it differs.
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
import {
  connectBroker,
  errorReason,
  isIdentifierRefusal,
  isProtocolRefusal,
  isRefusal,
} from './mqtt.js';
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

/** The configuration of a discovery, as kept in /data. */
const layoutRecord = (board) => ({
  name: board.name,
  type: board.type,
  mac: board.mac,
  shutters: board.layout ? board.layout.shutters : null,
  boards: board.layout ? board.layout.boards : null,
});

/** Socket errors before the connection opened: no CONNECT (no credentials) left. */
const NOT_OPENED = [
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRNOTAVAIL',
  'ETIMEDOUT',
];

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
    this.protocolVersion = 5;
    this.unanswered = 0;
    this.resetSession();
    this.model = buildModel({ boards: [] });
    this.lastStatus = undefined;
    this.lastStatusAt = -Infinity;
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
    this.announced = new Map();
    /** board id -> its raw discovery (an identical one changes nothing) */
    this.rawDiscovery = new Map();
    /** board id -> name, of the boards ignored over the limit of accepted boards */
    this.ignored = new Map();
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

  /** Like `later`, but an armed timer is kept: at most `delay` after the first request. */
  once(name, delay, fn) {
    if (this.timersById[name] === undefined) {
      this.later(name, delay, fn);
    }
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
      await this.rebuild({ force: true, urgent: true });
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
        await this.rebuild({ urgent: true });
      } else {
        await this.updateStatus({ urgent: true });
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
    this.unanswered = 0;
    this.protocolVersion = 5;
    const credentials = credentialsKey(this.config);
    if (this.credKey !== undefined && credentials !== this.credKey && this.memory.refused) {
      // Other credentials (or another broker): the stop on the refused ones is lifted.
      this.memory.refused = false;
      await this.saveMemory();
    }
    this.credKey = credentials;
    this.resetSession();
    this.publishedDevices = undefined;
    this.lastStatus = undefined;
    this.transports.clear();
    this.lastValues.clear();
    this.refreshCreated();
    // The routing of the accepted boards exists before any announcement.
    this.buildRouting();
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

  hasCredentials() {
    return this.config.username !== '' || this.config.password !== '';
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
      client = this.connect(this.config, { protocolVersion: this.protocolVersion });
    } catch (err) {
      this.lastError = errorReason(err);
      await this.setStatus(false, T.unreachable(this.lastError));
      return;
    }
    this.client = client;
    /**
     * A CONNECT left without CONNACK (so far): why, if the attempt ends now.
     * Set when an attempt starts (mqtt.js writes the CONNECT as soon as the
     * socket opens), cleared by a CONNACK or a socket that never opened.
     */
    const UNANSWERED = 'the broker closed the connection without answering';
    let pending = UNANSWERED;
    const current = () => generation === this.generation && this.client === client;
    client.on('reconnect', () => {
      pending = UNANSWERED;
    });
    client.on('packetsend', (packet) => {
      if (packet?.cmd === 'connect') {
        pending = UNANSWERED;
      }
    });
    client.on('packetreceive', (packet) => {
      if (packet?.cmd === 'connack') {
        pending = undefined;
      }
    });
    client.on('connect', () => {
      if (current()) {
        this.unanswered = 0;
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
      if (NOT_OPENED.includes(err?.code)) {
        // The socket never opened: the credentials did not leave.
        pending = undefined;
      }
      if (isRefusal(err)) {
        this.onRefused(reason).catch((e) => this.logger.error(`After a refusal: ${e.message}`));
        return;
      }
      if (isProtocolRefusal(err) && this.protocolVersion === 5) {
        this.onProtocolRefused().catch((e) => this.logger.error(`MQTT 3.1.1: ${e.message}`));
        return;
      }
      if (err?.message === 'connack timeout' && pending) {
        pending = 'no answer from the broker to the connection';
      }
      if (isIdentifierRefusal(err)) {
        // Counted like a CONNECT left unanswered (the same client id comes back).
        pending = reason;
      }
      this.warnOnce(`broker:${reason}`, `MQTT broker: ${reason}`);
      this.notify('session', { error: reason }, { all: true });
      this.setStatus(false, T.unreachable(reason));
    });
    client.on('close', () => {
      if (!current()) {
        return;
      }
      if (pending) {
        const reason = pending;
        pending = undefined;
        this.onUnanswered(reason).catch((e) => this.logger.error(`Unanswered: ${e.message}`));
        return;
      }
      if (this.wasConnected) {
        this.wasConnected = false;
        this.failWaiters();
        // The boards are unknown until the next session announces them again.
        this.resetSession();
        // The reason when the connection ended on an error (a message over 8 KB...).
        this.setStatus(false, this.lastError ? T.unreachable(this.lastError) : T.lost);
        this.publishAllTransports().catch(() => {});
      }
    });
  }

  /**
   * A CONNECT carrying the credentials was closed or left without answer
   * (lesson 13 of lot 14): the second time in a row, a final stop, as for
   * refused credentials. Without credentials there is nothing to protect.
   */
  async onUnanswered(reason) {
    this.lastError = reason;
    this.unanswered += 1;
    if (this.hasCredentials() && this.unanswered >= 2) {
      await this.onRefused(`${reason}, twice`);
      return;
    }
    this.notify('session', { error: reason }, { all: true });
    await this.setStatus(false, T.unreachable(reason));
  }

  /** The broker does not speak MQTT 5: 3.1.1, with the size guard of src/mqtt.js only. */
  async onProtocolRefused() {
    this.logger.warn('The MQTT broker does not support MQTT 5: using MQTT 3.1.1');
    this.endClient();
    this.protocolVersion = 4;
    await this.connectNow();
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
    this.lastStatusAt = this.now();
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
    this.logger.info(
      `Connected to the MQTT broker ${this.config.brokerUrl} (MQTT ${this.protocolVersion === 5 ? '5' : '3.1.1'})`,
    );
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
    await this.updateStatus({ urgent: true });
    this.later('discovery', TIMINGS.discoveryTimeout, () => {
      this.silentBroker = true;
      return this.rebuild({ urgent: true });
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
    const renamed = [];
    let unsupported = 0;
    for (const board of this.announced.values()) {
      if (board.type !== 'E-BOARD') {
        unsupported += 1;
      }
      const accepted = this.memory.boards.get(board.id);
      if (this.isPending(board)) {
        pending.push(accepted?.name ?? board.name);
      }
      if (this.isConflict(board)) {
        conflicts.push(accepted?.name ?? board.name);
      }
      if (accepted && accepted.name !== board.name) {
        renamed.push(`${accepted.name} → ${board.name}`);
      }
    }
    const single = this.single();
    const accepted = this.memory.boards;
    return {
      invalid: this.config.invalidOutputs,
      ambiguous: ambiguousOutputs(this.config.safeOutputs, single),
      unknownIds: [...this.config.safeOutputs]
        .filter((entry) => entry.includes(':') && !accepted.has(entry.split(':')[0]))
        .map((entry) => entry.split(':')[0]),
      pending,
      conflicts,
      renamed,
      sharedNames: [...this.nameIndex()].filter(([, ids]) => ids.size > 1).map(([name]) => name),
      unsupported,
      rejected: this.rejected,
      ignored: this.ignored.size,
      protocol3: this.protocolVersion !== 5,
    };
  }

  /**
   * The status from what is known now. Its counters change with every
   * message a broker may flood: when only the text changes, it is posted at
   * most every 10 s (at the end of the 10 s); `urgent` posts at once.
   */
  async updateStatus({ urgent = false } = {}) {
    let next;
    if (this.config.problem) {
      next = [false, T.problem(this.config.problem)];
    } else if (!this.client?.connected) {
      return undefined;
    } else if (this.announced.size === 0) {
      next = [false, this.silentBroker ? T.noBoard : T.waiting];
    } else {
      next = [true, T.connected(this.announced.size, this.offeredCount(), this.boardNotes())];
    }
    // A change of state goes at once; a change of the counters only every 10 s.
    if (!urgent && next[0] === this.lastStatusArgs?.[0]) {
      const wait = this.lastStatusAt + TIMINGS.statusRefresh - this.now();
      if (wait > 0) {
        this.once('status', wait, () => this.updateStatus({ urgent: true }));
        return undefined;
      }
    }
    return this.setStatus(...next);
  }

  // --- Boards ------------------------------------------------------------------------

  accepted(id) {
    return this.memory?.boards.get(id);
  }

  /** The board announced another type or layout than the accepted one. */
  isPending(board) {
    const accepted = this.accepted(board.id);
    const now = layoutRecord(board);
    return (
      accepted !== undefined &&
      (accepted.type !== now.type ||
        accepted.shutters !== now.shutters ||
        accepted.boards !== now.boards)
    );
  }

  /** Another MAC address answers for the board. */
  isConflict(board) {
    const accepted = this.accepted(board.id);
    return accepted !== undefined && accepted.mac !== board.mac;
  }

  /** The names of an accepted board: the accepted one, and the announced one when it differs. */
  namesOf(id) {
    const names = new Set();
    const accepted = this.accepted(id);
    if (accepted) {
      names.add(accepted.name);
    }
    const announced = this.announced.get(id);
    if (announced) {
      names.add(announced.name);
    }
    return names;
  }

  /** name -> the ids of the boards using it (accepted, announced or ignored). */
  nameIndex() {
    const index = new Map();
    const add = (name, id) => {
      if (!index.has(name)) {
        index.set(name, new Set());
      }
      index.get(name).add(id);
    };
    for (const id of this.memory?.boards.keys() ?? []) {
      for (const name of this.namesOf(id)) {
        add(name, id);
      }
    }
    for (const [id, name] of this.ignored) {
      add(name, id);
    }
    return index;
  }

  /** The accepted board of a name in a topic: only when exactly one board uses it. */
  boardByName(name) {
    const ids = this.nameIndex().get(name);
    if (!ids || ids.size !== 1) {
      return undefined;
    }
    const [id] = ids;
    return this.accepted(id) ? id : undefined;
  }

  /** One board only was accepted: a relay number alone then counts. */
  single() {
    return (this.memory?.boards.size ?? 0) === 1;
  }

  /** The accepted boards, with what their announcement adds (IP, firmware). */
  acceptedBoards() {
    const boards = [];
    for (const [id, accepted] of this.memory?.boards ?? []) {
      const announced = this.announced.get(id);
      const sameMac = announced?.mac === accepted.mac;
      boards.push({
        id,
        name: accepted.name,
        type: accepted.type,
        mac: accepted.mac,
        ip: sameMac ? announced.ip : undefined,
        fw: sameMac ? announced.fw : undefined,
        layout:
          accepted.boards === null
            ? null
            : { shutters: accepted.shutters, boards: accepted.boards },
      });
    }
    return boards;
  }

  /** The routing tables and devices, from the accepted configurations. */
  buildRouting() {
    this.model = buildModel({
      externalIds: (type, id) => this.gladys.externalIds(type, id),
      boards: this.acceptedBoards(),
      language: this.config.language,
      safeOutputs: this.config.safeOutputs,
      single: this.single(),
    });
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: this.model.throttled,
    });
  }

  /** The devices offered in the Discovery tab: those of the boards announced in this session. */
  offeredDevices() {
    return this.model.devices.filter((d) =>
      this.announced.has(this.model.deviceOf.get(d.external_id)),
    );
  }

  offeredCount() {
    return this.offeredDevices().length;
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
    const id = this.boardByName(info.name);
    if (!id) {
      return;
    }
    if (info.kind === 'sensor') {
      const parsed = parseSensor(payload);
      if (parsed.error) {
        this.warnOnce(`sensor:${id}`, `Sensor of ${id} ignored: ${parsed.error}`);
        return;
      }
      if (parsed.outOfRange.length > 0) {
        this.warnOnce(
          `range:${id}`,
          `Sensor of ${id}: ${parsed.outOfRange.join(', ')} out of range, ignored`,
        );
      }
      this.markSeen(id);
      this.recordTarget(`${id}/sensor/0`, parsed.values);
      return;
    }
    const state = info.kind === 'relay' ? parseRelayState(payload) : parseShutterState(payload);
    if (state === undefined) {
      this.warnOnce(`state:${id}/${info.kind}`, `A ${info.kind} state of ${id} ignored`);
      return;
    }
    const text = typeof state === 'boolean' ? (state ? 'ON' : 'OFF') : state;
    const key = `${id}/${info.kind}/${info.index}`;
    this.markSeen(id);
    this.notify(key, text);
    this.recordTarget(key, text);
  }

  /** The board published something useful: its badges at once when it was not seen. */
  markSeen(id) {
    const seen = this.lastSeen.get(id);
    const fresh = seen !== undefined && this.now() - seen < TIMINGS.silence;
    this.lastSeen.set(id, this.now());
    if (!fresh) {
      this.publishAllTransports().catch(() => {});
    }
  }

  onDiscovery(id, payload, retained) {
    if (!payload || payload.length === 0) {
      // The board withdrew its discovery (the retained message was cleared).
      this.rawDiscovery.delete(id);
      this.ignored.delete(id);
      if (this.announced.delete(id)) {
        this.lastSeen.delete(id);
        this.scheduleRebuild();
      }
      return;
    }
    const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    if (this.rawDiscovery.get(id) === raw) {
      // The same announcement again: nothing changes (it never delays the devices).
      if (!retained && this.announced.has(id)) {
        this.markSeen(id);
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
    if (!this.memory.boards.has(id)) {
      if (this.memory.boards.size >= LIMITS.boards) {
        // Said in the status, with the advice to Scan (which forgets the boards gone).
        if (this.ignored.size < LIMITS.boards || this.ignored.has(id)) {
          this.ignored.set(id, board.name);
        }
        this.warnOnce('layouts:max', `More than ${LIMITS.boards} boards known: ${id} ignored`);
        this.updateStatus().catch(() => {});
        return;
      }
      // A board never seen: its configuration is accepted as it is announced (the user
      // then chooses what to create in the Discovery tab). Later changes need a Scan.
      this.memory.boards.set(id, layoutRecord(board));
      this.saveMemory();
      this.logger.info(`New PG LAB board ${id} (${board.type})`);
    }
    this.rawDiscovery.set(id, raw);
    this.announced.set(id, board);
    if (!retained) {
      this.markSeen(id);
    }
    this.notify('discovery', board, { all: true });
    this.scheduleRebuild();
  }

  /** At most 1.5 s after the first discovery of a burst (never pushed back by the next ones). */
  scheduleRebuild() {
    this.once('rebuild', TIMINGS.rebuildDebounce, () => this.rebuild());
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

  async rebuild({ force = false, urgent = false } = {}) {
    this.timers.clearTimeout(this.timersById.rebuild);
    this.timersById.rebuild = undefined;
    this.buildRouting();
    const devices = this.keepCreatedFeatures(this.offeredDevices());
    const json = JSON.stringify(devices);
    if (force || json !== this.publishedDevices) {
      this.publishedDevices = json;
      await this.gladys
        .publishDiscoveredDevices(devices)
        .catch((err) => this.logger.warn(`Publishing the devices failed: ${err.message}`));
    }
    await this.updateStatus({ urgent });
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

  /** The accepted boards that have a device created in Gladys. */
  boardsWithDevices() {
    const ids = new Set();
    for (const device of this.gladys.devices ?? []) {
      const boardId = this.model.deviceOf.get(device.external_id);
      if (boardId !== undefined) {
        ids.add(boardId);
      }
    }
    return ids;
  }

  /**
   * Scan (Discovery tab): the user accepts what the boards announce now (a
   * changed name, type, layout or MAC included). The accepted set becomes
   * the boards announced now, plus the accepted ones that have a device in
   * Gladys (so their stop keeps its route), 64 at most: boards seen in
   * passing are forgotten. The broker sends the retained discoveries again.
   */
  async scan() {
    const next = new Map();
    for (const id of this.boardsWithDevices()) {
      if (next.size < LIMITS.boards && !this.announced.has(id)) {
        next.set(id, this.memory.boards.get(id));
      }
    }
    for (const board of this.announced.values()) {
      if (next.size < LIMITS.boards) {
        next.set(board.id, layoutRecord(board));
      }
    }
    // The boards ignored over the limit get their chance now.
    for (const id of this.ignored.keys()) {
      this.rawDiscovery.delete(id);
    }
    this.ignored.clear();
    const before = JSON.stringify(serializeMemory(this.memory));
    this.memory.boards = next;
    if (JSON.stringify(serializeMemory(this.memory)) !== before) {
      this.logger.info(`Scan: ${next.size} PG LAB board(s) accepted`);
      await this.saveMemory();
    }
    if (this.client?.connected) {
      this.client.subscribe([SUBSCRIPTIONS[0]], { qos: 0 }, () => {});
    }
    await this.rebuild({ force: true, urgent: true });
  }

  // --- Transport badge -------------------------------------------------------------------

  transportOf(deviceId) {
    const boardId = this.model.deviceOf.get(deviceId);
    const seen = this.lastSeen.get(boardId);
    const reachable =
      boardId !== undefined &&
      Boolean(this.client?.connected) &&
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

  /** Why a relay command or an opening may not leave for this board now, else undefined. */
  holdReason(id) {
    const announced = this.announced.get(id);
    if (!announced) {
      return ERRORS.notAnnounced;
    }
    if (this.isConflict(announced)) {
      return ERRORS.identityChanged;
    }
    if (this.isPending(announced)) {
      return ERRORS.layoutChanged;
    }
    if (this.accepted(id).name !== announced.name) {
      return ERRORS.renamed;
    }
    const index = this.nameIndex();
    if ([...this.namesOf(id)].some((name) => (index.get(name)?.size ?? 0) > 1)) {
      return ERRORS.nameShared;
    }
    return undefined;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const client = this.client;
    if (!client?.connected) {
      throw this.refusal(ERRORS.notConnected);
    }
    const entry = this.model.features.get(feature?.external_id);
    if (!entry) {
      throw this.refusal(ERRORS.notAccepted);
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
    const id = entry.boardId;
    let names;
    if (command.protective) {
      // Stop and close: under every name of the board, from the accepted configuration.
      names = [...this.namesOf(id)];
    } else {
      const hold = this.holdReason(id);
      if (hold) {
        throw this.refusal(hold);
      }
      names = [this.accepted(id).name];
    }
    if (this.now() > received + TIMINGS.commandSendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The confirmation is awaited from before the publication (a fast board).
    const confirmation = this.waitFor(
      `${id}/${entry.kind}/${entry.index}`,
      (state) => command.confirms.includes(state),
      answerBy,
    );
    this.logger.debug(`PG LAB ${id} ${entry.kind} ${entry.index}: ${command.payload}`);
    try {
      await Promise.all(
        names.map((name) =>
          this.send(
            client,
            commandMessage(name, entry.kind, entry.index, command.payload),
            answerBy,
          ),
        ),
      );
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
    const deadline = this.now() + 2 * TIMINGS.connectTimeout + 1000;
    if (!(this.started && connectionKey(config) === this.connKey && this.client?.connected)) {
      await this.start(raw, { force: true });
      if (!this.client) {
        return this.memory.refused
          ? TEST.refused(this.lastError ?? 'refused')
          : T.unreachable(this.lastError ?? 'error');
      }
      // An MQTT 3.1.1 fallback or a first unanswered CONNECT may come first.
      while (this.now() < deadline && !this.client?.connected) {
        if (!this.client) {
          break;
        }
        const outcome = await this.waitFor('session', () => true, deadline).promise;
        if (outcome?.refused) {
          return TEST.refused(outcome.refused);
        }
      }
      if (!this.client?.connected) {
        return this.memory.refused
          ? TEST.refused(this.lastError ?? 'refused')
          : T.unreachable(this.lastError ?? 'timeout');
      }
    }
    if (this.announced.size === 0) {
      await this.waitFor('discovery', () => true, this.now() + TIMINGS.testTimeout).promise;
    }
    if (this.announced.size === 0) {
      return T.noBoard;
    }
    this.buildRouting();
    return TEST.ok(this.announced.size, this.offeredCount());
  }
}
