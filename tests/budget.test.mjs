import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger, rejectsWithCode } from './support.mjs';
import { evaluateBudgetAlerts, GENERIC_BUDGET_BODY, GENERIC_BUDGET_TITLE } from '../docs/js/core/alerts.js';
import {
  alertKey, approachThreshold, budgetPeriod, budgetStatus, budgetStatuses, planBudgetAlerts, reached,
} from '../docs/js/core/budgets.js';
import { BudgetService, sanitizedThresholds } from '../docs/js/core/budget_service.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { makeBudget } from '../docs/js/core/models.js';
import { MAX_MINOR_UNITS, money } from '../docs/js/core/money.js';
import { LedgerDirectory } from '../docs/js/core/snapshot.js';
import { newId } from '../docs/js/core/util.js';

const sample = new SampleLedger();
const day = (y, m, d) => Fx.day(y, m, d);
const between = (a, b) => DayRange.between(a, b);

function budget(amount, {
  category = null, kind = 'monthly', thresholds = [80, 100], notify = true, start = null, end = null, currency = 'AED', id = newId(),
} = {}) {
  return makeBudget({
    id, name: category ? category.name : 'Overall', categoryID: category ? category.id : null, periodKind: kind,
    customStart: start, customEnd: end, amount: Fx.money(amount, currency), alertThresholds: thresholds,
    notificationsEnabled: notify, isActive: true, createdAt: Fx.now, modifiedAt: Fx.now,
  });
}

function status(b, { snapshot = sample.snapshot, today = Fx.today } = {}) {
  return budgetStatus(b, snapshot.expenses, new LedgerDirectory(snapshot), today, snapshot.settings.firstWeekday);
}

const statusList = (...items) => items.filter((s) => s !== null);

// Periods ----------------------------------------------------------------------------------------

test('budget periods', () => {
  assert.ok(budgetPeriod(budget('100'), Fx.today, 2).equals(between(day(2026, 10, 1), day(2026, 10, 31))));
  assert.ok(budgetPeriod(budget('100', { kind: 'weekly' }), Fx.today, 2).equals(between(day(2026, 10, 19), day(2026, 10, 25))));
  assert.ok(budgetPeriod(budget('100', { kind: 'weekly' }), Fx.today, 1).equals(between(day(2026, 10, 18), day(2026, 10, 24))));
  const custom = budget('100', { kind: 'custom', start: day(2026, 10, 10), end: day(2026, 10, 25) });
  assert.ok(budgetPeriod(custom, Fx.today, 2).equals(between(day(2026, 10, 10), day(2026, 10, 25))));
  assert.equal(budgetPeriod(budget('100', { kind: 'custom' }), Fx.today, 2), null);
  assert.equal(status(budget('100', { kind: 'custom' })), null);
});

// Spent, remaining, percentage -------------------------------------------------------------------

test('overall monthly budget', () => {
  const result = status(budget('1000'));
  assert.equal(result.spent.minorUnits, 23_850);
  assert.equal(result.limit.minorUnits, 100_000);
  assert.equal(result.remaining.minorUnits, 76_150);
  assert.equal(result.percentConsumed, 23.9);
  assert.equal(result.level, 'ok');
  assert.equal(result.isOver, false);
  assert.equal(result.categoryName, null);
  assert.equal(result.elapsedDays, 20);
  assert.equal(result.totalDays, 31);
  assert.equal(result.daysLeft, 11);
  assert.equal(result.remainingPerDay.minorUnits, 6_923);
});

test('the projection is an estimate based on the daily average so far', () => {
  const result = status(budget('1000'));
  // 238.50 over 20 days, continued for 31 days: 369.675, shown as 369.68.
  assert.equal(result.projectedTotal.minorUnits, 36_968);
  assert.equal(result.projectedOverBy, null);
  assert.equal(result.projectionIsEarly, false);
});

