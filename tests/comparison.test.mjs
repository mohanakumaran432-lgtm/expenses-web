import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { compareRanges } from '../docs/js/core/comparison.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { PeriodResolver } from '../docs/js/core/periods.js';
import { LedgerDirectory } from '../docs/js/core/snapshot.js';

const sample = new SampleLedger();
const day = (y, m, d) => Fx.day(y, m, d);
const between = (a, b) => DayRange.between(a, b);
const october = between(day(2026, 10, 1), day(2026, 10, 31));
const september = between(day(2026, 9, 1), day(2026, 9, 30));

function compare(snapshot, current, previous, { today = Fx.today, aligned = false } = {}) {
  return compareRanges({
    expenses: snapshot.expenses,
    directory: new LedgerDirectory(snapshot),
    currencyCode: 'AED',
    current,
    previous,
    today,
    firstWeekday: snapshot.settings.firstWeekday,
    alignToElapsed: aligned,
  });
}

// Totals -----------------------------------------------------------------------------------------

test('difference and percentage change', () => {
  const result = compare(sample.snapshot, october, september);
  assert.equal(result.current.total.minorUnits, 23_850);
  assert.equal(result.previous.total.minorUnits, 21_500);
  assert.equal(result.totalDifference.minorUnits, 2_350);
  assert.equal(result.percentChange, 10.9); // 2,350 / 21,500 = 10.93...%
  assert.equal(result.percentNote, null);
  assert.equal(result.previousWasAligned, false);
});

test('a decrease is negative', () => {
  const result = compare(sample.snapshot, september, october);
  assert.equal(result.totalDifference.minorUnits, -2_350);
  assert.equal(result.percentChange, -9.9); // -2,350 / 23,850 = -9.853...%
});

// Zero base --------------------------------------------------------------------------------------

test('no spending before means no percentage but a clear reason', () => {
  const january = between(day(2026, 1, 1), day(2026, 1, 31));
  const result = compare(sample.snapshot, october, january);
  assert.equal(result.percentChange, null, 'A change from zero has no percentage');
  assert.equal(result.totalDifference.minorUnits, 23_850);
  assert.equal(result.percentNote, 'There was no spending in the earlier period, so a percentage change cannot be calculated.');
});

test('no spending in either period', () => {
  const january = between(day(2026, 1, 1), day(2026, 1, 31));
  const february = between(day(2026, 2, 1), day(2026, 2, 28));
  const result = compare(sample.snapshot, february, january);
  assert.equal(result.percentChange, null);
  assert.equal(result.totalDifference.minorUnits, 0);
  assert.equal(result.percentNote, 'There is no spending in either period.');
  assert.equal(result.categoryChanges.length, 0);
});

test('spending stopping completely is minus one hundred percent', () => {
  const result = compare(sample.snapshot, between(day(2026, 1, 1), day(2026, 1, 31)), september);
  assert.equal(result.percentChange, -100);
  assert.equal(result.totalDifference.minorUnits, -21_500);
});

// Fair comparison --------------------------------------------------------------------------------

test('an unfinished month is compared with the same number of days of the last month', () => {
  const ranges = new PeriodResolver(2).comparisonRanges('thisMonthVsLastMonth', Fx.today);
  const result = compare(sample.snapshot, ranges.current, ranges.previous, { aligned: true });
  assert.equal(result.previousWasAligned, true);
  assert.ok(result.previous.range.equals(between(day(2026, 9, 1), day(2026, 9, 20))));
  assert.equal(result.previous.total.minorUnits, 20_000, 'Only September 1-20 counts; the expense on the 30th does not');
  assert.equal(result.totalDifference.minorUnits, 3_850);
  assert.equal(result.percentChange, 19.3); // 3,850 / 20,000 = 19.25%, which rounds half up to 19.3
  assert.equal(result.current.averagePerDay.minorUnits, 1_193);
  assert.equal(result.previous.averagePerDay.minorUnits, 1_000);
  assert.equal(result.averageDifference.minorUnits, 193);
});

test('finished periods are not trimmed even when aligning is requested', () => {
  const result = compare(sample.snapshot, september, between(day(2026, 8, 1), day(2026, 8, 31)), { aligned: true });
  assert.equal(result.previousWasAligned, false);
});

