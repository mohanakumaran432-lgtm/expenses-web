// Builds a report from expenses. A pure function: the same input always gives the same output, and nothing is stored.
//
// Reconciliation guarantee: the category, subcategory, payment-method, merchant, daily, weekly and monthly
// breakdowns are all computed from the same `included` list in one pass, so each of them adds up to `total` exactly.

import { compareText, saturatingAdd } from './util.js';
import { DayRange } from './dayrange.js';
import { compareNewestFirst } from './snapshot.js';
import { comparisonKey } from './text.js';
import { dividedBy, money, percentShare } from './money.js';

export const TREND_TITLES = Object.freeze({ day: 'Daily', week: 'Weekly', month: 'Monthly' });

const UNKNOWN_COLOR = '#8E8E93';

class Accumulator {
  constructor() {
    this.minor = 0;
    this.count = 0;
  }

  add(value) {
    this.minor = saturatingAdd(this.minor, value);
    this.count += 1;
  }
}

function slot(map, key) {
  let found = map.get(key);
  if (!found) {
    found = new Accumulator();
    map.set(key, found);
  }
  return found;
}

const byTotalThenName = (a, b) => {
  if (a.total.minorUnits !== b.total.minorUnits) return b.total.minorUnits - a.total.minorUnits;
  return compareText(a.name, b.name);
};

/**
 * Total and count for one range using exactly the rule `generateReport` uses to pick expenses
 * (same currency, day inside the range). For small summary tiles that do not need a full report.
 */
export function quickTotal(expenses, currencyCode, range) {
  const code = String(currencyCode).toUpperCase();
  let minor = 0;
  let count = 0;
  for (const expense of expenses) {
    if (range.contains(expense.localDay) && expense.amount.currencyCode === code) {
      minor = saturatingAdd(minor, expense.amount.minorUnits);
      count += 1;
    }
  }
  return { total: money(minor, code), count };
}

/**
 * Total and count per category for one range (or for all time when `range` is null), using the same selection rule.
 * Returns a Map of categoryID -> { minorUnits, count }. Categories with no spending are absent.
 */
export function quickCategoryTotals(expenses, currencyCode, range) {
  const code = String(currencyCode).toUpperCase();
  const result = new Map();
  for (const expense of expenses) {
    if (expense.amount.currencyCode !== code) continue;
    if (range && !range.contains(expense.localDay)) continue;
    const current = result.get(expense.categoryID) || { minorUnits: 0, count: 0 };
    result.set(expense.categoryID, {
      minorUnits: saturatingAdd(current.minorUnits, expense.amount.minorUnits),
      count: current.count + 1,
    });
  }
  return result;
}

/**
 * @param expenses      every expense (any currency, any date); the report picks what belongs
 * @param directory     a LedgerDirectory (names and icons for ids)
 * @param currencyCode  the report currency; expenses in other currencies are counted as excluded, never converted
 * @param range         the days to report on
 * @param today         today's date (decides how many days have "happened" for averages and charts)
 * @param firstWeekday  1 = Sunday ... 7 = Saturday
 */
