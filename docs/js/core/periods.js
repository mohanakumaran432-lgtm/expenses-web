// Turns a named period ("This month", "Last 30 days"...) into concrete calendar days.
//
// Definitions (the same as the iPhone app; see ../../../docs/REPORTING_RULES.md in the project):
// - Week: seven days starting on the configured first weekday.
// - Quarter: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec.
// - "Last N days" ends today and includes today.
// - "Last 12 months": from the day after today's date one year ago, through today.

import { DayRange } from './dayrange.js';

export const PERIOD_KINDS = Object.freeze([
  'today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter',
  'thisYear', 'lastYear', 'last7Days', 'last30Days', 'last90Days', 'last12Months', 'custom',
]);

export const PERIOD_TITLES = Object.freeze({
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  lastWeek: 'Last week',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisQuarter: 'This quarter',
  lastQuarter: 'Last quarter',
  thisYear: 'This year',
  lastYear: 'Last year',
  last7Days: 'Last 7 days',
  last30Days: 'Last 30 days',
  last90Days: 'Last 90 days',
  last12Months: 'Last 12 months',
  custom: 'Custom range',
});

/** Short labels for the Home screen's switcher. */
export const PERIOD_SHORT_TITLES = Object.freeze({
  today: 'Day',
  thisWeek: 'Week',
  thisMonth: 'Month',
  thisQuarter: 'Quarter',
  thisYear: 'Year',
  custom: 'Custom',
});

/** The six choices on the Home screen. */
export const DASHBOARD_KINDS = Object.freeze(['today', 'thisWeek', 'thisMonth', 'thisQuarter', 'thisYear', 'custom']);

export function isPeriodKind(value) {
  return PERIOD_KINDS.includes(value);
}

export const COMPARISON_PRESETS = Object.freeze([
  'thisWeekVsLastWeek', 'thisMonthVsLastMonth', 'thisQuarterVsLastQuarter', 'thisYearVsLastYear',
  'last30DaysVsPrevious30', 'custom',
]);

export const COMPARISON_TITLES = Object.freeze({
  thisWeekVsLastWeek: 'This week vs last week',
  thisMonthVsLastMonth: 'This month vs last month',
  thisQuarterVsLastQuarter: 'This quarter vs last quarter',
  thisYearVsLastYear: 'This year vs last year',
  last30DaysVsPrevious30: 'Last 30 days vs the 30 before',
  custom: 'Two custom ranges',
});

/** A chosen period. For 'custom', both days are included. */
export function periodSelection(kind, customStart = null, customEnd = null) {
  return { kind, customStart, customEnd };
}

export function customSelection(start, end) {
  const [first, second] = start.raw <= end.raw ? [start, end] : [end, start];
  return periodSelection('custom', first, second);
}

export class PeriodResolver {
  /** firstWeekday: 1 = Sunday ... 7 = Saturday. */
  constructor(firstWeekday) {
    this.firstWeekday = Math.min(Math.max(firstWeekday, 1), 7);
  }

  /** null when a custom selection is missing a date. */
  resolve(selection, today) {
    if (selection.kind === 'custom') {
      if (!selection.customStart || !selection.customEnd) return null;
      return DayRange.between(selection.customStart, selection.customEnd);
    }
    return this.range(selection.kind, today);
  }

  range(kind, today) {
    switch (kind) {
      case 'today':
        return DayRange.single(today);
      case 'yesterday':
        return DayRange.single(today.addingDays(-1));
      case 'thisWeek': {
        const start = today.startOfWeek(this.firstWeekday);
        return new DayRange(start, start.addingDays(6));
      }
      case 'lastWeek': {
        const start = today.startOfWeek(this.firstWeekday).addingDays(-7);
        return new DayRange(start, start.addingDays(6));
      }
      case 'thisMonth':
        return new DayRange(today.startOfMonth, today.endOfMonth);
      case 'lastMonth': {
        const first = today.startOfMonth.addingMonths(-1);
        return new DayRange(first, first.endOfMonth);
      }
      case 'thisQuarter':
        return new DayRange(today.startOfQuarter, today.endOfQuarter);
      case 'lastQuarter': {
        const first = today.startOfQuarter.addingMonths(-3);
        return new DayRange(first, first.endOfQuarter);
      }
      case 'thisYear':
        return new DayRange(today.startOfYear, today.endOfYear);
      case 'lastYear': {
        const first = today.startOfYear.addingYears(-1);
        return new DayRange(first, first.endOfYear);
      }
      case 'last7Days':
        return new DayRange(today.addingDays(-6), today);
      case 'last30Days':
        return new DayRange(today.addingDays(-29), today);
      case 'last90Days':
        return new DayRange(today.addingDays(-89), today);
      case 'last12Months':
        return new DayRange(today.addingMonths(-12).addingDays(1), today);
      default:
        return null;
    }
  }

  /** The two ranges for a ready-made comparison. 'custom' returns null (the caller supplies both ranges). */
  comparisonRanges(preset, today) {
    const pair = (currentKind, previousKind) => ({
      current: this.range(currentKind, today),
      previous: this.range(previousKind, today),
    });
    switch (preset) {
      case 'thisWeekVsLastWeek': return pair('thisWeek', 'lastWeek');
      case 'thisMonthVsLastMonth': return pair('thisMonth', 'lastMonth');
      case 'thisQuarterVsLastQuarter': return pair('thisQuarter', 'lastQuarter');
      case 'thisYearVsLastYear': return pair('thisYear', 'lastYear');
      case 'last30DaysVsPrevious30':
        return {
          current: new DayRange(today.addingDays(-29), today),
          previous: new DayRange(today.addingDays(-59), today.addingDays(-30)),
        };
      default:
        return null;
    }
  }

  /**
   * While the current period is still in progress, trims the previous period to the same number of days,
   * so the comparison is like for like (days 1-20 of this month against days 1-20 of last month).
   */
  alignedPrevious(current, previous, today) {
    const elapsed = current.elapsedDayCount(today);
    if (elapsed <= 0 || elapsed >= current.dayCount) return previous;
    const count = Math.min(elapsed, previous.dayCount);
    return new DayRange(previous.start, previous.start.addingDays(count - 1));
  }
}
