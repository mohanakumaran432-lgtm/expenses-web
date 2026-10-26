import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, rejectsWithCode } from './support.mjs';
import { ExpenseService } from '../docs/js/core/expense_service.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { makeDraft, makeSubcategory, makeTemplate, occurrenceKey, makeCategory, makePaymentMethod } from '../docs/js/core/models.js';
import { MAX_MINOR_UNITS, money, zero } from '../docs/js/core/money.js';
import { pendingOccurrences } from '../docs/js/core/recurrence.js';
import { MAX_AUTO_RECORD_PER_RUN, RecurrenceService, recurringPrefill } from '../docs/js/core/recurrence_service.js';
import { totalOf } from '../docs/js/core/query.js';
import { LedgerChangeSet } from '../docs/js/core/snapshot.js';
import { newId } from '../docs/js/core/util.js';

// Recurring templates: validation, recording, confirming, pausing, and the guarantees that nothing is ever
// recorded twice or half-recorded. "Today" is always 2026-10-20.

let store;
let expenses;
let service;
let rent;
const october = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));
const day = (y, m, d) => Fx.day(y, m, d);

beforeEach(() => {
  const catalog = Fx.catalog();
  store = Fx.store(catalog);
  expenses = new ExpenseService(store, () => Fx.now);
  service = new RecurrenceService(store, expenses, () => Fx.now);
  rent = Fx.category('Rent & Housing', catalog);
});

const make = ({ id = 5001, frequency = 'monthly', from, until = null, mode = 'autoRecord' }) => Fx.template({
  id, categoryID: rent.id, frequency, from, until, mode,
});
const tweak = (template, changes) => makeTemplate({ ...template, ...changes });
const days = (list) => list.map((e) => e.localDay.toString());

async function assertRejected(template, expected) {
  await rejectsWithCode(service.saveTemplate(template, { today: Fx.today }), expected);
  assert.equal(store.snapshot.templates.length, 0, 'A rejected template must not be stored');
}

// Validation -------------------------------------------------------------------------------------

test('invalid templates are rejected and nothing is stored', async () => {
  let template = tweak(make({ from: Fx.today }), { title: '   \n ' });
  await assertRejected(template, 'titleRequired');

  template = make({ from: Fx.today });
  await assertRejected(tweak(template, { amount: zero('AED') }), 'amountInvalid');
  await assertRejected(tweak(template, { amount: money(-100, 'AED') }), 'amountInvalid');
  await assertRejected(tweak(template, { amount: money(MAX_MINOR_UNITS + 1, 'AED') }), 'amountInvalid');

  await assertRejected(tweak(template, { interval: 0 }), 'intervalInvalid');
  await assertRejected(tweak(template, { interval: 366 }), 'intervalInvalid');
  await assertRejected(tweak(template, { categoryID: Fx.uuid(9999) }), 'categoryNotFound');
  await assertRejected(make({ from: Fx.today, until: day(2026, 10, 19) }), 'endBeforeStart');

  await assertRejected(tweak(template, { reminderDaysBefore: 31 }), 'reminderInvalid');
  await assertRejected(tweak(template, { reminderDaysBefore: 1, reminderHour: 24 }), 'reminderInvalid');
  await assertRejected(tweak(template, { reminderHour: 9, reminderMinute: 60 }), 'reminderInvalid');
});

test('a subcategory must belong to the chosen category', async () => {
  const groceries = Fx.category('Groceries', store.snapshot);
  const milk = makeSubcategory({
    id: Fx.uuid(900), categoryID: groceries.id, name: 'Milk', sortOrder: 0, isArchived: false, mergedIntoID: null,
    createdAt: Fx.now, modifiedAt: Fx.now,
  });
  const changes = new LedgerChangeSet();
  changes.subcategoriesToUpsert = [milk];
  await store.commit(changes);

  let template = tweak(make({ from: Fx.today }), { subcategoryID: milk.id });
  await assertRejected(template, 'subcategoryNotInCategory');
  template = tweak(template, { subcategoryID: Fx.uuid(901) });
  await assertRejected(template, 'subcategoryNotInCategory');

  template = tweak(template, { subcategoryID: milk.id, categoryID: groceries.id });
  assert.equal((await service.saveTemplate(template, { today: Fx.today })).subcategoryID, milk.id);
});

