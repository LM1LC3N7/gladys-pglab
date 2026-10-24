// -----------------------------------------------------------------------------
// The PG LAB boards -> Gladys devices and routing tables. Pure: same boards,
// same devices.
//
// What an E-Board becomes (as Home Assistant's PG LAB integration maps it,
// ported from its switch, cover and sensor platforms; Apache-2.0):
//   the board     its temperature and the voltage of its processor
//                 (read only)
//   each relay    a switch ONLY when declared safe in the configuration;
//                 otherwise a read-only state and "Turn on" / "Turn off"
//                 buttons, refused unless allowed (off by default)
//   each shutter  a shutter: open / close / stop (never a switch)
// The layout used (which relays, which shutters) is the one the user
// accepted (src/store.js), never one a later discovery published by itself.
// E-Switch and E-Relay boards are recognised but offer nothing: pypglab
// 0.0.5 gives them no output yet.
//
// External ids (frozen: never change one):
//   board    ext:<selector>:board:<board id>
//   relay    ext:<selector>:relay:<board id>-<relay number>
//   shutter  ext:<selector>:shutter:<board id>-<shutter number>
//   feature  <device>:<role> (src/constants.js FEATURES)
// The board id is the `id` of its discovery (as Home Assistant keys its
// entities), never its name (which the user may change on the board).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { COVER_STATE, FEATURES as F, LIMITS, PRESSED } from './constants.js';
import { isSafeOutput } from './config.js';
import { deviceName, featureName } from './i18n.js';
import { layoutOf } from './protocol.js';

/** A number sent by Gladys: a finite number, or a plain decimal text ('' and null are not 0). */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,9}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A refusal of a command value (the app turns the key into a message). */
export class CommandRefusal extends Error {
  constructor(key) {
    super(key);
    this.refusal = key;
  }
}
const refuse = (key) => {
  throw new CommandRefusal(key);
};

const onOff = (value) => {
  const v = strictNumber(value);
  if (v !== 0 && v !== 1) {
    refuse('badValue');
  }
  return v === 1;
};

/** The Gladys shutter state: opening or open -> open, closing or closed -> closed. */
export function shutterState(text) {
  if (text === 'OPEN' || text === 'OPENING') {
    return COVER_STATE.OPEN;
  }
  if (text === 'CLOSED' || text === 'CLOSING') {
    return COVER_STATE.CLOSE;
  }
  return undefined;
}

function feature(role, spec) {
  return { role, measurement: false, readOnly: true, ...spec };
}

/**
 * A command: the payload, whether it protects (a stop, a close: never held
 * by a changed layout, an identity in doubt or a name shared by two
 * boards), and the states the board publishes back that confirm it.
 */
const relayCommand = (on) => ({
  payload: on ? 'ON' : 'OFF',
  protective: false,
  confirms: [on ? 'ON' : 'OFF'],
});

const pushButton = (role, on) =>
  feature(role, {
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
    readOnly: false,
    history: false,
    gate: 'outputButtons',
    write: (value) => {
      if (strictNumber(value) !== PRESSED) {
        refuse('badValue');
      }
      return relayCommand(on);
    },
  });

/**
 * A relay. The load behind it is unknown (a lamp, but also a circulator, a
 * boiler, a heater, a freezer, a gate pulse...), and a "turn everything off
 * / on" of a voice assistant or a scene reaches every switch. So only a
 * relay declared safe in the configuration is a switch; any other is a
 * read-only state, with "Turn on" / "Turn off" push buttons that work only
 * when the configuration allows them.
 *
 * Both sets are built: the other one is `hidden` (not published, still read,
 * so a feature the user created before the list changed keeps its state; a
 * command on a hidden switch is refused).
 */
export function relayFeatures({ safe }) {
  const isOn = (state) => (state === 'ON' ? 1 : state === 'OFF' ? 0 : undefined);
  const controlled = [
    feature(F.POWER, {
      category: C.SWITCH,
      type: T.SWITCH.BINARY,
      min: 0,
      max: 1,
      readOnly: false,
      read: isOn,
      write: (value) => relayCommand(onOff(value)),
    }),
  ];
  const guarded = [
    feature(F.STATE, { category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1, read: isOn }),
    pushButton(F.TURN_ON, true),
    pushButton(F.TURN_OFF, false),
  ];
  const hide = (list, refusal) =>
    list.map((f) => ({ ...f, hidden: true, refusal: f.refusal ?? refusal }));
  return safe
    ? [...controlled, ...hide(guarded)]
    : [...guarded, ...hide(controlled, 'unsafeOutput')];
}

