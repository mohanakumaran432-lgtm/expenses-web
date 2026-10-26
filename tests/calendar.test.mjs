import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx } from './support.mjs';
import { CalendarContext } from '../docs/js/core/calendar.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { ExpenseService } from '../docs/js/core/expense_service.js';
import { LocalDate, daysInMonth, isLeapYear } from '../docs/js/core/localdate.js';
import { makeDraft } from '../docs/js/core/models.js';
import { PERIOD_KINDS, PERIOD_TITLES, PeriodResolver, customSelection, periodSelection } from '../docs/js/core/periods.js';

const same = (a, b, message) => assert.ok(a.equals(b), `${message ?? ''} expected ${b} but got ${a}`);
const sameRange = (a, b, message) => assert.ok(a.equals(b), `${message ?? ''} expected ${b.start}..${b.end} but got ${a.start}..${a.end}`);

// ---------------------------------------------------------------------------------------- LocalDate

test('epoch and known day numbers', () => {
  assert.equal(Fx.day(1970, 1, 1).dayNumber, 0);
  assert.equal(Fx.day(2000, 1, 1).dayNumber, 10_957);
  assert.equal(Fx.day(2024, 2, 29).dayNumber, 19_782);
  assert.equal(Fx.day(2026, 10, 20).dayNumber, 20_746);
});

test('day number round trip over a wide range', () => {
  let mismatches = 0;
  for (let number = -40_000; number <= 60_000; number += 1) {
    if (LocalDate.fromDayNumber(number).dayNumber !== number) mismatches += 1;
  }
  assert.equal(mismatches, 0);
});

test('LocalDate agrees with JavaScript Date for every day from 1900 to 2200', () => {
  // An independent check of the calendar arithmetic against the platform's own Gregorian calendar.
  let mismatches = 0;
  const start = Date.UTC(1900, 0, 1);
  const end = Date.UTC(2200, 11, 31);
  for (let ms = start; ms <= end; ms += 86_400_000) {
    const date = new Date(ms);
    const ours = LocalDate.fromDayNumber(ms / 86_400_000);
    if (ours.year !== date.getUTCFullYear() || ours.month !== date.getUTCMonth() + 1 || ours.day !== date.getUTCDate()) mismatches += 1;
    // JS getUTCDay: 0 = Sunday ... 6 = Saturday; ours: 1 = Sunday ... 7 = Saturday.
    if (ours.weekday !== date.getUTCDay() + 1) mismatches += 1;
  }
  assert.equal(mismatches, 0);
});

test('consecutive days always advance by exactly one day', () => {
  let cursor = Fx.day(2023, 1, 1);
  let problems = 0;
  for (let i = 0; i < 2_200; i += 1) {
    const next = cursor.addingDays(1);
    const sameMonthStep = next.year === cursor.year && next.month === cursor.month && next.day === cursor.day + 1;
    const monthRollover = next.day === 1 && cursor.day === daysInMonth(cursor.year, cursor.month);
    if (!(sameMonthStep || monthRollover)) problems += 1;
    if ((cursor.weekday % 7) + 1 !== next.weekday) problems += 1;
    cursor = next;
  }
  assert.equal(problems, 0);
});

test('leap years', () => {
  assert.ok(isLeapYear(2024));
  assert.ok(isLeapYear(2000));
  assert.ok(!isLeapYear(1900));
  assert.ok(!isLeapYear(2100));
  assert.ok(!isLeapYear(2023));
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2023, 2), 28);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.equal(daysInMonth(2026, 12), 31);
});

test('impossible dates are rejected', () => {
  assert.equal(LocalDate.valid(2023, 2, 29), null);
  assert.notEqual(LocalDate.valid(2024, 2, 29), null);
  assert.equal(LocalDate.valid(2026, 13, 1), null);
  assert.equal(LocalDate.valid(2026, 0, 1), null);
  assert.equal(LocalDate.valid(2026, 4, 31), null);
  assert.equal(LocalDate.fromISO('garbage'), null);
  assert.equal(LocalDate.fromISO('2026-02-30'), null);
  same(LocalDate.fromISO('2026-10-20'), Fx.today);
  assert.equal(LocalDate.fromRaw(20_261_320), null);
  same(LocalDate.fromRaw(20_261_020), Fx.today);
});

