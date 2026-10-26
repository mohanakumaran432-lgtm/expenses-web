// Searching, filtering, sorting and grouping the transaction list.

import { saturatingAdd } from './util.js';
import { compareNewestFirst } from './snapshot.js';
import { comparisonKey, line } from './text.js';
import { money, plainString } from './money.js';

export const SORT_FIELDS = Object.freeze(['date', 'amount', 'category', 'merchant']);
export const SORT_TITLES = Object.freeze({ date: 'Date', amount: 'Amount', category: 'Category', merchant: 'Merchant' });

export function makeSort(field = 'date', ascending = false) {
  return { field, ascending };
}

const NUMBER_LIKE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Splits typed text into comparable words. A comma used as a decimal separator is read as ".". */
export function searchWords(text) {
  const cleaned = comparisonKey(text);
  if (cleaned === '') return [];
  return cleaned.split(' ').filter((w) => w !== '').map((word) => {
    const digitsOnly = word.replaceAll(',', '.');
    return NUMBER_LIKE.test(digitsOnly) ? digitsOnly : word;
  });
}

/**
 * Search text is matched against a prepared lowercase, accent-free blob per expense.
 * Building the blobs once per data change keeps typing in the search box fast with thousands of records.
 */
export class ExpenseSearchIndex {
  constructor(expenses, directory) {
    this.blobs = new Map();
    for (const expense of expenses) {
      const parts = [expense.merchant, expense.notes, directory.categoryName(expense)];
      const subcategory = directory.subcategoryName(expense);
      if (subcategory) parts.push(subcategory);
      const method = directory.paymentMethodName(expense);
      if (method) parts.push(method);
      parts.push(...expense.tags);
      parts.push(plainString(expense.amount));
      this.blobs.set(expense.id, comparisonKey(parts.join(' ')));
    }
  }

  /** Every word typed must appear somewhere in the expense (merchant, notes, category, tags, amount...). */
  matches(expense, words) {
    const blob = this.blobs.get(expense.id);
    if (blob === undefined) return false;
    for (const word of words) {
      if (!blob.includes(word)) return false;
    }
    return true;
  }
}

export function makeFilter(overrides = {}) {
  return {
    range: null,
    categoryIDs: new Set(),
    subcategoryIDs: new Set(),
    paymentMethodIDs: new Set(),
    /** Matches an expense that has ANY of these tags (compared ignoring case). */
    tags: new Set(),
    searchText: '',
    currencyCode: null,
    ...overrides,
  };
}

export function filterIsActive(filter) {
  return Boolean(filter.range) || filter.categoryIDs.size > 0 || filter.subcategoryIDs.size > 0
    || filter.paymentMethodIDs.size > 0 || filter.tags.size > 0 || line(filter.searchText) !== '';
}

/** Number of separate filters switched on (for a badge on the filter button). */
export function filterActiveCount(filter) {
  let count = 0;
  if (filter.range) count += 1;
  if (filter.categoryIDs.size > 0) count += 1;
  if (filter.subcategoryIDs.size > 0) count += 1;
  if (filter.paymentMethodIDs.size > 0) count += 1;
  if (filter.tags.size > 0) count += 1;
  return count;
}

/** Everything except the search text. The search is applied through the index. */
export function matchesStructure(filter, expense) {
  if (filter.currencyCode && expense.amount.currencyCode !== filter.currencyCode) return false;
  if (filter.range && !filter.range.contains(expense.localDay)) return false;
  if (filter.categoryIDs.size > 0 && !filter.categoryIDs.has(expense.categoryID)) return false;
  if (filter.subcategoryIDs.size > 0 && !(expense.subcategoryID && filter.subcategoryIDs.has(expense.subcategoryID))) return false;
  if (filter.paymentMethodIDs.size > 0 && !(expense.paymentMethodID && filter.paymentMethodIDs.has(expense.paymentMethodID))) return false;
  if (filter.tags.size > 0) {
    const wanted = new Set(Array.from(filter.tags, (t) => t.toLowerCase()));
    if (!expense.tags.some((t) => wanted.has(t.toLowerCase()))) return false;
  }
  return true;
}

function direction(ascending, a, b) {
  if (a === b) return 0;
  return (a < b ? -1 : 1) * (ascending ? 1 : -1);
}

/** Orders a list. `expenses` are expected newest first (the order a snapshot keeps). */
export function sortExpenses(expenses, sort, directory) {
  switch (sort.field) {
    case 'amount':
      return expenses.slice().sort((a, b) => {
        const byAmount = direction(sort.ascending, a.amount.minorUnits, b.amount.minorUnits);
        return byAmount !== 0 ? byAmount : compareNewestFirst(a, b);
      });
    case 'category': {
      const names = new Map(expenses.map((e) => [e.id, comparisonKey(directory.categoryName(e))]));
      return expenses.slice().sort((a, b) => {
        const byName = direction(sort.ascending, names.get(a.id), names.get(b.id));
        return byName !== 0 ? byName : compareNewestFirst(a, b);
      });
    }
    case 'merchant': {
      const keys = new Map(expenses.map((e) => [e.id, comparisonKey(e.merchant)]));
      return expenses.slice().sort((a, b) => {
        const keyA = keys.get(a.id);
        const keyB = keys.get(b.id);
        // Expenses without a merchant always go last, whichever way the list is sorted.
        if ((keyA === '') !== (keyB === '')) return keyA === '' ? 1 : -1;
        const byKey = direction(sort.ascending, keyA, keyB);
        return byKey !== 0 ? byKey : compareNewestFirst(a, b);
      });
    }
    default:
      // Snapshots are newest first already; only reverse for ascending.
      return sort.ascending ? expenses.slice().reverse() : expenses.slice();
  }
}

/** Filters then sorts. */
export function runQuery(expenses, filter, sort, directory, index) {
  const words = searchWords(filter.searchText);
  const result = [];
  for (const expense of expenses) {
    if (!matchesStructure(filter, expense)) continue;
    if (words.length > 0 && !index.matches(expense, words)) continue;
    result.push(expense);
  }
  return sortExpenses(result, sort, directory);
}

/** Exact total of a list in one currency. Expenses in other currencies are ignored. */
export function totalOf(expenses, currencyCode) {
  const code = String(currencyCode).toUpperCase();
  let sum = 0;
  for (const expense of expenses) {
    if (expense.amount.currencyCode === code) sum = saturatingAdd(sum, expense.amount.minorUnits);
  }
  return money(sum, code);
}

/** Groups a newest-first list by calendar day, with a subtotal per day. Day order follows the list order. */
export function groupByDay(expenses, currencyCode) {
  const groups = [];
  let currentDay = null;
  let bucket = [];
  const flush = () => {
    if (currentDay && bucket.length > 0) {
      groups.push(Object.freeze({ day: currentDay, expenses: bucket, subtotal: totalOf(bucket, currencyCode) }));
    }
    bucket = [];
  };
  for (const expense of expenses) {
    if (!currentDay || currentDay.raw !== expense.localDay.raw) {
      flush();
      currentDay = expense.localDay;
    }
    bucket.push(expense);
  }
  flush();
  return groups;
}
