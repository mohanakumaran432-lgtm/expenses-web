import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { DayRange } from '../docs/js/core/dayrange.js';
import { PeriodResolver } from '../docs/js/core/periods.js';
import { ExpenseService } from '../docs/js/core/expense_service.js';
import { makeCategory, makeDraft } from '../docs/js/core/models.js';
import { plainString } from '../docs/js/core/money.js';
import { totalOf } from '../docs/js/core/query.js';
import {
  expensesForMerchant, expensesInCategory, expensesInDays, expensesInSubcategory, expensesWithPaymentMethod,
  quickCategoryTotals, quickTotal,
} from '../docs/js/core/reports.js';

const sample = new SampleLedger();
const fullReport = () => Fx.report(sample.snapshot, SampleLedger.fullRange);
const minor = (rows) => rows.map((m) => m.minorUnits);
const sumMinor = (rows) => rows.reduce((total, m) => total + m.minorUnits, 0);
const between = (a, b) => DayRange.between(a, b);
const day = (y, m, d) => Fx.day(y, m, d);

// Headline figures -------------------------------------------------------------------------------

test('total, count and average', () => {
  const report = fullReport();
  assert.equal(report.total.minorUnits, 45_350);
  assert.equal(report.count, 8);
  // 1 September to 20 October 2026 is 50 days that have happened; 45,350 / 50 = 907 fils exactly.
  assert.equal(report.elapsedDays, 50);
  assert.equal(report.averagePerDay.minorUnits, 907);
  assert.equal(report.currencyCode, 'AED');
  assert.equal(report.isEmpty, false);
});

test('highest and lowest expense', () => {
  const report = fullReport();
  assert.equal(report.highest.amount.minorUnits, 20_000);
  assert.equal(report.highest.merchant, 'ADNOC');
  assert.equal(report.lowest.amount.minorUnits, 800);
  assert.equal(report.lowest.categoryNameSnapshot, 'Transport');
});

test('top expenses are ranked by amount', () => {
  assert.deepEqual(fullReport().topExpenses.map((e) => e.amount.minorUnits), [20_000, 12_000, 5_000, 3_000, 1_800, 1_500, 1_250, 800]);
});

// Breakdowns -------------------------------------------------------------------------------------

test('category totals and percentages', () => {
  const report = fullReport();
  assert.deepEqual(report.categories.map((c) => c.name), ['Fuel', 'Entertainment', 'Groceries', 'Transport', 'Coffee & Snacks']);
  assert.deepEqual(minor(report.categories.map((c) => c.total)), [20_000, 12_000, 9_250, 2_300, 1_800]);
  assert.deepEqual(report.categories.map((c) => c.count), [1, 1, 3, 2, 1]);
  assert.deepEqual(report.categories.map((c) => c.percent), [44.1, 26.5, 20.4, 5.1, 4.0]);
  assert.equal(report.highestCategory.name, 'Fuel');
  assert.equal(report.lowestCategory.name, 'Coffee & Snacks');
});

test('subcategory rows stay inside their category', () => {
  const report = fullReport();
  const groceries = report.subcategories.filter((s) => s.categoryID === sample.groceries.id);
  assert.deepEqual(groceries.map((s) => s.name), ['Milk', 'No subcategory']);
  assert.deepEqual(minor(groceries.map((s) => s.total)), [5_000, 4_250]);
  assert.deepEqual(groceries.map((s) => s.percentOfCategory), [54.1, 45.9]);
  const transport = report.subcategories.filter((s) => s.categoryID === sample.transport.id);
  assert.deepEqual(transport.map((s) => s.name), ['No subcategory']);
  assert.equal(transport[0].total.minorUnits, 2_300);
});

test('payment method breakdown', () => {
  const report = fullReport();
  assert.deepEqual(report.paymentMethods.map((m) => m.name), ['Credit Card', 'Not specified', 'Cash', 'Debit Card']);
  assert.deepEqual(minor(report.paymentMethods.map((m) => m.total)), [21_800, 12_000, 8_800, 2_750]);
  assert.deepEqual(report.paymentMethods.map((m) => m.percent), [48.1, 26.5, 19.4, 6.1]);
});