test('text is cleaned before saving', async () => {
  const template = tweak(make({ from: Fx.today }), { title: '  Gym    membership \n', merchant: '  Fit   Zone ' });
  const saved = await service.saveTemplate(template, { today: Fx.today });
  assert.equal(saved.title, 'Gym membership');
  assert.equal(saved.merchant, 'Fit Zone');
  assert.deepEqual(store.snapshot.templates, [saved]);
});

test('saving the same template twice updates it instead of duplicating', async () => {
  const template = make({ from: Fx.today });
  await service.saveTemplate(template, { today: Fx.today });
  await service.saveTemplate(template, { today: Fx.today });
  assert.equal(store.snapshot.templates.length, 1);
});

// Creating and recording -------------------------------------------------------------------------

test('past occurrences can be skipped when the template is created', async () => {
  await service.saveTemplate(make({ from: day(2026, 8, 20) }), { pastOccurrences: 'skipThem', today: Fx.today });
  const skipped = store.snapshot.recurrenceLog.map((e) => e.dueDay.toString()).sort();
  assert.deepEqual(skipped, ['2026-08-20', '2026-09-20']);
  assert.ok(store.snapshot.recurrenceLog.every((e) => e.outcome === 'skipped' && e.expenseID === null));

  const result = await service.run(Fx.today);
  assert.deepEqual(days(result.recorded), ['2026-10-20'], "Only today's occurrence is recorded");
  assert.equal(store.snapshot.expenses.length, 1);
});

test('past occurrences can be recorded when the template is created', async () => {
  await service.saveTemplate(make({ from: day(2026, 8, 20) }), { pastOccurrences: 'recordThem', today: Fx.today });
  assert.equal(store.snapshot.recurrenceLog.length, 0);
  assert.equal(store.snapshot.expenses.length, 0, 'Saving a template records nothing by itself');

  const result = await service.run(Fx.today);
  assert.deepEqual(days(result.recorded), ['2026-08-20', '2026-09-20', '2026-10-20']);
  assert.equal(totalOf(store.snapshot.expenses, 'AED').minorUnits, 900_000);
});

test('running again records nothing new and writes nothing', async () => {
  await service.saveTemplate(make({ from: day(2026, 8, 20) }), { pastOccurrences: 'recordThem', today: Fx.today });
  await service.run(Fx.today);
  const writes = store.writeCount;

  const again = await service.run(Fx.today);
  assert.equal(again.recorded.length, 0);
  assert.equal(store.writeCount, writes, 'Nothing changed, so nothing is written');
  assert.equal(store.snapshot.expenses.length, 3);
  assert.equal(new Set(store.snapshot.expenses.map((e) => e.occurrenceKey)).size, 3);
});

test('a later run records only the new occurrence', async () => {
  await service.saveTemplate(make({ from: day(2026, 8, 20) }), { pastOccurrences: 'recordThem', today: Fx.today });
  await service.run(Fx.today);
  const later = await service.run(day(2026, 11, 20));
  assert.deepEqual(days(later.recorded), ['2026-11-20']);
  assert.equal(store.snapshot.expenses.length, 4);
});

test('a recorded expense carries the template details', async () => {
  const template = tweak(make({ from: Fx.today }), {
    notes: 'Monthly rent', tags: ['Home'], paymentMethodID: Fx.method('Bank Transfer', store.snapshot).id,
  });
  await service.saveTemplate(template, { today: Fx.today });

  const expense = (await service.run(Fx.today)).recorded[0];
  assert.equal(expense.amount.minorUnits, 300_000);
  assert.equal(expense.amount.currencyCode, 'AED');
  assert.ok(expense.localDay.equals(Fx.today));
  assert.equal(expense.hasExplicitTime, false);
  assert.equal(expense.categoryID, rent.id);
  assert.equal(expense.categoryNameSnapshot, 'Rent & Housing');
  assert.equal(expense.paymentMethodNameSnapshot, 'Bank Transfer');
  assert.equal(expense.merchant, 'Rent', 'With no merchant set, the title is used');
  assert.equal(expense.notes, 'Monthly rent');
  assert.equal(expense.timeZoneID, 'Asia/Dubai');
  assert.equal(expense.recurringTemplateID, template.id);
  assert.equal(expense.occurrenceKey, occurrenceKey(template.id, Fx.today));
  assert.deepEqual(store.snapshot.tags.map((t) => t.name.toLowerCase()), ['home']);

  const entry = store.snapshot.recurrenceLog[0];
  assert.equal(entry.outcome, 'recorded');
  assert.equal(entry.expenseID, expense.id);
});