test('a category budget counts only that category', () => {
  const result = status(budget('100', { category: sample.groceries }));
  assert.equal(result.spent.minorUnits, 9_250);
  assert.equal(result.percentConsumed, 92.5);
  assert.equal(result.level, 'approaching');
  assert.equal(result.remaining.minorUnits, 750);
  assert.equal(result.categoryName, 'Groceries');
});

test('a category budget includes its subcategories', () => {
  // The "Milk" expense (50.00) is a subcategory of Groceries and counts toward the Groceries budget.
  const result = status(budget('100', { category: sample.groceries }));
  assert.ok(result.spent.minorUnits >= 5_000);
  assert.equal(sample.e[0].subcategoryID, sample.milk.id);
});

test('an exceeded budget', () => {
  const result = status(budget('100', { category: sample.entertainment }));
  assert.equal(result.spent.minorUnits, 12_000);
  assert.equal(result.remaining.minorUnits, -2_000);
  assert.equal(result.percentConsumed, 120);
  assert.equal(result.level, 'exceeded');
  assert.equal(result.isOver, true);
  assert.equal(result.remainingPerDay, null, 'Nothing is left to spread over the remaining days');
  assert.equal(result.projectedTotal.minorUnits, 18_600);
  assert.equal(result.projectedOverBy.minorUnits, 8_600);
});

test('spending exactly the limit is not over budget', () => {
  const result = status(budget('120', { category: sample.entertainment }));
  assert.deepEqual(result.spent, result.limit);
  assert.equal(result.isOver, false);
  assert.equal(result.level, 'approaching');
  assert.equal(result.percentConsumed, 100);
  assert.equal(result.remaining.minorUnits, 0);
});

test('the warning level uses exact math, not the rounded percentage', () => {
  const snapshot = Fx.catalog();
  const food = Fx.category('Food & Dining', snapshot);
  snapshot.expenses = [Fx.expense('79.99', Fx.today, food)];
  const justUnder = status(budget('100', { category: food }), { snapshot });
  assert.equal(justUnder.percentConsumed, 80, 'Shown rounded: 80.0%');
  assert.equal(justUnder.level, 'ok', '...but it has not really reached 80%');
  snapshot.expenses = [Fx.expense('80', Fx.today, food)];
  assert.equal(status(budget('100', { category: food }), { snapshot }).level, 'approaching');
  snapshot.expenses = [Fx.expense('100.01', Fx.today, food)];
  assert.equal(status(budget('100', { category: food }), { snapshot }).level, 'exceeded');
  assert.equal(reached(Fx.money('79.99'), Fx.money('100'), 80), false);
  assert.equal(reached(Fx.money('80'), Fx.money('100'), 80), true);
});

test('a custom approach threshold', () => {
  const strict = budget('100', { category: sample.groceries, thresholds: [95, 100] });
  assert.equal(approachThreshold(strict), 95);
  const none = budget('100', { category: sample.groceries, thresholds: [100] });
  assert.equal(approachThreshold(none), 80);
  // 92.5% is below the 95% warning point of the strict budget.
  assert.equal(status(strict).level, 'ok');
});

// Projection details -----------------------------------------------------------------------------

test('early in the period the projection is marked unreliable', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.expenses = [sample.e[5]]; // the only expense on or before October 2: 30.00 on October 1
  const result = status(budget('1000'), { snapshot, today: day(2026, 10, 2) });
  assert.equal(result.elapsedDays, 2);
  assert.equal(result.spent.minorUnits, 3_000);
  assert.equal(result.projectedTotal.minorUnits, 46_500);
  assert.equal(result.projectionIsEarly, true);
});

test('a finished period projects exactly what was spent', () => {
  const result = status(budget('1000'), { today: day(2026, 10, 31) });
  assert.deepEqual(result.projectedTotal, result.spent);
  assert.equal(result.daysLeft, 0);
  assert.equal(result.remainingPerDay, null);
});

