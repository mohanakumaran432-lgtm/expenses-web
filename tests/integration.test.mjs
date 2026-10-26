// The whole stack working together. Services write through the store, and then every way of looking at the data
// (report, transaction list, daily groups, CSV, printable report, backup, budgets) must tell the same story.
// Mirrors the iPhone app's IntegrationTests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { makeBackup, openBackup, planRestore } from '../docs/js/core/backup.js';
import { budgetStatuses } from '../docs/js/core/budgets.js';
import { BudgetService } from '../docs/js/core/budget_service.js';
import { CategoryService } from '../docs/js/core/catalog_service.js';
import { makeCSV, parseCSV } from '../docs/js/core/csv.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { ExpenseService, editDraft } from '../docs/js/core/expense_service.js';
import { makeBudget, makeDraft } from '../docs/js/core/models.js';
import { money as makeMoney, parseMoney } from '../docs/js/core/money.js';
import { PeriodResolver } from '../docs/js/core/periods.js';
import { groupByDay, totalOf } from '../docs/js/core/query.js';
import { RecurrenceService } from '../docs/js/core/recurrence_service.js';
import { buildReportDocument } from '../docs/js/core/report_document.js';
import { LedgerDirectory, initialSnapshot } from '../docs/js/core/snapshot.js';

const september = DayRange.between(Fx.day(2026, 9, 1), Fx.day(2026, 9, 30));
const october = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));
const both = SampleLedger.fullRange;

function harness() {
  const catalog = Fx.catalog();
  const store = Fx.store(catalog);
  const clock = { now: Fx.now };
  const expenses = new ExpenseService(store, () => clock.now);
  return { catalog, store, clock, expenses };
}

async function add(h, amount, day, categoryName, { method = null, merchant = '' } = {}) {
  h.clock.now += 1000;
  const draft = makeDraft({
    amount: Fx.money(amount),
    day,
    timeZoneID: Fx.dubai,
    categoryID: Fx.category(categoryName, h.catalog).id,
    paymentMethodID: method ? Fx.method(method, h.catalog).id : null,
    merchant,
  });
  return h.expenses.save(draft, Fx.today);
}

/** Seven expenses worth 3,415.50 AED: five in October (3,200.50) and two in September (215.00). */
async function addLedger(h) {
  return [
    await add(h, '50', Fx.day(2026, 10, 20), 'Groceries', { method: 'Cash', merchant: 'Spinneys' }),
    await add(h, '12.50', Fx.day(2026, 10, 20), 'Groceries', { method: 'Debit Card', merchant: 'Carrefour' }),
    await add(h, '18', Fx.day(2026, 10, 19), 'Coffee & Snacks', { method: 'Credit Card', merchant: 'Café Nero' }),
    await add(h, '120', Fx.day(2026, 10, 19), 'Entertainment', { merchant: 'Reel Cinemas' }),
    await add(h, '3000', Fx.day(2026, 10, 1), 'Rent & Housing', { method: 'Debit Card', merchant: 'Landlord' }),
    await add(h, '15', Fx.day(2026, 9, 30), 'Transport', { method: 'Debit Card', merchant: 'RTA' }),
    await add(h, '200', Fx.day(2026, 9, 15), 'Fuel', { method: 'Credit Card', merchant: 'ADNOC' }),
  ];
}

const minor = (values) => values.reduce((total, value) => total + value.minorUnits, 0);