test('nothing is recorded after the end day', async () => {
  const template = make({ from: day(2026, 8, 20), until: day(2026, 9, 30) });
  await service.saveTemplate(template, { pastOccurrences: 'recordThem', today: Fx.today });
  assert.deepEqual(days((await service.run(Fx.today)).recorded), ['2026-08-20', '2026-09-20']);
});

// Ask me to confirm ------------------------------------------------------------------------------

test('confirmation templates wait and add nothing until confirmed', async () => {
  await service.saveTemplate(make({ from: Fx.today, mode: 'askToConfirm' }), { today: Fx.today });

  const result = await service.run(Fx.today);
  assert.equal(result.recorded.length, 0);
  assert.deepEqual(result.awaitingConfirmation.map((o) => o.dueDay.toString()), [Fx.today.toString()]);
  assert.equal(store.snapshot.expenses.length, 0);
  assert.equal(Fx.report(store.snapshot, october).total.minorUnits, 0);

  const waiting = result.awaitingConfirmation[0];
  const confirmed = await service.confirm(waiting, Fx.money('412.75'), Fx.today);
  assert.equal(confirmed.amount.minorUnits, 41_275, 'The amount can be adjusted for a bill that varies');
  assert.equal(Fx.report(store.snapshot, october).total.minorUnits, 41_275);

  await rejectsWithCode(service.confirm(waiting, null, Fx.today), 'occurrenceNotPending');
  assert.equal((await service.run(Fx.today)).awaitingConfirmation.length, 0);
  assert.equal(store.snapshot.expenses.length, 1);
});

test('confirming without an amount uses the template amount', async () => {
  await service.saveTemplate(make({ from: Fx.today, mode: 'askToConfirm' }), { today: Fx.today });
  const waiting = (await service.run(Fx.today)).awaitingConfirmation[0];
  assert.equal((await service.confirm(waiting, null, Fx.today)).amount.minorUnits, 300_000);
});

test('confirming with an invalid amount changes nothing', async () => {
  await service.saveTemplate(make({ from: Fx.today, mode: 'askToConfirm' }), { today: Fx.today });
  const waiting = (await service.run(Fx.today)).awaitingConfirmation[0];
  await assert.rejects(service.confirm(waiting, zero('AED'), Fx.today), (error) => {
    assert.equal(error.code, 'invalid');
    assert.deepEqual(error.details.problems, ['amountNotPositive']);
    return true;
  });
  assert.equal(store.snapshot.expenses.length, 0);
  assert.equal((await service.run(Fx.today)).awaitingConfirmation.length, 1, 'It is still waiting');
});

test('skipping removes an occurrence for good', async () => {
  await service.saveTemplate(make({ from: Fx.today, mode: 'askToConfirm' }), { today: Fx.today });
  const waiting = (await service.run(Fx.today)).awaitingConfirmation[0];
  await service.skip(waiting, Fx.today);

  assert.equal((await service.run(Fx.today)).awaitingConfirmation.length, 0);
  assert.equal(store.snapshot.expenses.length, 0);
  assert.deepEqual(store.snapshot.recurrenceLog.map((e) => e.outcome), ['skipped']);
  await rejectsWithCode(service.skip(waiting, Fx.today), 'occurrenceNotPending');
  await rejectsWithCode(service.confirm(waiting, null, Fx.today), 'occurrenceNotPending');
});

// Deleting, editing, pausing ---------------------------------------------------------------------

