// The real storage: the browser's IndexedDB. It has the same behaviour as the in-memory backend (backend_memory.js),
// and the same contract checks run against both.
//
// - Every write is ONE transaction: all of it is stored or none of it. Encryption happens before the transaction opens
//   (a transaction closes by itself if the code waits for anything that is not a database request).
// - The write first reads the stored version inside the same transaction and compares it with the version the caller
//   expects. Two windows of the app can therefore never overwrite each other's changes unnoticed.
// - Writes ask for "strict" durability: the browser must put the data on disk before reporting success.
// - Nothing is sent anywhere. IndexedDB belongs to this web address and stays on the device.

import { AppError } from '../core/util.js';
import {
  DB_NAME, DB_VERSION, META_KEYS, META_STORE, ROW_STORES, newVersionToken, storageError,
} from './stores.js';

const ALL_STORES = Object.freeze([...ROW_STORES, META_STORE]);

/** Turns whatever the browser threw into one of this app's storage errors. Carries no personal data. */
export function mapStorageError(error) {
  if (error instanceof AppError) return error;
  const name = error && error.name;
  if (name === 'QuotaExceededError') return storageError('full');
  if (name === 'SecurityError' || name === 'NotSupportedError') return storageError('unavailable', { name });
  return storageError('failed', { name: name || 'Error' });
}

export class IndexedDbBackend {
  #name;
  #factory;
  #db = null;
  #connecting = null;

  constructor(name, factory) {
    this.#name = name;
    this.#factory = factory;
  }

  /** Opens (creating on first use) the database. Rejects with AppError('storage', 'unavailable') when the browser refuses. */
  static async open({ name = DB_NAME, factory = globalThis.indexedDB } = {}) {
    if (!factory) throw storageError('unavailable');
    const backend = new IndexedDbBackend(name, factory);
    await backend.#connect();
    return backend;
  }

  /** Deletes a whole database. Only the tests use this, to clean up the databases they created. */
  static destroy(name, factory = globalThis.indexedDB) {
    return new Promise((resolve, reject) => {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(mapStorageError(request.error));
      request.onblocked = () => {};
    });
  }

  #connect() {
    if (!this.#connecting) {
      const attempt = new Promise((resolve, reject) => {
        let request;
        try {
          request = this.#factory.open(this.#name, DB_VERSION);
        } catch (error) {
          reject(mapStorageError(error));
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of ROW_STORES) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another window asked to delete or upgrade the database: let go, and reconnect on the next use.
          db.onversionchange = () => {
            db.close();
            if (this.#db === db) this.#db = null;
          };
          db.onclose = () => {
            if (this.#db === db) this.#db = null;
          };
          this.#db = db;
          resolve(db);
        };
        request.onerror = (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          reject(mapStorageError(request.error));
        };
        request.onblocked = () => {};
      });
      this.#connecting = attempt;
      const clear = () => {
        if (this.#connecting === attempt) this.#connecting = null;
      };
      attempt.then(clear, clear);
    }
    return this.#connecting;
  }

  async #database() {
    return this.#db || this.#connect();
  }

  /**
   * Runs `work(tx, done, fail)` inside one transaction and resolves with whatever `done(value)` was given once the
   * transaction has COMPLETED (so the data is stored). `fail(error)` aborts the transaction, undoing everything.
   */
  async #transaction(storeNames, mode, work) {
    let db = await this.#database();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#runOnce(db, storeNames, mode, work);
      } catch (error) {
        // The connection may have been closed by another window since we last used it: reconnect once.
        if (attempt === 0 && error && error.details && error.details.name === 'InvalidStateError') {
          this.#db = null;
          db = await this.#connect();
        } else {
          throw error;
        }
      }
    }
  }

  #runOnce(db, storeNames, mode, work) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = mode === 'readwrite'
          ? db.transaction(storeNames, mode, { durability: 'strict' })
          : db.transaction(storeNames, mode);
      } catch (error) {
        reject(mapStorageError(error));
        return;
      }
      let result;
      let failure = null;
      const fail = (error) => {
        if (failure === null) failure = mapStorageError(error);
        try {
          tx.abort();
        } catch {
          // Already finished.
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || mapStorageError(tx.error));
      try {
        work(tx, (value) => { result = value; }, fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  // The contract ------------------------------------------------------------------------------------

  async load({ rows = true } = {}) {
    return this.#transaction(rows ? ALL_STORES : [META_STORE], 'readonly', (tx, done) => {
      const out = { version: null, meta: {}, rows: {} };
      const metaRequest = tx.objectStore(META_STORE).getAll();
      metaRequest.onsuccess = () => {
        for (const item of metaRequest.result) {
          if (item.key === META_KEYS.version) out.version = item.value;
          else out.meta[item.key] = item.value;
        }
      };
      if (rows) {
        for (const name of ROW_STORES) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => { out.rows[name] = request.result; };
        }
      }
      done(out);
    });
  }

  async commit({ expectVersion = null, ops = [], meta = {} } = {}) {
    const version = newVersionToken();
    await this.#transaction(ALL_STORES, 'readwrite', (tx, done, fail) => {
      const metaStore = tx.objectStore(META_STORE);
      const read = metaStore.get(META_KEYS.version);
      read.onsuccess = () => {
        try {
          const current = read.result ? read.result.value : null;
          if (current !== expectVersion) {
            fail(storageError('conflict'));
            return;
          }
          for (const operation of ops) {
            if (operation.op === 'clear') tx.objectStore(operation.store).clear();
            else if (operation.op === 'put') tx.objectStore(operation.store).put(operation.row);
            else if (operation.op === 'delete') tx.objectStore(operation.store).delete(operation.id);
            else throw storageError('failed', { reason: 'unknown operation' });
          }
          for (const [key, value] of Object.entries(meta)) {
            if (key === META_KEYS.version) throw storageError('failed', { reason: 'version is reserved' });
            if (value === null || value === undefined) metaStore.delete(key);
            else metaStore.put({ key, value });
          }
          metaStore.put({ key: META_KEYS.version, value: version });
        } catch (error) {
          fail(error);
        }
      };
    });
    return version;
  }

  async getMeta(key) {
    return this.#transaction([META_STORE], 'readonly', (tx, done) => {
      const request = tx.objectStore(META_STORE).get(key);
      request.onsuccess = () => done(request.result ? request.result.value : null);
    });
  }

  async putMeta(key, value) {
    if (key === META_KEYS.version) throw storageError('failed', { reason: 'version is reserved' });
    await this.#transaction([META_STORE], 'readwrite', (tx) => {
      tx.objectStore(META_STORE).put({ key, value });
    });
  }

  async deleteMeta(key) {
    if (key === META_KEYS.version) throw storageError('failed', { reason: 'version is reserved' });
    await this.#transaction([META_STORE], 'readwrite', (tx) => {
      tx.objectStore(META_STORE).delete(key);
    });
  }

  /**
   * Removes every record and every small value in one transaction. (The database itself is left in place:
   * deleting it can be blocked by another open window, and clearing is complete and cannot be blocked.)
   */
  async eraseAll() {
    await this.#transaction(ALL_STORES, 'readwrite', (tx) => {
      for (const name of ALL_STORES) tx.objectStore(name).clear();
    });
  }

  close() {
    if (this.#db) this.#db.close();
    this.#db = null;
  }
}
