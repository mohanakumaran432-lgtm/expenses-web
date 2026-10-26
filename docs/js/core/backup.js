// Backup files: writing, opening, checking and restoring.
//
// The file layout is the iPhone app's (docs/BACKUP_FORMAT.md): a readable header plus the payload as base64 text, with
// the SHA-256 of the payload bytes so any change or damage is detected before anything is restored.
// A backup made here with no password opens in the iPhone app and the other way round.
//
// The web app adds one optional extra: a password-protected backup ("aes-256-gcm+pbkdf2-sha256+json+base64").
// The iPhone app does not know that encoding and says so instead of guessing.

import { AppError, isPlainObject } from './util.js';
import { isCurrencyCode } from './currency.js';
import { MAX_MINOR_UNITS } from './money.js';
import { comparisonKey } from './text.js';
import { LedgerSnapshot } from './snapshot.js';
import {
  WireError, fromWire, makeBudget, makeCategory, makeExpense, makeSubcategory, makeTemplate,
  normalizeSettings, settingsToWire, toWire,
} from './models.js';
import {
  base64ToBytes, bytesToBase64, sha256Hex, stableStringify, utf8Decode, utf8Encode, randomBytes,
} from './encoding.js';
import { MAX_ACCEPTED_ITERATIONS, MIN_ACCEPTED_ITERATIONS, PBKDF2_ITERATIONS, SALT_BYTES, deriveKey, open, seal } from './crypto.js';

export const BACKUP_FORMAT = 'private-expense-tracker-backup';
export const BACKUP_VERSION = 1;
export const ENCODING_PLAIN = 'json+base64';
export const ENCODING_PROTECTED = 'aes-256-gcm+pbkdf2-sha256+json+base64';
const KDF_NAME = 'PBKDF2-HMAC-SHA256';
/** A file bigger than this (in characters) is refused rather than risking a frozen page. */
export const MAX_BACKUP_CHARACTERS = 250_000_000;

export const BACKUP_MESSAGES = Object.freeze({
  notABackup: 'This file is not a backup made by this app.',
  unsupportedEncoding: 'This backup uses a storage method this version does not support.',
  passwordRequired: 'This backup is protected. Enter its password to open it.',
  wrongPassword: 'The password is wrong, or the backup was changed.',
});

function backupError(code, message, details) {
  return new AppError('backup', code, message || BACKUP_MESSAGES[code], details);
}

// ---------------------------------------------------------------- payload

const RECORD_LISTS = Object.freeze([
  ['categories', 'category'],
  ['subcategories', 'subcategory'],
  ['paymentMethods', 'paymentMethod'],
  ['tags', 'tag'],
  ['expenses', 'expense'],
  ['budgets', 'budget'],
  ['templates', 'template'],
  ['recurrenceLog', 'logEntry'],
]);

/** The JSON-ready form of everything the app knows. */
export function payloadToWire(snapshot) {
  const wire = { settings: settingsToWire(snapshot.settings) };
  for (const [listName, kind] of RECORD_LISTS) wire[listName] = snapshot[listName].map(toWire[kind]);
  return wire;
}

/** Reads a payload object (strictly). Throws WireError for any shape or value problem. */
export function payloadFromWire(object) {
  if (!isPlainObject(object)) throw new WireError('payload is not an object');
  const payload = { settings: fromWire.settings(object.settings) };
  for (const [listName, kind] of RECORD_LISTS) {
    const list = object[listName];
    if (!Array.isArray(list)) throw new WireError(`${listName} is not a list`);
    payload[listName] = list.map((item) => fromWire[kind](item));
  }
  return payload;
}