test('weekdays use Sunday as one', () => {
  assert.equal(Fx.day(2026, 10, 20).weekday, 3); // Tuesday
  assert.equal(Fx.day(1970, 1, 1).weekday, 5); // Thursday
  assert.equal(Fx.day(2000, 1, 1).weekday, 7); // Saturday
  assert.equal(Fx.day(2026, 3, 8).weekday, 1); // Sunday
});

test('adding days across boundaries', () => {
  same(Fx.day(2026, 12, 31).addingDays(1), Fx.day(2027, 1, 1));
  same(Fx.day(2024, 2, 28).addingDays(1), Fx.day(2024, 2, 29));
  same(Fx.day(2023, 2, 28).addingDays(1), Fx.day(2023, 3, 1));
  same(Fx.day(2026, 3, 1).addingDays(-1), Fx.day(2026, 2, 28));
  same(Fx.day(2026, 1, 1).addingDays(-1), Fx.day(2025, 12, 31));
  assert.equal(Fx.day(2026, 10, 1).daysUntil(Fx.day(2026, 10, 20)), 19);
});

test('adding months clamps to the last day', () => {
  same(Fx.day(2026, 1, 31).addingMonths(1), Fx.day(2026, 2, 28));
  same(Fx.day(2024, 1, 31).addingMonths(1), Fx.day(2024, 2, 29));
  same(Fx.day(2026, 1, 31).addingMonths(2), Fx.day(2026, 3, 31));
  same(Fx.day(2026, 3, 31).addingMonths(-1), Fx.day(2026, 2, 28));
  same(Fx.day(2026, 1, 15).addingMonths(-1), Fx.day(2025, 12, 15));
  same(Fx.day(2026, 1, 15).addingMonths(12), Fx.day(2027, 1, 15));
  same(Fx.day(2026, 11, 30).addingMonths(3), Fx.day(2027, 2, 28));
});

test('adding years from a leap day', () => {
  same(Fx.day(2024, 2, 29).addingYears(1), Fx.day(2025, 2, 28));
  same(Fx.day(2024, 2, 29).addingYears(4), Fx.day(2028, 2, 29));
});

test('start of week follows the chosen first day', () => {
  const tuesday = Fx.day(2026, 10, 20);
  same(tuesday.startOfWeek(2), Fx.day(2026, 10, 19)); // Monday first
  same(tuesday.startOfWeek(1), Fx.day(2026, 10, 18)); // Sunday first
  same(tuesday.startOfWeek(7), Fx.day(2026, 10, 17)); // Saturday first
  const sunday = Fx.day(2026, 10, 18);
  same(sunday.startOfWeek(2), Fx.day(2026, 10, 12));
  same(sunday.startOfWeek(1), sunday);
  const monday = Fx.day(2026, 10, 19);
  same(monday.startOfWeek(2), monday);
});

test('month, quarter and year edges', () => {
  const day = Fx.day(2026, 10, 20);
  same(day.startOfMonth, Fx.day(2026, 10, 1));
  same(day.endOfMonth, Fx.day(2026, 10, 31));
  same(day.startOfQuarter, Fx.day(2026, 10, 1));
  same(day.endOfQuarter, Fx.day(2026, 12, 31));
  same(Fx.day(2026, 5, 5).startOfQuarter, Fx.day(2026, 4, 1));
  same(Fx.day(2026, 5, 5).endOfQuarter, Fx.day(2026, 6, 30));
  same(Fx.day(2026, 2, 28).startOfQuarter, Fx.day(2026, 1, 1));
  same(Fx.day(2026, 2, 28).endOfQuarter, Fx.day(2026, 3, 31));
  same(Fx.day(2024, 2, 10).endOfMonth, Fx.day(2024, 2, 29));
  same(day.startOfYear, Fx.day(2026, 1, 1));
  same(day.endOfYear, Fx.day(2026, 12, 31));
});

