// An in-memory stand-in for the browser database. It follows exactly the same rules as the real one
// (backend_indexeddb.js): writes are all-or-nothing, a write names the version it expects and is refused if another
// writer got there first, and everything stored is a copy, so changing an object after saving it changes nothing.
// The tests use it, and a shared set of contract checks (tests/backend_contract.mjs) holds both to the same behaviour.
//
// The backend contract:
//   load({ rows })                      -> { version, meta: {key: value}, rows: {store: [row]} }
//   commit({ expectVersion, ops, meta })-> new version. ops = [{op:'put',store,row} | {op:'delete',store,id} | {op:'clear',store}]
//                                          applied in order; meta = {key: value, key: null (delete)}.
//                                          Throws AppError('storage','conflict') when the version is not the expected one.
//   getMeta(key) / putMeta(key, value) / deleteMeta(key)   small values that are not part of the versioned records
//   eraseAll()                          removes everything, including the version
//   close()

import { META_KEYS, ROW_STORES, newVersionToken, storageError } from './stores.js';

export class MemoryBackend {
  constructor() {
    this.rows = new Map(ROW_STORES.map((name) => [name, new Map()]));
    this.meta = new Map();
    /** Makes the NEXT record write fail without changing anything: 'failed', 'full' or 'unavailable'. */
    this.failNext = null;
    /** Makes every read fail (tests of unreadable storage). */
    this.failLoad = false;
    /** Makes every small-value write (lock timeout, wrong-passcode count) fail. */
    this.failMeta = false;
    this.commitCount = 0;
    this.loadCount = 0;
  }

  async load({ rows = true } = {}) {
    if (this.failLoad) throw storageError('unavailable');
    this.loadCount += 1;
    const result = { version: this.meta.has(META_KEYS.version) ? this.meta.get(META_KEYS.version) : null, meta: {}, rows: {} };
    for (const [key, value] of this.meta) {
      if (key !== META_KEYS.version) result.meta[key] = structuredClone(value);
    }
    if (rows) {
      for (const name of ROW_STORES) result.rows[name] = Array.from(this.rows.get(name).values(), (row) => structuredClone(row));
    }
    return result;
  }

  async commit({ expectVersion = null, ops = [], meta = {} } = {}) {
    const current = this.meta.has(META_KEYS.version) ? this.meta.get(META_KEYS.version) : null;
    if (current !== expectVersion) throw storageError('conflict');
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = null;
      throw storageError(code);
    }
    try {
      // Work on copies, so a problem half-way through leaves everything exactly as it was.
      const work = new Map();
      const copyOf = (name) => {
        if (!this.rows.has(name)) throw storageError('failed', { reason: 'unknown store' });
        if (!work.has(name)) work.set(name, new Map(this.rows.get(name)));
        return work.get(name);
      };
      for (const operation of ops) {
        if (operation.op === 'clear') {
          copyOf(operation.store).clear();
        } else if (operation.op === 'put') {
          const row = operation.row;
          if (!row || typeof row.id !== 'string') throw storageError('failed', { reason: 'row without id' });
          copyOf(operation.store).set(row.id, structuredClone(row));
        } else if (operation.op === 'delete') {
          copyOf(operation.store).delete(operation.id);
        } else {
          throw storageError('failed', { reason: 'unknown operation' });
        }
      }
      const metaWork = new Map(this.meta);
      for (const [key, value] of Object.entries(meta)) {
        if (key === META_KEYS.version) throw storageError('failed', { reason: 'version is reserved' });
        if (value === null || value === undefined) metaWork.delete(key);
        else metaWork.set(key, structuredClone(value));
      }
      const version = newVersionToken();
      metaWork.set(META_KEYS.version, version);
      for (const [name, map] of work) this.rows.set(name, map);
      this.meta = metaWork;
      this.commitCount += 1;
      return version;
    } catch (error) {
      if (error && error.kind === 'storage') throw error;
      throw storageError('failed', { name: error && error.name });
    }
  }

  async getMeta(key) {
    if (this.failLoad) throw storageError('unavailable');
    return this.meta.has(key) ? structuredClone(this.meta.get(key)) : null;
  }

  async putMeta(key, value) {
    if (key === META_KEYS.version) throw storageError('failed', { reason: 'version is reserved' });
    if (this.failMeta) throw storageError('failed');
    this.meta.set(key, structuredClone(value));
  }

  async deleteMeta(key) {
    if (key === META_KEYS.version) throw storageError('failed', { reason: 'version is reserved' });
    if (this.failMeta) throw storageError('failed');
    this.meta.delete(key);
  }

  async eraseAll() {
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = null;
      throw storageError(code);
    }
    this.rows = new Map(ROW_STORES.map((name) => [name, new Map()]));
    this.meta = new Map();
  }

  close() {}

  // For tests: look at and change what is stored, the way someone with access to the storage could ------------------

  /** Everything stored, as one piece of text (bytes become characters), to prove that a secret never appears in it. */
  dump() {
    const replacer = (key, value) => (value instanceof Uint8Array ? Array.from(value, (byte) => String.fromCharCode(byte)).join('') : value);
    return JSON.stringify({
      meta: Object.fromEntries(this.meta),
      rows: Object.fromEntries(Array.from(this.rows, ([name, map]) => [name, Array.from(map.values())])),
    }, replacer);
  }

  rawRows(store) {
    return Array.from(this.rows.get(store).values(), (row) => structuredClone(row));
  }

  rawRow(store, id) {
    const row = this.rows.get(store).get(id);
    return row === undefined ? null : structuredClone(row);
  }

  /** Writes a row directly, without the version changing (as if another program edited the storage). */
  rawPut(store, row) {
    this.rows.get(store).set(row.id, structuredClone(row));
  }

  rawDelete(store, id) {
    this.rows.get(store).delete(id);
  }

  rawMeta(key) {
    return this.meta.has(key) ? structuredClone(this.meta.get(key)) : null;
  }

  rawPutMeta(key, value) {
    this.meta.set(key, structuredClone(value));
  }
}