/** A snapshot holding the payload's records (ordered for use). */
export function payloadToSnapshot(payload) {
  const snapshot = new LedgerSnapshot({
    settings: payload.settings,
    categories: payload.categories.slice(),
    subcategories: payload.subcategories.slice(),
    paymentMethods: payload.paymentMethods.slice(),
    tags: payload.tags.slice(),
    expenses: payload.expenses.slice(),
    budgets: payload.budgets.slice(),
    templates: payload.templates.slice(),
    recurrenceLog: payload.recurrenceLog.slice(),
  });
  return snapshot.normalizeOrder();
}

export function payloadFromSnapshot(snapshot) {
  const payload = { settings: snapshot.settings };
  for (const [listName] of RECORD_LISTS) payload[listName] = snapshot[listName].slice();
  return payload;
}

/** Quick facts shown before a restore. */
export function backupCounts(payload) {
  let first = null;
  let last = null;
  for (const expense of payload.expenses) {
    if (first === null || expense.localDay.raw < first.raw) first = expense.localDay;
    if (last === null || expense.localDay.raw > last.raw) last = expense.localDay;
  }
  return {
    expenses: payload.expenses.length,
    categories: payload.categories.length,
    subcategories: payload.subcategories.length,
    paymentMethods: payload.paymentMethods.length,
    tags: payload.tags.length,
    budgets: payload.budgets.length,
    templates: payload.templates.length,
    recurrenceLog: payload.recurrenceLog.length,
    firstExpenseDay: first,
    lastExpenseDay: last,
  };
}

function countsToWire(counts) {
  const wire = { ...counts };
  wire.firstExpenseDay = counts.firstExpenseDay ? counts.firstExpenseDay.toString() : undefined;
  wire.lastExpenseDay = counts.lastExpenseDay ? counts.lastExpenseDay.toString() : undefined;
  if (wire.firstExpenseDay === undefined) delete wire.firstExpenseDay;
  if (wire.lastExpenseDay === undefined) delete wire.lastExpenseDay;
  return wire;
}

// ---------------------------------------------------------------- writing

function protectionAAD() {
  return utf8Encode(`${BACKUP_FORMAT}|${BACKUP_VERSION}|${ENCODING_PROTECTED}`);
}

/**
 * Builds the text of a complete backup file.
 * @param password  optional. When given, the payload is encrypted with a key made from it (and the counts are left out
 *                  of the readable header, so the file reveals nothing but its size).
 */
export async function makeBackup(snapshot, nowMs, appVersion, { password = '' } = {}) {
  const payload = payloadFromSnapshot(snapshot);
  const bytes = utf8Encode(stableStringify(payloadToWire(snapshot)));
  const envelope = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    createdAtMillis: Math.round(nowMs),
    appVersion,
  };

  if (password === '') {
    envelope.counts = countsToWire(backupCounts(payload));
    envelope.payloadEncoding = ENCODING_PLAIN;
    envelope.payloadSHA256 = await sha256Hex(bytes);
    envelope.payload = bytesToBase64(bytes);
  } else {
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const sealed = await seal(key, bytes, protectionAAD());
    envelope.payloadEncoding = ENCODING_PROTECTED;
    envelope.kdf = { name: KDF_NAME, iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) };
    envelope.payloadSHA256 = await sha256Hex(sealed);
    envelope.payload = bytesToBase64(sealed);
  }
  return stableStringify(envelope, 2);
}

// ---------------------------------------------------------------- opening

function readEnvelope(text) {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_CHARACTERS) throw backupError('notABackup');
  // Some editors put an invisible byte-order mark in front of a saved file. JSON does not allow one, so it is dropped.
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  let envelope;
  try {
    envelope = JSON.parse(clean);
  } catch {
    throw backupError('notABackup');
  }
  if (!isPlainObject(envelope)) throw backupError('notABackup');
  const okText = (key) => typeof envelope[key] === 'string';
  const okInt = (key) => Number.isSafeInteger(envelope[key]);
  if (!okText('format') || !okInt('formatVersion') || !okInt('createdAtMillis') || !okText('appVersion')
    || !okText('payloadEncoding') || !okText('payloadSHA256') || !okText('payload')) {
    throw backupError('notABackup');
  }
  return envelope;
}

