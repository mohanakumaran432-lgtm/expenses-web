// Writing, opening and rejecting backup files. Mirrors the iPhone app's BackupCodecTests, then adds what only the web
// app has: password-protected backups.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Fx, SampleLedger, rejectsWithCode } from './support.mjs';
import { CalendarContext } from '../docs/js/core/calendar.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import {
  BACKUP_FORMAT, BACKUP_VERSION, ENCODING_PLAIN, ENCODING_PROTECTED, backupNeedsPassword, makeBackup, openBackup,
  payloadFromSnapshot, payloadToSnapshot,
} from '../docs/js/core/backup.js';
import { base64ToBytes, bytesToBase64, sha256Hex, utf8Decode, utf8Encode } from '../docs/js/core/encoding.js';
import {
  makeBudget, makeCategory, makeExpense, makeLogEntry, makeSubcategory, makeTag, makeTemplate, normalizeSettings,
  occurrenceKey,
} from '../docs/js/core/models.js';
import { money, plainString } from '../docs/js/core/money.js';
import { totalOf } from '../docs/js/core/query.js';
import { quickTotal } from '../docs/js/core/reports.js';

const sample = new SampleLedger();
const APP_VERSION = '1.0 (1)';

const backup = (snapshot = sample.snapshot, options) => makeBackup(snapshot, Fx.now, APP_VERSION, options);
const readEnvelope = (text) => JSON.parse(text);
const writeEnvelope = (envelope) => JSON.stringify(envelope);
const payloadText = (envelope) => utf8Decode(base64ToBytes(envelope.payload));

const assertOpenFails = (text, code, options) => rejectsWithCode(openBackup(text, options), code);
const assertCorrupted = (text) => assertOpenFails(text, 'corrupted');

/** Puts new payload text into a file and fixes the checksum, as someone who edits the file carefully would. */
async function withPayload(text, change) {
  const envelope = readEnvelope(text);
  const bytes = utf8Encode(change(payloadText(envelope)));
  envelope.payload = bytesToBase64(bytes);
  envelope.payloadSHA256 = await sha256Hex(bytes);
  return writeEnvelope(envelope);
}

/** A ledger that uses every kind of record, so the round trip proves nothing is dropped. */
function richSnapshot() {
  const snapshot = sample.snapshot.clone();
  snapshot.settings = normalizeSettings({
    ...snapshot.settings, currencyCode: 'USD', firstWeekday: 1, defaultPaymentMethodID: sample.cash.id,
  });

  const base = Fx.expense('3.5', Fx.day(2026, 10, 21), sample.coffee, {
    method: sample.credit, merchant: 'Café ☕ "Nero", Dubai', tags: ['a', 'b'], zone: Fx.newYork,
    createdAt: Fx.now + 50_000, id: Fx.uuid(9100),
  });
  const timed = makeExpense({
    ...base,
    hasExplicitTime: true,
    occurredAt: new CalendarContext(Fx.newYork).instant(Fx.day(2026, 10, 21), 23, 30),
    notes: 'line one\nline two',
    recurringTemplateID: Fx.uuid(5001),
    occurrenceKey: occurrenceKey(Fx.uuid(5001), Fx.day(2026, 10, 21)),
  });
  snapshot.expenses.push(timed);

  snapshot.tags = [makeTag({ id: Fx.uuid(7001), name: 'a', createdAt: Fx.now })];
  snapshot.budgets = [makeBudget({
    id: Fx.uuid(6001), name: 'Food', categoryID: sample.groceries.id, periodKind: 'monthly', amount: Fx.money('500'),
    alertThresholds: [80, 100], notificationsEnabled: true, isActive: true, createdAt: Fx.now, modifiedAt: Fx.now,
  })];
  snapshot.templates = [Fx.template({ categoryID: sample.coffee.id, from: Fx.day(2026, 10, 21) })];
  snapshot.recurrenceLog = [makeLogEntry({
    id: Fx.uuid(8001), templateID: Fx.uuid(5001), dueDay: Fx.day(2026, 10, 21), outcome: 'recorded',
    expenseID: timed.id, decidedAt: Fx.now,
  })];
  snapshot.categories = snapshot.categories.map((category) => (category.id === sample.fuel.id
    ? makeCategory({ ...category, isArchived: true, mergedIntoID: sample.transport.id })
    : category));
  return snapshot.normalizeOrder();
}

/** The sample ledger with one of its expenses changed. */
function editing(expense, changes) {
  const copy = sample.snapshot.clone();
  const position = copy.expenses.findIndex((e) => e.id === expense.id);
  assert.ok(position >= 0, 'That expense is not in the sample ledger');
  copy.expenses[position] = makeExpense({ ...expense, ...changes });
  copy.invalidate();
  return copy;
}

