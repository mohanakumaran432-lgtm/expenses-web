// Compares two periods: totals, averages and which categories moved the most.

import { compareText } from './util.js';
import { PeriodResolver } from './periods.js';
import { generateReport } from './reports.js';
import { percentChange, subtract, zero } from './money.js';

const UNKNOWN_COLOR = '#8E8E93';

export function isNewCategory(change) {
  return change.previous.minorUnits === 0 && change.current.minorUnits > 0;
}

export function isGoneCategory(change) {
  return change.current.minorUnits === 0 && change.previous.minorUnits > 0;
}

/**
 * @param alignToElapsed  while the current period is still running, cut the earlier period to the same number of days
 *                        so the comparison is like for like (days 1-20 against days 1-20)
 */
export function compareRanges({
  expenses, directory, currencyCode, current: currentRange, previous: previousRange, today, firstWeekday, alignToElapsed,
}) {
  let effectivePrevious = previousRange;
  if (alignToElapsed) {
    effectivePrevious = new PeriodResolver(firstWeekday).alignedPrevious(currentRange, previousRange, today);
  }

  const currentReport = generateReport({ expenses, directory, currencyCode, range: currentRange, today, firstWeekday });
  const previousReport = generateReport({ expenses, directory, currencyCode, range: effectivePrevious, today, firstWeekday });

  const totalDifference = subtract(currentReport.total, previousReport.total);
  const percent = percentChange(previousReport.total, currentReport.total);

  let percentNote = null;
  if (percent === null) {
    percentNote = currentReport.total.minorUnits === 0
      ? 'There is no spending in either period.'
      : 'There was no spending in the earlier period, so a percentage change cannot be calculated.';
  }

  let averageDifference = null;
  let averagePercentChange = null;
  if (currentReport.averagePerDay && previousReport.averagePerDay) {
    averageDifference = subtract(currentReport.averagePerDay, previousReport.averagePerDay);
    averagePercentChange = percentChange(previousReport.averagePerDay, currentReport.averagePerDay);
  }

  const changes = makeCategoryChanges(currentReport, previousReport, currentReport.currencyCode);

  const increases = changes
    .filter((c) => c.difference.minorUnits > 0 && !isNewCategory(c))
    .sort((a, b) => b.difference.minorUnits - a.difference.minorUnits);
  const decreases = changes
    .filter((c) => c.difference.minorUnits < 0 && !isGoneCategory(c))
    .sort((a, b) => a.difference.minorUnits - b.difference.minorUnits);
  const newCategories = changes.filter(isNewCategory).sort((a, b) => b.current.minorUnits - a.current.minorUnits);
  const goneCategories = changes.filter(isGoneCategory).sort((a, b) => b.previous.minorUnits - a.previous.minorUnits);

  const currentDayCount = currentReport.range.dayCount;
  const previousDayCount = previousReport.range.dayCount;

  return Object.freeze({
    current: currentReport,
    previous: previousReport,
    previousWasAligned: !effectivePrevious.equals(previousRange),
    totalDifference,
    percentChange: percent,
    percentNote,
    averageDifference,
    averagePercentChange,
    categoryChanges: changes,
    biggestIncreases: increases.slice(0, 5),
    biggestDecreases: decreases.slice(0, 5),
    newCategories,
    goneCategories,
    currentDayCount,
    previousDayCount,
    periodLengthsDiffer: currentDayCount !== previousDayCount,
  });
}

function makeCategoryChanges(current, previous, code) {
  const currentByID = new Map(current.categories.map((row) => [row.categoryID, row]));
  const previousByID = new Map(previous.categories.map((row) => [row.categoryID, row]));
  const ids = new Set([...currentByID.keys(), ...previousByID.keys()]);

  const rows = [];
  for (const id of ids) {
    const now = currentByID.get(id) || null;
    const before = previousByID.get(id) || null;
    const meta = now || before;
    const currentMoney = now ? now.total : zero(code);
    const previousMoney = before ? before.total : zero(code);
    rows.push(Object.freeze({
      categoryID: id,
      name: meta ? meta.name : 'Unknown category',
      iconSymbol: meta ? meta.iconSymbol : 'questionmark.circle',
      colorHex: meta ? meta.colorHex : UNKNOWN_COLOR,
      current: currentMoney,
      previous: previousMoney,
      difference: subtract(currentMoney, previousMoney),
      percentChange: percentChange(previousMoney, currentMoney),
    }));
  }
  rows.sort((a, b) => {
    const magnitudeA = Math.abs(a.difference.minorUnits);
    const magnitudeB = Math.abs(b.difference.minorUnits);
    if (magnitudeA !== magnitudeB) return magnitudeB - magnitudeA;
    return compareText(a.name, b.name);
  });
  return rows;
}
