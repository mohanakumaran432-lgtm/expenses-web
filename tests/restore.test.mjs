// What a restore would do, worked out before anything is changed. Mirrors the iPhone app's RestoreTests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { payloadFromSnapshot, planRestore } from '../docs/js/core/backup.js';
import { makeBudget, makeExpense, makeLogEntry, normalizeSettings, logEntryKey } from '../docs/js/core/models.js';
import { initialSnapshot } from '../docs/js/core/snapshot.js';
import { totalOf } from '../docs/js/core/query.js';

const sample = new SampleLedger();
const payload = (snapshot = sample.snapshot) => payloadFromSnapshot(snapshot);

/** What a freshly installed app holds: the default categories and payment methods under brand-new ids. */
const freshInstall = () => initialSnapshot(Fx.now, 2);

const groceriesBudget = () => makeBudget({
  id: Fx.uuid(6001), name: 'Groceries', categoryID: sample.groceries.id, periodKind: 'monthly', amount: Fx.money('500'),
  alertThresholds: [80, 100], notificationsEnabled: false, isActive: true, createdAt: Fx.now, modifiedAt: Fx.now,
});

/** A copy of the sample ledger in which one expense was edited later. */
function editedSample(changes) {
  const copy = sample.snapshot.clone();
  const position = copy.expenses.findIndex((e) => e.id === sample.e[0].id);
  copy.expenses[position] = makeExpense({ ...sample.e[0], ...changes });
  copy.invalidate();
  return copy;
}

// Replace everything ------------------------------------------------------------------------------

test('replace-all uses the backup exactly', () => {
  const current = freshInstall();
  current.expenses = [Fx.expense('1', Fx.day(2026, 1, 1), Fx.category('Groceries', current))];
  current.invalidate();
  const backupSnapshot = sample.snapshot.clone();
  backupSnapshot.settings = normalizeSettings({ ...backupSnapshot.settings, hasCompletedOnboarding: false });

  const plan = planRestore(payload(backupSnapshot), current, 'replaceAll');
  assert.deepEqual(plan.result.expenses, backupSnapshot.expenses);
  assert.deepEqual(plan.result.categories, backupSnapshot.categories);
  assert.deepEqual(plan.result.paymentMethods, backupSnapshot.paymentMethods);
  assert.equal(plan.result.settings.hasCompletedOnboarding, true, 'A restored app must not show first-run onboarding again');
  assert.deepEqual(plan.preview, {
    mode: 'replaceAll', currentExpenseCount: 1, backupExpenseCount: 8, expensesToAdd: 8, expensesToUpdate: 0,
    expensesKept: 0, categoriesToAdd: 23, budgetsToAdd: 0, templatesToAdd: 0,
  });
});

test('replace-all does not change the current data it was given', () => {
  const current = freshInstall();
  const before = { categories: current.categories.slice(), expenses: current.expenses.slice(), settings: current.settings };
  planRestore(payload(), current, 'replaceAll');
  assert.deepEqual(current.categories, before.categories);
  assert.deepEqual(current.expenses, before.expenses);
  assert.equal(current.settings, before.settings);
});

test('replace-all of an empty backup leaves an empty ledger, not the old one', () => {
  const current = sample.snapshot.clone();
  const empty = Fx.catalog();
  const plan = planRestore(payload(empty), current, 'replaceAll');
  assert.equal(plan.result.expenses.length, 0);
  assert.equal(plan.preview.currentExpenseCount, 8);
  assert.equal(plan.preview.backupExpenseCount, 0);
});

// Merge -------------------------------------------------------------------------------------------

test('merging into a fresh install maps the defaults by name instead of duplicating them', () => {
  const fresh = freshInstall();
  const plan = planRestore(payload(), fresh, 'merge');
  const { result } = plan;

  assert.equal(result.categories.length, 23);
  assert.equal(result.paymentMethods.length, 5);
  assert.equal(result.expenses.length, 8);
  assert.equal(plan.preview.expensesToAdd, 8);
  assert.equal(plan.preview.categoriesToAdd, 0);

  const freshGroceries = Fx.category('Groceries', fresh);
  assert.equal(result.expenses.filter((e) => e.categoryID === freshGroceries.id).length, 3);
  assert.deepEqual(result.subcategories.map((s) => s.name), ['Milk']);
  assert.equal(result.subcategories[0].categoryID, freshGroceries.id);
  const freshCash = Fx.method('Cash', fresh);
  assert.equal(result.expenses.filter((e) => e.paymentMethodID === freshCash.id).length, 3);
  assert.ok(result.expenses.every((e) => result.category(e.categoryID) !== null), 'Every reference resolves');

  const report = Fx.report(result, SampleLedger.fullRange);
  assert.equal(report.total.minorUnits, SampleLedger.grandTotalMinor);
  assert.equal(report.categories.find((c) => c.name === 'Groceries').total.minorUnits, 9_250);
});