test('deleting a recorded occurrence keeps it deleted', async () => {
  await service.saveTemplate(make({ from: Fx.today }), { today: Fx.today });
  const recorded = (await service.run(Fx.today)).recorded[0];
  await expenses.delete(recorded.id);

  assert.equal(store.snapshot.expenses.length, 0);
  assert.deepEqual(store.snapshot.recurrenceLog.map((e) => e.outcome), ['skipped']);
  assert.equal((await service.run(Fx.today)).recorded.length, 0, 'A deleted occurrence is not recreated');
  assert.equal(store.snapshot.expenses.length, 0);
});

test('editing a template never rewrites recorded expenses', async () => {
  const original = await service.saveTemplate(make({ from: Fx.today }), { today: Fx.today });
  await service.run(Fx.today);

  const later = new RecurrenceService(store, expenses, () => Fx.now + 3_600_000);
  const edited = tweak(original, { amount: Fx.money('3500'), title: 'Rent (new lease)' });
  const saved = await later.saveTemplate(edited, { today: Fx.today });

  assert.equal(saved.createdAt, Fx.now, 'The creation time never changes');
  assert.equal(saved.modifiedAt, Fx.now + 3_600_000);
  assert.equal(store.snapshot.templates.length, 1);
  assert.equal(store.snapshot.expenses[0].amount.minorUnits, 300_000, 'Already recorded, so unchanged');
  assert.equal((await later.run(Fx.today)).recorded.length, 0);

  const next = await later.run(day(2026, 11, 20));
  assert.deepEqual(next.recorded.map((e) => e.amount.minorUnits), [350_000], 'The new amount applies from now on');
});

test('resuming a paused template does not backfill', async () => {
  const january = day(2026, 1, 20);
  const template = await service.saveTemplate(make({ from: january }), { today: january });
  await service.run(january);
  assert.equal(store.snapshot.expenses.length, 1);

  await service.setActive(false, template.id, day(2026, 1, 21));
  assert.equal(store.snapshot.templates[0].isActive, false);
  assert.equal((await service.run(Fx.today)).recorded.length, 0, 'A stopped template records nothing');

  await service.setActive(true, template.id, Fx.today);
  const skipped = store.snapshot.recurrenceLog.filter((e) => e.outcome === 'skipped').map((e) => e.dueDay.toString()).sort();
  assert.deepEqual(skipped, ['2026-02-20', '2026-03-20', '2026-04-20', '2026-05-20', '2026-06-20', '2026-07-20', '2026-08-20', '2026-09-20']);
  assert.deepEqual(days((await service.run(Fx.today)).recorded), ['2026-10-20'], "Only today's bill comes back");
  assert.equal(store.snapshot.expenses.length, 2);
});

test('stopping an unknown template fails and repeating the same state writes nothing', async () => {
  await rejectsWithCode(service.setActive(false, Fx.uuid(777), Fx.today), 'notFound');
  const template = await service.saveTemplate(make({ from: Fx.today }), { today: Fx.today });
  const writes = store.writeCount;
  await service.setActive(true, template.id, Fx.today);
  assert.equal(store.writeCount, writes);
});

test('deleting a template keeps the expenses it created', async () => {
  const template = await service.saveTemplate(make({ from: day(2026, 8, 20) }), { pastOccurrences: 'recordThem', today: Fx.today });
  await service.run(Fx.today);
  assert.equal(store.snapshot.recurrenceLog.length, 3);

  await service.deleteTemplate(template.id);
  assert.equal(store.snapshot.templates.length, 0);
  assert.equal(store.snapshot.recurrenceLog.length, 0);
  assert.equal(store.snapshot.expenses.length, 3);
  assert.equal(totalOf(store.snapshot.expenses, 'AED').minorUnits, 900_000);
  assert.equal((await service.run(Fx.today)).recorded.length, 0);
  await rejectsWithCode(service.deleteTemplate(template.id), 'notFound');
});

// Safety -----------------------------------------------------------------------------------------