test('merchant totals group spellings and keep an unnamed row', () => {
  const report = fullReport();
  assert.deepEqual(report.merchants.map((m) => m.name),
    ['ADNOC', 'Reel Cinemas', 'Spinneys', 'Café Nero', 'RTA', 'Carrefour', 'No merchant']);
  assert.deepEqual(minor(report.merchants.map((m) => m.total)), [20_000, 12_000, 8_000, 1_800, 1_500, 1_250, 800]);
  assert.equal(report.merchants.find((m) => m.name === 'Spinneys').count, 2);
});

test('merchant spellings differing in case are one merchant', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.expenses.push(Fx.expense('10', day(2026, 10, 18), sample.groceries, { merchant: 'SPINNEYS' }));
  snapshot.expenses.push(Fx.expense('10', day(2026, 10, 17), sample.groceries, { merchant: 'spinneys ' }));
  snapshot.normalizeOrder();
  const report = Fx.report(snapshot, SampleLedger.fullRange);
  const spinneys = report.merchants.find((m) => m.key === 'spinneys');
  assert.equal(spinneys.count, 4);
  assert.equal(spinneys.total.minorUnits, 10_000);
  assert.equal(spinneys.name, 'Spinneys', 'The most common spelling is shown');
});

// Time buckets -----------------------------------------------------------------------------------

test('daily buckets cover every day including empty ones', () => {
  const report = fullReport();
  assert.equal(report.daily.length, 50);
  assert.ok(report.daily[0].range.start.equals(day(2026, 9, 1)));
  assert.ok(report.daily.at(-1).range.start.equals(day(2026, 10, 20)));
  const busiest = report.daily.find((b) => b.range.start.equals(day(2026, 10, 19)));
  assert.equal(busiest.total.minorUnits, 13_800);
  assert.equal(busiest.count, 2);
  const quiet = report.daily.find((b) => b.range.start.equals(day(2026, 10, 5)));
  assert.equal(quiet.total.minorUnits, 0);
  assert.equal(quiet.count, 0);
});

test('weekly buckets mark partial weeks', () => {
  const report = fullReport();
  assert.equal(report.weekly.length, 8);
  assert.deepEqual(minor(report.weekly.map((b) => b.total)), [0, 0, 20_000, 0, 4_500, 0, 0, 20_850]);
  assert.deepEqual(report.weekly.map((b) => b.isPartial), [true, false, false, false, false, false, false, true]);
  assert.equal(report.weekly[1].range.start.weekday, 2, 'Weeks start on Monday in this ledger');
});

test('monthly buckets', () => {
  const report = fullReport();
  assert.equal(report.monthly.length, 2);
  assert.deepEqual(minor(report.monthly.map((b) => b.total)), [21_500, 23_850]);
  assert.deepEqual(report.monthly.map((b) => b.isPartial), [false, true], 'October is still in progress');
});

test('trend detail depends on the length of the period', () => {
  const granularity = (days) => Fx.report(sample.snapshot, between(Fx.today.addingDays(-(days - 1)), Fx.today)).trendGranularity;
  assert.equal(granularity(1), 'day');
  assert.equal(granularity(31), 'day');
  assert.equal(granularity(32), 'week');
  assert.equal(granularity(140), 'week');
  assert.equal(granularity(141), 'month');
  assert.equal(granularity(365), 'month');
});

// Reconciliation ---------------------------------------------------------------------------------

test('every breakdown adds up to the total', () => {
  const report = fullReport();
  const total = report.total.minorUnits;
  assert.equal(sumMinor(report.categories.map((r) => r.total)), total);
  assert.equal(sumMinor(report.subcategories.map((r) => r.total)), total);
  assert.equal(sumMinor(report.paymentMethods.map((r) => r.total)), total);
  assert.equal(sumMinor(report.merchants.map((r) => r.total)), total);
  assert.equal(sumMinor(report.daily.map((r) => r.total)), total);
  assert.equal(sumMinor(report.weekly.map((r) => r.total)), total);
  assert.equal(sumMinor(report.monthly.map((r) => r.total)), total);
  const count = (rows) => rows.reduce((n, r) => n + r.count, 0);
  assert.equal(count(report.categories), report.count);
  assert.equal(count(report.paymentMethods), report.count);
  assert.equal(count(report.merchants), report.count);
  assert.equal(count(report.daily), report.count);
});