test('ordering and text', () => {
  assert.ok(Fx.day(2026, 10, 19).raw < Fx.day(2026, 10, 20).raw);
  assert.ok(Fx.day(2025, 12, 31).raw < Fx.day(2026, 1, 1).raw);
  assert.equal(Fx.day(2026, 3, 5).toString(), '2026-03-05');
  assert.equal(Fx.today.raw, 20_261_020);
});

test('JSON uses ISO text', () => {
  assert.equal(JSON.stringify({ day: Fx.today }), '{"day":"2026-10-20"}');
  assert.equal(LocalDate.fromISO('2026-02-30'), null);
});

// ---------------------------------------------------------------------------------------- DayRange

test('inclusive counts', () => {
  assert.equal(DayRange.single(Fx.today).dayCount, 1);
  assert.equal(DayRange.between(Fx.day(2026, 1, 1), Fx.day(2026, 1, 31)).dayCount, 31);
  assert.equal(DayRange.between(Fx.day(2024, 1, 1), Fx.day(2024, 12, 31)).dayCount, 366);
  assert.equal(DayRange.between(Fx.day(2025, 1, 1), Fx.day(2025, 12, 31)).dayCount, 365);
});

test('either order is accepted', () => {
  const range = DayRange.between(Fx.day(2026, 10, 5), Fx.day(2026, 10, 1));
  same(range.start, Fx.day(2026, 10, 1));
  same(range.end, Fx.day(2026, 10, 5));
  assert.equal(DayRange.make(Fx.day(2026, 10, 5), Fx.day(2026, 10, 1)), null);
  assert.notEqual(DayRange.make(Fx.day(2026, 10, 5), Fx.day(2026, 10, 5)), null);
});

test('both end days are included', () => {
  const range = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 5));
  assert.ok(range.contains(Fx.day(2026, 10, 1)));
  assert.ok(range.contains(Fx.day(2026, 10, 5)));
  assert.ok(!range.contains(Fx.day(2026, 9, 30)));
  assert.ok(!range.contains(Fx.day(2026, 10, 6)));
  const days = range.days();
  assert.equal(days.length, 5);
  same(days[0], Fx.day(2026, 10, 1));
  same(days[days.length - 1], Fx.day(2026, 10, 5));
});

test('elapsed days', () => {
  const october = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));
  assert.equal(october.elapsedDayCount(Fx.day(2026, 10, 20)), 20);
  assert.equal(october.elapsedDayCount(Fx.day(2026, 9, 30)), 0);
  assert.equal(october.elapsedDayCount(Fx.day(2026, 11, 5)), 31);
  assert.equal(october.elapsedDayCount(Fx.day(2026, 10, 1)), 1);
  assert.equal(october.elapsed(Fx.day(2026, 9, 30)), null);
  same(october.elapsed(Fx.day(2026, 10, 20)).end, Fx.day(2026, 10, 20));
});

test('week buckets with a Monday start', () => {
  const october = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));
  const buckets = october.weekBuckets(2);
  assert.equal(buckets.length, 5);
  sameRange(buckets[0], DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 4)));
  sameRange(buckets[1], DayRange.between(Fx.day(2026, 10, 5), Fx.day(2026, 10, 11)));
  sameRange(buckets[4], DayRange.between(Fx.day(2026, 10, 26), Fx.day(2026, 10, 31)));
  assert.equal(buckets.reduce((total, bucket) => total + bucket.dayCount, 0), 31);
});

test('month buckets across a year boundary', () => {
  const range = DayRange.between(Fx.day(2026, 10, 15), Fx.day(2027, 1, 10));
  const buckets = range.monthBuckets();
  assert.deepEqual(buckets.map((b) => b.dayCount), [17, 30, 31, 10]);
  assert.equal(buckets.reduce((total, bucket) => total + bucket.dayCount, 0), range.dayCount);
  assert.equal(range.dayCount, 88);
});

