// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in pglab-state.json, readable by the container user only (0600):
//   - `refused`: the broker refused the credentials. Final: no automatic
//     new try, even across a restart; only other credentials (saved in the
//     configuration) or the "Test the connection" button connect again, and
//     the stop is lifted only once a connection succeeded.
//   - `boards`: per board id, the configuration the user accepted: its name
//     (which routes the topics), its type, its MAC, its number of shutters
//     and its extension boards. The first discovery of an unknown board is
//     accepted (64 boards at most); a later discovery that changes any of
//     it is never applied by itself, only by a Scan in the Discovery tab,
//     which also forgets the boards no longer announced and without a
//     device in Gladys. What a board publishes never turns an output into
//     something commandable; the stop and the close of a shutter are routed
//     from this configuration, before any announcement.
// Never a secret: no user name, no password, not even a hash of them. Read
// back bounded, only known keys of the expected shape (never an inherited or
// `__proto__` key).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { DEVICE_TYPES, LIMITS } from './constants.js';
import { isName } from './protocol.js';

export const STATE_FILE = '/data/pglab-state.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 64 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failing` refuses every save. */
export function memoryStore(initial = null, { failing = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;

/** A layout as kept in /data, or undefined when its shape is wrong. */
export function normalizeLayout(raw) {
  const name = own(raw, 'name');
  const type = own(raw, 'type');
  const mac = own(raw, 'mac');
  const shutters = own(raw, 'shutters');
  const boards = own(raw, 'boards');
  if (typeof mac !== 'string' || !MAC.test(mac) || !isName(name) || !DEVICE_TYPES.includes(type)) {
    return undefined;
  }
  if (shutters === null && boards === null) {
    // A board without outputs (E-Switch, E-Relay in pypglab 0.0.5).
    return { name, type, mac, shutters: null, boards: null };
  }
  if (
    !Number.isInteger(shutters) ||
    shutters < 0 ||
    shutters > LIMITS.shutters ||
    typeof boards !== 'string' ||
    !/^[01]{8}$/.test(boards)
  ) {
    return undefined;
  }
  return { name, type, mac, shutters, boards };
}

/** The persisted state, repaired and bounded. */
export function normalizeMemory(raw) {
  const boards = new Map();
  const rawBoards = own(raw, 'boards');
  if (isObject(rawBoards)) {
    for (const id of Object.keys(rawBoards)) {
      if (boards.size >= LIMITS.boards) {
        break;
      }
      const layout = ID.test(id) ? normalizeLayout(own(rawBoards, id)) : undefined;
      if (layout) {
        boards.set(id, layout);
      }
    }
  }
  return { refused: own(raw, 'refused') === true, boards };
}

export const serializeMemory = ({ refused, boards }) => ({
  refused,
  boards: Object.fromEntries(
    [...boards].map(([id, l]) => [
      id,
      { name: l.name, type: l.type, mac: l.mac, shutters: l.shutters, boards: l.boards },
    ]),
  ),
});