test('one run records at most four hundred occurrences', async () => {
  await service.saveTemplate(make({ frequency: 'daily', from: day(2025, 1, 1) }), { pastOccurrences: 'recordThem', today: Fx.today });

  const first = await service.run(Fx.today);
  assert.equal(first.recorded.length, MAX_AUTO_RECORD_PER_RUN);
  assert.ok(first.recorded[0].localDay.equals(day(2025, 1, 1)));
  assert.ok(first.recorded.at(-1).localDay.equals(day(2026, 2, 4)));

  const second = await service.run(Fx.today);
  assert.equal(second.recorded.length, 258);
  assert.ok(second.recorded[0].localDay.equals(day(2026, 2, 5)));
  assert.ok(second.recorded.at(-1).localDay.equals(Fx.today));

  assert.equal((await service.run(Fx.today)).recorded.length, 0);
  assert.equal(store.snapshot.expenses.length, 658);
  assert.equal(new Set(store.snapshot.expenses.map((e) => e.occurrenceKey)).size, 658);
});

test('a failed write leaves nothing half recorded', async () => {
  await service.saveTemplate(make({ from: day(2026, 8, 20) }), { pastOccurrences: 'recordThem', today: Fx.today });
  store.failNextWrite = true;
  await assert.rejects(service.run(Fx.today));
  assert.equal(store.snapshot.expenses.length, 0);
  assert.equal(store.stored.expenses.length, 0);
  assert.equal(store.snapshot.recurrenceLog.length, 0);

  const retry = await service.run(Fx.today);
  assert.equal(retry.recorded.length, 3);
  assert.equal(store.stored.expenses.length, 3);
  assert.equal(store.stored.recurrenceLog.length, 3);
});

test('a template whose category is gone is reported and the others still run', async () => {
  // Written straight to the store, the way data from an older backup could arrive.
  const broken = Fx.template({ id: 5002, categoryID: Fx.uuid(9999), from: Fx.today });
  const changes = new LedgerChangeSet();
  changes.templatesToUpsert = [broken];
  await store.commit(changes);
  await service.saveTemplate(make({ from: Fx.today }), { today: Fx.today });

  const result = await service.run(Fx.today);
  assert.deepEqual(result.failedTemplateIDs, [broken.id]);
  assert.equal(result.recorded.length, 1);
  assert.equal(store.snapshot.expenses.length, 1);
});

test('two expenses can never share an occurrence key', async () => {
  const template = await service.saveTemplate(make({ from: Fx.today }), { today: Fx.today });
  const recorded = (await service.run(Fx.today)).recorded[0];
  const clone = makeDraft({
    id: newId(), amount: recorded.amount, day: recorded.localDay, hasExplicitTime: false, hour: 12, minute: 0,
    timeZoneID: recorded.timeZoneID, categoryID: rent.id, recurringTemplateID: template.id, occurrenceKey: recorded.occurrenceKey,
  });
  await rejectsWithCode(expenses.save(clone, Fx.today), 'duplicateOccurrence');
  assert.equal(store.snapshot.expenses.length, 1);
});

// "Make this a repeating expense": what is copied ------------------------------------------------

const subcategoryFor = (number, category, archived = false) => makeSubcategory({
  id: Fx.uuid(number), categoryID: category.id, name: 'Apartment', sortOrder: 0, isArchived: archived, mergedIntoID: null,
  createdAt: Fx.now, modifiedAt: Fx.now,
});
const draftOf = (fields) => makeDraft({ timeZoneID: Fx.dubai, day: Fx.today, ...fields });