test('the report agrees with the list query and the expenses themselves', () => {
  const report = fullReport();
  assert.deepEqual(report.total, totalOf(sample.snapshot.expenses, 'AED'));
  assert.equal(report.total.minorUnits, sample.e.reduce((n, e) => n + e.amount.minorUnits, 0));
  assert.equal(report.total.minorUnits, SampleLedger.grandTotalMinor);
});

test('drill-down lists add up to the tapped figure', () => {
  const report = fullReport();
  const same = (rows, row, label) => {
    assert.deepEqual(totalOf(rows, 'AED'), row.total, label);
  };
  for (const row of report.categories) {
    const rows = expensesInCategory(report, row.categoryID);
    same(rows, row, row.name);
    assert.equal(rows.length, row.count, row.name);
  }
  for (const row of report.paymentMethods) same(expensesWithPaymentMethod(report, row.methodID), row, row.name);
  for (const row of report.merchants) same(expensesForMerchant(report, row.key), row, row.name);
  for (const row of report.subcategories) same(expensesInSubcategory(report, row.categoryID, row.subcategoryID), row, row.name);
  for (const bucket of report.weekly) same(expensesInDays(report, bucket.range), bucket, 'week');
});

test('adjacent periods never count an expense twice', () => {
  const september = Fx.report(sample.snapshot, between(day(2026, 9, 1), day(2026, 9, 30)));
  const october = Fx.report(sample.snapshot, between(day(2026, 10, 1), day(2026, 10, 31)));
  assert.equal(september.total.minorUnits, 21_500);
  assert.equal(october.total.minorUnits, 23_850);
  assert.equal(september.count + october.count, fullReport().count);
  assert.equal(september.total.minorUnits + october.total.minorUnits, fullReport().total.minorUnits);
});

// One-day reports --------------------------------------------------------------------------------

test('a one-day custom report counts only that day and averages over one day', () => {
  // 19 October holds the 18.00 coffee and the 120.00 cinema ticket; 18 and 20 October must not leak in.
  const report = Fx.report(sample.snapshot, DayRange.single(day(2026, 10, 19)));
  assert.equal(report.range.dayCount, 1);
  assert.equal(report.total.minorUnits, 13_800);
  assert.equal(report.count, 2);
  assert.equal(report.elapsedDays, 1);
  assert.equal(report.averagePerDay.minorUnits, 13_800, 'one day, so the average is the total');
  assert.deepEqual(report.categories.map((c) => c.name), ['Entertainment', 'Coffee & Snacks']);
  assert.equal(report.daily.length, 1);
  assert.equal(report.daily[0].total.minorUnits, 13_800);
  assert.equal(report.trendGranularity, 'day');
  assert.equal(report.highest.amount.minorUnits, 12_000);
  assert.equal(report.lowest.amount.minorUnits, 1_800);
  assert.equal(report.excludedOtherCurrencyCount, 0);
});

test('a one-day report for a day with nothing is zero and the neighbours are not included', () => {
  const report = Fx.report(sample.snapshot, DayRange.single(day(2026, 10, 2)));
  assert.equal(report.isEmpty, true);
  assert.equal(report.total.minorUnits, 0);
  assert.equal(report.daily.length, 1);
  const first = Fx.report(sample.snapshot, DayRange.single(day(2026, 10, 1)));
  assert.equal(first.total.minorUnits, 3_000);
  assert.equal(first.count, 1);
});

// Empty and future periods -----------------------------------------------------------------------

test('an empty period is zero, not an error', () => {
  const report = Fx.report(sample.snapshot, between(day(2026, 1, 1), day(2026, 1, 31)));
  assert.equal(report.isEmpty, true);
  assert.equal(report.total.minorUnits, 0);
  assert.equal(report.count, 0);
  assert.equal(report.averagePerDay.minorUnits, 0);
  assert.equal(report.highest, null);
  assert.equal(report.lowest, null);
  assert.equal(report.highestCategory, null);
  assert.equal(report.categories.length, 0);
  assert.equal(report.paymentMethods.length, 0);
  assert.equal(report.daily.length, 31);
  assert.equal(report.trendGranularity, 'day');
});

