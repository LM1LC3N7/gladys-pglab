// -----------------------------------------------------------------------------
// Constants: the PG LAB MQTT protocol, feature roles, manifest keys, limits
// and timings.
//
// A PG LAB Electronics board (E-Board) speaks MQTT itself: it connects to an
// MQTT broker of the user (Mosquitto, the broker of Gladys...) and publishes
// its configuration under pglab/discovery/<id>/config, its states under
// pglab/<name>/..., as in pypglab 0.0.5 (MIT, PG LAB Electronics, the library
// of Home Assistant's PG LAB integration).
// -----------------------------------------------------------------------------

export const TOPIC_PREFIX = 'pglab';
export const MANUFACTURER = 'PG LAB Electronics';

/** The device types pypglab knows; only the E-Board has outputs in pypglab 0.0.5. */
export const DEVICE_TYPES = ['E-BOARD', 'E-RELAY', 'E-SWITCH'];

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  /** On/off of a relay declared safe (a switch). */
  POWER: 'power',
  /** The read-only state of a relay not declared safe, and its buttons. */
  STATE: 'state',
  TURN_ON: 'turn-on',
  TURN_OFF: 'turn-off',
  /** Shutter: open / close / stop. */
  SHUTTER: 'shutter',
  /** The board itself: its temperature and the voltage of its processor. */
  TEMPERATURE: 'temperature',
  VOLTAGE: 'voltage',
};

/** Manifest `actions` keys: frozen. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** The minimum interval between two readings of a measurement (s), mirrored by the manifest. */
export const SENSOR_INTERVAL = { min: 0, max: 300, default: 60 };

/** Gladys COVER_STATE (server/utils/constants.js). */
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };

/** Gladys value of a pressed push button. */
export const PRESSED = 1;

export const LIMITS = {
  /** Gladys accepts 300 states per minute: a margin is kept. */
  statesPerMinute: 250,
  /** A discovery message: a few hundred bytes. Larger is dropped. */
  discoveryBytes: 4096,
  /** A state ("ON", "CLOSING") or the sensor JSON: a few dozen bytes. */
  stateBytes: 512,
  /** Boards known at once (one broker): more are ignored. */
  boards: 64,
  /** The relays of an E-Board: 8 boards of 8 relays (pypglab). */
  relays: 64,
  /** Shutters of an E-Board (pypglab: 0 to 32, two relays each). */
  shutters: 32,
  /** Names are cut to this length. */
  nameLength: 60,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

export const TIMINGS = {
  /** Broker connection timeout. */
  connectTimeout: 10 * SECOND,
  /** Delay between two reconnection attempts when the broker is unreachable. */
  reconnectPeriod: 10 * SECOND,
  /** How long to wait for a board to publish its discovery before saying so. */
  discoveryTimeout: 15 * SECOND,
  /** Several discoveries in a row (boards starting): rebuild once. */
  rebuildDebounce: 1500,
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * MINUTE,
  /** The counters of the status (a flood of discoveries) are posted at most this often. */
  statusRefresh: 10 * SECOND,
  /** A board that published nothing useful for this long is shown unreachable. */
  silence: 5 * MINUTE,
  /** The transport badges are checked this often. */
  badgeInterval: MINUTE,
  /** How long the "Test the connection" button waits for the broker and a board. */
  testTimeout: 20 * SECOND,
  /** The button acts at most this often. */
  testCooldown: 10 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the message must leave by 3.5 s
   * after the click or the command is refused unsent; the state the board
   * publishes back is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
};
