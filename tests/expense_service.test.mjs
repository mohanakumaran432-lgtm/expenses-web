import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, rejectsWithCode } from './support.mjs';
import { ExpenseService, editDraft, expenseProblemMessage } from '../docs/js/core/expense_service.js';
import { makeDraft, makeSubcategory, occurrenceKey } from '../docs/js/core/models.js';
import { MAX_MINOR_UNITS, money, zero } from '../docs/js/core/money.js';
import { MAX_MERCHANT_LENGTH, MAX_NOTES_LENGTH } from '../docs/js/core/text.js';

function makeHarness() {
  const snapshot = Fx.catalog();
  const groceries = Fx.category('Groceries', snapshot);
  const transport = Fx.category('Transport', snapshot);
  const milk = makeSubcategory({
    id: Fx.uuid(900), categoryID: groceries.id, name: 'Milk', sortOrder: 0, isArchived: false, mergedIntoID: null,
    createdAt: Fx.now, modifiedAt: Fx.now,
  });
  const bus = makeSubcategory({
    id: Fx.uuid(901), categoryID: transport.id, name: 'Bus', sortOrder: 0, isArchived: false, mergedIntoID: null,
    createdAt: Fx.now, modifiedAt: Fx.now,
  });
  snapshot.subcategories = [milk, bus];
  snapshot.invalidate();
  const store = Fx.store(snapshot);
  const clock = { now: Fx.now };
  const service = new ExpenseService(store, () => clock.now);
  return { store, service, clock, groceries, transport, milk, bus, cash: Fx.method('Cash', snapshot) };
}

const draft = (amount, category, { day = Fx.today, id = undefined, ...rest } = {}) => makeDraft({
  id, amount: Fx.money(amount), day, timeZoneID: Fx.dubai, categoryID: category ? category.id : null, ...rest,
});

async function assertInvalid(expected, promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'invalid');
    assert.deepEqual(error.details.problems, expected);
    return true;
  });
}

// Add ---------------------------------------------------------------------------------------------

test('adds an expense with everything filled in', async () => {
  const h = makeHarness();
  const input = draft('42.50', h.groceries, {
    subcategoryID: h.milk.id, paymentMethodID: h.cash.id, merchant: 'Spinneys', notes: 'Weekly shop', tags: ['family'],
  });
  const saved = await h.service.save(input, Fx.today);

  assert.equal(h.store.snapshot.expenses.length, 1);
  assert.equal(saved.amount.minorUnits, 4250);
  assert.ok(saved.localDay.equals(Fx.today));
  assert.equal(saved.categoryNameSnapshot, 'Groceries');
  assert.equal(saved.subcategoryNameSnapshot, 'Milk');
  assert.equal(saved.paymentMethodNameSnapshot, 'Cash');
  assert.equal(saved.createdAt, Fx.now);
  assert.equal(saved.modifiedAt, Fx.now);
  assert.equal(saved.hasExplicitTime, false);
  assert.equal(h.store.stored.expenses.length, 1, 'It reached the storage layer, not only memory');
});

test('an explicit time is kept in the original time zone', async () => {
  const h = makeHarness();
  const saved = await h.service.save(draft('10', h.groceries, { hasExplicitTime: true, hour: 21, minute: 5 }), Fx.today);
  assert.equal(saved.hasExplicitTime, true);
  assert.equal(Fx.formatter().timeOfExpense(saved), '21:05');
  assert.equal(saved.timeZoneID, Fx.dubai);
});

test('saving the same draft twice creates one expense', async () => {
  const h = makeHarness();
  const input = draft('15', h.groceries);
  await h.service.save(input, Fx.today);
  await h.service.save(input, Fx.today);
  assert.equal(h.store.snapshot.expenses.length, 1, 'A double tap on Save must not duplicate');
});

test('two separate drafts with the same values are two expenses', async () => {
  const h = makeHarness();
  await h.service.save(draft('4', h.groceries), Fx.today);
  await h.service.save(draft('4', h.groceries), Fx.today);
  assert.equal(h.store.snapshot.expenses.length, 2, 'Two real coffees on one day are legitimate');
});