test('a period that has not started has no average', () => {
  const report = Fx.report(sample.snapshot, between(day(2026, 11, 1), day(2026, 11, 30)));
  assert.equal(report.total.minorUnits, 0);
  assert.equal(report.elapsedDays, 0);
  assert.equal(report.averagePerDay, null);
  assert.equal(report.daily.length, 0);
});

test('the average divides by the days that have happened', () => {
  // October so far: 20 elapsed days. 23,850 / 20 = 1,192.5 fils, which rounds to 1,193.
  const october = Fx.report(sample.snapshot, between(day(2026, 10, 1), day(2026, 10, 31)));
  assert.equal(october.elapsedDays, 20);
  assert.equal(october.averagePerDay.minorUnits, 1_193);
  // Once the month is over, the average divides by all 31 days.
  const finished = Fx.report(sample.snapshot, between(day(2026, 10, 1), day(2026, 10, 31)), day(2026, 11, 15));
  assert.equal(finished.elapsedDays, 31);
  assert.equal(finished.averagePerDay.minorUnits, 769); // 23,850 / 31 = 769.35...
});

test('a future-dated expense extends the average period', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.expenses.push(Fx.expense('50', day(2026, 10, 25), sample.groceries));
  snapshot.normalizeOrder();
  const report = Fx.report(snapshot, between(day(2026, 10, 1), day(2026, 10, 31)));
  assert.equal(report.total.minorUnits, 28_850);
  assert.equal(report.elapsedDays, 25);
  assert.equal(report.averagePerDay.minorUnits, 1_154); // 28,850 / 25
});

// Boundaries -------------------------------------------------------------------------------------

test('a month boundary assigns each expense to exactly one month', () => {
  const october = Fx.report(sample.snapshot, between(day(2026, 10, 1), day(2026, 10, 31)));
  assert.ok(october.expenses.some((e) => e.localDay.equals(day(2026, 10, 1))));
  assert.ok(!october.expenses.some((e) => e.localDay.equals(day(2026, 9, 30))));
  const september = Fx.report(sample.snapshot, between(day(2026, 9, 1), day(2026, 9, 30)));
  assert.ok(september.expenses.some((e) => e.localDay.equals(day(2026, 9, 30))));
  assert.ok(!september.expenses.some((e) => e.localDay.equals(day(2026, 10, 1))));
});

test('year boundary', () => {
  const snapshot = Fx.catalog();
  const food = Fx.category('Food & Dining', snapshot);
  snapshot.expenses = [Fx.expense('100', day(2025, 12, 31), food), Fx.expense('200', day(2026, 1, 1), food)];
  snapshot.normalizeOrder();
  const lastYear = Fx.report(snapshot, between(day(2025, 1, 1), day(2025, 12, 31)));
  const thisYear = Fx.report(snapshot, between(day(2026, 1, 1), day(2026, 12, 31)));
  assert.equal(lastYear.total.minorUnits, 10_000);
  assert.equal(thisYear.total.minorUnits, 20_000);
});

test('leap day and the average over a short February', () => {
  const snapshot = Fx.catalog();
  const food = Fx.category('Food & Dining', snapshot);
  snapshot.expenses = [Fx.expense('29', day(2024, 2, 29), food)];
  const leap = Fx.report(snapshot, between(day(2024, 2, 1), day(2024, 2, 29)), day(2024, 3, 10));
  assert.equal(leap.total.minorUnits, 2_900);
  assert.equal(leap.elapsedDays, 29);
  assert.equal(leap.averagePerDay.minorUnits, 100);
  const short = Fx.report(snapshot, between(day(2024, 2, 1), day(2024, 2, 28)), day(2024, 3, 10));
  assert.equal(short.total.minorUnits, 0, 'February 29 is not in a range that ends on the 28th');
});

