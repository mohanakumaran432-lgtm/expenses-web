// The names and rules every storage backend shares. Nothing here touches a database.
//
// How the data is laid out (the same in the browser's IndexedDB and in the in-memory test backend):
//
//   One "row store" per kind of record (expenses, categories, ...), plus "settings" and "extras" (the memory of which
//   budget alerts were already shown). A row is { id, plain } when the data is not passcode-protected and
//   { id, sealed } (bytes) when it is. The "meta" store holds a few small named values:
//
//     format    { schema }            which layout this is, so a future version can migrate it
//     keyring   {...}                 the passcode-locked data key (present only when a passcode is set)
//     version   "<random text>"       changes on every write to the records; used to notice a second window writing
//     lock      { timeout }           how long the app may stay in the background before it locks
//     attempts  { failedAttempts, lockedUntil }   wrong-passcode count (so closing the app does not clear it)

import { AppError } from '../core/util.js';
import { stableStringify } from '../core/encoding.js';

export const DB_NAME = 'private-expense-tracker';
export const DB_VERSION = 1;
/** Bump when the layout of the rows changes. A store that sees a larger number refuses to touch the data. */
export const SCHEMA_VERSION = 1;

/** The record kinds, in the order they are written. `kind` names the reader/writer in core/models.js. */
export const LEDGER_STORES = Object.freeze([
  Object.freeze({ store: 'categories', list: 'categories', kind: 'category', upsert: 'categoriesToUpsert', remove: 'categoryIDsToDelete' }),
  Object.freeze({ store: 'subcategories', list: 'subcategories', kind: 'subcategory', upsert: 'subcategoriesToUpsert', remove: 'subcategoryIDsToDelete' }),
  Object.freeze({ store: 'paymentMethods', list: 'paymentMethods', kind: 'paymentMethod', upsert: 'paymentMethodsToUpsert', remove: 'paymentMethodIDsToDelete' }),
  Object.freeze({ store: 'tags', list: 'tags', kind: 'tag', upsert: 'tagsToUpsert', remove: 'tagIDsToDelete' }),
  Object.freeze({ store: 'expenses', list: 'expenses', kind: 'expense', upsert: 'expensesToUpsert', remove: 'expenseIDsToDelete' }),
  Object.freeze({ store: 'budgets', list: 'budgets', kind: 'budget', upsert: 'budgetsToUpsert', remove: 'budgetIDsToDelete' }),
  Object.freeze({ store: 'templates', list: 'templates', kind: 'template', upsert: 'templatesToUpsert', remove: 'templateIDsToDelete' }),
  Object.freeze({ store: 'recurrenceLog', list: 'recurrenceLog', kind: 'logEntry', upsert: 'logEntriesToUpsert', remove: 'logEntryIDsToDelete' }),
]);

export const SETTINGS_STORE = 'settings';
export const SETTINGS_ROW_ID = 'settings';
export const EXTRAS_STORE = 'extras';
export const FIRED_ALERTS_ROW_ID = 'firedAlerts';
export const META_STORE = 'meta';

/** Every store whose rows are encrypted when a passcode is set. */
export const ROW_STORES = Object.freeze([...LEDGER_STORES.map((entry) => entry.store), SETTINGS_STORE, EXTRAS_STORE]);

export const META_KEYS = Object.freeze({
  format: 'format',
  keyring: 'keyring',
  version: 'version',
  lock: 'lock',
  attempts: 'attempts',
});

export const STORAGE_MESSAGES = Object.freeze({
  unavailable: 'This browser is not letting the app save data on this device. Open the app from its Home Screen icon, and make sure it is not a private tab.',
  full: 'There is no room left to save. Free some space on your iPhone, or export a backup first. Nothing was changed.',
  conflict: 'Your data was changed in another window of this app, so this change was not saved. Reload to continue.',
  failed: 'The change could not be saved. Nothing was changed.',
  newerVersion: 'This data was saved by a newer version of the app. Update the app (close and reopen it) before using it.',
  unrecognized: 'The layout of the saved data is not recognised, so the app will not change it. Restore from a backup file.',
  locked: 'The data is locked. Enter your passcode first.',
  empty: 'There is no data yet.',
  alreadyInitialized: 'There is already data in this app.',
  unreadableRecords: 'Some saved records could not be read, so this cannot be done safely. Export a backup, restore it (that rewrites everything cleanly), and try again.',
  alreadyProtected: 'A passcode is already set.',
  notProtected: 'No passcode is set.',
  weakPasscode: 'Choose a different passcode.',
});

export function storageError(code, details) {
  return new AppError('storage', code, STORAGE_MESSAGES[code] || STORAGE_MESSAGES.failed, details);
}

/** A random text token (the "version"): never repeats, so a changed-and-changed-back store is still noticed. */
export function newVersionToken() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/** True when two keyrings (or two absences of one) are the same stored value. */
export function sameKeyring(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}
