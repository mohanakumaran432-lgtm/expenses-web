// The app's real store. Screens read `snapshot` (plain values) and save through `commit(changes)`.
//
// What it guarantees:
// - A save is all-or-nothing: one database transaction. The snapshot the screens see changes only AFTER the save
//   succeeded, so the screen can never show something that was not stored.
// - Saves run one after the other. A save names the version of the data it started from; if another window of the app
//   saved in between, this save is refused (error code 'conflict') instead of overwriting that window's work.
// - With a passcode set, every record is encrypted (see core/vault.js) before it reaches the database. Without a
//   passcode the records are stored as plain readable JSON, and the app says so on its privacy screen.
// - Records that cannot be read (damaged, changed, or placed where they do not belong) are counted and left out; the
//   rest of the data still opens. Nothing is rewritten or erased silently, and changing the passcode is refused until
//   the person has restored a clean copy.
// - While the app is locked, `snapshot` is empty and saving is refused.
//
// States: 'empty' (nothing saved yet: first start), 'locked' (a passcode is set and has not been entered), 'ready'.

import { AppError } from '../core/util.js';
import { LedgerSnapshot } from '../core/snapshot.js';
import { defaultSettings, fromWire, settingsToWire, toWire } from '../core/models.js';
import {
  PASSCODE_PROBLEMS, checkNewPasscode, createKeyring, openKeyring, openRecord, reprotect, sealRecord,
} from '../core/vault.js';
import {
  EXTRAS_STORE, FIRED_ALERTS_ROW_ID, LEDGER_STORES, META_KEYS, ROW_STORES, SCHEMA_VERSION, SETTINGS_ROW_ID, SETTINGS_STORE,
  sameKeyring, storageError,
} from './stores.js';

export const STORE_STATES = Object.freeze({ empty: 'empty', locked: 'locked', ready: 'ready' });

/** Records are sealed and opened in groups, so thousands of them do not queue up thousands of tiny jobs at once. */
const BATCH = 256;

function weakPasscodeError(problem) {
  return new AppError('vault', 'weakPasscode', PASSCODE_PROBLEMS[problem] || 'Choose a different passcode.', { problem });
}

function requireGoodPasscode(passcode) {
  const check = checkNewPasscode(passcode);
  if (!check.ok) throw weakPasscodeError(check.problem);
}

function emptyUnreadable() {
  return { total: 0, byStore: {} };
}

export class LedgerStore {
  #backend;
  #state = STORE_STATES.empty;
  #keyring = null;
  #dek = null;
  #snapshot = null;
  #firedAlertKeys = new Set();
  #version = null;
  #unreadable = emptyUnreadable();
  #stale = false;
  #tail = Promise.resolve();
  #listeners = new Set();
  #reportListenerError;

  constructor(backend, { reportListenerError = (error) => queueMicrotask(() => { throw error; }) } = {}) {
    this.#backend = backend;
    this.#reportListenerError = reportListenerError;
  }

  /**
   * Looks at what is stored. Plain data is loaded straight away; protected data waits for the passcode.
   * `reportListenerError(error)` is told about a screen that failed while being notified (by default the error is
   * re-thrown so it shows up in the console; a failing screen never stops the saving).
   */
  static async open(backend, options) {
    const store = new LedgerStore(backend, options);
    await store.#enqueue(() => store.#refresh());
    return store;
  }

  // What the screens can read ----------------------------------------------------------------------