test('merging the same backup twice adds nothing the second time', () => {
  const first = planRestore(payload(), freshInstall(), 'merge');
  const second = planRestore(payload(), first.result, 'merge');
  assert.equal(second.preview.expensesToAdd, 0);
  assert.equal(second.preview.expensesToUpdate, 0);
  assert.equal(second.preview.expensesKept, 8);
  assert.equal(second.preview.categoriesToAdd, 0);
  assert.deepEqual(second.result.expenses, first.result.expenses);
  assert.deepEqual(second.result.categories, first.result.categories);
  assert.deepEqual(second.result.subcategories, first.result.subcategories);
  assert.deepEqual(second.result.paymentMethods, first.result.paymentMethods);
});

test('merging a backup of the same ledger changes nothing', () => {
  const plan = planRestore(payload(), sample.snapshot, 'merge');
  assert.equal(plan.preview.expensesToAdd, 0);
  assert.equal(plan.preview.expensesKept, 8);
  assert.deepEqual(plan.result.expenses, sample.snapshot.expenses);
  assert.deepEqual(plan.result.categories, sample.snapshot.categories);
});

test('the newer copy of the same expense wins', () => {
  const edited = editedSample({ amount: Fx.money('55'), modifiedAt: Fx.now + 500_000 });

  // The app has the later edit; the backup has the original: the app's copy stays.
  const keepApp = planRestore(payload(), edited, 'merge');
  assert.equal(keepApp.preview.expensesKept, 8);
  assert.equal(keepApp.preview.expensesToUpdate, 0);
  assert.equal(keepApp.result.expense(sample.e[0].id).amount.minorUnits, 5_500);

  // The backup has the later edit; the app has the original: the backup's copy is taken.
  const takeBackup = planRestore(payload(edited), sample.snapshot, 'merge');
  assert.equal(takeBackup.preview.expensesToUpdate, 1);
  assert.equal(takeBackup.preview.expensesKept, 7);
  assert.equal(takeBackup.result.expense(sample.e[0].id).amount.minorUnits, 5_500);

  // The same edit time on both sides is a tie, and a tie keeps what the app has.
  const tie = editedSample({ amount: Fx.money('77'), modifiedAt: sample.e[0].modifiedAt });
  const tied = planRestore(payload(tie), sample.snapshot, 'merge');
  assert.equal(tied.preview.expensesToUpdate, 0);
  assert.equal(tied.result.expense(sample.e[0].id).amount.minorUnits, 5_000);
});

test('two similar expenses with different ids are both kept', () => {
  const twin = Fx.expense('50', Fx.day(2026, 10, 20), sample.groceries, {
    subcategory: sample.milk, method: sample.cash, merchant: 'Spinneys', tags: ['family'], createdAt: Fx.now,
  });
  const current = sample.snapshot.clone();
  current.expenses.push(twin);
  current.normalizeOrder();
  const plan = planRestore(payload(), current, 'merge');
  assert.equal(plan.result.expenses.length, 9, 'Buying the same thing twice is legitimate');
  assert.equal(plan.preview.expensesToAdd, 0);
});

test('merge keeps the current settings', () => {
  const current = freshInstall();
  current.settings = normalizeSettings({ ...current.settings, currencyCode: 'USD', firstWeekday: 1 });
  const plan = planRestore(payload(), current, 'merge');
  assert.equal(plan.result.settings.currencyCode, 'USD');
  assert.equal(plan.result.settings.firstWeekday, 1);
});

test('budgets and templates are added with their categories remapped', () => {
  const source = sample.snapshot.clone();
  const template = Fx.template({ categoryID: sample.groceries.id, from: Fx.day(2026, 10, 1) });
  source.budgets = [groceriesBudget()];
  source.templates = [template];
  const fresh = freshInstall();
  const freshGroceries = Fx.category('Groceries', fresh);

  const plan = planRestore(payload(source), fresh, 'merge');
  assert.equal(plan.preview.budgetsToAdd, 1);
  assert.equal(plan.preview.templatesToAdd, 1);
  assert.equal(plan.result.budgets[0].categoryID, freshGroceries.id);
  assert.equal(plan.result.templates[0].categoryID, freshGroceries.id);

  const again = planRestore(payload(source), plan.result, 'merge');
  assert.equal(again.preview.budgetsToAdd, 0);
  assert.equal(again.preview.templatesToAdd, 0);
  assert.equal(again.result.budgets.length, 1);
  assert.equal(again.result.templates.length, 1);
});

test('an expense made by a recurring template keeps its link to the template', () => {
  const source = sample.snapshot.clone();
  const template = Fx.template({ categoryID: sample.groceries.id, from: Fx.day(2026, 10, 1) });
  source.templates = [template];
  const recurring = makeExpense({
    ...sample.e[5], id: Fx.uuid(9200), recurringTemplateID: template.id, occurrenceKey: `${template.id}#2026-10-01`,
  });
  source.expenses.push(recurring);
  source.normalizeOrder();

  const plan = planRestore(payload(source), freshInstall(), 'merge');
  const restored = plan.result.expense(recurring.id);
  assert.equal(restored.recurringTemplateID, template.id);
  assert.equal(restored.occurrenceKey, `${template.id}#2026-10-01`);
  assert.equal(plan.result.templates[0].id, template.id);
});

