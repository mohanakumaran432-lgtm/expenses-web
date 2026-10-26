import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { DayRange } from '../docs/js/core/dayrange.js';
import {
  ExpenseSearchIndex, filterActiveCount, filterIsActive, groupByDay, makeFilter, makeSort, runQuery, totalOf,
} from '../docs/js/core/query.js';
import { LedgerDirectory } from '../docs/js/core/snapshot.js';

const sample = new SampleLedger();
const day = (y, m, d) => Fx.day(y, m, d);

function run(filter = makeFilter(), sort = makeSort()) {
  const directory = sample.directory;
  const index = new ExpenseSearchIndex(sample.snapshot.expenses, directory);
  return runQuery(sample.snapshot.expenses, filter, sort, directory, index).map((e) => e.amount.minorUnits);
}

const searching = (text) => run(makeFilter({ searchText: text }));

// Order and grouping -----------------------------------------------------------------------------

test('default order is newest first', () => {
  assert.deepEqual(run(), [800, 1250, 5000, 12000, 1800, 3000, 1500, 20000]);
});

test('grouped by day with subtotals', () => {
  const groups = groupByDay(sample.snapshot.expenses, 'AED');
  assert.deepEqual(groups.map((g) => g.day.toString()), ['2026-10-20', '2026-10-19', '2026-10-01', '2026-09-30', '2026-09-15']);
  assert.deepEqual(groups.map((g) => g.subtotal.minorUnits), [7050, 13800, 3000, 1500, 20000]);
  assert.deepEqual(groups.map((g) => g.expenses.length), [3, 2, 1, 1, 1]);
  assert.equal(groups.reduce((n, g) => n + g.subtotal.minorUnits, 0), SampleLedger.grandTotalMinor,
    'Daily subtotals add up to the grand total');
});

test('grouping an empty list gives no groups', () => {
  assert.deepEqual(groupByDay([], 'AED'), []);
});

// Sorting ----------------------------------------------------------------------------------------

test('sort by amount', () => {
  assert.deepEqual(run(makeFilter(), makeSort('amount', false)), [20000, 12000, 5000, 3000, 1800, 1500, 1250, 800]);
  assert.deepEqual(run(makeFilter(), makeSort('amount', true)), [800, 1250, 1500, 1800, 3000, 5000, 12000, 20000]);
});

test('sort by date ascending', () => {
  assert.deepEqual(run(makeFilter(), makeSort('date', true)), [20000, 1500, 3000, 1800, 12000, 5000, 1250, 800]);
});

test('sort by category name', () => {
  assert.deepEqual(run(makeFilter(), makeSort('category', true)), [1800, 12000, 20000, 1250, 5000, 3000, 800, 1500]);
  assert.deepEqual(run(makeFilter(), makeSort('category', false)), [800, 1500, 1250, 5000, 3000, 20000, 12000, 1800]);
});

test('sort by merchant puts missing merchants last', () => {
  assert.deepEqual(run(makeFilter(), makeSort('merchant', true)), [20000, 1800, 1250, 12000, 1500, 5000, 3000, 800]);
  assert.deepEqual(run(makeFilter(), makeSort('merchant', false)), [5000, 3000, 1500, 12000, 1250, 1800, 20000, 800]);
});

// Filters ----------------------------------------------------------------------------------------

test('no filter means everything', () => {
  const filter = makeFilter();
  assert.equal(filterIsActive(filter), false);
  assert.equal(filterActiveCount(filter), 0);
  assert.equal(run(filter).length, 8);
});

test('category filter', () => {
  const filter = makeFilter({ categoryIDs: new Set([sample.groceries.id]) });
  assert.deepEqual(run(filter), [1250, 5000, 3000]);
  filter.categoryIDs = new Set([sample.groceries.id, sample.fuel.id]);
  assert.deepEqual(run(filter), [1250, 5000, 3000, 20000]);
});

test('date range filter includes both end days', () => {
  const filter = makeFilter({ range: DayRange.between(day(2026, 9, 30), day(2026, 10, 1)) });
  assert.deepEqual(run(filter), [3000, 1500]);
  filter.range = DayRange.single(day(2026, 10, 19));
  assert.deepEqual(run(filter), [12000, 1800]);
});

test('payment method filter', () => {
  const filter = makeFilter({ paymentMethodIDs: new Set([sample.cash.id]) });
  assert.deepEqual(run(filter), [800, 5000, 3000]);
  filter.paymentMethodIDs = new Set([sample.cash.id, sample.debit.id]);
  assert.deepEqual(run(filter), [800, 1250, 5000, 3000, 1500]);
});

test('different filters combine with AND', () => {
  const filter = makeFilter({
    categoryIDs: new Set([sample.groceries.id]), paymentMethodIDs: new Set([sample.cash.id]),
  });
  assert.deepEqual(run(filter), [5000, 3000]);
  filter.range = DayRange.between(day(2026, 10, 15), day(2026, 10, 31));
  assert.deepEqual(run(filter), [5000]);
  assert.equal(filterActiveCount(filter), 3);
  assert.equal(filterIsActive(filter), true);
});