test('periods of different length compare daily averages', () => {
  const week = between(day(2026, 9, 24), day(2026, 9, 30));
  const earlier = between(day(2026, 8, 25), day(2026, 9, 23));
  const result = compare(sample.snapshot, week, earlier);
  assert.equal(result.periodLengthsDiffer, true);
  assert.equal(result.currentDayCount, 7);
  assert.equal(result.previousDayCount, 30);
  assert.equal(result.current.total.minorUnits, 1_500);
  assert.equal(result.previous.total.minorUnits, 20_000);
  assert.equal(result.percentChange, -92.5);
  // 1,500 / 7 = 214.28 -> 214;  20,000 / 30 = 666.67 -> 667
  assert.equal(result.current.averagePerDay.minorUnits, 214);
  assert.equal(result.previous.averagePerDay.minorUnits, 667);
  assert.equal(result.averageDifference.minorUnits, -453);
  assert.equal(result.averagePercentChange, -67.9); // -453 / 667 = -67.91...%
});

// Category movers --------------------------------------------------------------------------------

test('increases, decreases, new and gone are separated', () => {
  const snapshot = Fx.catalog();
  const groceries = Fx.category('Groceries', snapshot);
  const transport = Fx.category('Transport', snapshot);
  const fuel = Fx.category('Fuel', snapshot);
  const education = Fx.category('Education', snapshot);
  snapshot.expenses = [
    Fx.expense('100', day(2026, 9, 3), groceries),
    Fx.expense('50', day(2026, 9, 4), transport),
    Fx.expense('30', day(2026, 9, 5), fuel),
    Fx.expense('150', day(2026, 10, 3), groceries),
    Fx.expense('20', day(2026, 10, 4), transport),
    Fx.expense('40', day(2026, 10, 5), education),
  ];
  snapshot.normalizeOrder();
  const result = compare(snapshot, between(day(2026, 10, 1), day(2026, 10, 10)), between(day(2026, 9, 1), day(2026, 9, 10)));

  assert.deepEqual(result.biggestIncreases.map((c) => c.name), ['Groceries']);
  assert.equal(result.biggestIncreases[0].difference.minorUnits, 5_000);
  assert.equal(result.biggestIncreases[0].percentChange, 50);
  assert.deepEqual(result.biggestDecreases.map((c) => c.name), ['Transport']);
  assert.equal(result.biggestDecreases[0].difference.minorUnits, -3_000);
  assert.equal(result.biggestDecreases[0].percentChange, -60);
  assert.deepEqual(result.newCategories.map((c) => c.name), ['Education']);
  assert.equal(result.newCategories[0].percentChange, null, 'A new category has no percentage');
  assert.deepEqual(result.goneCategories.map((c) => c.name), ['Fuel']);
  assert.equal(result.goneCategories[0].percentChange, -100);
  // 21,000 vs 18,000 -> +3,000 -> +16.7%
  assert.equal(result.totalDifference.minorUnits, 3_000);
  assert.equal(result.percentChange, 16.7);
});

test('category changes are sorted by the size of the move', () => {
  const result = compare(sample.snapshot, october, september);
  assert.deepEqual(result.categoryChanges.map((c) => c.name), ['Fuel', 'Entertainment', 'Groceries', 'Coffee & Snacks', 'Transport']);
  assert.deepEqual(result.categoryChanges.map((c) => c.difference.minorUnits), [-20_000, 12_000, 9_250, 1_800, -700]);
  assert.deepEqual(result.biggestDecreases.map((c) => c.name), ['Transport'], 'Fuel is gone, so it is listed separately');
  assert.deepEqual(result.goneCategories.map((c) => c.name), ['Fuel']);
  assert.deepEqual(result.newCategories.map((c) => c.name), ['Entertainment', 'Groceries', 'Coffee & Snacks']);
  assert.equal(result.biggestIncreases.length, 0, 'Every riser here is new, so none is a plain increase');
});

test('category changes reconcile with the total difference', () => {
  const result = compare(sample.snapshot, october, september);
  const sum = result.categoryChanges.reduce((n, c) => n + c.difference.minorUnits, 0);
  assert.equal(sum, result.totalDifference.minorUnits);
});

test('comparing a period with itself shows no change', () => {
  const result = compare(sample.snapshot, october, october);
  assert.equal(result.totalDifference.minorUnits, 0);
  assert.equal(result.percentChange, 0);
  assert.equal(result.biggestIncreases.length, 0);
  assert.equal(result.biggestDecreases.length, 0);
  assert.equal(result.newCategories.length, 0);
  assert.equal(result.goneCategories.length, 0);
});
