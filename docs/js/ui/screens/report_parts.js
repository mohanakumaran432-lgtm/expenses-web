// Pieces of a report that both Home and Reports show: the category donut with its legend, and the spending-over-time chart.
// Every figure comes from the report object (exact money); the drawings only place shapes.

import { h, plural } from '../dom.js';
import { icon } from '../icons.js';
import { row, swatch, badge } from '../components.js';
import { donutChart, columnChart, tableTwin, seenColor } from '../charts.js';
import { digitsForCode } from '../../core/currency.js';
import { TREND_TITLES, generateReport } from '../../core/reports.js';
import { doubleValue, money as makeMoney, percentShare } from '../../core/money.js';
import { saturatingAdd } from '../../core/util.js';

export const MAX_DONUT_SLICES = 6;
export const OTHER_COLOR = '#8E8E93';

/** The top categories as donut slices, with everything smaller gathered into "Other categories". */
export function categorySlices(app, report) {
  const f = app.formatter;
  const code = report.currencyCode;
  const slices = report.categories.slice(0, MAX_DONUT_SLICES).map((row) => ({
    id: row.categoryID,
    name: row.name,
    value: doubleValue(row.total),
    color: row.colorHex,
    iconSymbol: row.iconSymbol,
    amount: row.total,
    amountText: f.money.string(row.total),
    percentText: f.money.percentString(row.percent),
    count: row.count,
    categoryIDs: [row.categoryID],
  }));
  const rest = report.categories.slice(MAX_DONUT_SLICES);
  if (rest.length > 0) {
    let minor = 0;
    let count = 0;
    for (const row of rest) {
      minor = saturatingAdd(minor, row.total.minorUnits);
      count += row.count;
    }
    const amount = makeMoney(minor, code);
    slices.push({
      id: '__other__',
      name: `Other categories (${rest.length})`,
      value: doubleValue(amount),
      color: OTHER_COLOR,
      iconSymbol: 'ellipsis.circle',
      amount,
      amountText: f.money.string(amount),
      percentText: f.money.percentString(percentShare(amount, report.total)),
      count,
      categoryIDs: rest.map((row) => row.categoryID),
    });
  }
  return slices;
}

/** Donut plus one legend row per slice. Tapping a slice or a row calls open(slice). */
export function categoryBreakdown(app, report, { open }) {
  const f = app.formatter;
  const slices = categorySlices(app, report);
  const donut = donutChart({
    slices,
    center: { label: 'Total', value: f.money.string(report.total) },
    onOpen: open,
    ariaLabel: `Spending by category, ${slices.length} ${slices.length === 1 ? 'slice' : 'slices'}`,
  });
  const legend = h('div', { class: 'group' }, slices.map((slice) => row({
    badge: badge({ iconSymbol: slice.iconSymbol, colorHex: seenColor(slice.color) }),
    title: h('span', { class: 'legend-name' }, swatch(seenColor(slice.color)), slice.name),
    sub: plural(slice.count, 'transaction'),
    amount: slice.amountText,
    amountSub: slice.percentText,
    onClick: () => open(slice),
    ariaLabel: `${slice.name}, ${slice.amountText}, ${slice.percentText}, ${plural(slice.count, 'transaction')}. View transactions.`,
  })));
  return h('div', { class: 'stack' }, donut, legend);
}

function bucketTexts(f, granularity, bucket) {
  const start = bucket.range.start;
  switch (granularity) {
    case 'day':
      return { axis: f.dayMonthShort(start), title: `${f.weekdayShort(start)}, ${f.day(start)}` };
    case 'week':
      return { axis: f.dayMonthShort(start), title: bucket.isPartial ? `${f.range(bucket.range)} (part of a week)` : f.range(bucket.range) };
    default:
      return { axis: f.monthYearShort(start), title: bucket.isPartial ? `${f.monthYear(start)} (part of a month)` : f.monthYear(start) };
  }
}

/** The label for the vertical axis: short whole amounts such as 1.2K. */
export function axisFormatter(app, code) {
  const digits = digitsForCode(code);
  return (value) => app.formatter.money.compactString(makeMoney(Math.round(value * 10 ** digits), code));
}

/** Spending per day, week or month as columns, with a table of the same figures underneath. onOpen(point) shows what a column is made of. */
export function trendChart(app, report, { onOpen, buckets = null, granularity = null }) {
  const f = app.formatter;
  const kind = granularity || report.trendGranularity;
  const source = buckets || report.trend;
  const points = source.map((bucket) => {
    const texts = bucketTexts(f, kind, bucket);
    return {
      axisLabel: texts.axis,
      title: texts.title,
      value: doubleValue(bucket.total),
      amountText: f.money.string(bucket.total),
      detail: plural(bucket.count, 'transaction'),
      count: bucket.count,
      range: bucket.range,
    };
  });
  const todayIndex = points.findIndex((p) => p.range.contains(report.today));
  const chart = columnChart({
    points,
    ariaLabel: `${TREND_TITLES[kind]} spending`,
    formatAxis: axisFormatter(app, report.currencyCode),
    initialIndex: todayIndex >= 0 ? todayIndex : Math.max(0, points.length - 1),
    onOpen,
  });
  const twin = tableTwin({
    summary: 'Show these figures as a table',
    headers: ['Period', 'Transactions', 'Amount'],
    rows: points.map((p) => [p.title, String(p.count), p.amountText]),
    footer: ['Total', String(report.count), f.money.string(report.total)],
  });
  return h('div', { class: 'stack' }, chart, twin);
}

export { swatch };

/**
 * A function that builds the report for one fixed range from whatever the data is now. Drill-down pages call it again when the
 * data changes, so they keep showing the period they were opened from (not whatever period is chosen later).
 */
export function reportGenerator(range, currencyCode = null) {
  return (a) => generateReport({
    expenses: a.snapshot.expenses, directory: a.directory, currencyCode: currencyCode || a.currency, range, today: a.today(), firstWeekday: a.settings.firstWeekday,
  });
}

/** The wide button that shows the chosen period (or pair of periods) and opens the chooser. */
export function periodButton({ label, title, subtitle, onClick }) {
  return h('button', { type: 'button', class: 'period-button', onClick, 'aria-label': `${label}: ${title}, ${subtitle}. Change.` },
    h('span', { class: 'period-text' },
      h('span', { class: 'period-title' }, title),
      h('span', { class: 'period-sub' }, subtitle)),
    icon('chevronDown', { size: '1.2rem' }));
}