test('prefill copies the form and starts on the expense\'s own day', () => {
  const snapshot = Fx.catalog();
  const rentCategory = Fx.category('Rent & Housing', snapshot);
  const cash = Fx.method('Cash', snapshot);
  const apartment = subcategoryFor(900, rentCategory);
  snapshot.subcategories = [apartment];
  snapshot.invalidate();

  const prefill = recurringPrefill(draftOf({
    amount: Fx.money('3000'), day: day(2026, 10, 20), categoryID: rentCategory.id, subcategoryID: apartment.id,
    paymentMethodID: cash.id, merchant: '  Dubai \n Properties  ', notes: '  October rent  ', tags: ['home', 'Home', '#flat'],
  }), snapshot);

  assert.equal(prefill.title, 'Dubai Properties');
  assert.equal(prefill.merchant, 'Dubai Properties');
  assert.deepEqual(prefill.amount, Fx.money('3000'));
  assert.equal(prefill.currencyCode, 'AED');
  assert.equal(prefill.categoryID, rentCategory.id);
  assert.equal(prefill.subcategoryID, apartment.id);
  assert.equal(prefill.paymentMethodID, cash.id);
  assert.equal(prefill.notes, 'October rent');
  assert.deepEqual(prefill.tags, ['home', 'flat']);
  assert.ok(prefill.startDay.equals(day(2026, 10, 20)));
});

test('prefill: the name falls back to the category and a zero amount is not copied', () => {
  const snapshot = Fx.catalog();
  const rentCategory = Fx.category('Rent & Housing', snapshot);
  const withCategory = recurringPrefill(draftOf({ amount: zero('AED'), categoryID: rentCategory.id }), snapshot);
  assert.equal(withCategory.title, 'Rent & Housing');
  assert.equal(withCategory.merchant, '');
  assert.equal(withCategory.amount, null, 'No amount has been typed yet, so none is suggested');

  const empty = recurringPrefill(draftOf({ amount: zero('AED') }), snapshot);
  assert.equal(empty.title, '');
  assert.equal(empty.categoryID, null);
  assert.equal(empty.amount, null);
});

test('prefill: an expense in another currency keeps its currency', () => {
  const snapshot = Fx.catalog();
  const rentCategory = Fx.category('Rent & Housing', snapshot);
  const prefill = recurringPrefill(draftOf({ amount: Fx.money('19.99', 'USD'), categoryID: rentCategory.id, merchant: 'Streaming' }), snapshot);
  assert.equal(prefill.currencyCode, 'USD');
  assert.equal(prefill.amount.currencyCode, 'USD');
  assert.equal(prefill.amount.minorUnits, 1999);
});

test('prefill: choices that are no longer offered are left empty', () => {
  const snapshot = Fx.catalog();
  const rentCategory = Fx.category('Rent & Housing', snapshot);
  const cash = Fx.method('Cash', snapshot);
  const oldSub = subcategoryFor(901, rentCategory, true);
  snapshot.subcategories = [oldSub];
  snapshot.paymentMethods = snapshot.paymentMethods.map((p) => (p.id === cash.id ? makePaymentMethod({ ...p, isArchived: true }) : p));
  snapshot.invalidate();

  const prefill = recurringPrefill(draftOf({
    amount: Fx.money('100'), categoryID: rentCategory.id, subcategoryID: oldSub.id, paymentMethodID: cash.id, merchant: 'Landlord',
  }), snapshot);
  assert.equal(prefill.categoryID, rentCategory.id, 'The category itself is still current');
  assert.equal(prefill.subcategoryID, null);
  assert.equal(prefill.paymentMethodID, null);

  // An archived category takes its subcategory with it, and the name falls back to the merchant.
  const liveSub = subcategoryFor(902, rentCategory);
  snapshot.subcategories = [liveSub];
  snapshot.categories = snapshot.categories.map((c) => (c.id === rentCategory.id ? makeCategory({ ...c, isArchived: true }) : c));
  snapshot.invalidate();
  const archived = recurringPrefill(draftOf({
    amount: Fx.money('100'), categoryID: rentCategory.id, subcategoryID: liveSub.id, merchant: 'Landlord',
  }), snapshot);
  assert.equal(archived.categoryID, null);
  assert.equal(archived.subcategoryID, null);
  assert.equal(archived.title, 'Landlord');
});

test('prefill: a subcategory of another category is not copied', () => {
  const snapshot = Fx.catalog();
  const rentCategory = Fx.category('Rent & Housing', snapshot);
  const transport = Fx.category('Transport', snapshot);
  const strayed = subcategoryFor(903, transport);
  snapshot.subcategories = [strayed];
  snapshot.invalidate();
  const prefill = recurringPrefill(draftOf({ amount: Fx.money('100'), categoryID: rentCategory.id, subcategoryID: strayed.id }), snapshot);
  assert.equal(prefill.subcategoryID, null);
});