/** Every figure the app can show for one period, worked out separately, must equal `total`. */
function assertViewsAgree(h, range, total, count) {
  const { snapshot } = h.store;
  const directory = new LedgerDirectory(snapshot);
  const report = Fx.report(snapshot, range);
  const inRange = snapshot.expenses.filter((e) => range.contains(e.localDay));

  assert.equal(report.total.minorUnits, total, 'report total');
  assert.equal(report.count, count, 'report count');
  assert.equal(inRange.length, count, 'expenses in range');
  assert.equal(totalOf(inRange, 'AED').minorUnits, total, 'filtered total');
  assert.equal(minor(report.categories.map((c) => c.total)), total, 'category totals');
  assert.equal(minor(report.subcategories.map((c) => c.total)), total, 'subcategory totals');
  assert.equal(minor(report.paymentMethods.map((c) => c.total)), total, 'payment method totals');
  assert.equal(minor(report.merchants.map((c) => c.total)), total, 'merchant totals');
  assert.equal(minor(report.trend.map((c) => c.total)), total, 'trend totals');
  assert.equal(minor(groupByDay(inRange, 'AED').map((g) => g.subtotal)), total, 'daily subtotals');

  // The CSV that would be exported for the same expenses.
  const table = parseCSV(makeCSV(inRange, directory));
  assert.equal(table.length - 1, count, 'CSV rows');
  let csvTotal = 0;
  for (const row of table.slice(1)) {
    const parsed = parseMoney(row[2], row[3]);
    assert.ok(parsed.ok, `Unreadable CSV amount ${row[2]}`);
    csvTotal += parsed.money.minorUnits;
  }
  assert.equal(csvTotal, total, 'CSV amounts');

  // The printable report.
  const formatter = Fx.formatter();
  const document = buildReportDocument({
    report, comparison: null, directory, formatter, generatedAt: Fx.now, timeZone: Fx.dubai,
  });
  assert.equal(document.summary[0].value, formatter.money.string(makeMoney(total, 'AED')), 'printed total');
  assert.equal(document.summary[1].value, String(count), 'printed count');
}

// Add, edit, delete ------------------------------------------------------------------------------

test('every view agrees after adding, editing and deleting', async () => {
  const h = harness();
  const list = await addLedger(h);
  assertViewsAgree(h, both, 341_550, 7);
  assertViewsAgree(h, october, 320_050, 5);
  assertViewsAgree(h, september, 21_500, 2);

  // The rent was really 3,100: an edit changes the record and adds no second one.
  const raise = editDraft(list[4]);
  raise.amount = Fx.money('3100');
  await h.expenses.save(raise, Fx.today);
  assert.equal(h.store.snapshot.expenses.length, 7);
  assertViewsAgree(h, both, 351_550, 7);

  // The fuel was bought on October 2, not in September: both months change, the grand total does not.
  const move = editDraft(list[6]);
  move.day = Fx.day(2026, 10, 2);
  await h.expenses.save(move, Fx.today);
  assertViewsAgree(h, september, 1_500, 1);
  assertViewsAgree(h, october, 350_050, 6);
  assertViewsAgree(h, both, 351_550, 7);

  await h.expenses.delete(list[3].id);
  assertViewsAgree(h, both, 339_550, 6);
  const removed = await h.expenses.deleteMany([list[0].id, list[1].id]);
  assert.equal(removed, 2);
  assertViewsAgree(h, both, 333_300, 4);
  assert.equal(h.store.stored.expenses.length, 4, 'The saved copy matches what the screens show');
});

test('saving the same form twice still gives one expense', async () => {
  const h = harness();
  const draft = makeDraft({
    amount: Fx.money('42'), day: Fx.today, timeZoneID: Fx.dubai, categoryID: Fx.category('Groceries', h.catalog).id,
  });
  await h.expenses.save(draft, Fx.today);
  await h.expenses.save(draft, Fx.today);
  assert.equal(h.store.snapshot.expenses.length, 1, 'A double tap on Save cannot create a duplicate');
  assertViewsAgree(h, october, 4_200, 1);
});

test('two saves at the same moment (a double tap) still give one expense', async () => {
  const h = harness();
  const draft = makeDraft({
    amount: Fx.money('42'), day: Fx.today, timeZoneID: Fx.dubai, categoryID: Fx.category('Groceries', h.catalog).id,
  });
  await Promise.all([h.expenses.save(draft, Fx.today), h.expenses.save(draft, Fx.today)]);
  assert.equal(h.store.snapshot.expenses.length, 1);
});