async function assertInvalid(snapshot, expected) {
  const text = await backup(snapshot);
  await assert.rejects(openBackup(text), (error) => {
    assert.equal(error.code, 'invalidContent', `Expected invalid content, got ${error.code}: ${error.message}`);
    assert.ok(error.details.problems.includes(expected), `Problems were: ${JSON.stringify(error.details.problems)}`);
    return true;
  });
}

// Writing and reading ----------------------------------------------------------------------------

test('a round trip keeps everything', async () => {
  const opened = await openBackup(await backup());
  assert.deepEqual(opened.payload, payloadFromSnapshot(sample.snapshot));
  assert.deepEqual(opened.warnings, []);
  assert.equal(opened.info.formatVersion, 1);
  assert.equal(opened.info.appVersion, '1.0 (1)');
  assert.equal(opened.info.createdAt, Fx.now);
  assert.equal(opened.info.isProtected, false);
  const { counts } = opened.info;
  assert.equal(counts.expenses, 8);
  assert.equal(counts.categories, 23);
  assert.equal(counts.subcategories, 1);
  assert.equal(counts.paymentMethods, 5);
  assert.equal(counts.firstExpenseDay.toString(), '2026-09-15');
  assert.equal(counts.lastExpenseDay.toString(), '2026-10-20');

  const restored = payloadToSnapshot(opened.payload);
  assert.deepEqual(restored.expenses, sample.snapshot.expenses);
  assert.equal(totalOf(restored.expenses, 'AED').minorUnits, SampleLedger.grandTotalMinor);
});

test('every kind of record survives a round trip', async () => {
  const rich = richSnapshot();
  const opened = await openBackup(await backup(rich));
  assert.deepEqual(opened.payload, payloadFromSnapshot(rich));
  assert.equal(opened.payload.expenses.length, 9);
  assert.equal(opened.payload.settings.currencyCode, 'USD');
  assert.equal(opened.payload.settings.firstWeekday, 1);
  assert.equal(opened.payload.settings.defaultPaymentMethodID, sample.cash.id);
  assert.equal(opened.payload.budgets.length, 1);
  assert.equal(opened.payload.templates.length, 1);
  assert.equal(opened.payload.recurrenceLog.length, 1);
  assert.equal(opened.payload.tags.length, 1);
  const timed = opened.payload.expenses.find((e) => e.hasExplicitTime);
  assert.equal(timed.merchant, 'Café ☕ "Nero", Dubai');
  assert.equal(timed.notes, 'line one\nline two');
  assert.equal(timed.timeZoneID, 'America/New_York');
  const fuel = opened.payload.categories.find((c) => c.id === sample.fuel.id);
  assert.equal(fuel.isArchived, true);
  assert.equal(fuel.mergedIntoID, sample.transport.id);
});

test('the same data always produces the same file', async () => {
  assert.equal(await backup(), await backup());
});

test('the file has a readable header and a matching checksum', async () => {
  const envelope = readEnvelope(await backup());
  assert.equal(envelope.format, 'private-expense-tracker-backup');
  assert.equal(envelope.format, BACKUP_FORMAT);
  assert.equal(envelope.formatVersion, 1);
  assert.equal(envelope.formatVersion, BACKUP_VERSION);
  assert.equal(envelope.payloadEncoding, 'json+base64');
  assert.equal(envelope.payloadEncoding, ENCODING_PLAIN);
  assert.equal(envelope.payloadSHA256.length, 64);
  assert.equal(envelope.counts.expenses, 8);
  assert.equal(envelope.appVersion, '1.0 (1)');
  assert.equal(envelope.createdAtMillis, 1_792_497_600_000);
  const payloadBytes = base64ToBytes(envelope.payload);
  assert.equal(await sha256Hex(payloadBytes), envelope.payloadSHA256);
  // Checked a second way, with Node's own implementation instead of the browser interface the app uses.
  assert.equal(createHash('sha256').update(payloadBytes).digest('hex'), envelope.payloadSHA256);
});

test('an uppercase checksum is accepted', async () => {
  const envelope = readEnvelope(await backup());
  envelope.payloadSHA256 = envelope.payloadSHA256.toUpperCase();
  const opened = await openBackup(writeEnvelope(envelope));
  assert.equal(opened.payload.expenses.length, 8);
});

