// Measures budgets against spending, and works out which budget alerts are due.

import { saturatingAdd } from './util.js';
import { DayRange } from './dayrange.js';
import { dividedBy, money, percentShare, roundedRatio, subtract } from './money.js';

export const DEFAULT_APPROACH_THRESHOLD = 80;

/** The period instance a budget measures right now. null for a custom budget without dates. */
export function budgetPeriod(budget, today, firstWeekday) {
  switch (budget.periodKind) {
    case 'weekly': {
      const start = today.startOfWeek(firstWeekday);
      return DayRange.between(start, start.addingDays(6));
    }
    case 'monthly':
      return DayRange.between(today.startOfMonth, today.endOfMonth);
    case 'custom':
      if (!budget.customStart || !budget.customEnd) return null;
      return DayRange.between(budget.customStart, budget.customEnd);
    default:
      return null;
  }
}

/** The lowest alert threshold below 100, or 80 if the budget has none. */
export function approachThreshold(budget) {
  const below = budget.alertThresholds.filter((t) => t > 0 && t < 100);
  return below.length > 0 ? Math.min(...below) : DEFAULT_APPROACH_THRESHOLD;
}

/** Exact integer test for "spent has reached `percent` percent of the limit" (no rounding involved). */
export function reached(spent, limit, percent) {
  if (limit.minorUnits <= 0) return false;
  return BigInt(spent.minorUnits) * 100n >= BigInt(limit.minorUnits) * BigInt(percent);
}

/**
 * A budget measured against the expenses of its current period. Returns null when the period cannot be worked out.
 * level is 'ok', 'approaching' (reached the warning point, not over) or 'exceeded'.
 */
export function budgetStatus(budget, expenses, directory, today, firstWeekday) {
  const range = budgetPeriod(budget, today, firstWeekday);
  if (!range) return null;
  const code = budget.amount.currencyCode;

  let spentMinor = 0;
  for (const expense of expenses) {
    if (!range.contains(expense.localDay) || expense.amount.currencyCode !== code) continue;
    if (budget.categoryID && expense.categoryID !== budget.categoryID) continue;
    spentMinor = saturatingAdd(spentMinor, expense.amount.minorUnits);
  }
  const spent = money(spentMinor, code);
  const limit = budget.amount;
  const remaining = subtract(limit, spent);
  const percentConsumed = percentShare(spent, limit);

  let level;
  if (spent.minorUnits > limit.minorUnits) level = 'exceeded';
  else if (reached(spent, limit, approachThreshold(budget))) level = 'approaching';
  else level = 'ok';

  const elapsedDays = range.elapsedDayCount(today);
  const totalDays = range.dayCount;
  const daysLeft = Math.max(0, totalDays - elapsedDays);

  // ESTIMATE of the spending at the end of the period if the daily average so far continues. Not a guarantee.
  let projectedTotal = null;
  let projectionIsEarly = false;
  if (elapsedDays > 0) {
    if (today.raw >= range.end.raw) {
      projectedTotal = spent;
    } else {
      projectedTotal = roundedRatio(BigInt(spent.minorUnits) * BigInt(totalDays), elapsedDays, code);
      projectionIsEarly = elapsedDays < 3 && totalDays > 7;
    }
  }
  let projectedOverBy = null;
  if (projectedTotal && projectedTotal.minorUnits > limit.minorUnits) projectedOverBy = subtract(projectedTotal, limit);

  let remainingPerDay = null;
  if (daysLeft > 0 && remaining.minorUnits > 0) remainingPerDay = dividedBy(remaining, daysLeft);

  let categoryName = null;
  if (budget.categoryID) {
    const category = directory.categoriesByID.get(budget.categoryID);
    categoryName = category ? category.name : 'Unknown category';
  }

  return Object.freeze({
    budget,
    range,
    categoryName,
    spent,
    limit,
    remaining,
    percentConsumed,
    level,
    elapsedDays,
    totalDays,
    daysLeft,
    projectedTotal,
    projectedOverBy,
    projectionIsEarly,
    remainingPerDay,
    isOver: spent.minorUnits > limit.minorUnits,
  });
}

/** Statuses of all active budgets: the overall budget first, then the rest by how much of the limit is used. */
export function budgetStatuses(budgets, expenses, directory, today, firstWeekday) {
  const result = [];
  for (const budget of budgets) {
    if (!budget.isActive) continue;
    const measured = budgetStatus(budget, expenses, directory, today, firstWeekday);
    if (measured) result.push(measured);
  }
  result.sort((a, b) => {
    const aOverall = !a.budget.categoryID;
    const bOverall = !b.budget.categoryID;
    if (aOverall !== bOverall) return aOverall ? -1 : 1;
    if (a.percentConsumed !== b.percentConsumed) return b.percentConsumed - a.percentConsumed;
    return a.budget.createdAt - b.budget.createdAt;
  });
  return result;
}

// Alerts ---------------------------------------------------------------------------------------

/** Unique per budget, period, limit and threshold. Remembering fired keys is what stops repeat alerts. */
export function alertKey(budgetID, periodStart, threshold, limitMinorUnits) {
  return [budgetID, periodStart.toString(), String(threshold), String(limitMinorUnits)].join('|');
}

/** The period start stored inside a key, used to forget keys of very old periods. */
export function periodStartInKey(key) {
  const parts = key.split('|');
  if (parts.length < 2) return null;
  // LocalDate is imported lazily by callers that need it; return the text and let them parse.
  return parts[1];
}

/**
 * Which alerts are due now. Only the highest newly reached threshold of each budget is returned,
 * and `reachedKeys` lists every threshold currently reached so nothing fires twice for the same period.
 */
export function planBudgetAlerts(statuses, alreadyFired) {
  const alerts = [];
  const reachedKeys = new Set();
  for (const status of statuses) {
    if (!status.budget.notificationsEnabled || !status.budget.isActive) continue;
    const thresholds = Array.from(new Set(status.budget.alertThresholds)).sort((a, b) => a - b);
    let newest = null;
    for (const threshold of thresholds) {
      if (!reached(status.spent, status.limit, threshold)) continue;
      const key = alertKey(status.budget.id, status.range.start, threshold, status.limit.minorUnits);
      reachedKeys.add(key);
      if (!alreadyFired.has(key)) {
        newest = Object.freeze({
          budgetID: status.budget.id,
          budgetName: status.budget.name,
          periodStart: status.range.start,
          threshold,
          limitMinorUnits: status.limit.minorUnits,
          isOver: status.isOver,
          key,
        });
      }
    }
    if (newest) alerts.push(newest);
  }
  return { alerts, reachedKeys };
}