// Validation -------------------------------------------------------------------------------------

test('zero and negative amounts are rejected', async () => {
  const h = makeHarness();
  const zeroDraft = makeDraft({ amount: zero('AED'), day: Fx.today, timeZoneID: Fx.dubai, categoryID: h.groceries.id });
  const negative = makeDraft({ amount: money(-100, 'AED'), day: Fx.today, timeZoneID: Fx.dubai, categoryID: h.groceries.id });
  await assertInvalid(['amountNotPositive'], h.service.save(zeroDraft, Fx.today));
  await assertInvalid(['amountNotPositive'], h.service.save(negative, Fx.today));
  assert.equal(h.store.snapshot.expenses.length, 0);
  assert.equal(h.store.writeCount, 0);
});

test('amount limit', async () => {
  const h = makeHarness();
  const tooBig = makeDraft({ amount: money(MAX_MINOR_UNITS + 1, 'AED'), day: Fx.today, timeZoneID: Fx.dubai, categoryID: h.groceries.id });
  await assertInvalid(['amountTooLarge'], h.service.save(tooBig, Fx.today));
  const largest = makeDraft({ amount: money(MAX_MINOR_UNITS, 'AED'), day: Fx.today, timeZoneID: Fx.dubai, categoryID: h.groceries.id });
  await h.service.save(largest, Fx.today);
});

test('a category is required and must exist', async () => {
  const h = makeHarness();
  await assertInvalid(['categoryRequired'], h.service.save(draft('5', null), Fx.today));
  const unknown = draft('5', h.groceries);
  unknown.categoryID = Fx.uuid(99_999);
  await assertInvalid(['categoryNotFound'], h.service.save(unknown, Fx.today));
});

test('a subcategory must belong to the chosen category', async () => {
  const h = makeHarness();
  const wrong = draft('5', h.groceries, { subcategoryID: h.bus.id });
  await assertInvalid(['subcategoryNotInCategory'], h.service.save(wrong, Fx.today));
  const right = draft('5', h.transport, { subcategoryID: h.bus.id });
  await h.service.save(right, Fx.today);
});

test('a payment method must exist', async () => {
  const h = makeHarness();
  await assertInvalid(['paymentMethodNotFound'], h.service.save(draft('5', h.groceries, { paymentMethodID: Fx.uuid(88_888) }), Fx.today));
});

test('date limits and back-dating', async () => {
  const h = makeHarness();
  await assertInvalid(['dateTooEarly'], h.service.save(draft('5', h.groceries, { day: Fx.day(1999, 12, 31) }), Fx.today));
  await h.service.save(draft('5', h.groceries, { day: Fx.day(2020, 1, 1) }), Fx.today);
  await h.service.save(draft('5', h.groceries, { day: Fx.today.addingDays(366) }), Fx.today);
  await assertInvalid(['dateTooFarInFuture'], h.service.save(draft('5', h.groceries, { day: Fx.today.addingDays(367) }), Fx.today));
});

test('a time must be a valid clock time', async () => {
  const h = makeHarness();
  await assertInvalid(['invalidTime'], h.service.save(draft('5', h.groceries, { hasExplicitTime: true, hour: 24 }), Fx.today));
  await assertInvalid(['invalidTime'], h.service.save(draft('5', h.groceries, { hasExplicitTime: true, minute: 60 }), Fx.today));
});

test('problems can be checked without saving', () => {
  const h = makeHarness();
  const bad = makeDraft({ amount: zero('AED'), day: Fx.today, timeZoneID: Fx.dubai });
  const found = h.service.problems(bad, Fx.today);
  assert.deepEqual(new Set(found), new Set(['amountNotPositive', 'categoryRequired']));
  assert.equal(h.store.writeCount, 0);
  assert.notEqual(expenseProblemMessage('amountNotPositive'), '');
});