test('a new file has the same fields as the iPhone app writes', async () => {
  // The frozen file below was written by the iPhone app. Every field written here must be one it has, and every field
  // it always writes must be written here, or the two apps could not read each other's backups.
  const theirs = readEnvelope(readFileSync(new URL('./fixtures/backup_v1.json', import.meta.url), 'utf8'));
  const theirPayload = JSON.parse(payloadText(theirs));
  const ours = readEnvelope(await backup(richSnapshot()));
  const ourPayload = JSON.parse(payloadText(ours));

  assert.deepEqual(Object.keys(ours).sort(), Object.keys(theirs).sort());
  assert.deepEqual(Object.keys(ours.counts).sort(), Object.keys(theirs.counts).sort());
  assert.deepEqual(Object.keys(ourPayload).sort(), Object.keys(theirPayload).sort());
  assert.deepEqual(Object.keys(ourPayload.settings).sort(), Object.keys(theirPayload.settings).sort());

  const lists = ['budgets', 'categories', 'expenses', 'paymentMethods', 'recurrenceLog', 'subcategories', 'tags', 'templates'];
  for (const list of lists) {
    const allowed = new Set(theirPayload[list].flatMap((record) => Object.keys(record)));
    const always = Object.keys(theirPayload[list][0]).filter((key) => theirPayload[list].every((record) => key in record));
    assert.ok(ourPayload[list].length > 0, `The rich ledger should contain ${list}`);
    for (const record of ourPayload[list]) {
      for (const key of Object.keys(record)) assert.ok(allowed.has(key), `${list}: "${key}" is not a field the iPhone app writes`);
      for (const key of always) assert.ok(key in record, `${list}: "${key}" is missing`);
    }
  }
  // Dates travel as text and instants as whole milliseconds, exactly like the iPhone app.
  const spent = ourPayload.expenses[0];
  assert.match(spent.localDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isSafeInteger(spent.occurredAt) && Number.isSafeInteger(spent.createdAt));
  assert.deepEqual(Object.keys(spent.amount).sort(), ['currencyCode', 'minorUnits']);
});

test('records and settings with extra unknown fields still open (a newer app may add fields)', async () => {
  const text = await withPayload(await backup(), (json) => {
    const object = JSON.parse(json);
    object.somethingNew = [1, 2, 3];
    object.settings.aNewSetting = true;
    object.expenses[0].aNewField = 'x';
    object.categories[0].aNewField = { nested: true };
    return JSON.stringify(object);
  });
  const opened = await openBackup(text);
  assert.equal(opened.payload.expenses.length, 8);
  assert.equal('aNewField' in opened.payload.expenses[0], false, 'Unknown fields are ignored, not carried around');
});

// Damage and tampering ---------------------------------------------------------------------------

test('changing an amount inside the file is detected', async () => {
  const envelope = readEnvelope(await backup());
  let json = payloadText(envelope);
  assert.ok(json.includes('"minorUnits":5000'), 'Test assumption: expense #1 is stored as 5000 minor units');
  json = json.replace('"minorUnits":5000', '"minorUnits":500000');
  envelope.payload = bytesToBase64(utf8Encode(json));
  await assertCorrupted(writeEnvelope(envelope));
});

test('a flipped character, a truncated payload or non-base64 text is detected', async () => {
  const envelope = readEnvelope(await backup());
  const original = envelope.payload;
  const characters = Array.from(original);
  const middle = Math.floor(characters.length / 2);
  characters[middle] = characters[middle] === 'A' ? 'B' : 'A';
  envelope.payload = characters.join('');
  await assertCorrupted(writeEnvelope(envelope));

  envelope.payload = original.slice(0, -8);
  await assertCorrupted(writeEnvelope(envelope));
  envelope.payload = '***not base64***';
  await assertCorrupted(writeEnvelope(envelope));
  envelope.payload = '';
  await assertCorrupted(writeEnvelope(envelope));
});

test('a matching checksum does not make unreadable content acceptable', async () => {
  const unreadable = [
    '{}',
    '[]',
    'null',
    'not json at all',
    '{"settings":{},"categories":[],"subcategories":[],"paymentMethods":[],"tags":[],"expenses":"oops","budgets":[],"templates":[],"recurrenceLog":[]}',
  ];
  for (const content of unreadable) {
    const envelope = readEnvelope(await backup());
    const bytes = utf8Encode(content);
    envelope.payload = bytesToBase64(bytes);
    envelope.payloadSHA256 = await sha256Hex(bytes);
    await assertCorrupted(writeEnvelope(envelope));
  }
  // Bytes that are not valid text at all.
  const envelope = readEnvelope(await backup());
  const bytes = new Uint8Array([0xFF, 0xFE, 0xFD, 0x80]);
  envelope.payload = bytesToBase64(bytes);
  envelope.payloadSHA256 = await sha256Hex(bytes);
  await assertCorrupted(writeEnvelope(envelope));
});

test('a record with a wrong kind of value is reported as damaged, with no private details', async () => {
  const text = await withPayload(await backup(), (json) => {
    const object = JSON.parse(json);
    object.expenses[0].merchant = 12345;
    object.expenses[0].localDay = 'not a day';
    return JSON.stringify(object);
  });
  await assert.rejects(openBackup(text), (error) => {
    assert.equal(error.code, 'corrupted');
    assert.ok(!error.message.includes('12345'));
    return true;
  });
});