test('the whole end day is included even for a late evening expense', async () => {
  const store = Fx.store(sample.snapshot);
  const service = new ExpenseService(store, () => Fx.now);
  const late = makeDraft({
    amount: Fx.money('9.99'), day: day(2026, 10, 20), hasExplicitTime: true, hour: 23, minute: 59,
    timeZoneID: Fx.dubai, categoryID: sample.groceries.id,
  });
  const early = makeDraft({
    amount: Fx.money('1.11'), day: day(2026, 10, 21), hasExplicitTime: true, hour: 0, minute: 0,
    timeZoneID: Fx.dubai, categoryID: sample.groceries.id,
  });
  await service.save(late, Fx.today);
  await service.save(early, Fx.today);
  const throughTheTwentieth = Fx.report(store.snapshot, between(day(2026, 10, 20), day(2026, 10, 20)));
  assert.equal(throughTheTwentieth.total.minorUnits, 7_050 + 999);
  const twentyFirst = Fx.report(store.snapshot, DayRange.single(day(2026, 10, 21)));
  assert.equal(twentyFirst.total.minorUnits, 111);
});

test('the first day of the week changes which week an expense belongs to', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.expenses.push(Fx.expense('100', day(2026, 10, 18), sample.groceries)); // a Sunday
  snapshot.normalizeOrder();
  const mondayFirst = new PeriodResolver(2);
  const sundayFirst = new PeriodResolver(1);

  const mondayWeek = mondayFirst.range('thisWeek', Fx.today);
  const sundayWeek = sundayFirst.range('thisWeek', Fx.today);
  assert.equal(Fx.report(snapshot, mondayWeek).total.minorUnits, 20_850);
  assert.equal(Fx.report(snapshot, sundayWeek).total.minorUnits, 30_850);

  const mondayLast = mondayFirst.range('lastWeek', Fx.today);
  const sundayLast = sundayFirst.range('lastWeek', Fx.today);
  assert.equal(Fx.report(snapshot, mondayLast).total.minorUnits, 10_000);
  assert.equal(Fx.report(snapshot, sundayLast).total.minorUnits, 0);
});

// Currencies -------------------------------------------------------------------------------------

test('other currencies are counted separately, never added', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.expenses.push(Fx.expense('10', day(2026, 10, 20), sample.groceries, { currency: 'USD' }));
  snapshot.normalizeOrder();
  const dirham = Fx.report(snapshot, SampleLedger.fullRange);
  assert.equal(dirham.total.minorUnits, 45_350);
  assert.equal(dirham.count, 8);
  assert.equal(dirham.excludedOtherCurrencyCount, 1);
  const dollars = Fx.report(snapshot, SampleLedger.fullRange, Fx.today, 'USD');
  assert.equal(dollars.total.minorUnits, 1_000);
  assert.equal(dollars.count, 1);
  assert.equal(dollars.excludedOtherCurrencyCount, 8);
});

test('yen has no decimals', () => {
  const snapshot = Fx.catalog();
  const food = Fx.category('Food & Dining', snapshot);
  snapshot.expenses = [Fx.expense('1500', Fx.today, food, { currency: 'JPY' }), Fx.expense('250', Fx.today, food, { currency: 'JPY' })];
  const report = Fx.report(snapshot, DayRange.single(Fx.today), Fx.today, 'JPY');
  assert.equal(report.total.minorUnits, 1_750);
  assert.equal(plainString(report.total), '1750');
  assert.equal(report.averagePerDay.minorUnits, 1_750);
});

// Category history -------------------------------------------------------------------------------

test('archived categories stay in history', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.categories = snapshot.categories.map((c) => (c.id === sample.groceries.id ? makeCategory({ ...c, isArchived: true }) : c));
  snapshot.invalidate();
  const report = Fx.report(snapshot, SampleLedger.fullRange);
  const row = report.categories.find((c) => c.categoryID === sample.groceries.id);
  assert.equal(row.total.minorUnits, 9_250);
  assert.equal(row.isArchived, true);
  assert.equal(report.total.minorUnits, 45_350);
});

test('renaming a category renames it everywhere in history', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.categories = snapshot.categories.map((c) => (c.id === sample.groceries.id ? makeCategory({ ...c, name: 'Supermarkets' }) : c));
  snapshot.invalidate();
  const report = Fx.report(snapshot, SampleLedger.fullRange);
  assert.ok(report.categories.find((c) => c.name === 'Supermarkets'));
  assert.equal(report.categories.find((c) => c.name === 'Groceries'), undefined);
  assert.equal(sample.e[0].categoryNameSnapshot, 'Groceries', 'The saved expense itself is untouched');
});