export function generateReport({ expenses: all, directory, currencyCode, range, today, firstWeekday }) {
  const code = String(currencyCode).toUpperCase();

  // 1. Select what belongs in the report: inside the range, in the report currency. Newest first.
  const included = [];
  let excluded = 0;
  for (const expense of all) {
    if (!range.contains(expense.localDay)) continue;
    if (expense.amount.currencyCode === code) included.push(expense);
    else excluded += 1;
  }
  included.sort(compareNewestFirst);

  // 2. One pass over the included expenses.
  const totalAcc = new Accumulator();
  const byCategory = new Map();
  const categoryFallback = new Map();
  const bySub = new Map(); // key: categoryID + '/' + (subcategoryID or 'none')
  const subFallback = new Map();
  const subParts = new Map();
  const byMethod = new Map(); // key: methodID or null
  const methodFallback = new Map();
  const byMerchant = new Map();
  const spellings = new Map();
  const byDay = new Map(); // key: LocalDate.raw
  let highest = null;
  let lowest = null;

  for (const expense of included) {
    const value = expense.amount.minorUnits;
    totalAcc.add(value);

    slot(byCategory, expense.categoryID).add(value);
    if (!categoryFallback.has(expense.categoryID)) categoryFallback.set(expense.categoryID, expense.categoryNameSnapshot);

    const subKey = `${expense.categoryID}/${expense.subcategoryID || 'none'}`;
    slot(bySub, subKey).add(value);
    if (!subParts.has(subKey)) subParts.set(subKey, { categoryID: expense.categoryID, subcategoryID: expense.subcategoryID });
    if (!subFallback.has(subKey) && expense.subcategoryNameSnapshot) subFallback.set(subKey, expense.subcategoryNameSnapshot);

    slot(byMethod, expense.paymentMethodID).add(value);
    if (expense.paymentMethodID && !methodFallback.has(expense.paymentMethodID) && expense.paymentMethodNameSnapshot) {
      methodFallback.set(expense.paymentMethodID, expense.paymentMethodNameSnapshot);
    }

    const merchantKey = comparisonKey(expense.merchant);
    slot(byMerchant, merchantKey).add(value);
    if (merchantKey !== '') {
      let options = spellings.get(merchantKey);
      if (!options) {
        options = new Map();
        spellings.set(merchantKey, options);
      }
      options.set(expense.merchant, (options.get(expense.merchant) || 0) + 1);
    }

    slot(byDay, expense.localDay.raw).add(value);

    if (highest === null || value > highest.amount.minorUnits) highest = expense;
    if (lowest === null || value < lowest.amount.minorUnits) lowest = expense;
  }

  const totalMoney = money(totalAcc.minor, code);

  // 3. The days the average and the charts cover: from the first day through today,
  //    extended to the last dated expense if someone recorded one in the future.
  let seriesEnd = range.end.raw <= today.raw ? range.end : today;
  if (included.length > 0 && included[0].localDay.raw > seriesEnd.raw) seriesEnd = included[0].localDay;
  const seriesRange = DayRange.make(range.start, seriesEnd);
  const elapsedDays = seriesRange ? seriesRange.dayCount : 0;
  const averagePerDay = elapsedDays > 0 ? dividedBy(totalMoney, elapsedDays) : null;

  // 4. Breakdowns.
  const categories = makeCategories(byCategory, categoryFallback, directory, totalMoney, code);
  const subcategories = makeSubcategories(bySub, subParts, subFallback, categories, directory, code);
  const paymentMethods = makePaymentMethods(byMethod, methodFallback, directory, totalMoney, code);
  const merchants = makeMerchants(byMerchant, spellings, totalMoney, code);

  const daily = [];
  const weekly = [];
  const monthly = [];
  if (seriesRange) {
    for (const day of seriesRange.days()) {
      const acc = byDay.get(day.raw);
      daily.push(Object.freeze({
        range: DayRange.single(day),
        total: money(acc ? acc.minor : 0, code),
        count: acc ? acc.count : 0,
        isPartial: false,
      }));
    }
    for (const bucket of seriesRange.weekBuckets(firstWeekday)) {
      const weekStart = bucket.start.startOfWeek(firstWeekday);
      const complete = bucket.start.equals(weekStart) && bucket.end.equals(weekStart.addingDays(6));
      weekly.push(makeBucket(bucket, byDay, code, !complete));
    }
    for (const bucket of seriesRange.monthBuckets()) {
      const complete = bucket.start.equals(bucket.start.startOfMonth) && bucket.end.equals(bucket.end.endOfMonth);
      monthly.push(makeBucket(bucket, byDay, code, !complete));
    }
  }

  let trendGranularity;
  if (elapsedDays <= 31) trendGranularity = 'day';
  else if (elapsedDays <= 140) trendGranularity = 'week';
  else trendGranularity = 'month';
  const trend = trendGranularity === 'day' ? daily : trendGranularity === 'week' ? weekly : monthly;

  const top = included.slice().sort((a, b) => {
    if (a.amount.minorUnits !== b.amount.minorUnits) return b.amount.minorUnits - a.amount.minorUnits;
    return compareNewestFirst(a, b);
  });

  return Object.freeze({
    range,
    currencyCode: code,
    today,
    expenses: included,
    total: totalMoney,
    count: totalAcc.count,
    elapsedDays,
    averagePerDay,
    highest,
    lowest,
    categories,
    highestCategory: categories.length > 0 ? categories[0] : null,
    lowestCategory: categories.length > 0 ? categories[categories.length - 1] : null,
    subcategories,
    daily,
    weekly,
    monthly,
    trendGranularity,
    trend,
    paymentMethods,
    merchants,
    topExpenses: top.slice(0, 10),
    excludedOtherCurrencyCount: excluded,
    isEmpty: totalAcc.count === 0,
  });
}