test('other files are not backups', async () => {
  await assertOpenFails('', 'notABackup');
  await assertOpenFails('hello', 'notABackup');
  await assertOpenFails('{"format":"something-else"}', 'notABackup');
  await assertOpenFails('[]', 'notABackup');
  await assertOpenFails('null', 'notABackup');
  await assertOpenFails('42', 'notABackup');
  await assertOpenFails(undefined, 'notABackup');

  let envelope = readEnvelope(await backup());
  envelope.format = 'some-other-app-backup';
  await assertOpenFails(writeEnvelope(envelope), 'notABackup');

  envelope = readEnvelope(await backup());
  envelope.formatVersion = 0;
  await assertOpenFails(writeEnvelope(envelope), 'notABackup');

  for (const missing of ['format', 'formatVersion', 'createdAtMillis', 'appVersion', 'payloadEncoding', 'payloadSHA256', 'payload']) {
    envelope = readEnvelope(await backup());
    delete envelope[missing];
    await assertOpenFails(writeEnvelope(envelope), 'notABackup');
  }
});

test('a backup from a newer version is refused with a clear reason', async () => {
  const envelope = readEnvelope(await backup());
  envelope.formatVersion = 2;
  const text = writeEnvelope(envelope);
  await assert.rejects(openBackup(text), (error) => {
    assert.equal(error.code, 'newerVersion');
    assert.deepEqual(error.details, { found: 2, supported: 1 });
    assert.ok(error.message.includes('newer version'), error.message);
    return true;
  });
});

test('an unknown storage method is refused', async () => {
  const envelope = readEnvelope(await backup());
  envelope.payloadEncoding = 'json+gzip';
  await assertOpenFails(writeEnvelope(envelope), 'unsupportedEncoding');
});

// Consistency checks -----------------------------------------------------------------------------

test('inconsistent content is refused before anything is restored', async () => {
  const transportExpense = sample.e[2];
  const groceriesExpense = sample.e[0];

  await assertInvalid(editing(groceriesExpense, { categoryID: Fx.uuid(9999) }), '1 expenses point to a missing category.');
  await assertInvalid(editing(groceriesExpense, { paymentMethodID: Fx.uuid(9999) }), '1 expenses point to a missing payment method.');
  await assertInvalid(editing(groceriesExpense, { amount: money(0, 'AED') }), '1 expenses have an amount that is not valid.');
  await assertInvalid(editing(groceriesExpense, { amount: money(-5, 'AED') }), '1 expenses have an amount that is not valid.');
  await assertInvalid(editing(groceriesExpense, { amount: money(10_000_000_000_001, 'AED') }), '1 expenses have an amount that is not valid.');
  await assertInvalid(editing(groceriesExpense, { amount: money(100, 'US') }), '1 expenses have an invalid currency code.');
  await assertInvalid(editing(groceriesExpense, { localDay: Fx.day(1980, 1, 1) }), '1 expenses have a date outside 1990-2200.');
  await assertInvalid(editing(groceriesExpense, { localDay: Fx.day(2300, 1, 1) }), '1 expenses have a date outside 1990-2200.');
  await assertInvalid(
    editing(transportExpense, { subcategoryID: sample.milk.id }),
    '1 expenses point to a subcategory that does not match their category.',
  );

  const duplicate = sample.snapshot.clone();
  duplicate.expenses.push(sample.e[0]);
  await assertInvalid(duplicate, 'Some expenses share the same id.');

  const duplicateCategory = sample.snapshot.clone();
  duplicateCategory.categories.push(sample.groceries);
  await assertInvalid(duplicateCategory, 'Some categories share the same id.');

  const orphan = sample.snapshot.clone();
  orphan.subcategories.push(makeSubcategory({
    id: Fx.uuid(901), categoryID: Fx.uuid(9999), name: 'Lost', sortOrder: 0, isArchived: false, mergedIntoID: null,
    createdAt: Fx.now, modifiedAt: Fx.now,
  }));
  await assertInvalid(orphan, '1 subcategories belong to a missing category.');

  const badBudget = sample.snapshot.clone();
  badBudget.budgets = [makeBudget({
    id: Fx.uuid(6001), name: 'Bad', categoryID: Fx.uuid(9999), periodKind: 'monthly', amount: Fx.money('10'),
    alertThresholds: [100], notificationsEnabled: false, isActive: true, createdAt: Fx.now, modifiedAt: Fx.now,
  })];
  await assertInvalid(badBudget, '1 budgets are not valid.');

  const badTemplate = sample.snapshot.clone();
  const template = Fx.template({ categoryID: sample.coffee.id, from: Fx.today });
  badTemplate.templates = [makeTemplate({ ...template, interval: 0 })];
  await assertInvalid(badTemplate, '1 recurring templates are not valid.');
});

test('every problem is reported and no private details are in the messages', async () => {
  const snapshot = editing(sample.e[1], {
    categoryID: Fx.uuid(9999), merchant: 'SECRET-MERCHANT', amount: Fx.money('987.65'), paymentMethodID: Fx.uuid(9998),
  });
  await assert.rejects(openBackup(await backup(snapshot)), (error) => {
    assert.equal(error.code, 'invalidContent');
    const { problems } = error.details;
    assert.equal(problems.length, 2, JSON.stringify(problems));
    const text = error.message + problems.join('');
    assert.ok(!text.includes('SECRET-MERCHANT'));
    assert.ok(!text.includes('987'));
    return true;
  });
});

