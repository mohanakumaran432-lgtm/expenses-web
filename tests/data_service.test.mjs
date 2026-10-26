import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { DataService } from '../docs/js/core/data_service.js';
import { ExpenseService } from '../docs/js/core/expense_service.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { makeBudget, makeLogEntry, makeTemplate } from '../docs/js/core/models.js';
import { LedgerChangeSet } from '../docs/js/core/snapshot.js';

let sample;
let store;
let data;

beforeEach(async () => {
  sample = new SampleLedger();
  store = Fx.store(sample.snapshot);
  data = new DataService(store, new ExpenseService(store, () => Fx.now));
  const changes = new LedgerChangeSet();
  changes.budgetsToUpsert = [
    makeBudget({
      id: Fx.uuid(700), name: 'Month', categoryID: null, periodKind: 'monthly', amount: Fx.money('1000'), alertThresholds: [80, 100],
      notificationsEnabled: false, isActive: true, createdAt: Fx.now, modifiedAt: Fx.now,
    }),
    makeBudget({
      id: Fx.uuid(701), name: 'Groceries', categoryID: sample.groceries.id, periodKind: 'weekly', amount: Fx.money('300'), alertThresholds: [80, 100],
      notificationsEnabled: true, isActive: true, createdAt: Fx.now + 1, modifiedAt: Fx.now,
    }),
  ];
  changes.templatesToUpsert = [makeTemplate({
    id: Fx.uuid(800), title: 'Rent', amount: Fx.money('6500'), categoryID: sample.groceries.id, frequency: 'monthly', interval: 1,
    startDay: Fx.day(2026, 1, 1), mode: 'askToConfirm', isActive: true, timeZoneID: Fx.dubai, createdAt: Fx.now, modifiedAt: Fx.now,
  })];
  changes.logEntriesToUpsert = [makeLogEntry({
    id: Fx.uuid(801), templateID: Fx.uuid(800), dueDay: Fx.day(2026, 1, 1), outcome: 'skipped', expenseID: null, decidedAt: Fx.now,
  })];
  await store.commit(changes);
});

test('deleting expenses in a date range keeps everything else', async () => {
  const october = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));
  assert.equal(data.expensesInRange(october).length, 6);
  const removed = await data.deleteExpensesInRange(october);
  assert.equal(removed, 6);
  assert.equal(store.snapshot.expenses.length, 2);
  assert.ok(store.snapshot.expenses.every((expense) => expense.localDay.month === 9));
  assert.equal(store.snapshot.budgets.length, 2, 'budgets stay');
  assert.equal(store.snapshot.categories.length, sample.snapshot.categories.length, 'categories stay');
});

test('the range includes both of its end days', async () => {
  const one = DayRange.single(Fx.day(2026, 10, 19));
  assert.equal(data.expensesInRange(one).length, 2);
  assert.equal(await data.deleteExpensesInRange(one), 2);
  assert.equal(await data.deleteExpensesInRange(one), 0, 'nothing left to delete there');
});

test('deleting all expenses leaves budgets, schedules, categories and settings', async () => {
  assert.equal(await data.deleteAllExpenses(), 8);
  assert.equal(store.snapshot.expenses.length, 0);
  assert.equal(store.snapshot.budgets.length, 2);
  assert.equal(store.snapshot.templates.length, 1);
  assert.equal(store.snapshot.settings.currencyCode, 'AED');
  assert.equal(await data.deleteAllExpenses(), 0);
});

test('deleting all budgets does not touch expenses', async () => {
  assert.equal(await data.deleteAllBudgets(), 2);
  assert.equal(store.snapshot.budgets.length, 0);
  assert.equal(store.snapshot.expenses.length, 8);
  assert.equal(await data.deleteAllBudgets(), 0);
});

test('deleting all schedules removes their log, and expenses recorded from them stay', async () => {
  assert.equal(await data.deleteAllRepeating(), 1);
  assert.equal(store.snapshot.templates.length, 0);
  assert.equal(store.snapshot.recurrenceLog.length, 0);
  assert.equal(store.snapshot.expenses.length, 8);
  assert.equal(await data.deleteAllRepeating(), 0);
});