// "Make this a repeating expense": never recorded twice ------------------------------------------

test('the expense being entered and the schedule do not record the same day twice', async () => {
  // The person enters today's rent by hand, then makes it repeat. The schedule records automatically.
  const manual = draftOf({ id: Fx.uuid(7001), amount: Fx.money('3000'), categoryID: rent.id, merchant: 'Landlord' });
  await expenses.save(manual, Fx.today);

  const prefill = recurringPrefill(manual, store.snapshot);
  const template = tweak(Fx.template({ categoryID: prefill.categoryID, from: prefill.startDay, mode: 'autoRecord' }), {
    title: prefill.title, amount: prefill.amount,
  });
  await service.saveTemplate(template, { startDayAlreadyEntered: true, today: Fx.today });

  const sameDay = await service.run(Fx.today);
  assert.equal(sameDay.recorded.length, 0, "Today's rent was entered by hand and must not be recorded again");
  assert.equal(store.snapshot.expenses.length, 1);

  const nextMonth = await service.run(day(2026, 11, 20));
  assert.deepEqual(nextMonth.recorded.map((e) => e.localDay.toString()), ['2026-11-20']);
  assert.equal(store.snapshot.expenses.length, 2);

  const again = await service.run(day(2026, 11, 20));
  assert.equal(again.recorded.length, 0, 'Running again changes nothing');
});

test('without the flag the same schedule would record today again (the control)', async () => {
  const manual = draftOf({ id: Fx.uuid(7001), amount: Fx.money('3000'), categoryID: rent.id });
  await expenses.save(manual, Fx.today);
  await service.saveTemplate(Fx.template({ categoryID: rent.id, from: Fx.today, mode: 'autoRecord' }), { today: Fx.today });
  const result = await service.run(Fx.today);
  assert.equal(result.recorded.length, 1);
  assert.equal(store.snapshot.expenses.length, 2);
});

test('the schedule keeps the original day of the month', async () => {
  // Rent paid on 31 January: the schedule must fall on 28 February and then 31 March, not drift to the 28th.
  const template = Fx.template({ categoryID: rent.id, from: day(2026, 1, 31), mode: 'autoRecord' });
  await service.saveTemplate(template, { startDayAlreadyEntered: true, today: day(2026, 1, 31) });
  const result = await service.run(day(2026, 3, 31));
  assert.deepEqual(result.recorded.map((e) => e.localDay.toString()).sort(), ['2026-02-28', '2026-03-31']);
});

test('a confirm schedule does not offer the day that was entered by hand', async () => {
  const template = Fx.template({ categoryID: rent.id, from: Fx.today, mode: 'askToConfirm' });
  await service.saveTemplate(template, { startDayAlreadyEntered: true, today: Fx.today });
  assert.equal(pendingOccurrences(store.snapshot, Fx.today).length, 0);
  const nextMonth = pendingOccurrences(store.snapshot, day(2026, 11, 20));
  assert.deepEqual(nextMonth.map((p) => p.dueDay.toString()), ['2026-11-20']);
});

test('only the start day is covered when earlier dates are recorded too', async () => {
  // A weekly bill that started on 6 October, entered by hand that day, and set to record the dates since then.
  const weekly = Fx.template({ categoryID: rent.id, frequency: 'weekly', from: day(2026, 10, 6), mode: 'autoRecord' });
  await service.saveTemplate(weekly, { pastOccurrences: 'recordThem', startDayAlreadyEntered: true, today: Fx.today });
  const result = await service.run(Fx.today);
  assert.deepEqual(result.recorded.map((e) => e.localDay.toString()).sort(), ['2026-10-13', '2026-10-20']);
});

test('a past start day is marked only once', async () => {
  const template = Fx.template({ categoryID: rent.id, from: day(2026, 10, 10) });
  await service.saveTemplate(template, { startDayAlreadyEntered: true, today: Fx.today });
  const entries = store.snapshot.recurrenceLog.filter((e) => e.dueDay.equals(day(2026, 10, 10)));
  assert.equal(entries.length, 1, 'Skipping past dates and covering the start day must not log it twice');
  assert.equal(entries[0].outcome, 'skipped');
});