test('a log entry for a missing template is only a warning', async () => {
  const snapshot = sample.snapshot.clone();
  snapshot.recurrenceLog = [makeLogEntry({
    id: Fx.uuid(8001), templateID: Fx.uuid(5001), dueDay: Fx.today, outcome: 'skipped', expenseID: null, decidedAt: Fx.now,
  })];
  const opened = await openBackup(await backup(snapshot));
  assert.equal(opened.warnings.length, 1);
  assert.ok(opened.warnings[0].includes('recurring-expense history'));
  assert.equal(opened.payload.expenses.length, 8);
});

// Settings and size ------------------------------------------------------------------------------

test('an out-of-range week start is reset and a valid one is left alone', async () => {
  const withWeekday = async (firstWeekday) => {
    const snapshot = sample.snapshot.clone();
    snapshot.settings = Object.freeze({ ...snapshot.settings, firstWeekday });
    return (await openBackup(await backup(snapshot))).payload.settings.firstWeekday;
  };
  assert.equal(await withWeekday(0), 2);
  assert.equal(await withWeekday(9), 2);
  assert.equal(await withWeekday(4), 4);
  assert.equal(await withWeekday(1), 1);
  assert.equal(await withWeekday(7), 7);
});

test('three thousand expenses round trip', async () => {
  const snapshot = Fx.catalog();
  const categories = snapshot.categories.slice(0, 6);
  const list = [];
  let expectedTotal = 0;
  for (let i = 0; i < 3_000; i += 1) {
    const item = Fx.expense(`${(i % 400) + 1}.25`, Fx.day(2025, 1, 1).addingDays(i % 500), categories[i % categories.length], {
      merchant: `Store ${i % 50}`, createdAt: Fx.now + i * 1000,
    });
    expectedTotal += item.amount.minorUnits;
    list.push(item);
  }
  snapshot.expenses = list;
  snapshot.normalizeOrder();

  const opened = await openBackup(await backup(snapshot));
  assert.equal(opened.info.counts.expenses, 3_000);
  assert.deepEqual(opened.payload.expenses, snapshot.expenses);
  assert.equal(totalOf(opened.payload.expenses, 'AED').minorUnits, expectedTotal);
});

// A frozen version-1 file (see tests/fixtures/backup_v1.json) -----------------------------------------------
//
// The file was written by the iPhone app and its checksum was computed separately with Python's hashlib, so it does
// not depend on any code in this project. If a test here fails, the format changed in a way old files cannot follow:
// do not edit the file to make the test pass, add a new formatVersion and a conversion step instead.

const FROZEN_TEXT = readFileSync(new URL('./fixtures/backup_v1.json', import.meta.url), 'utf8');
const ID = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const GROCERIES = ID(1);
const TRANSPORT = ID(2);
const COFFEE = ID(3);
const FRUIT = ID(11);
const CASH = ID(21);
const TEMPLATE = ID(301);
const RECURRING_EXPENSE = ID(104);
const KUWAIT_EXPENSE = ID(103);

test('a frozen version-1 file still opens with everything in it', async () => {
  const opened = await openBackup(FROZEN_TEXT);

  assert.equal(opened.info.formatVersion, 1);
  assert.equal(opened.info.appVersion, '1.0 (1)');
  assert.equal(opened.info.createdAt, 1_792_497_600_000);
  assert.deepEqual(opened.warnings, []);

  const { counts } = opened.info;
  assert.equal(counts.expenses, 4);
  assert.equal(counts.categories, 3);
  assert.equal(counts.subcategories, 1);
  assert.equal(counts.paymentMethods, 2);
  assert.equal(counts.tags, 1);
  assert.equal(counts.budgets, 2);
  assert.equal(counts.templates, 1);
  assert.equal(counts.recurrenceLog, 2);
  assert.equal(counts.firstExpenseDay.toString(), '2026-10-03');
  assert.equal(counts.lastExpenseDay.toString(), '2026-10-15');

  const { settings } = opened.payload;
  assert.equal(settings.currencyCode, 'AED');
  assert.equal(settings.numberFormat, 'commaDot');
  assert.equal(settings.dateFormat, 'yearMonthDay');
  assert.equal(settings.timeFormat, 'twentyFourHour');
  assert.equal(settings.firstWeekday, 2);
  assert.equal(settings.defaultReportPeriod, 'thisMonth');
  assert.equal(settings.appearance, 'dark');
  assert.equal(settings.defaultPaymentMethodID, CASH);
  assert.equal(settings.budgetAlertsEnabled, true);
  assert.equal(settings.recurringRemindersEnabled, false);
  assert.equal(settings.notificationsShowAmounts, false);
  assert.equal(settings.hideContentInAppSwitcher, true);
  assert.equal(settings.excludeFromDeviceBackup, false);
  assert.equal(settings.hasCompletedOnboarding, true);
});