test('a custom budget before, during and after', () => {
  const during = status(budget('500', { kind: 'custom', start: day(2026, 10, 10), end: day(2026, 10, 25) }));
  assert.equal(during.spent.minorUnits, 20_850);
  assert.equal(during.elapsedDays, 11);
  assert.equal(during.totalDays, 16);
  assert.equal(during.daysLeft, 5);
  const before = status(budget('500', { kind: 'custom', start: day(2026, 11, 1), end: day(2026, 11, 30) }));
  assert.equal(before.spent.minorUnits, 0);
  assert.equal(before.elapsedDays, 0);
  assert.equal(before.projectedTotal, null);
  assert.equal(before.daysLeft, 30);
  const after = status(budget('500', { kind: 'custom', start: day(2026, 9, 1), end: day(2026, 9, 30) }));
  assert.equal(after.spent.minorUnits, 21_500);
  assert.deepEqual(after.projectedTotal, after.spent);
  assert.equal(after.daysLeft, 0);
});

test('a weekly budget follows the first weekday setting', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.expenses.push(Fx.expense('100', day(2026, 10, 18), sample.groceries)); // a Sunday
  snapshot.normalizeOrder();
  snapshot.settings = Object.freeze({ ...snapshot.settings, firstWeekday: 2 });
  assert.equal(status(budget('500', { kind: 'weekly' }), { snapshot }).spent.minorUnits, 20_850);
  snapshot.settings = Object.freeze({ ...snapshot.settings, firstWeekday: 1 });
  assert.equal(status(budget('500', { kind: 'weekly' }), { snapshot }).spent.minorUnits, 30_850);
});

test('other currency expenses are not counted against a budget', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.expenses.push(Fx.expense('500', Fx.today, sample.groceries, { currency: 'USD' }));
  snapshot.normalizeOrder();
  assert.equal(status(budget('1000'), { snapshot }).spent.minorUnits, 23_850);
  assert.equal(status(budget('1000', { currency: 'USD' }), { snapshot }).spent.minorUnits, 50_000);
});

test('statuses are ordered overall first, then by how full they are', () => {
  const overall = budget('1000');
  const groceries = budget('100', { category: sample.groceries });
  const entertainment = budget('100', { category: sample.entertainment });
  const inactive = makeBudget({ ...budget('10', { category: sample.fuel }), isActive: false });
  const statuses = budgetStatuses([groceries, inactive, entertainment, overall], sample.snapshot.expenses, sample.directory, Fx.today, 2);
  assert.deepEqual(statuses.map((s) => s.budget.id), [overall.id, entertainment.id, groceries.id]);
});

// Alerts -----------------------------------------------------------------------------------------

test('an alert only for the highest newly reached threshold', () => {
  const big = budget('100', { category: sample.entertainment, thresholds: [50, 80, 100] });
  const plan = planBudgetAlerts(statusList(status(big)), new Set());
  assert.equal(plan.alerts.length, 1);
  assert.equal(plan.alerts[0].threshold, 100);
  assert.equal(plan.alerts[0].isOver, true);
  assert.equal(plan.reachedKeys.size, 3, '50, 80 and 100 have all been reached');
});

test('an alert is not repeated', () => {
  const target = budget('100', { category: sample.groceries, thresholds: [80, 100] });
  const statuses = statusList(status(target));
  const first = planBudgetAlerts(statuses, new Set());
  assert.deepEqual(first.alerts.map((a) => a.threshold), [80]);
  const second = planBudgetAlerts(statuses, first.reachedKeys);
  assert.equal(second.alerts.length, 0);
});

test('earlier thresholds already announced are skipped', () => {
  const target = budget('100', { category: sample.entertainment, thresholds: [50, 80, 100] });
  const statuses = statusList(status(target));
  const all = planBudgetAlerts(statuses, new Set()).reachedKeys;
  const key50 = alertKey(target.id, day(2026, 10, 1), 50, 10_000);
  const key80 = alertKey(target.id, day(2026, 10, 1), 80, 10_000);
  assert.ok(all.has(key50));
  assert.ok(all.has(key80));
  const next = planBudgetAlerts(statuses, new Set([key50, key80]));
  assert.deepEqual(next.alerts.map((a) => a.threshold), [100]);
});