// Backup and restore -----------------------------------------------------------------------------

test('backup and restore reproduce every figure', async () => {
  const h = harness();
  await addLedger(h);
  const before = h.store.snapshot;
  const beforeCSV = makeCSV(before.expenses, new LedgerDirectory(before));
  const beforeReport = Fx.report(before, both);

  const text = await makeBackup(before, Fx.now, '1.0 (1)');
  const opened = await openBackup(text);
  assert.deepEqual(opened.warnings, []);

  // A new phone: the default categories exist again, under brand-new ids.
  const fresh = initialSnapshot(Fx.now, 2);
  const target = Fx.store(fresh);
  const plan = planRestore(opened.payload, fresh, 'merge');
  assert.equal(plan.preview.expensesToAdd, 7);
  await target.replaceAll(plan.result);

  const after = target.snapshot;
  const afterReport = Fx.report(after, both);
  assert.deepEqual(afterReport.total, beforeReport.total);
  assert.deepEqual(afterReport.categories.map((c) => c.name), beforeReport.categories.map((c) => c.name));
  assert.deepEqual(afterReport.categories.map((c) => c.total), beforeReport.categories.map((c) => c.total));
  assert.deepEqual(afterReport.paymentMethods.map((c) => c.name), beforeReport.paymentMethods.map((c) => c.name));
  assert.deepEqual(afterReport.merchants.map((c) => c.name), beforeReport.merchants.map((c) => c.name));
  assert.equal(makeCSV(after.expenses, new LedgerDirectory(after)), beforeCSV, 'The exported file is identical after a restore');
  assert.equal(target.stored.expenses.length, 7);
});

test('a password-protected backup restores to exactly the same figures', async () => {
  const h = harness();
  await addLedger(h);
  const before = h.store.snapshot;
  const text = await makeBackup(before, Fx.now, '1.0 (1)', { password: 'a long private password' });
  const opened = await openBackup(text, { password: 'a long private password' });

  const target = Fx.store(initialSnapshot(Fx.now, 2));
  const plan = planRestore(opened.payload, target.snapshot, 'replaceAll');
  await target.replaceAll(plan.result);
  assert.deepEqual(Fx.report(target.snapshot, both).total, Fx.report(before, both).total);
  assert.equal(makeCSV(target.snapshot.expenses, new LedgerDirectory(target.snapshot)),
    makeCSV(before.expenses, new LedgerDirectory(before)));
});

// Categories -------------------------------------------------------------------------------------

test('renaming, archiving and merging categories never change the totals', async () => {
  const h = harness();
  await addLedger(h);
  const categories = new CategoryService(h.store, () => Fx.now);
  const groceries = Fx.category('Groceries', h.catalog);
  const coffee = Fx.category('Coffee & Snacks', h.catalog);
  const entertainment = Fx.category('Entertainment', h.catalog);

  await categories.updateCategory(groceries.id, 'Food Shopping', groceries.iconSymbol, groceries.colorHex);
  let report = Fx.report(h.store.snapshot, both);
  assert.equal(report.categories.find((c) => c.categoryID === groceries.id).name, 'Food Shopping');
  assert.equal(report.categories.find((c) => c.name === 'Groceries'), undefined, 'Old expenses show the new name');
  assertViewsAgree(h, both, 341_550, 7);

  await categories.setCategoryArchived(true, entertainment.id);
  report = Fx.report(h.store.snapshot, both);
  const archived = report.categories.find((c) => c.categoryID === entertainment.id);
  assert.equal(archived.total.minorUnits, 12_000, 'History keeps an archived category');
  assert.equal(archived.isArchived, true);
  assertViewsAgree(h, both, 341_550, 7);

  const summary = await categories.mergeCategory(coffee.id, groceries.id);
  assert.equal(summary.expensesMoved, 1);
  report = Fx.report(h.store.snapshot, both);
  assert.equal(report.categories.find((c) => c.categoryID === coffee.id), undefined);
  assert.equal(
    report.categories.find((c) => c.categoryID === groceries.id).total.minorUnits, 8_050,
    '50.00 + 12.50 + the 18.00 that moved in',
  );
  assertViewsAgree(h, both, 341_550, 7);
});