test("the frozen file's expenses keep every field", async () => {
  const { payload } = await openBackup(FROZEN_TEXT);
  const byID = new Map(payload.expenses.map((e) => [e.id, e]));

  // Every field present, with a clock time.
  const first = payload.expenses.find((e) => e.merchant === 'Lulu');
  assert.deepEqual(first.amount, money(1_250, 'AED'));
  assert.equal(first.localDay.toString(), '2026-10-03');
  assert.equal(first.occurredAt, 1_791_037_800_000);
  assert.equal(first.hasExplicitTime, true);
  assert.equal(first.timeZoneID, 'Asia/Dubai');
  assert.equal(first.categoryID, GROCERIES);
  assert.equal(first.subcategoryID, FRUIT);
  assert.equal(first.paymentMethodID, CASH);
  assert.equal(first.categoryNameSnapshot, 'Groceries');
  assert.equal(first.subcategoryNameSnapshot, 'Fruit');
  assert.equal(first.paymentMethodNameSnapshot, 'Cash');
  assert.equal(first.notes, 'weekly shop');
  assert.deepEqual([...first.tags], ['family']);
  assert.equal(first.recurringTemplateID, null);
  assert.equal(first.occurrenceKey, null);

  // No clock time, no payment method, no subcategory.
  const bare = payload.expenses.find((e) => e.merchant === 'RTA');
  assert.equal(bare.amount.minorUnits, 4_000);
  assert.equal(bare.hasExplicitTime, false);
  assert.equal(bare.subcategoryID, null);
  assert.equal(bare.paymentMethodID, null);
  assert.equal(bare.categoryID, TRANSPORT);

  // Another currency with three decimals, awkward text, two tags.
  const kuwait = byID.get(KUWAIT_EXPENSE);
  assert.equal(kuwait.amount.minorUnits, 7_250);
  assert.equal(kuwait.amount.currencyCode, 'KWD');
  assert.equal(plainString(kuwait.amount), '7.250');
  assert.equal(kuwait.merchant, '=SUM(A1)');
  assert.equal(kuwait.notes, 'café ☕\nsecond line, with "quotes"');
  assert.deepEqual([...kuwait.tags], ['family', 'trip']);
  assert.equal(kuwait.timeZoneID, 'Asia/Kuwait');
  assert.ok(kuwait.modifiedAt > kuwait.createdAt);

  // Made by a recurring template.
  const recurring = byID.get(RECURRING_EXPENSE);
  assert.equal(recurring.recurringTemplateID, TEMPLATE);
  assert.equal(recurring.occurrenceKey, `${TEMPLATE}#2026-10-15`);
  assert.equal(recurring.amount.minorUnits, 15_000);
});

test("the frozen file's other records keep every field", async () => {
  const { payload } = await openBackup(FROZEN_TEXT);

  const transport = payload.categories.find((c) => c.id === TRANSPORT);
  assert.equal(transport.isArchived, true);
  assert.equal(transport.mergedIntoID, null);
  assert.equal(transport.iconSymbol, 'bus');
  assert.equal(transport.colorHex, '#007AFF');
  const coffee = payload.categories.find((c) => c.id === COFFEE);
  assert.equal(coffee.isArchived, true);
  assert.equal(coffee.mergedIntoID, GROCERIES);

  const fruit = payload.subcategories[0];
  assert.equal(fruit.name, 'Fruit');
  assert.equal(fruit.categoryID, GROCERIES);

  assert.deepEqual(new Set(payload.paymentMethods.map((p) => p.name)), new Set(['Cash', 'Debit Card']));
  assert.deepEqual(payload.tags.map((t) => t.name), ['family']);

  const monthly = payload.budgets.find((b) => b.periodKind === 'monthly');
  assert.equal(monthly.categoryID, null);
  assert.deepEqual(monthly.amount, money(150_000, 'AED'));
  assert.deepEqual([...monthly.alertThresholds], [80, 100]);
  assert.equal(monthly.notificationsEnabled, true);
  assert.equal(monthly.isActive, true);
  const custom = payload.budgets.find((b) => b.periodKind === 'custom');
  assert.equal(custom.categoryID, GROCERIES);
  assert.equal(custom.customStart.toString(), '2026-10-01');
  assert.equal(custom.customEnd.toString(), '2026-10-31');
  assert.equal(custom.isActive, false);

  const template = payload.templates[0];
  assert.equal(template.id, TEMPLATE);
  assert.equal(template.title, 'Gym');
  assert.equal(template.frequency, 'monthly');
  assert.equal(template.interval, 1);
  assert.equal(template.startDay.toString(), '2026-09-15');
  assert.equal(template.endDay, null);
  assert.equal(template.mode, 'autoRecord');
  assert.equal(template.reminderEnabled, true);
  assert.equal(template.reminderDaysBefore, 1);
  assert.equal(template.reminderHour, 9);
  assert.equal(template.reminderMinute, 0);
  assert.equal(template.isActive, true);

  const skipped = payload.recurrenceLog.find((entry) => entry.outcome === 'skipped');
  assert.equal(skipped.dueDay.toString(), '2026-09-15');
  assert.equal(skipped.expenseID, null);
  const recorded = payload.recurrenceLog.find((entry) => entry.outcome === 'recorded');
  assert.equal(recorded.dueDay.toString(), '2026-10-15');
  assert.equal(recorded.expenseID, RECURRING_EXPENSE);
});