test('shifted', () => {
  const range = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 7));
  const earlier = range.shifted(-7);
  same(earlier.start, Fx.day(2026, 9, 24));
  same(earlier.end, Fx.day(2026, 9, 30));
});

// ---------------------------------------------------------------------------------------- PeriodResolver

const mondayFirst = new PeriodResolver(2);
const rangeOf = (kind, today = Fx.today, resolver = mondayFirst) => resolver.range(kind, today);
const assertRange = (range, start, end) => {
  same(range.start, start, 'start');
  same(range.end, end, 'end');
};

test('day periods', () => {
  assertRange(rangeOf('today'), Fx.day(2026, 10, 20), Fx.day(2026, 10, 20));
  assertRange(rangeOf('yesterday'), Fx.day(2026, 10, 19), Fx.day(2026, 10, 19));
});

test('week periods follow the first weekday', () => {
  assertRange(rangeOf('thisWeek'), Fx.day(2026, 10, 19), Fx.day(2026, 10, 25));
  assertRange(rangeOf('lastWeek'), Fx.day(2026, 10, 12), Fx.day(2026, 10, 18));
  const sundayFirst = new PeriodResolver(1);
  assertRange(rangeOf('thisWeek', Fx.today, sundayFirst), Fx.day(2026, 10, 18), Fx.day(2026, 10, 24));
  assertRange(rangeOf('lastWeek', Fx.today, sundayFirst), Fx.day(2026, 10, 11), Fx.day(2026, 10, 17));
});

test('month, quarter and year periods', () => {
  assertRange(rangeOf('thisMonth'), Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));
  assertRange(rangeOf('lastMonth'), Fx.day(2026, 9, 1), Fx.day(2026, 9, 30));
  assertRange(rangeOf('thisQuarter'), Fx.day(2026, 10, 1), Fx.day(2026, 12, 31));
  assertRange(rangeOf('lastQuarter'), Fx.day(2026, 7, 1), Fx.day(2026, 9, 30));
  assertRange(rangeOf('thisYear'), Fx.day(2026, 1, 1), Fx.day(2026, 12, 31));
  assertRange(rangeOf('lastYear'), Fx.day(2025, 1, 1), Fx.day(2025, 12, 31));
});

test('rolling periods end today and include it', () => {
  assertRange(rangeOf('last7Days'), Fx.day(2026, 10, 14), Fx.day(2026, 10, 20));
  assertRange(rangeOf('last30Days'), Fx.day(2026, 9, 21), Fx.day(2026, 10, 20));
  assertRange(rangeOf('last90Days'), Fx.day(2026, 7, 23), Fx.day(2026, 10, 20));
  assertRange(rangeOf('last12Months'), Fx.day(2025, 10, 21), Fx.day(2026, 10, 20));
  assert.equal(rangeOf('last7Days').dayCount, 7);
  assert.equal(rangeOf('last30Days').dayCount, 30);
  assert.equal(rangeOf('last90Days').dayCount, 90);
  assert.equal(rangeOf('last12Months').dayCount, 365);
});

test('year boundary', () => {
  const early = Fx.day(2027, 1, 5);
  assertRange(rangeOf('lastMonth', early), Fx.day(2026, 12, 1), Fx.day(2026, 12, 31));
  assertRange(rangeOf('lastQuarter', early), Fx.day(2026, 10, 1), Fx.day(2026, 12, 31));
  assertRange(rangeOf('thisWeek', early), Fx.day(2027, 1, 4), Fx.day(2027, 1, 10));
  assertRange(rangeOf('lastWeek', early), Fx.day(2026, 12, 28), Fx.day(2027, 1, 3));
  assertRange(rangeOf('lastYear', early), Fx.day(2026, 1, 1), Fx.day(2026, 12, 31));
});