// Budgets ----------------------------------------------------------------------------------------

test('budgets measure the same expenses as the report', async () => {
  const h = harness();
  await addLedger(h);
  const groceries = Fx.category('Groceries', h.catalog);
  const budgets = new BudgetService(h.store, () => Fx.now);
  const make = (name, category, amount, id) => makeBudget({
    id, name, categoryID: category ? category.id : null, periodKind: 'monthly', amount: Fx.money(amount),
    alertThresholds: [80, 100], notificationsEnabled: false, isActive: true, createdAt: Fx.now, modifiedAt: Fx.now,
  });
  await budgets.save(make('Groceries', groceries, '100', Fx.uuid(6101)));
  await budgets.save(make('Overall', null, '4000', Fx.uuid(6102)));

  const { snapshot } = h.store;
  const statuses = budgetStatuses(snapshot.budgets, snapshot.expenses, new LedgerDirectory(snapshot), Fx.today, snapshot.settings.firstWeekday);
  assert.equal(statuses.length, 2);
  const report = Fx.report(snapshot, october);

  const overall = statuses[0];
  assert.equal(overall.budget.categoryID, null, 'The overall budget is listed first');
  assert.deepEqual(overall.range, october);
  assert.deepEqual(overall.spent, report.total, "September's expenses are not counted in October's budget");
  assert.equal(overall.remaining.minorUnits, 400_000 - 320_050);

  const food = statuses[1];
  assert.equal(food.spent.minorUnits, 6_250);
  assert.equal(food.spent.minorUnits, report.categories.find((c) => c.categoryID === groceries.id).total.minorUnits);
  assert.equal(food.remaining.minorUnits, 3_750);
});

// Recurring --------------------------------------------------------------------------------------

test('recurring expenses flow into every view and never duplicate', async () => {
  const h = harness();
  const recurrence = new RecurrenceService(h.store, h.expenses, () => Fx.now);
  const rent = Fx.category('Rent & Housing', h.catalog);
  const template = Fx.template({ categoryID: rent.id, from: Fx.day(2026, 8, 20) });
  await recurrence.saveTemplate(template, { pastOccurrences: 'recordThem', today: Fx.today });

  const first = await recurrence.run(Fx.today);
  assert.deepEqual(first.recorded.map((e) => e.localDay.toString()), ['2026-08-20', '2026-09-20', '2026-10-20']);
  const augustToOctober = DayRange.between(Fx.day(2026, 8, 1), Fx.day(2026, 10, 31));
  assertViewsAgree(h, augustToOctober, 900_000, 3);

  const { snapshot } = h.store;
  const csv = parseCSV(makeCSV(snapshot.expenses, new LedgerDirectory(snapshot)));
  assert.ok(csv.slice(1).every((row) => row[10] === 'Yes'), 'Exported rows say they came from a recurring template');

  assert.deepEqual((await recurrence.run(Fx.today)).recorded, [], 'Running again adds nothing');
  await h.expenses.delete(first.recorded[2].id);
  assert.deepEqual((await recurrence.run(Fx.today)).recorded, [], 'A deleted occurrence stays deleted');
  assertViewsAgree(h, augustToOctober, 600_000, 2);
});