test('the frozen file gives the same totals as its contents', async () => {
  const { payload } = await openBackup(FROZEN_TEXT);
  const snapshot = payloadToSnapshot(payload);
  const october = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));

  // 12.50 + 40.00 + 150.00 in AED. The 7.250 KWD expense is another currency: counted apart, never converted.
  const quick = quickTotal(snapshot.expenses, 'AED', october);
  assert.equal(quick.total.minorUnits, 20_250);
  assert.equal(quick.count, 3);

  const report = Fx.report(snapshot, october, Fx.day(2026, 10, 20));
  assert.equal(report.total.minorUnits, 20_250);
  assert.equal(report.count, 3);
  assert.equal(report.excludedOtherCurrencyCount, 1);
  assert.equal(report.categories.reduce((sum, row) => sum + row.total.minorUnits, 0), 20_250);
});

test('the frozen file survives being saved again by the current version', async () => {
  const opened = await openBackup(FROZEN_TEXT);
  const rewritten = await makeBackup(payloadToSnapshot(opened.payload), Fx.now, '9.9');
  const reopened = await openBackup(rewritten);

  assert.equal(reopened.info.formatVersion, BACKUP_VERSION);
  assert.equal(reopened.info.appVersion, '9.9');
  const byID = (list) => list.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const name of ['expenses', 'categories', 'subcategories', 'paymentMethods', 'tags', 'budgets', 'templates']) {
    assert.deepEqual(byID(reopened.payload[name]), byID(opened.payload[name]), name);
  }
  const key = (entry) => `${entry.templateID}#${entry.dueDay}`;
  assert.deepEqual(
    reopened.payload.recurrenceLog.slice().sort((a, b) => (key(a) < key(b) ? -1 : 1)),
    opened.payload.recurrenceLog.slice().sort((a, b) => (key(a) < key(b) ? -1 : 1)),
  );
  assert.deepEqual(reopened.payload.settings, opened.payload.settings);
});

test('the frozen file is still rejected when one character of its payload changes', async () => {
  const marker = '"payload" : "';
  const start = FROZEN_TEXT.indexOf(marker) + marker.length;
  assert.ok(start > marker.length);
  let position = start;
  while (FROZEN_TEXT[position] !== 'A' && FROZEN_TEXT[position] !== 'B') position += 1;
  const swapped = FROZEN_TEXT[position] === 'A' ? 'B' : 'A';
  const changed = FROZEN_TEXT.slice(0, position) + swapped + FROZEN_TEXT.slice(position + 1);
  await assertCorrupted(changed);
});

test('a byte order mark in front of a backup does not stop it from opening', async () => {
  // Some editors add one when a file is opened and saved again.
  const opened = await openBackup(`﻿${await backup()}`);
  assert.equal(opened.payload.expenses.length, 8);
});

// Password-protected backups (only in the web app) ---------------------------------------------------------------

const PASSWORD = 'correct horse battery staple';
let protectedFileOnce = null;
const protectedFile = () => {
  protectedFileOnce ??= backup(richSnapshot(), { password: PASSWORD });
  return protectedFileOnce;
};

test('a protected backup reveals nothing but its size', async () => {
  const text = await protectedFile();
  const envelope = readEnvelope(text);
  assert.equal(envelope.payloadEncoding, ENCODING_PROTECTED);
  assert.equal(envelope.payloadEncoding, 'aes-256-gcm+pbkdf2-sha256+json+base64');
  assert.equal(envelope.kdf.name, 'PBKDF2-HMAC-SHA256');
  assert.ok(envelope.kdf.iterations >= 600_000);
  assert.equal(base64ToBytes(envelope.kdf.salt).length, 16);
  assert.equal('counts' in envelope, false, 'Counts would tell a reader how much is inside');
  assert.equal(await sha256Hex(base64ToBytes(envelope.payload)), envelope.payloadSHA256);

  // Nothing readable from the ledger is in the file, in text or in the decoded bytes.
  const decoded = Array.from(base64ToBytes(envelope.payload), (byte) => String.fromCharCode(byte)).join('');
  for (const secret of ['Spinneys', 'Carrefour', 'Nero', 'Groceries', 'family', 'minorUnits', 'line one']) {
    assert.ok(!text.includes(secret), `"${secret}" is visible in the file`);
    assert.ok(!decoded.includes(secret), `"${secret}" is visible in the decoded payload`);
  }
  assert.equal(backupNeedsPassword(text), true);
  assert.equal(backupNeedsPassword(await backup()), false);
  assert.equal(backupNeedsPassword('not a backup'), false);
});