test('editing an existing schedule ignores the flag', async () => {
  const template = Fx.template({ categoryID: rent.id, from: day(2026, 12, 1) });
  await service.saveTemplate(template, { today: Fx.today });
  const edited = tweak(template, { amount: Fx.money('3100') });
  await service.saveTemplate(edited, { startDayAlreadyEntered: true, today: Fx.today });
  assert.equal(store.snapshot.recurrenceLog.length, 0, 'Only a new schedule can cover its start day');
  const result = await service.run(day(2026, 12, 1));
  assert.deepEqual(result.recorded.map((e) => e.localDay.toString()), ['2026-12-01']);
});

// Editing never brings back dates that have already passed ----------------------------------------

test('moving the start day earlier does not add expenses for the dates it uncovers', async () => {
  const august = day(2026, 8, 20);
  const original = await service.saveTemplate(make({ from: august }), { pastOccurrences: 'recordThem', today: Fx.today });
  await service.run(Fx.today);
  assert.deepEqual(days(store.snapshot.expenses).sort(), ['2026-08-20', '2026-09-20', '2026-10-20']);

  await service.saveTemplate(tweak(original, { startDay: day(2026, 6, 20) }), { today: Fx.today });

  assert.equal(store.snapshot.expenses.length, 3, 'June and July were not added');
  const skipped = store.snapshot.recurrenceLog.filter((e) => e.outcome === 'skipped').map((e) => e.dueDay.toString()).sort();
  assert.deepEqual(skipped, ['2026-06-20', '2026-07-20']);
  assert.equal((await service.run(Fx.today)).recorded.length, 0);
  assert.deepEqual(days((await service.run(day(2026, 11, 20))).recorded), ['2026-11-20'], 'The next real date still comes');
});

test('extending the end day does not add the passed dates that were left out after it ended', async () => {
  const original = await service.saveTemplate(make({ from: day(2026, 6, 20), until: day(2026, 8, 20) }), { today: day(2026, 6, 20) });
  await service.run(Fx.today);
  assert.deepEqual(days(store.snapshot.expenses).sort(), ['2026-06-20', '2026-07-20', '2026-08-20']);

  await service.saveTemplate(tweak(original, { endDay: day(2026, 12, 31) }), { today: Fx.today });

  assert.equal(store.snapshot.expenses.length, 3, 'September was not added');
  assert.deepEqual(days((await service.run(Fx.today)).recorded), ['2026-10-20'], 'A date that falls today is not a passed date');
  assert.deepEqual(days((await service.run(day(2026, 11, 20))).recorded), ['2026-11-20']);
});

test('dates already waiting stay waiting when the schedule is edited', async () => {
  const original = await service.saveTemplate(make({ from: day(2026, 9, 20), mode: 'askToConfirm' }), { pastOccurrences: 'recordThem', today: Fx.today });
  const waiting = () => pendingOccurrences(store.snapshot, Fx.today).map((p) => p.dueDay.toString());
  assert.deepEqual(waiting(), ['2026-09-20', '2026-10-20']);

  await service.saveTemplate(tweak(original, { amount: Fx.money('3100') }), { today: Fx.today });
  assert.deepEqual(waiting(), ['2026-09-20', '2026-10-20'], 'An unrelated edit leaves them waiting');
  assert.equal(store.snapshot.recurrenceLog.length, 0);
});

test('editing a paused schedule does not skip anything (resuming does that)', async () => {
  const original = await service.saveTemplate(make({ from: day(2026, 8, 20) }), { today: day(2026, 8, 20) });
  await service.setActive(false, original.id, day(2026, 8, 21));
  const logBefore = store.snapshot.recurrenceLog.length;
  await service.saveTemplate(tweak(store.snapshot.templates[0], { startDay: day(2026, 6, 20) }), { today: Fx.today });
  assert.equal(store.snapshot.recurrenceLog.length, logBefore);
});