test('overlong text is rejected', async () => {
  const h = makeHarness();
  const input = draft('5', h.groceries, { notes: 'x'.repeat(MAX_NOTES_LENGTH + 1) });
  await assertInvalid(['notesTooLong'], h.service.save(input, Fx.today));
  const merchant = draft('5', h.groceries, { merchant: 'm'.repeat(MAX_MERCHANT_LENGTH + 1) });
  await assertInvalid(['merchantTooLong'], h.service.save(merchant, Fx.today));
});

test('every problem has a readable message that never contains an amount', () => {
  for (const code of ['amountNotPositive', 'amountTooLarge', 'categoryRequired', 'categoryNotFound', 'subcategoryNotInCategory',
    'paymentMethodNotFound', 'dateTooEarly', 'dateTooFarInFuture', 'invalidTime', 'merchantTooLong', 'notesTooLong', 'tooManyTags']) {
    const text = expenseProblemMessage(code);
    assert.ok(text.length > 5 && !/\d{3}/.test(text), `${code}: ${text}`);
  }
});

// Text cleaning and tags ------------------------------------------------------------------------

test('text fields are cleaned', async () => {
  const h = makeHarness();
  const input = draft('5', h.groceries, {
    merchant: '  Lulu    Hypermarket \n', notes: '\n  line one\nline two  \n', tags: [' #Lunch ', 'lunch', 'Work,Trip', '', '   '],
  });
  const saved = await h.service.save(input, Fx.today);
  assert.equal(saved.merchant, 'Lulu Hypermarket');
  assert.equal(saved.notes, 'line one\nline two');
  assert.deepEqual([...saved.tags], ['Lunch', 'Work Trip']);
  assert.deepEqual(h.store.snapshot.tags.map((t) => t.name).sort(), ['Lunch', 'Work Trip']);
  // Saving the same tags again (different case) creates no new tag records.
  await h.service.save(draft('6', h.groceries, { tags: ['LUNCH'] }), Fx.today);
  assert.equal(h.store.snapshot.tags.length, 2);
});

// Edit -------------------------------------------------------------------------------------------

test('editing keeps identity and creation time', async () => {
  const h = makeHarness();
  const original = await h.service.save(draft('20', h.groceries), Fx.today);
  h.clock.now = Fx.now + 3_600_000;

  const edit = editDraft(original);
  edit.amount = Fx.money('25.25');
  edit.categoryID = h.transport.id;
  edit.merchant = 'Taxi';
  const updated = await h.service.save(edit, Fx.today);

  assert.equal(h.store.snapshot.expenses.length, 1);
  assert.equal(updated.id, original.id);
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.modifiedAt, Fx.now + 3_600_000);
  assert.equal(updated.amount.minorUnits, 2525);
  assert.equal(updated.categoryNameSnapshot, 'Transport');
  assert.equal(h.store.snapshot.expense(original.id).merchant, 'Taxi');
});

test('an edit draft reproduces the original values', async () => {
  const h = makeHarness();
  const saved = await h.service.save(draft('9.99', h.groceries, { hasExplicitTime: true, hour: 7, minute: 45 }), Fx.today);
  const reopened = editDraft(saved);
  assert.equal(reopened.id, saved.id);
  assert.deepEqual(reopened.amount, saved.amount);
  assert.ok(reopened.day.equals(saved.localDay));
  assert.equal(reopened.hasExplicitTime, true);
  assert.equal(reopened.hour, 7);
  assert.equal(reopened.minute, 45);
  assert.equal(reopened.timeZoneID, Fx.dubai);
});

// Delete -----------------------------------------------------------------------------------------

test('delete removes only that expense', async () => {
  const h = makeHarness();
  const first = await h.service.save(draft('1', h.groceries), Fx.today);
  const second = await h.service.save(draft('2', h.groceries), Fx.today);
  await h.service.delete(first.id);
  assert.deepEqual(h.store.snapshot.expenses.map((e) => e.id), [second.id]);
  assert.equal(h.store.stored.expenses.length, 1);
});