test('nothing fires below the first threshold', () => {
  const roomy = budget('1000', { category: sample.groceries });
  const plan = planBudgetAlerts(statusList(status(roomy)), new Set());
  assert.equal(plan.alerts.length, 0);
  assert.equal(plan.reachedKeys.size, 0);
});

test('budgets with notifications off never alert', () => {
  const quiet = budget('100', { category: sample.entertainment, notify: false });
  assert.equal(planBudgetAlerts(statusList(status(quiet)), new Set()).alerts.length, 0);
});

test('a new period or a new limit can alert again', () => {
  const target = budget('100', { category: sample.groceries, thresholds: [80, 100] });
  const fired = planBudgetAlerts(statusList(status(target)), new Set()).reachedKeys;
  // A higher limit means a different key, so the situation counts as new.
  const raised = makeBudget({ ...target, amount: Fx.money('110') });
  const raisedPlan = planBudgetAlerts(statusList(status(raised)), fired);
  assert.deepEqual(raisedPlan.alerts.map((a) => a.threshold), [80], '92.50 of 110.00 is 84%, a new situation');
  // The same budget next month has a different period start.
  const snapshot = sample.snapshot.clone();
  snapshot.expenses.push(Fx.expense('90', day(2026, 11, 3), sample.groceries));
  snapshot.normalizeOrder();
  const november = planBudgetAlerts(statusList(status(target, { snapshot, today: day(2026, 11, 10) })), fired);
  assert.deepEqual(november.alerts.map((a) => a.threshold), [80]);
});

// In-app alerts and their text -------------------------------------------------------------------

function snapshotWithBudget({ alertsOn, showAmounts = false }) {
  const snapshot = sample.snapshot.clone();
  snapshot.settings = Object.freeze({ ...snapshot.settings, budgetAlertsEnabled: alertsOn, notificationsShowAmounts: showAmounts });
  // A fixed id: the same budget must produce the same alert keys each time the snapshot is rebuilt.
  snapshot.budgets = [budget('100', { category: sample.groceries, thresholds: [80, 100], id: Fx.uuid(6100) })];
  return snapshot;
}

const evaluate = (snapshot, firedKeys = new Set()) => evaluateBudgetAlerts({
  snapshot, today: Fx.today, firedKeys, formatter: Fx.formatter(),
});

test('alerts are delivered once and remembered', () => {
  const snapshot = snapshotWithBudget({ alertsOn: true });
  const first = evaluate(snapshot);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].kind, 'budget');
  assert.equal(first.firedKeys.size, 1);
  const second = evaluate(snapshot, first.firedKeys);
  assert.equal(second.messages.length, 0);
});

test('switched-off alerts deliver nothing but still remember what was reached', () => {
  const off = evaluate(snapshotWithBudget({ alertsOn: false }));
  assert.equal(off.messages.length, 0);
  assert.equal(off.firedKeys.size, 1);
  // Switching them on later does not announce what was already true.
  const later = evaluate(snapshotWithBudget({ alertsOn: true }), off.firedKeys);
  assert.equal(later.messages.length, 0);
});

test('the default alert text has no amounts or names', () => {
  const note = evaluate(snapshotWithBudget({ alertsOn: true, showAmounts: false })).messages[0];
  assert.equal(note.title, GENERIC_BUDGET_TITLE);
  assert.equal(note.body, GENERIC_BUDGET_BODY);
  const text = `${note.title} ${note.body}`;
  assert.ok(!text.includes('Groceries'));
  assert.ok(!/\d/.test(text), 'No digits, so no amount or percentage');
});