/**
 * Opens a backup file and checks it completely. Nothing is restored here; this only proves the file is genuine,
 * undamaged, from a version this app understands, and internally consistent.
 * Throws AppError(kind 'backup'). code 'passwordRequired' means: ask for the password and call again with it.
 * Returns { info, payload, warnings }.
 */
export async function openBackup(text, { password = '' } = {}) {
  const envelope = readEnvelope(text);

  if (envelope.format !== BACKUP_FORMAT) throw backupError('notABackup');
  if (envelope.formatVersion < 1) throw backupError('notABackup');
  if (envelope.formatVersion > BACKUP_VERSION) {
    throw backupError(
      'newerVersion',
      `This backup was made by a newer version of the app (format ${envelope.formatVersion}); this version understands up to format ${BACKUP_VERSION}. Update the app to restore it.`,
      { found: envelope.formatVersion, supported: BACKUP_VERSION },
    );
  }
  if (envelope.payloadEncoding !== ENCODING_PLAIN && envelope.payloadEncoding !== ENCODING_PROTECTED) {
    throw backupError('unsupportedEncoding');
  }

  const stored = base64ToBytes(envelope.payload);
  if (stored === null) throw backupError('corrupted', 'The backup is damaged or was modified: the stored data is not readable.');
  if ((await sha256Hex(stored)) !== envelope.payloadSHA256.toLowerCase()) {
    throw backupError('corrupted', 'The backup is damaged or was modified: the checksum does not match, so the file was changed or damaged.');
  }

  let payloadBytes = stored;
  if (envelope.payloadEncoding === ENCODING_PROTECTED) {
    if (password === '') throw backupError('passwordRequired');
    const kdf = envelope.kdf;
    const salt = isPlainObject(kdf) ? base64ToBytes(kdf.salt) : null;
    if (!isPlainObject(kdf) || kdf.name !== KDF_NAME || salt === null || salt.length < 8
      || !Number.isSafeInteger(kdf.iterations)
      || kdf.iterations < MIN_ACCEPTED_ITERATIONS || kdf.iterations > MAX_ACCEPTED_ITERATIONS) {
      throw backupError('corrupted', 'The backup is damaged or was modified: its protection settings are not valid.');
    }
    const key = await deriveKey(password, salt, kdf.iterations);
    try {
      payloadBytes = await open(key, stored, protectionAAD());
    } catch {
      throw backupError('wrongPassword');
    }
  }

  let payload;
  try {
    payload = payloadFromWire(JSON.parse(utf8Decode(payloadBytes)));
  } catch {
    throw backupError('corrupted', 'The backup is damaged or was modified: the content could not be read.');
  }

  const problems = validatePayload(payload);
  const fatal = problems.filter((p) => p.isFatal).map((p) => p.message);
  if (fatal.length > 0) {
    throw backupError(
      'invalidContent',
      `The backup contains inconsistent data and was not restored: ${fatal.join(' ')}`,
      { problems: fatal },
    );
  }

  return {
    info: {
      formatVersion: envelope.formatVersion,
      createdAt: envelope.createdAtMillis,
      appVersion: envelope.appVersion,
      counts: backupCounts(payload),
      isProtected: envelope.payloadEncoding === ENCODING_PROTECTED,
    },
    payload,
    warnings: problems.filter((p) => !p.isFatal).map((p) => p.message),
  };
}