test('leap year periods', () => {
  assertRange(rangeOf('lastMonth', Fx.day(2024, 3, 1)), Fx.day(2024, 2, 1), Fx.day(2024, 2, 29));
  assertRange(rangeOf('lastMonth', Fx.day(2025, 3, 1)), Fx.day(2025, 2, 1), Fx.day(2025, 2, 28));
  const leapDay = rangeOf('last12Months', Fx.day(2024, 2, 29));
  assertRange(leapDay, Fx.day(2023, 3, 1), Fx.day(2024, 2, 29));
  assert.equal(leapDay.dayCount, 366);
});

test('a custom range includes the whole end day', () => {
  const selection = customSelection(Fx.day(2026, 10, 1), Fx.day(2026, 10, 5));
  const resolved = mondayFirst.resolve(selection, Fx.today);
  assert.equal(resolved.dayCount, 5);
  const swapped = customSelection(Fx.day(2026, 10, 5), Fx.day(2026, 10, 1));
  sameRange(mondayFirst.resolve(swapped, Fx.today), resolved);
  assert.equal(mondayFirst.resolve(periodSelection('custom'), Fx.today), null, 'A custom period needs both dates');
});

test('every named period resolves', () => {
  for (const kind of PERIOD_KINDS.filter((k) => k !== 'custom')) {
    assert.notEqual(mondayFirst.range(kind, Fx.today), null, PERIOD_TITLES[kind]);
  }
  assert.equal(PERIOD_KINDS.length, 15);
});

test('comparison presets', () => {
  const month = mondayFirst.comparisonRanges('thisMonthVsLastMonth', Fx.today);
  assertRange(month.current, Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));
  assertRange(month.previous, Fx.day(2026, 9, 1), Fx.day(2026, 9, 30));
  const thirty = mondayFirst.comparisonRanges('last30DaysVsPrevious30', Fx.today);
  assertRange(thirty.current, Fx.day(2026, 9, 21), Fx.day(2026, 10, 20));
  assertRange(thirty.previous, Fx.day(2026, 8, 22), Fx.day(2026, 9, 20));
  assert.equal(mondayFirst.comparisonRanges('custom', Fx.today), null);
});

test('the previous period is trimmed to the same number of days', () => {
  const ranges = mondayFirst.comparisonRanges('thisMonthVsLastMonth', Fx.today);
  const aligned = mondayFirst.alignedPrevious(ranges.current, ranges.previous, Fx.today);
  assertRange(aligned, Fx.day(2026, 9, 1), Fx.day(2026, 9, 20));
  // Finished periods are never trimmed.
  const finished = mondayFirst.alignedPrevious(ranges.current, ranges.previous, Fx.day(2026, 11, 3));
  sameRange(finished, ranges.previous);
  // A shorter previous month is trimmed no further than its own length.
  const march = DayRange.between(Fx.day(2026, 3, 1), Fx.day(2026, 3, 31));
  const february = DayRange.between(Fx.day(2026, 2, 1), Fx.day(2026, 2, 28));
  const capped = mondayFirst.alignedPrevious(march, february, Fx.day(2026, 3, 30));
  sameRange(capped, february);
});

// ---------------------------------------------------------------------------------------- CalendarContext

test('just before and after midnight in Dubai', () => {
  const dubai = new CalendarContext(Fx.dubai);
  // 19:59:59 UTC is 23:59:59 in Dubai (UTC+4): still the 20th.
  same(dubai.localDate(1_792_526_399_000), Fx.day(2026, 10, 20));
  // 20:30:00 UTC is 00:30 on the 21st in Dubai.
  const after = 1_792_528_200_000;
  same(dubai.localDate(after), Fx.day(2026, 10, 21));
  assert.equal(dubai.hourAndMinute(after).hour, 0);
  assert.equal(dubai.hourAndMinute(after).minute, 30);
  // The same instant is still the 20th in UTC.
  same(new CalendarContext(Fx.utc).localDate(after), Fx.day(2026, 10, 20));
});