// Drill-down: the same expenses the totals were built from ---------------------------------------

export function expensesInCategory(report, categoryID) {
  return report.expenses.filter((e) => e.categoryID === categoryID);
}

export function expensesInSubcategory(report, categoryID, subcategoryID) {
  const wanted = subcategoryID || null;
  return report.expenses.filter((e) => e.categoryID === categoryID && (e.subcategoryID || null) === wanted);
}

export function expensesWithPaymentMethod(report, methodID) {
  const wanted = methodID || null;
  return report.expenses.filter((e) => (e.paymentMethodID || null) === wanted);
}

export function expensesInDays(report, days) {
  return report.expenses.filter((e) => days.contains(e.localDay));
}

export function expensesForMerchant(report, key) {
  return report.expenses.filter((e) => comparisonKey(e.merchant) === key);
}

// Builders -------------------------------------------------------------------------------------

function makeCategories(source, fallback, directory, total, code) {
  const rows = [];
  for (const [id, acc] of source) {
    const meta = directory.categoriesByID.get(id);
    const amount = money(acc.minor, code);
    rows.push(Object.freeze({
      categoryID: id,
      name: (meta && meta.name) || fallback.get(id) || 'Unknown category',
      iconSymbol: meta ? meta.iconSymbol : 'questionmark.circle',
      colorHex: meta ? meta.colorHex : UNKNOWN_COLOR,
      isArchived: meta ? meta.isArchived : false,
      total: amount,
      count: acc.count,
      percent: percentShare(amount, total),
    }));
  }
  rows.sort(byTotalThenName);
  return rows;
}

function makeSubcategories(source, parts, fallback, categories, directory, code) {
  const result = [];
  for (const category of categories) {
    const rows = [];
    for (const [key, acc] of source) {
      const part = parts.get(key);
      if (part.categoryID !== category.categoryID) continue;
      const amount = money(acc.minor, code);
      let name = 'No subcategory';
      if (part.subcategoryID) {
        const meta = directory.subcategoriesByID.get(part.subcategoryID);
        name = (meta && meta.name) || fallback.get(key) || 'Unknown subcategory';
      }
      rows.push(Object.freeze({
        categoryID: category.categoryID,
        categoryName: category.name,
        subcategoryID: part.subcategoryID || null,
        name,
        total: amount,
        count: acc.count,
        percentOfCategory: percentShare(amount, category.total),
      }));
    }
    rows.sort(byTotalThenName);
    result.push(...rows);
  }
  return result;
}

function makePaymentMethods(source, fallback, directory, total, code) {
  const rows = [];
  for (const [id, acc] of source) {
    const amount = money(acc.minor, code);
    let name = 'Not specified';
    let icon = 'minus.circle';
    if (id) {
      const meta = directory.paymentMethodsByID.get(id);
      name = (meta && meta.name) || fallback.get(id) || 'Unknown method';
      icon = meta ? meta.iconSymbol : 'creditcard';
    }
    rows.push(Object.freeze({
      methodID: id || null, name, iconSymbol: icon, total: amount, count: acc.count, percent: percentShare(amount, total),
    }));
  }
  rows.sort(byTotalThenName);
  return rows;
}

function makeMerchants(source, spellings, total, code) {
  const rows = [];
  for (const [key, acc] of source) {
    const amount = money(acc.minor, code);
    let name = 'No merchant';
    if (key !== '' && spellings.has(key)) {
      // The spelling used most often; ties go to the one that sorts first.
      const best = Array.from(spellings.get(key).entries()).sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1];
        return compareText(a[0], b[0]);
      });
      name = best.length > 0 ? best[0][0] : key;
    }
    rows.push(Object.freeze({ key, name, total: amount, count: acc.count, percent: percentShare(amount, total) }));
  }
  rows.sort(byTotalThenName);
  return rows;
}

function makeBucket(range, byDay, code, isPartial) {
  let minor = 0;
  let count = 0;
  for (const day of range.days()) {
    const acc = byDay.get(day.raw);
    if (acc) {
      minor = saturatingAdd(minor, acc.minor);
      count += acc.count;
    }
  }
  return Object.freeze({ range, total: money(minor, code), count, isPartial });
}