test('a protected backup opens with its password and only with it', async () => {
  const text = await protectedFile();
  await assertOpenFails(text, 'passwordRequired');
  await assertOpenFails(text, 'passwordRequired', { password: '' });
  await assertOpenFails(text, 'wrongPassword', { password: 'wrong password' });
  await assertOpenFails(text, 'wrongPassword', { password: `${PASSWORD} ` });
  await assertOpenFails(text, 'wrongPassword', { password: PASSWORD.toUpperCase() });

  const opened = await openBackup(text, { password: PASSWORD });
  assert.equal(opened.info.isProtected, true);
  assert.equal(opened.info.counts.expenses, 9);
  assert.deepEqual(opened.payload, payloadFromSnapshot(richSnapshot()));
  assert.deepEqual(opened.warnings, []);
});

test('a protected backup cannot be changed without being noticed', async () => {
  const text = await protectedFile();
  const original = readEnvelope(text);
  const bytes = base64ToBytes(original.payload);

  // Changing the stored bytes without fixing the checksum: damaged.
  const flipped = Uint8Array.from(bytes);
  flipped[flipped.length - 1] ^= 1;
  let envelope = { ...original, payload: bytesToBase64(flipped) };
  await assertCorrupted(writeEnvelope(envelope));

  // Fixing the checksum as well does not help: the encryption itself notices (it reports the same message as a wrong
  // password, because nobody should be able to tell the two apart).
  envelope = { ...original, payload: bytesToBase64(flipped), payloadSHA256: await sha256Hex(flipped) };
  await assertOpenFails(writeEnvelope(envelope), 'wrongPassword', { password: PASSWORD });

  // Settings that would make the key cheap to guess, or that make no sense, are refused outright.
  for (const kdf of [
    { ...original.kdf, iterations: 1 },
    { ...original.kdf, iterations: 99_999 },
    { ...original.kdf, iterations: 99_000_000 },
    { ...original.kdf, iterations: 'many' },
    { ...original.kdf, salt: '' },
    { ...original.kdf, salt: '***' },
    { ...original.kdf, name: 'MD5' },
  ]) {
    envelope = { ...original, kdf };
    await assertOpenFails(writeEnvelope(envelope), 'corrupted', { password: PASSWORD });
  }
  const noKdf = { ...original };
  delete noKdf.kdf;
  await assertOpenFails(writeEnvelope(noKdf), 'corrupted', { password: PASSWORD });
});

test('pretending a protected file is a plain one does not get anything out of it', async () => {
  const original = readEnvelope(await protectedFile());
  const envelope = { ...original, payloadEncoding: ENCODING_PLAIN };
  delete envelope.kdf;
  await assertCorrupted(writeEnvelope(envelope));
});

test('a lower but still accepted iteration count simply gives the wrong key', async () => {
  const original = readEnvelope(await protectedFile());
  const envelope = { ...original, kdf: { ...original.kdf, iterations: 100_000 } };
  await assertOpenFails(writeEnvelope(envelope), 'wrongPassword', { password: PASSWORD });
});

test('an empty password means no protection, and two protected files of the same data differ', async () => {
  assert.equal(await backup(sample.snapshot, { password: '' }), await backup());
  const again = await backup(richSnapshot(), { password: PASSWORD });
  const first = await protectedFile();
  assert.notEqual(again, first, 'A new random salt and nonce are used every time');
  const a = await openBackup(first, { password: PASSWORD });
  const b = await openBackup(again, { password: PASSWORD });
  assert.deepEqual(a.payload, b.payload);
});

test('the same password typed with a different but equivalent spelling still opens the file', async () => {
  const composed = 'café Ångström'; // é, Å, ö as single characters
  const decomposed = 'café Ångström'; // the same text with accents as separate marks
  assert.notEqual(composed, decomposed);
  const text = await backup(sample.snapshot, { password: composed });
  const opened = await openBackup(text, { password: decomposed });
  assert.equal(opened.payload.expenses.length, 8);
});

test('a protected backup keeps non-English text, including a non-English password', async () => {
  const snapshot = sample.snapshot.clone();
  const arabic = makeExpense({ ...sample.e[1], merchant: 'سوبرماركت', notes: 'ملاحظة\nسطر ثان' });
  snapshot.expenses[snapshot.expenses.findIndex((e) => e.id === arabic.id)] = arabic;
  const opened = await openBackup(await backup(snapshot, { password: 'ينبغي' }), { password: 'ينبغي' });
  const read = opened.payload.expenses.find((e) => e.id === arabic.id);
  assert.equal(read.merchant, 'سوبرماركت');
  assert.equal(read.notes, 'ملاحظة\nسطر ثان');
});