test('a missing category falls back to the name saved on the expense', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.categories = snapshot.categories.filter((c) => c.id !== sample.groceries.id);
  snapshot.invalidate();
  const report = Fx.report(snapshot, SampleLedger.fullRange);
  const row = report.categories.find((c) => c.categoryID === sample.groceries.id);
  assert.equal(row.name, 'Groceries');
  assert.equal(row.iconSymbol, 'questionmark.circle');
  assert.equal(row.total.minorUnits, 9_250);
});

// Quick totals (Home tiles) ----------------------------------------------------------------------

test('quick total agrees with the full report for every range', () => {
  const usd = Fx.expense('5', day(2026, 10, 20), sample.groceries, { currency: 'USD', createdAt: Fx.now + 50_000 });
  const snapshot = Fx.adding([usd], sample.snapshot);
  const ranges = [
    SampleLedger.fullRange,
    DayRange.single(day(2026, 10, 20)),
    between(day(2026, 10, 19), day(2026, 10, 20)),
    between(day(2026, 8, 1), day(2026, 8, 10)),
    DayRange.single(day(2026, 9, 30)),
  ];
  for (const range of ranges) {
    const quick = quickTotal(snapshot.expenses, 'AED', range);
    const full = Fx.report(snapshot, range);
    assert.deepEqual(quick.total, full.total);
    assert.equal(quick.count, full.count);
  }
});

test('quick category totals agree with the full report and add up to its total', () => {
  const usd = Fx.expense('5', day(2026, 10, 20), sample.groceries, { currency: 'USD', createdAt: Fx.now + 50_000 });
  const snapshot = Fx.adding([usd], sample.snapshot);
  // null means "all time"; the sample ledger sits entirely inside fullRange, so the two must agree.
  const ranges = [null, SampleLedger.fullRange, DayRange.single(day(2026, 10, 20)), between(day(2026, 8, 1), day(2026, 8, 10))];
  for (const range of ranges) {
    const quick = quickCategoryTotals(snapshot.expenses, 'AED', range);
    const full = Fx.report(snapshot, range || SampleLedger.fullRange);
    assert.equal(quick.size, full.categories.length);
    for (const category of full.categories) {
      assert.equal(quick.get(category.categoryID).minorUnits, category.total.minorUnits);
      assert.equal(quick.get(category.categoryID).count, category.count);
    }
    let sum = 0;
    for (const value of quick.values()) sum += value.minorUnits;
    assert.equal(sum, full.total.minorUnits);
  }
});

// Rounding ---------------------------------------------------------------------------------------

test('equal thirds show as 33.3 and the amounts still add up exactly', () => {
  const snapshot = Fx.catalog();
  const a = Fx.category('Groceries', snapshot);
  const b = Fx.category('Fuel', snapshot);
  const c = Fx.category('Education', snapshot);
  snapshot.expenses = [Fx.expense('1', Fx.today, a), Fx.expense('1', Fx.today, b), Fx.expense('1', Fx.today, c)];
  const report = Fx.report(snapshot, DayRange.single(Fx.today));
  assert.deepEqual(report.categories.map((r) => r.percent), [33.3, 33.3, 33.3]);
  assert.equal(report.total.minorUnits, 300);
  assert.equal(sumMinor(report.categories.map((r) => r.total)), 300);
});

test('thousands of tiny amounts sum exactly', () => {
  const snapshot = Fx.catalog();
  const food = Fx.category('Food & Dining', snapshot);
  const list = [];
  for (let i = 0; i < 1_000; i += 1) list.push(Fx.expense('0.01', Fx.today, food, { createdAt: Fx.now + i * 1000 }));
  snapshot.expenses = list;
  snapshot.normalizeOrder();
  const report = Fx.report(snapshot, DayRange.single(Fx.today));
  assert.equal(report.total.minorUnits, 1_000);
  assert.equal(plainString(report.total), '10.00');
});