test('subcategory filter', () => {
  assert.deepEqual(run(makeFilter({ subcategoryIDs: new Set([sample.milk.id]) })), [5000]);
});

test('tag filter matches any tag ignoring case', () => {
  const filter = makeFilter({ tags: new Set(['family', 'work']) });
  assert.deepEqual(run(filter), [5000, 1800]);
  filter.tags = new Set(['work']);
  assert.deepEqual(run(filter), [1800]);
});

test('currency filter and totals ignore other currencies', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.expenses.push(Fx.expense('10', day(2026, 10, 20), sample.groceries, { currency: 'USD' }));
  snapshot.normalizeOrder();
  const directory = new LedgerDirectory(snapshot);
  const index = new ExpenseSearchIndex(snapshot.expenses, directory);
  const onlyDirham = runQuery(snapshot.expenses, makeFilter({ currencyCode: 'AED' }), makeSort(), directory, index);
  assert.equal(onlyDirham.length, 8);
  assert.equal(totalOf(snapshot.expenses, 'AED').minorUnits, SampleLedger.grandTotalMinor);
  assert.equal(totalOf(snapshot.expenses, 'USD').minorUnits, 1000);
});

// Search -----------------------------------------------------------------------------------------

test('search by merchant, category, tag and amount', () => {
  assert.deepEqual(searching('spinneys'), [5000, 3000]);
  assert.deepEqual(searching('SPINNEYS'), [5000, 3000]);
  assert.deepEqual(searching('fuel'), [20000]);
  assert.deepEqual(searching('transport'), [800, 1500]);
  assert.deepEqual(searching('family'), [5000]);
  assert.deepEqual(searching('work'), [1800]);
  assert.deepEqual(searching('12.50'), [1250]);
});

test('search ignores accents and accepts a comma as decimal point', () => {
  assert.deepEqual(searching('cafe'), [1800]);
  assert.deepEqual(searching('CAFÉ'), [1800]);
  assert.deepEqual(searching('12,50'), [1250]);
});

test('every word must match', () => {
  assert.deepEqual(searching('groceries spinneys'), [5000, 3000]);
  assert.deepEqual(searching('groceries carrefour'), [1250]);
  assert.deepEqual(searching('fuel spinneys'), []);
});

test('search by payment method and subcategory', () => {
  assert.deepEqual(searching('credit'), [1800, 20000]);
  assert.deepEqual(searching('milk'), [5000]);
});

test('blank or unmatched search', () => {
  assert.equal(searching('   ').length, 8);
  assert.deepEqual(searching(''), run());
  assert.deepEqual(searching('zzzz'), []);
});

test('search and filters work together', () => {
  const filter = makeFilter({ searchText: 'spinneys', range: DayRange.between(day(2026, 10, 10), day(2026, 10, 31)) });
  assert.deepEqual(run(filter), [5000]);
});

// Many rows --------------------------------------------------------------------------------------

test('twenty thousand expenses stay correct', () => {
  const snapshot = Fx.catalog();
  const categories = snapshot.categories.slice(0, 6);
  const list = [];
  let expectedTotal = 0;
  let expectedGroceriesLikeCount = 0;
  const first = day(2025, 1, 1);
  for (let i = 0; i < 20_000; i += 1) {
    const amountText = `${(i % 500) + 1}.${i % 2 === 0 ? '00' : '50'}`;
    const item = Fx.expense(amountText, first.addingDays(i % 600), categories[i % categories.length], {
      merchant: `Store${i % 40}`, createdAt: Fx.now + i * 1000,
    });
    expectedTotal += item.amount.minorUnits;
    if (i % categories.length === 1) expectedGroceriesLikeCount += 1;
    list.push(item);
  }
  snapshot.expenses = list;
  snapshot.normalizeOrder();

  const directory = new LedgerDirectory(snapshot);
  const index = new ExpenseSearchIndex(snapshot.expenses, directory);

  const filter = makeFilter({ categoryIDs: new Set([categories[1].id]) });
  assert.equal(runQuery(snapshot.expenses, filter, makeSort(), directory, index).length, expectedGroceriesLikeCount);

  const all = runQuery(snapshot.expenses, makeFilter(), makeSort(), directory, index);
  assert.equal(all.length, 20_000);
  assert.equal(totalOf(all, 'AED').minorUnits, expectedTotal);

  const groups = groupByDay(all, 'AED');
  assert.equal(groups.length, 600);
  assert.equal(groups.reduce((n, g) => n + g.expenses.length, 0), 20_000);
  assert.equal(groups.reduce((n, g) => n + g.subtotal.minorUnits, 0), expectedTotal);

  filter.searchText = 'store7';
  const searched = runQuery(snapshot.expenses, filter, makeSort('amount'), directory, index);
  assert.ok(searched.length > 0);
  for (const item of searched) {
    assert.equal(item.merchant, 'Store7');
    assert.equal(item.categoryID, categories[1].id);
  }
});
