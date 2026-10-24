// Fixtures: the discovery of an E-Board as pypglab expects it, and its topics.

export const BOARD_ID = 'DD53AC85';
export const BOARD_NAME = 'E-BOARD-DD53AC85';
export const MAC = 'aa:bb:cc:dd:53:85';
export const SELECTOR = 'pglab';

export function discovery(overrides = {}, params = { shutters: 2, boards: '11000000' }) {
  return {
    ip: '192.168.1.40',
    mac: 'AA:BB:CC:DD:53:85',
    id: BOARD_ID,
    name: BOARD_NAME,
    type: 'E-BOARD',
    manufacturer: 'PG LAB Electronics',
    hw: '1.0.0',
    fw: '1.2.3',
    params,
    ...overrides,
  };
}

export const topic = {
  discovery: (id = BOARD_ID) => `pglab/discovery/${id}/config`,
  relay: (n, name = BOARD_NAME) => `pglab/${name}/relay/${n}/state`,
  relaySet: (n, name = BOARD_NAME) => `pglab/${name}/relay/${n}/set`,
  shutter: (n, name = BOARD_NAME) => `pglab/${name}/shutter/${n}/state`,
  shutterSet: (n, name = BOARD_NAME) => `pglab/${name}/shutter/${n}/set`,
  sensor: (name = BOARD_NAME) => `pglab/${name}/sensor/value`,
};

/** The external ids the SDK builds (fake Gladys selector "pglab"). */
export const ext = {
  board: (id = BOARD_ID) => `ext:${SELECTOR}:board:${id}`,
  relay: (n, id = BOARD_ID) => `ext:${SELECTOR}:relay:${id}-${n}`,
  shutter: (n, id = BOARD_ID) => `ext:${SELECTOR}:shutter:${id}-${n}`,
};