test('recurrence history is merged without overwriting decisions', () => {
  const source = sample.snapshot.clone();
  const template = Fx.template({ categoryID: sample.groceries.id, from: Fx.day(2026, 10, 1) });
  const october = makeLogEntry({
    id: Fx.uuid(8001), templateID: template.id, dueDay: Fx.day(2026, 10, 1), outcome: 'recorded', expenseID: null, decidedAt: Fx.now,
  });
  const november = makeLogEntry({
    id: Fx.uuid(8002), templateID: template.id, dueDay: Fx.day(2026, 11, 1), outcome: 'skipped', expenseID: null, decidedAt: Fx.now,
  });
  const stray = makeLogEntry({
    id: Fx.uuid(8003), templateID: Fx.uuid(5999), dueDay: Fx.day(2026, 10, 1), outcome: 'skipped', expenseID: null, decidedAt: Fx.now,
  });
  source.templates = [template];
  source.recurrenceLog = [october, november, stray];

  const first = planRestore(payload(source), freshInstall(), 'merge');
  assert.deepEqual(
    first.result.recurrenceLog.map(logEntryKey).sort(),
    [logEntryKey(october), logEntryKey(november)].sort(),
    'An entry whose template is missing is ignored',
  );

  // The person later changes their mind about October. Merging the old backup again must not undo that.
  const changed = first.result.clone();
  const position = changed.recurrenceLog.findIndex((entry) => logEntryKey(entry) === logEntryKey(october));
  changed.recurrenceLog[position] = makeLogEntry({ ...changed.recurrenceLog[position], outcome: 'skipped' });
  const second = planRestore(payload(source), changed, 'merge');
  const matching = second.result.recurrenceLog.filter((entry) => logEntryKey(entry) === logEntryKey(october));
  assert.equal(matching.length, 1);
  assert.equal(matching[0].outcome, 'skipped');
});

test('an archived and merged category is matched to the one the app already has', () => {
  // Fuel was merged into Transport in the backup. The app has no such history, so Fuel simply maps to its own Fuel.
  const source = sample.snapshot.clone();
  source.categories = source.categories.map((c) => (c.id === sample.fuel.id
    ? Object.freeze({ ...c, isArchived: true, mergedIntoID: sample.transport.id })
    : c));
  const fresh = freshInstall();
  const plan = planRestore(payload(source), fresh, 'merge');
  assert.equal(plan.preview.categoriesToAdd, 0);
  assert.equal(plan.result.categories.length, 23);
  const freshFuel = Fx.category('Fuel', fresh);
  assert.equal(plan.result.expenses.filter((e) => e.categoryID === freshFuel.id).length, 1);
});

test('a category the app does not have is added, and the data stays consistent', () => {
  const source = sample.snapshot.clone();
  const custom = Object.freeze({ ...sample.groceries, id: Fx.uuid(9300), name: 'Pet Supplies', sortOrder: 99 });
  source.categories = [...source.categories, custom];
  source.expenses = [...source.expenses, makeExpense({ ...sample.e[0], id: Fx.uuid(9301), categoryID: custom.id, categoryNameSnapshot: custom.name, subcategoryID: null, subcategoryNameSnapshot: null })];
  source.normalizeOrder();

  const fresh = freshInstall();
  const plan = planRestore(payload(source), fresh, 'merge');
  assert.equal(plan.preview.categoriesToAdd, 1);
  assert.equal(plan.result.categories.length, 24);
  assert.ok(plan.result.category(custom.id));
  assert.equal(plan.result.expense(Fx.uuid(9301)).categoryID, custom.id);
  assert.ok(plan.result.expenses.every((e) => plan.result.category(e.categoryID) !== null));
});

test('merging never changes the data it was given', () => {
  const current = freshInstall();
  const before = { categories: current.categories.slice(), expenses: current.expenses.slice(), paymentMethods: current.paymentMethods.slice() };
  planRestore(payload(), current, 'merge');
  assert.deepEqual(current.categories, before.categories);
  assert.deepEqual(current.expenses, before.expenses);
  assert.deepEqual(current.paymentMethods, before.paymentMethods);
});

// Applying a plan --------------------------------------------------------------------------------

test('restoring through the store is all-or-nothing', async () => {
  const store = Fx.store(freshInstall());
  const plan = planRestore(payload(), store.snapshot, 'replaceAll');

  store.failNextWrite = true;
  await assert.rejects(store.replaceAll(plan.result));
  assert.equal(store.snapshot.expenses.length, 0, 'A failed restore leaves the app as it was');
  assert.equal(store.stored.expenses.length, 0);

  await store.replaceAll(plan.result);
  assert.equal(store.snapshot.expenses.length, 8);
  assert.equal(store.stored.expenses.length, 8);
  assert.equal(totalOf(store.snapshot.expenses, 'AED').minorUnits, SampleLedger.grandTotalMinor);
});