/** A shutter: open / close / stop, never a switch. Stop and close protect. */
export function shutterFeatures() {
  return [
    feature(F.SHUTTER, {
      category: C.SHUTTER,
      type: T.SHUTTER.STATE,
      min: -1,
      max: 1,
      readOnly: false,
      read: shutterState,
      write: (value) => {
        const v = strictNumber(value);
        if (v === COVER_STATE.STOP) {
          return { payload: 'STOP', protective: true, confirms: ['OPEN', 'CLOSED'] };
        }
        if (v === COVER_STATE.CLOSE) {
          return { payload: 'CLOSE', protective: true, confirms: ['CLOSING', 'CLOSED'] };
        }
        if (v === COVER_STATE.OPEN) {
          return { payload: 'OPEN', protective: false, confirms: ['OPENING', 'OPEN'] };
        }
        return refuse('badValue');
      },
    }),
  ];
}

/** The read-only status of the board: its temperature and processor voltage. */
export function boardFeatures() {
  return [
    feature(F.TEMPERATURE, {
      category: C.DEVICE_TEMPERATURE_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: 'celsius',
      min: -40,
      max: 125,
      measurement: true,
      read: (values) => values.temp,
    }),
    feature(F.VOLTAGE, {
      category: C.ENERGY_SENSOR,
      type: T.ENERGY_SENSOR.VOLTAGE,
      unit: 'volt',
      min: 0,
      max: 60,
      measurement: true,
      read: (values) => values.volt,
    }),
  ];
}

/**
 * @param {{ externalIds: Function, boards: object[], language: string,
 *   safeOutputs: Set, single: boolean }} input
 *   boards: { id, name, type, mac, ip, fw, layout } with the ACCEPTED layout
 *   single: one board only is known (a relay number alone then counts)
 * @returns {{ devices, features, targets, deviceOf, throttled }}
 *   features: featureId -> { boardId, kind, index, spec, deviceId } (hidden ones included)
 *   targets: "<board id>/<kind>/<index>" (kind relay, shutter, sensor) -> [featureId]
 *   deviceOf: deviceId -> board id
 */
export function buildModel({
  externalIds,
  boards = [],
  language = 'fr',
  safeOutputs = new Set(),
  single = false,
}) {
  const model = {
    devices: [],
    features: new Map(),
    targets: new Map(),
    deviceOf: new Map(),
    throttled: new Set(),
  };
  const add = (board, type, platformId, kind, index, name, specs, params) => {
    const ids = externalIds(type, platformId);
    const featureIds = [];
    const features = [];
    for (const spec of specs) {
      const featureId = ids.feature(spec.role);
      featureIds.push(featureId);
      model.features.set(featureId, { boardId: board.id, kind, index, spec, deviceId: ids.device });
      if (spec.measurement) {
        model.throttled.add(featureId);
      }
      if (spec.hidden) {
        continue;
      }
      features.push({
        name: featureName(spec.role, language),
        external_id: featureId,
        category: spec.category,
        type: spec.type,
        ...(spec.unit ? { unit: spec.unit } : {}),
        min: spec.min,
        max: spec.max,
        read_only: spec.readOnly,
        has_feedback: spec.read !== undefined,
        keep_history: spec.history !== false,
      });
    }
    model.devices.push({
      name,
      external_id: ids.device,
      params: [
        { name: 'PGLAB_ID', value: board.id },
        { name: 'PGLAB_NAME', value: board.name },
        { name: 'PGLAB_TYPE', value: board.type },
        ...params,
      ],
      features,
    });
    model.deviceOf.set(ids.device, board.id);
    model.targets.set(`${board.id}/${kind}/${index}`, featureIds);
  };
  for (const board of boards.slice(0, LIMITS.boards)) {
    if (board.type !== 'E-BOARD' || !board.layout || board.layout.boards === null) {
      continue;
    }
    add(
      board,
      'board',
      board.id,
      'sensor',
      0,
      board.name.slice(0, LIMITS.nameLength),
      boardFeatures(),
      [
        { name: 'PGLAB_MAC', value: board.mac },
        ...(board.ip ? [{ name: 'PGLAB_IP', value: board.ip }] : []),
        ...(board.fw ? [{ name: 'PGLAB_FIRMWARE', value: board.fw }] : []),
      ],
    );
    const layout = layoutOf(board.layout);
    for (const n of layout.shutters) {
      add(
        board,
        'shutter',
        `${board.id}-${n}`,
        'shutter',
        n,
        deviceName('shutter', board.name, n, language),
        shutterFeatures(),
        [{ name: 'PGLAB_SHUTTER', value: String(n) }],
      );
    }
    for (const n of layout.relays) {
      const safe = isSafeOutput(safeOutputs, board.id, n, { single });
      add(
        board,
        'relay',
        `${board.id}-${n}`,
        'relay',
        n,
        deviceName('relay', board.name, n, language),
        relayFeatures({ safe }),
        [{ name: 'PGLAB_RELAY', value: String(n) }],
      );
    }
  }
  return model;
}