test('today depends on the time zone', () => {
  const moment = 1_792_530_000_000; // 2026-10-20 21:00 UTC
  same(new CalendarContext(Fx.dubai).today(moment), Fx.day(2026, 10, 21));
  same(new CalendarContext(Fx.utc).today(moment), Fx.day(2026, 10, 20));
  same(new CalendarContext(Fx.newYork).today(moment), Fx.day(2026, 10, 20));
});

test('an instant round-trips to the same day and time', () => {
  for (const zone of [Fx.dubai, Fx.utc, Fx.newYork]) {
    const context = new CalendarContext(zone);
    const moment = context.instant(Fx.day(2026, 10, 20), 23, 45);
    same(context.localDate(moment), Fx.day(2026, 10, 20), zone);
    assert.equal(context.hourAndMinute(moment).hour, 23, zone);
    assert.equal(context.hourAndMinute(moment).minute, 45, zone);
  }
});

test('expenses without a time are stored at noon', () => {
  const context = new CalendarContext(Fx.dubai);
  const moment = context.instantFor(Fx.today, false, 3, 15);
  assert.equal(context.hourAndMinute(moment).hour, 12);
  assert.equal(context.hourAndMinute(moment).minute, 0);
  same(context.localDate(moment), Fx.today);
});

test('daylight saving days keep their date', () => {
  const newYork = new CalendarContext(Fx.newYork);
  // 2026-03-08: clocks jump from 02:00 to 03:00, so 02:30 does not exist.
  const skipped = newYork.instant(Fx.day(2026, 3, 8), 2, 30);
  same(newYork.localDate(skipped), Fx.day(2026, 3, 8));
  // 2026-11-01: 01:30 happens twice; the first occurrence is used.
  const repeated = newYork.instant(Fx.day(2026, 11, 1), 1, 30);
  same(newYork.localDate(repeated), Fx.day(2026, 11, 1));
  assert.equal(repeated, Date.UTC(2026, 10, 1, 5, 30), '01:30 EDT (UTC-4) is the first occurrence');
});

test('daylight saving days are short and long', () => {
  const newYork = new CalendarContext(Fx.newYork);
  const springLength = newYork.startOfDay(Fx.day(2026, 3, 9)) - newYork.startOfDay(Fx.day(2026, 3, 8));
  assert.equal(springLength, 23 * 3_600_000);
  const autumnLength = newYork.startOfDay(Fx.day(2026, 11, 2)) - newYork.startOfDay(Fx.day(2026, 11, 1));
  assert.equal(autumnLength, 25 * 3_600_000);
});

test('an unknown time zone name falls back instead of failing', () => {
  const context = new CalendarContext('Not/AZone');
  assert.equal(typeof context.timeZone, 'string');
  assert.ok(context.localDate(Fx.now) instanceof LocalDate);
});

test('a saved day does not move when the time zone changes later', async () => {
  // An expense entered at 00:30 on the 21st in Dubai is 20:30 UTC on the 20th.
  const store = Fx.store(Fx.catalog());
  const groceries = Fx.category('Groceries', store.snapshot);
  const service = new ExpenseService(store, () => Fx.now);
  const draft = makeDraft({
    amount: Fx.money('25'), day: Fx.day(2026, 10, 21), hasExplicitTime: true, hour: 0, minute: 30,
    timeZoneID: Fx.dubai, categoryID: groceries.id,
  });
  const saved = await service.save(draft, Fx.today);
  same(saved.localDay, Fx.day(2026, 10, 21));
  same(new CalendarContext(Fx.utc).localDate(saved.occurredAt), Fx.day(2026, 10, 20),
    'Converting again in another zone would give a different day; that is why the day is stored');
  // Reports use the stored day, and the original wall-clock time is still shown.
  const report = Fx.report(store.snapshot, DayRange.single(Fx.day(2026, 10, 21)));
  assert.equal(report.count, 1);
  assert.equal(Fx.formatter().timeOfExpense(saved), '00:30');
});