test('deleting something that does not exist is reported', async () => {
  const h = makeHarness();
  await rejectsWithCode(h.service.delete(Fx.uuid(12345)), 'notFound');
});

test('bulk delete is one step and counts what existed', async () => {
  const h = makeHarness();
  const ids = [];
  for (const amount of ['1', '2', '3', '4']) ids.push((await h.service.save(draft(amount, h.groceries), Fx.today)).id);
  const writesBefore = h.store.writeCount;
  const removed = await h.service.deleteMany([ids[0], ids[1], ids[2], Fx.uuid(777)]);
  assert.equal(removed, 3);
  assert.equal(h.store.writeCount, writesBefore + 1, 'One atomic write');
  assert.equal(h.store.snapshot.expenses.length, 1);
});

// Failed writes ----------------------------------------------------------------------------------

test('a failed save changes nothing and can be retried', async () => {
  const h = makeHarness();
  h.store.failNextWrite = true;
  const input = draft('30', h.groceries);
  await assert.rejects(h.service.save(input, Fx.today));
  assert.equal(h.store.snapshot.expenses.length, 0, 'Memory must not show something that was not saved');
  assert.equal(h.store.stored.expenses.length, 0);
  await h.service.save(input, Fx.today);
  assert.equal(h.store.snapshot.expenses.length, 1);
});

test('a failed delete keeps the expense', async () => {
  const h = makeHarness();
  const saved = await h.service.save(draft('30', h.groceries), Fx.today);
  h.store.failNextWrite = true;
  await assert.rejects(h.service.delete(saved.id));
  assert.equal(h.store.snapshot.expenses.length, 1);
});

// Recent choices ---------------------------------------------------------------------------------

test('recent categories and payment method', async () => {
  const h = makeHarness();
  await h.service.save(draft('1', h.groceries, { paymentMethodID: h.cash.id }), Fx.today);
  h.clock.now = Fx.now + 60_000;
  await h.service.save(draft('2', h.transport), Fx.today);
  assert.deepEqual(h.service.recentCategoryIDs(), [h.transport.id, h.groceries.id]);
  assert.equal(h.service.recentPaymentMethodID(), h.cash.id);
  h.clock.now = Fx.now + 120_000;
  await h.service.save(draft('3', h.groceries), Fx.today);
  assert.deepEqual(h.service.recentCategoryIDs(1), [h.groceries.id]);
});

// Recurring occurrences --------------------------------------------------------------------------

test('one expense per recurring occurrence', async () => {
  const h = makeHarness();
  const key = occurrenceKey(Fx.uuid(700), Fx.today);
  const first = draft('50', h.groceries, { occurrenceKey: key });
  await h.service.save(first, Fx.today);
  const second = draft('50', h.groceries, { occurrenceKey: key });
  await rejectsWithCode(h.service.save(second, Fx.today), 'duplicateOccurrence');
  await h.service.save(first, Fx.today); // saving the same expense again is an edit, not a clash
  assert.equal(h.store.snapshot.expenses.length, 1);
});

test('deleting a recurring expense remembers that the occurrence was dealt with', async () => {
  const h = makeHarness();
  const key = occurrenceKey(Fx.uuid(700), Fx.today);
  const saved = await h.service.save(draft('50', h.groceries, { occurrenceKey: key }), Fx.today);
  const changes = new (await import('../docs/js/core/snapshot.js')).LedgerChangeSet();
  const { makeLogEntry } = await import('../docs/js/core/models.js');
  changes.logEntriesToUpsert = [makeLogEntry({
    id: Fx.uuid(1), templateID: Fx.uuid(700), dueDay: Fx.today, outcome: 'recorded', expenseID: saved.id, decidedAt: Fx.now,
  })];
  await h.store.commit(changes);
  await h.service.delete(saved.id);
  const entry = h.store.snapshot.recurrenceLog[0];
  assert.equal(entry.outcome, 'skipped');
  assert.equal(entry.expenseID, null);
});