/** True when the file says it needs a password, judged from its header alone (nothing is decrypted). */
export function backupNeedsPassword(text) {
  try {
    return readEnvelope(text).payloadEncoding === ENCODING_PROTECTED;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- validation

function hasDuplicates(ids) {
  return new Set(ids).size !== ids.length;
}

/**
 * Checks that a backup's content is internally consistent BEFORE anything is restored.
 * Messages describe the kind and number of problems, never amounts or names.
 * Returns a list of { message, isFatal }.
 */
export function validatePayload(payload) {
  const problems = [];
  const fatal = (message) => problems.push({ message, isFatal: true });
  const warn = (message) => problems.push({ message, isFatal: false });

  if (hasDuplicates(payload.expenses.map((e) => e.id))) fatal('Some expenses share the same id.');
  if (hasDuplicates(payload.categories.map((c) => c.id))) fatal('Some categories share the same id.');
  if (hasDuplicates(payload.subcategories.map((s) => s.id))) fatal('Some subcategories share the same id.');
  if (hasDuplicates(payload.paymentMethods.map((p) => p.id))) fatal('Some payment methods share the same id.');
  if (hasDuplicates(payload.budgets.map((b) => b.id))) fatal('Some budgets share the same id.');
  if (hasDuplicates(payload.templates.map((t) => t.id))) fatal('Some recurring templates share the same id.');

  const categoryIDs = new Set(payload.categories.map((c) => c.id));
  const subcategoryParent = new Map(payload.subcategories.map((s) => [s.id, s.categoryID]));
  const methodIDs = new Set(payload.paymentMethods.map((p) => p.id));
  const templateIDs = new Set(payload.templates.map((t) => t.id));

  const orphanSubcategories = payload.subcategories.filter((s) => !categoryIDs.has(s.categoryID)).length;
  if (orphanSubcategories > 0) fatal(`${orphanSubcategories} subcategories belong to a missing category.`);

  let badAmounts = 0;
  let badCurrencies = 0;
  let missingCategory = 0;
  let badSubcategory = 0;
  let missingMethod = 0;
  let badDates = 0;
  for (const expense of payload.expenses) {
    if (expense.amount.minorUnits <= 0 || expense.amount.minorUnits > MAX_MINOR_UNITS) badAmounts += 1;
    if (!isCurrencyCode(expense.amount.currencyCode)) badCurrencies += 1;
    if (!categoryIDs.has(expense.categoryID)) missingCategory += 1;
    if (expense.subcategoryID && subcategoryParent.get(expense.subcategoryID) !== expense.categoryID) badSubcategory += 1;
    if (expense.paymentMethodID && !methodIDs.has(expense.paymentMethodID)) missingMethod += 1;
    if (expense.localDay.year < 1990 || expense.localDay.year > 2200) badDates += 1;
  }
  if (badAmounts > 0) fatal(`${badAmounts} expenses have an amount that is not valid.`);
  if (badCurrencies > 0) fatal(`${badCurrencies} expenses have an invalid currency code.`);
  if (missingCategory > 0) fatal(`${missingCategory} expenses point to a missing category.`);
  if (badSubcategory > 0) fatal(`${badSubcategory} expenses point to a subcategory that does not match their category.`);
  if (missingMethod > 0) fatal(`${missingMethod} expenses point to a missing payment method.`);
  if (badDates > 0) fatal(`${badDates} expenses have a date outside 1990-2200.`);

  let badBudgets = 0;
  for (const budget of payload.budgets) {
    if (budget.amount.minorUnits <= 0 || budget.amount.minorUnits > MAX_MINOR_UNITS) badBudgets += 1;
    if (budget.categoryID && !categoryIDs.has(budget.categoryID)) badBudgets += 1;
  }
  if (badBudgets > 0) fatal(`${badBudgets} budgets are not valid.`);

  let badTemplates = 0;
  for (const template of payload.templates) {
    if (template.amount.minorUnits <= 0 || template.amount.minorUnits > MAX_MINOR_UNITS) badTemplates += 1;
    if (template.interval < 1) badTemplates += 1;
    if (!categoryIDs.has(template.categoryID)) badTemplates += 1;
  }
  if (badTemplates > 0) fatal(`${badTemplates} recurring templates are not valid.`);

  const strayLog = payload.recurrenceLog.filter((entry) => !templateIDs.has(entry.templateID)).length;
  if (strayLog > 0) warn(`${strayLog} recurring-expense history entries belong to a template that is not in the backup and will be ignored.`);

  return problems;
}

// ---------------------------------------------------------------- restoring

export function makeRestorePreview(mode, currentExpenseCount, backupExpenseCount) {
  return {
    mode,
    /** Expenses in the app right now (they are lost in 'replaceAll'). */
    currentExpenseCount,
    backupExpenseCount,
    expensesToAdd: 0,
    /** Same expense id in both, and the backup's copy is newer. */
    expensesToUpdate: 0,
    /** Same expense id in both, and the app's copy is the same or newer (kept as is). */
    expensesKept: 0,
    categoriesToAdd: 0,
    budgetsToAdd: 0,
    templatesToAdd: 0,
  };
}

/**
 * Works out the result of a restore without changing anything.
 * mode 'replaceAll': throw away everything in the app and use the backup instead.
 * mode 'merge': keep what is in the app and add what the backup has that the app does not. Records are matched by
 * their unique id, so restoring the same backup twice adds nothing the second time. Two different expenses that
 * merely look alike are never treated as duplicates, because buying the same coffee twice in a day is legitimate.
 * Returns { result: LedgerSnapshot, preview }.
 */
export function planRestore(payload, current, mode) {
  const preview = makeRestorePreview(mode, current.expenses.length, payload.expenses.length);

  if (mode === 'replaceAll') {
    const result = payloadToSnapshot(payload);
    result.settings = Object.freeze({ ...normalizeSettings(result.settings), hasCompletedOnboarding: true });
    preview.expensesToAdd = payload.expenses.length;
    preview.categoriesToAdd = payload.categories.length;
    preview.budgetsToAdd = payload.budgets.length;
    preview.templatesToAdd = payload.templates.length;
    return { result, preview };
  }
  return mergeRestore(payload, current, preview);
}

function mergeRestore(payload, current, preview) {
  const result = current.clone();
  result.invalidate();

  // 1. Categories: same id, else same name (a fresh install already has the default categories under different ids),
  //    else add the backup's category.
  const categoryMap = new Map();
  for (const incoming of payload.categories) {
    if (current.category(incoming.id)) {
      categoryMap.set(incoming.id, incoming.id);
      continue;
    }
    const key = comparisonKey(incoming.name);
    const same = current.categories.find((c) => !c.mergedIntoID && comparisonKey(c.name) === key);
    if (same) {
      categoryMap.set(incoming.id, same.id);
      continue;
    }
    categoryMap.set(incoming.id, incoming.id);
    let added = incoming;
    if (incoming.mergedIntoID) {
      added = makeCategory({ ...incoming, mergedIntoID: categoryMap.get(incoming.mergedIntoID) || incoming.mergedIntoID });
    }
    result.categories.push(added);
    preview.categoriesToAdd += 1;
  }

  // 2. Subcategories follow their category.
  const subcategoryMap = new Map();
  for (const incoming of payload.subcategories) {
    const parent = categoryMap.get(incoming.categoryID) || incoming.categoryID;
    if (current.subcategory(incoming.id)) {
      subcategoryMap.set(incoming.id, incoming.id);
      continue;
    }
    const key = comparisonKey(incoming.name);
    const existing = result.subcategories.find(
      (s) => s.categoryID === parent && !s.mergedIntoID && comparisonKey(s.name) === key,
    );
    if (existing) {
      subcategoryMap.set(incoming.id, existing.id);
      continue;
    }
    subcategoryMap.set(incoming.id, incoming.id);
    result.subcategories.push(makeSubcategory({ ...incoming, categoryID: parent }));
  }

  // 3. Payment methods and tags: by id, else by name.
  const methodMap = new Map();
  for (const incoming of payload.paymentMethods) {
    if (current.paymentMethod(incoming.id)) {
      methodMap.set(incoming.id, incoming.id);
      continue;
    }
    const key = comparisonKey(incoming.name);
    const same = result.paymentMethods.find((p) => comparisonKey(p.name) === key);
    if (same) {
      methodMap.set(incoming.id, same.id);
      continue;
    }
    methodMap.set(incoming.id, incoming.id);
    result.paymentMethods.push(incoming);
  }
  const knownTags = new Set(result.tags.map((t) => t.name.toLowerCase()));
  for (const incoming of payload.tags) {
    const key = incoming.name.toLowerCase();
    if (knownTags.has(key)) continue;
    knownTags.add(key);
    result.tags.push(incoming);
  }

  // 4. Expenses: matched by id. The newer copy (by modification time) wins; ties keep the app's copy.
  const positionByID = new Map();
  result.expenses.forEach((expense, position) => positionByID.set(expense.id, position));
  for (const incoming of payload.expenses) {
    const expense = makeExpense({
      ...incoming,
      categoryID: categoryMap.get(incoming.categoryID) || incoming.categoryID,
      subcategoryID: incoming.subcategoryID ? (subcategoryMap.get(incoming.subcategoryID) || incoming.subcategoryID) : null,
      paymentMethodID: incoming.paymentMethodID ? (methodMap.get(incoming.paymentMethodID) || incoming.paymentMethodID) : null,
    });
    const position = positionByID.get(expense.id);
    if (position !== undefined) {
      if (expense.modifiedAt > result.expenses[position].modifiedAt) {
        result.expenses[position] = expense;
        preview.expensesToUpdate += 1;
      } else {
        preview.expensesKept += 1;
      }
    } else {
      positionByID.set(expense.id, result.expenses.length);
      result.expenses.push(expense);
      preview.expensesToAdd += 1;
    }
  }

  // 5. Budgets and templates: by id, newer wins, categories remapped.
  for (const incoming of payload.budgets) {
    const budget = makeBudget({
      ...incoming,
      categoryID: incoming.categoryID ? (categoryMap.get(incoming.categoryID) || incoming.categoryID) : null,
    });
    const position = result.budgets.findIndex((b) => b.id === budget.id);
    if (position >= 0) {
      if (budget.modifiedAt > result.budgets[position].modifiedAt) result.budgets[position] = budget;
    } else {
      result.budgets.push(budget);
      preview.budgetsToAdd += 1;
    }
  }
  for (const incoming of payload.templates) {
    const template = makeTemplate({
      ...incoming,
      categoryID: categoryMap.get(incoming.categoryID) || incoming.categoryID,
      subcategoryID: incoming.subcategoryID ? (subcategoryMap.get(incoming.subcategoryID) || incoming.subcategoryID) : null,
      paymentMethodID: incoming.paymentMethodID ? (methodMap.get(incoming.paymentMethodID) || incoming.paymentMethodID) : null,
    });
    const position = result.templates.findIndex((t) => t.id === template.id);
    if (position >= 0) {
      if (template.modifiedAt > result.templates[position].modifiedAt) result.templates[position] = template;
    } else {
      result.templates.push(template);
      preview.templatesToAdd += 1;
    }
  }

  // 6. Recurrence history: one entry per template and due day. Existing decisions are never overwritten.
  const templateIDs = new Set(result.templates.map((t) => t.id));
  const knownKeys = new Set(result.recurrenceLog.map((entry) => `${entry.templateID}#${entry.dueDay.toString()}`));
  for (const entry of payload.recurrenceLog) {
    const key = `${entry.templateID}#${entry.dueDay.toString()}`;
    if (!templateIDs.has(entry.templateID) || knownKeys.has(key)) continue;
    knownKeys.add(key);
    result.recurrenceLog.push(entry);
  }

  // Settings are kept as they are in merge mode.
  result.normalizeOrder();
  return { result, preview };
}