  get state() { return this.#state; }
  get isReady() { return this.#state === STORE_STATES.ready; }
  /** True when a passcode is set (the data is encrypted). */
  get isProtected() { return this.#keyring !== null; }
  /** True after another window saved first; saving stays refused until `reload()`. */
  get isStale() { return this.#stale; }
  /** Everything the app knows. Empty (and harmless) while the app is locked or has no data. */
  get snapshot() { return this.#snapshot || new LedgerSnapshot(); }
  /** How many saved records could not be read the last time the data was loaded. */
  get unreadableCount() { return this.#unreadable.total; }
  get unreadableByStore() { return { ...this.#unreadable.byStore }; }
  /** The budget alerts already shown (a copy). */
  get firedAlertKeys() { return new Set(this.#firedAlertKeys); }

  /** `listener(store, reason)` runs after every change ('state', 'commit' or 'replace'). Returns a function that stops listening. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(reason) {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(this, reason);
      } catch (error) {
        // A screen that fails must not stop the saving, but the failure must not vanish either.
        this.#reportListenerError(error);
      }
    }
  }

  // Order of work ----------------------------------------------------------------------------------

  /** Runs `task` after everything queued before it has finished (whether that succeeded or not). */
  #enqueue(task) {
    const run = this.#tail.then(task);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #requireReady() {
    if (this.#state === STORE_STATES.empty) throw storageError('empty');
    if (this.#state === STORE_STATES.locked) throw storageError('locked');
    if (this.#stale) throw storageError('conflict');
  }

  // Reading ----------------------------------------------------------------------------------------

  /** Looks at what is stored and brings this store in line with it. Keeps the key when the protection did not change. */
  async #refresh() {
    const loaded = await this.#backend.load({ rows: false });
    const format = loaded.meta[META_KEYS.format] ?? null;
    const keyring = loaded.meta[META_KEYS.keyring] ?? null;
    if (format !== null) {
      if (typeof format !== 'object' || !Number.isInteger(format.schema) || format.schema < 1) throw storageError('unrecognized');
      if (format.schema > SCHEMA_VERSION) throw storageError('newerVersion');
    }
    const keepKey = this.#dek !== null && sameKeyring(keyring, this.#keyring);
    this.#version = loaded.version;
    this.#keyring = keyring;
    this.#stale = false;
    if (!keepKey) {
      this.#dek = null;
      this.#snapshot = null;
      this.#firedAlertKeys = new Set();
      this.#unreadable = emptyUnreadable();
    }
    if (keyring !== null) {
      if (keepKey) await this.#loadRows(this.#dek, keyring);
      else this.#state = STORE_STATES.locked;
    } else if (format === null) {
      this.#state = STORE_STATES.empty;
    } else {
      await this.#loadRows(null, null);
    }
    this.#notify('state');
  }

  /**
   * Reads and opens every record. `expectedKeyring` is the keyring `dek` came from; the records are read in the same
   * step as the keyring, so if it changed in between the key would not fit and this refuses instead of guessing.
   */
  async #loadRows(dek, expectedKeyring) {
    const loaded = await this.#backend.load({ rows: true });
    const keyringNow = loaded.meta[META_KEYS.keyring] ?? null;
    if (!sameKeyring(keyringNow, expectedKeyring)) throw storageError('conflict');

    const parts = {};
    const unreadable = emptyUnreadable();
    for (const entry of LEDGER_STORES) {
      const { records, bad } = await this.#decodeRows(entry.store, loaded.rows[entry.store], dek, fromWire[entry.kind]);
      parts[entry.list] = records;
      if (bad > 0) {
        unreadable.byStore[entry.store] = bad;
        unreadable.total += bad;
      }
    }

    let settings = defaultSettings();
    const settingsRow = loaded.rows[SETTINGS_STORE].find((row) => row.id === SETTINGS_ROW_ID);
    try {
      if (!settingsRow) throw new Error('missing');
      settings = fromWire.settings(await this.#openRow(SETTINGS_STORE, settingsRow, dek));
    } catch {
      unreadable.byStore[SETTINGS_STORE] = 1;
      unreadable.total += 1;
    }

    // The memory of shown alerts is a convenience; if it cannot be read it simply starts again.
    let firedKeys = new Set();
    const extrasRow = loaded.rows[EXTRAS_STORE].find((row) => row.id === FIRED_ALERTS_ROW_ID);
    if (extrasRow) {
      try {
        const wire = await this.#openRow(EXTRAS_STORE, extrasRow, dek);
        if (Array.isArray(wire.keys) && wire.keys.every((key) => typeof key === 'string')) firedKeys = new Set(wire.keys);
      } catch {
        firedKeys = new Set();
      }
    }

    this.#version = loaded.version;
    this.#snapshot = new LedgerSnapshot({ ...parts, settings }).normalizeOrder();
    this.#firedAlertKeys = firedKeys;
    this.#unreadable = unreadable;
    this.#state = STORE_STATES.ready;
  }

  async #decodeRows(storeName, rows, dek, reader) {
    const records = [];
    let bad = 0;
    for (let start = 0; start < rows.length; start += BATCH) {
      const decoded = await Promise.all(rows.slice(start, start + BATCH).map(async (row) => {
        try {
          const record = reader(await this.#openRow(storeName, row, dek));
          // The record must carry the id it is filed under, or it was moved.
          return record.id === row.id ? record : null;
        } catch {
          return null;
        }
      }));
      for (const record of decoded) {
        if (record === null) bad += 1;
        else records.push(record);
      }
    }
    return { records, bad };
  }

  /** The JSON inside one stored row. A protected store accepts only sealed rows; a plain store only plain ones. */
  async #openRow(storeName, row, dek) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string') throw new Error('not a row');
    if (dek !== null) {
      if (!(row.sealed instanceof Uint8Array)) throw new Error('not sealed');
      return openRecord(dek, storeName, row.id, row.sealed);
    }
    if (row.plain === null || typeof row.plain !== 'object') throw new Error('not plain');
    return row.plain;
  }

  // Writing ----------------------------------------------------------------------------------------

  async #rowFor(storeName, id, wire, dek) {
    if (dek !== null) return { id, sealed: await sealRecord(dek, storeName, id, wire) };
    return { id, plain: wire };
  }

  /** Records are filed under their upper-case id, the same spelling a backup uses; anything else would not be found again. */
  static #requireCanonicalId(id) {
    if (typeof id !== 'string' || id === '' || id !== id.toUpperCase()) throw storageError('failed', { reason: 'id is not canonical' });
    return id;
  }

  async #putOps(storeName, items, wireOf, dek) {
    const ops = [];
    for (let start = 0; start < items.length; start += BATCH) {
      const rows = await Promise.all(items.slice(start, start + BATCH).map(
        (item) => this.#rowFor(storeName, LedgerStore.#requireCanonicalId(item.id), wireOf(item), dek),
      ));
      for (const row of rows) ops.push({ op: 'put', store: storeName, row });
    }
    return ops;
  }

  /** The database steps for one set of changes, in the order that gives the same result as `snapshot.apply`. */
  async #opsForChanges(changes, dek) {
    const ops = [];
    for (const entry of LEDGER_STORES) {
      const puts = await this.#putOps(entry.store, changes[entry.upsert], toWire[entry.kind], dek);
      const deletes = changes[entry.remove].map((id) => ({ op: 'delete', store: entry.store, id }));
      // Expenses: deletions first, then saves. Everything else: saves first, then deletions (as snapshot.apply does).
      if (entry.store === 'expenses') ops.push(...deletes, ...puts);
      else ops.push(...puts, ...deletes);
    }
    if (changes.settings) {
      ops.push({ op: 'put', store: SETTINGS_STORE, row: await this.#rowFor(SETTINGS_STORE, SETTINGS_ROW_ID, settingsToWire(changes.settings), dek) });
    }
    return ops;
  }

  /** The steps that wipe every record store and write `snapshot` (and the alert memory) in its place. */
  async #opsForEverything(snapshot, firedKeys, dek) {
    const ops = ROW_STORES.map((store) => ({ op: 'clear', store }));
    for (const entry of LEDGER_STORES) ops.push(...await this.#putOps(entry.store, snapshot[entry.list], toWire[entry.kind], dek));
    ops.push({ op: 'put', store: SETTINGS_STORE, row: await this.#rowFor(SETTINGS_STORE, SETTINGS_ROW_ID, settingsToWire(snapshot.settings), dek) });
    if (firedKeys.size > 0) {
      ops.push({
        op: 'put', store: EXTRAS_STORE, row: await this.#rowFor(EXTRAS_STORE, FIRED_ALERTS_ROW_ID, { keys: Array.from(firedKeys).sort() }, dek),
      });
    }
    return ops;
  }

  async #write(ops, meta = {}) {
    try {
      this.#version = await this.#backend.commit({ expectVersion: this.#version, ops, meta });
    } catch (error) {
      if (error && error.code === 'conflict') this.#stale = true;
      throw error;
    }
  }

  // Saving -----------------------------------------------------------------------------------------

  /** Saves a group of changes together. Nothing changes if any part fails. */
  commit(changes) {
    return this.#enqueue(async () => {
      this.#requireReady();
      if (changes.isEmpty) return;
      const dek = this.#dek;
      const snapshot = this.#snapshot;
      const ops = await this.#opsForChanges(changes, dek);
      await this.#write(ops);
      snapshot.apply(changes);
      this.#notify('commit');
    });
  }

  /** Replaces everything in one all-or-nothing step (restoring a backup). The passcode and lock settings are untouched. */
  replaceAll(snapshot) {
    return this.#enqueue(async () => {
      this.#requireReady();
      const next = snapshot.clone().normalizeOrder();
      const ops = await this.#opsForEverything(next, new Set(), this.#dek);
      await this.#write(ops);
      this.#snapshot = next;
      this.#firedAlertKeys = new Set();
      this.#unreadable = emptyUnreadable();
      this.#notify('replace');
    });
  }

  /** Remembers which budget alerts were already shown. */
  saveFiredAlertKeys(keys) {
    return this.#enqueue(async () => {
      this.#requireReady();
      const wanted = new Set(keys);
      const row = await this.#rowFor(EXTRAS_STORE, FIRED_ALERTS_ROW_ID, { keys: Array.from(wanted).sort() }, this.#dek);
      await this.#write([{ op: 'put', store: EXTRAS_STORE, row }]);
      this.#firedAlertKeys = wanted;
    });
  }

  // First start ------------------------------------------------------------------------------------

  /**
   * Stores the first ledger (the default categories and settings, or the contents of a backup). With a passcode the
   * data is encrypted from the first byte.
   */
  initializeNew(snapshot, { passcode = null, iterations } = {}) {
    return this.#enqueue(async () => {
      if (this.#state !== STORE_STATES.empty) throw storageError('alreadyInitialized');
      let keyring = null;
      let dek = null;
      if (passcode !== null) {
        requireGoodPasscode(passcode);
        ({ keyring, dek } = await createKeyring(passcode, iterations === undefined ? undefined : { iterations }));
      }
      const next = snapshot.clone().normalizeOrder();
      const ops = await this.#opsForEverything(next, new Set(), dek);
      const meta = { [META_KEYS.format]: { schema: SCHEMA_VERSION } };
      if (keyring !== null) meta[META_KEYS.keyring] = keyring;
      await this.#write(ops, meta);
      this.#keyring = keyring;
      this.#dek = dek;
      this.#snapshot = next;
      this.#firedAlertKeys = new Set();
      this.#unreadable = emptyUnreadable();
      this.#stale = false;
      this.#state = STORE_STATES.ready;
      this.#notify('state');
    });
  }

  // The passcode -----------------------------------------------------------------------------------

  /**
   * Checks a passcode against the stored keyring (the freshest one, in case another window changed it) and returns the
   * key it unlocks. Changes nothing. Throws AppError('vault', 'wrongPasscode') for a wrong passcode.
   */
  async verifyKey(passcode) {
    const keyring = await this.#backend.getMeta(META_KEYS.keyring);
    if (keyring === null) throw storageError('notProtected');
    const dek = await openKeyring(keyring, passcode);
    return Object.freeze({ dek, keyring });
  }

  /** True when the passcode is right, false when it is wrong. Other problems (damaged keyring, storage) throw. */
  async verifyPasscode(passcode) {
    try {
      await this.verifyKey(passcode);
      return true;
    } catch (error) {
      if (error && error.code === 'wrongPasscode') return false;
      throw error;
    }
  }

  /** Opens the data with a key from `verifyKey`. Call it only once the app lock has agreed to open. */
  unlockWithKey(unlockKey) {
    return this.#enqueue(async () => {
      if (this.#state === STORE_STATES.ready) return;
      if (this.#state === STORE_STATES.empty) throw storageError('empty');
      await this.#loadRows(unlockKey.dek, unlockKey.keyring);
      this.#keyring = unlockKey.keyring;
      this.#dek = unlockKey.dek;
      this.#stale = false;
      this.#notify('state');
    });
  }

  /** Checks the passcode and opens the data. */
  async unlock(passcode) {
    await this.unlockWithKey(await this.verifyKey(passcode));
  }

  /** Forgets the key and the decrypted data. Does nothing when no passcode is set. */
  lock() {
    if (this.#keyring === null || this.#state !== STORE_STATES.ready) return;
    this.#dek = null;
    this.#snapshot = null;
    this.#firedAlertKeys = new Set();
    this.#unreadable = emptyUnreadable();
    this.#state = STORE_STATES.locked;
    this.#notify('state');
  }

  #requireProtectionChangeAllowed() {
    this.#requireReady();
    if (this.#unreadable.total > 0) throw storageError('unreadableRecords');
  }

  /** Sets a passcode: encrypts every record, in one all-or-nothing step. */
  enableProtection(passcode, { iterations } = {}) {
    return this.#enqueue(async () => {
      this.#requireProtectionChangeAllowed();
      if (this.#keyring !== null) throw storageError('alreadyProtected');
      requireGoodPasscode(passcode);
      const { keyring, dek } = await createKeyring(passcode, iterations === undefined ? undefined : { iterations });
      const ops = await this.#opsForEverything(this.#snapshot, this.#firedAlertKeys, dek);
      await this.#write(ops, { [META_KEYS.keyring]: keyring });
      this.#keyring = keyring;
      this.#dek = dek;
      this.#notify('state');
    });
  }

  /** Removes the passcode (needs it): every record is stored as plain readable JSON again. */
  disableProtection(passcode) {
    return this.#enqueue(async () => {
      this.#requireProtectionChangeAllowed();
      if (this.#keyring === null) throw storageError('notProtected');
      await openKeyring(this.#keyring, passcode); // throws wrongPasscode
      const ops = await this.#opsForEverything(this.#snapshot, this.#firedAlertKeys, null);
      await this.#write(ops, { [META_KEYS.keyring]: null });
      this.#keyring = null;
      this.#dek = null;
      this.#notify('state');
    });
  }

  /** Changes the passcode (needs the current one). Makes a NEW data key and re-encrypts everything in one step. */
  changePasscode(current, next, { iterations } = {}) {
    return this.#enqueue(async () => {
      this.#requireProtectionChangeAllowed();
      if (this.#keyring === null) throw storageError('notProtected');
      requireGoodPasscode(next);
      const { keyring, dek } = await reprotect(this.#keyring, current, next, iterations === undefined ? undefined : { iterations });
      const ops = await this.#opsForEverything(this.#snapshot, this.#firedAlertKeys, dek);
      await this.#write(ops, { [META_KEYS.keyring]: keyring });
      this.#keyring = keyring;
      this.#dek = dek;
      this.#notify('state');
    });
  }

  // Starting over ----------------------------------------------------------------------------------

  /** Deletes everything (records, passcode, lock settings). Works even when the app is locked: this is "forgot my passcode". */
  eraseEverything() {
    return this.#enqueue(async () => {
      await this.#backend.eraseAll();
      this.#keyring = null;
      this.#dek = null;
      this.#snapshot = null;
      this.#firedAlertKeys = new Set();
      this.#version = null;
      this.#unreadable = emptyUnreadable();
      this.#stale = false;
      this.#state = STORE_STATES.empty;
      this.#notify('state');
    });
  }

  /** After a 'conflict': reads what is stored now. If the passcode was changed elsewhere, the store locks. */
  reload() {
    return this.#enqueue(() => this.#refresh());
  }
}