test('opening the app twice at once records each recurring occurrence only once', async () => {
  const h = harness();
  const recurrence = new RecurrenceService(h.store, h.expenses, () => Fx.now);
  const rent = Fx.category('Rent & Housing', h.catalog);
  await recurrence.saveTemplate(Fx.template({ categoryID: rent.id, from: Fx.day(2026, 8, 20) }), { pastOccurrences: 'recordThem', today: Fx.today });

  // Two tabs, or a quick double launch, can both run the check.
  const [a, b] = await Promise.all([recurrence.run(Fx.today), recurrence.run(Fx.today)]);
  assert.equal(h.store.snapshot.expenses.length, 3, `Expected 3 expenses but found ${h.store.snapshot.expenses.length} (${a.recorded.length} + ${b.recorded.length} recorded)`);
});

// Home dashboard ---------------------------------------------------------------------------------

test('dashboard periods agree with the transaction list', () => {
  const sample = new SampleLedger();
  const resolver = new PeriodResolver(2);
  const expectations = [
    ['today', 7_050, 3], ['yesterday', 13_800, 2], ['thisWeek', 20_850, 5], ['thisMonth', 23_850, 6],
    ['lastMonth', 21_500, 2], ['thisYear', 45_350, 8], ['lastYear', 0, 0],
  ];
  for (const [kind, total, count] of expectations) {
    const range = resolver.range(kind, Fx.today);
    assert.ok(range, kind);
    const report = Fx.report(sample.snapshot, range);
    const listed = sample.snapshot.expenses.filter((e) => range.contains(e.localDay));
    assert.equal(report.total.minorUnits, total, kind);
    assert.equal(report.count, count, kind);
    assert.equal(totalOf(listed, 'AED').minorUnits, total, kind);
  }

  const month = Fx.report(sample.snapshot, october);
  assert.equal(month.highestCategory.name, 'Entertainment');
  assert.deepEqual(month.expenses.slice(0, 5).map((e) => e.amount.minorUnits), [800, 1_250, 5_000, 12_000, 1_800], 'Recent transactions, newest first');
  const today = Fx.report(sample.snapshot, DayRange.single(Fx.today));
  assert.equal(today.averagePerDay.minorUnits, 7_050);
});

// A large history --------------------------------------------------------------------------------

test('eight thousand expenses stay consistent and quick', () => {
  const base = Fx.catalog();
  const names = base.categories.slice(0, 12).map((c) => c.name);
  const start = Fx.day(2025, 1, 1);
  const list = [];
  let expectedTotal = 0;
  const expectedByCategory = new Map();
  for (let index = 0; index < 8_000; index += 1) {
    const cents = 100 + ((index * 37) % 9_900);
    const name = names[index % 12];
    const pad = cents % 100 < 10 ? '0' : '';
    const text = `${Math.floor(cents / 100)}.${pad}${cents % 100}`;
    list.push(Fx.expense(text, start.addingDays(index % 600), Fx.category(name, base), { createdAt: Fx.now + index * 1000 }));
    expectedTotal += cents;
    expectedByCategory.set(name, (expectedByCategory.get(name) || 0) + cents);
  }
  const snapshot = Fx.adding(list, base);
  const range = DayRange.between(start, Fx.day(2026, 10, 31));

  const started = performance.now();
  const report = Fx.report(snapshot, range);
  const elapsed = performance.now() - started;
  assert.equal(report.count, 8_000);
  assert.equal(report.total.minorUnits, expectedTotal);
  assert.equal(report.categories.length, 12);
  for (const row of report.categories) assert.equal(row.total.minorUnits, expectedByCategory.get(row.name), row.name);
  assert.equal(report.trendGranularity, 'month');
  assert.equal(report.trend.length, 22, 'January 2025 to October 2026');
  assert.equal(minor(report.trend.map((b) => b.total)), expectedTotal);
  const groups = groupByDay(report.expenses, 'AED');
  assert.equal(groups.length, 600);
  assert.equal(minor(groups.map((g) => g.subtotal)), expectedTotal);

  // A generous limit: the point is to catch an accidental slow path, not to benchmark.
  assert.ok(elapsed < 3_000, `The report took ${Math.round(elapsed)} ms`);
  console.log(`      (report for 8,000 expenses: ${Math.round(elapsed)} ms on this machine)`);
});