test('details appear only when the person opted in', () => {
  const note = evaluate(snapshotWithBudget({ alertsOn: true, showAmounts: true })).messages[0];
  assert.equal(note.title, 'Groceries: 80% used');
  assert.ok(note.body.includes('92.50'), note.body);
  assert.ok(note.body.includes('100.00'), note.body);
  assert.ok(note.body.includes('7.50'), note.body);
  assert.ok(note.body.includes('AED'), note.body);
});

test('old keys are forgotten', () => {
  const old = alertKey(Fx.uuid(1), day(2024, 1, 1), 80, 10_000);
  const result = evaluate(snapshotWithBudget({ alertsOn: true }), new Set([old, 'not a key']));
  assert.equal(result.firedKeys.size, 1, "Only the current period's key remains");
  assert.equal(result.changed, true);
});

// Budget service ---------------------------------------------------------------------------------

function makeService() {
  const store = Fx.store(sample.snapshot);
  return { service: new BudgetService(store, () => Fx.now), store };
}

test('saving and editing budgets', async () => {
  const { service, store } = makeService();
  const saved = await service.save(makeBudget({ ...budget('250', { category: sample.groceries }), name: '  Food   budget ' }));
  assert.equal(saved.name, 'Food budget');
  assert.equal(store.snapshot.budgets.length, 1);

  const updated = await service.save(makeBudget({ ...saved, amount: Fx.money('300'), createdAt: Fx.now + 99 }));
  assert.equal(store.snapshot.budgets.length, 1);
  assert.equal(updated.createdAt, saved.createdAt, 'The creation time of the first save is kept');
  assert.equal(store.snapshot.budgets[0].amount.minorUnits, 30_000);
});

test('invalid budgets are rejected', async () => {
  const { service } = makeService();
  await rejectsWithCode(service.save(budget('0')), 'amountNotPositive');
  const tooBig = makeBudget({ ...budget('1'), amount: money(MAX_MINOR_UNITS + 1, 'AED') });
  await rejectsWithCode(service.save(tooBig), 'amountTooLarge');
  await rejectsWithCode(service.save(budget('10', { kind: 'custom' })), 'invalidCustomRange');
  await rejectsWithCode(service.save(budget('10', { kind: 'custom', start: day(2026, 10, 5), end: day(2026, 10, 1) })), 'invalidCustomRange');
  const ghost = makeBudget({ ...budget('10'), categoryID: Fx.uuid(77_777) });
  await rejectsWithCode(service.save(ghost), 'categoryNotFound');
});

test('only one active budget per category and period', async () => {
  const { service } = makeService();
  await service.save(budget('100', { category: sample.groceries }));
  await rejectsWithCode(service.save(budget('200', { category: sample.groceries })), 'duplicate');
  await service.save(budget('200', { category: sample.groceries, kind: 'weekly' }));
  await service.save(budget('200', { category: sample.transport }));
  await service.save(budget('900'));
});

test('thresholds are cleaned up', () => {
  assert.deepEqual(sanitizedThresholds([150, 80, 80, 0, -5, 2_000]), [80, 150]);
  assert.deepEqual(sanitizedThresholds([]), [80, 100]);
  assert.deepEqual(sanitizedThresholds([0, -1]), [80, 100]);
});

test('pausing, resuming and deleting', async () => {
  const { service, store } = makeService();
  const saved = await service.save(budget('100', { category: sample.groceries }));
  await service.setActive(false, saved.id);
  assert.equal(store.snapshot.budgets[0].isActive, false);
  await service.setActive(true, saved.id);
  assert.equal(store.snapshot.budgets[0].isActive, true);
  await service.delete(saved.id);
  assert.equal(store.snapshot.budgets.length, 0);
  assert.equal(store.snapshot.expenses.length, 8, 'Budgets never change expenses');
  await rejectsWithCode(service.delete(saved.id), 'notFound');
  await rejectsWithCode(service.setActive(true, newId()), 'notFound');
});
