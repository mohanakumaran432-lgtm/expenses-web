// The content of a printable report, already turned into display text. The PDF renderer only has to draw it,
// so every figure in the PDF comes from the same report object the screen shows.

import { saturatingAdd } from './util.js';
import { TREND_TITLES } from './reports.js';
import { doubleValue, money as makeMoney, percentShare } from './money.js';

export const MAX_SLICES = 8;
const METHOD_PALETTE = Object.freeze(['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#30B0C7', '#8E8E93']);

function labelFor(expense, directory) {
  const category = directory.categoryName(expense);
  return expense.merchant === '' ? category : `${expense.merchant} (${category})`;
}

function bucketLabel(bucket, granularity, formatter) {
  switch (granularity) {
    case 'day':
      return formatter.day(bucket.range.start);
    case 'week': {
      const text = formatter.range(bucket.range);
      return bucket.isPartial ? `${text} (partial)` : text;
    }
    default: {
      const text = formatter.monthYear(bucket.range.start);
      return bucket.isPartial ? `${text} (partial)` : text;
    }
  }
}

export function signed(value, moneyFormatter) {
  return value.minorUnits > 0 ? `+${moneyFormatter.string(value)}` : moneyFormatter.string(value);
}

export function signedPercent(percent, moneyFormatter) {
  return percent > 0 ? `+${moneyFormatter.percentString(percent)}` : moneyFormatter.percentString(percent);
}

/**
 * @param report      from generateReport
 * @param comparison  from compareRanges, or null
 * @param directory   a LedgerDirectory
 * @param formatter   a DisplayFormatter
 * @param generatedAt milliseconds since 1970
 * @param timeZone    the time zone name used for the "Generated" line
 */
export function buildReportDocument({ report, comparison = null, directory, formatter, generatedAt, timeZone, title = 'Spending report' }) {
  const money = formatter.money;
  const code = report.currencyCode;
  const metric = (name, value) => ({ title: name, value });

  // Summary figures.
  const summary = [
    metric('Total spending', money.string(report.total)),
    metric('Transactions', String(report.count)),
  ];
  if (report.averagePerDay) summary.push(metric('Average per day', money.string(report.averagePerDay)));
  if (report.highest) {
    summary.push(metric('Highest expense', `${money.string(report.highest.amount)} – ${labelFor(report.highest, directory)}`));
  }
  if (report.lowest) {
    summary.push(metric('Lowest expense', `${money.string(report.lowest.amount)} – ${labelFor(report.lowest, directory)}`));
  }
  if (report.highestCategory) {
    summary.push(metric('Highest category', `${report.highestCategory.name} – ${money.string(report.highestCategory.total)}`));
  }
  if (report.lowestCategory && report.categories.length > 1) {
    summary.push(metric('Lowest category', `${report.lowestCategory.name} – ${money.string(report.lowestCategory.total)}`));
  }

  // Charts. The exact figures are printed next to each slice, so color is never the only signal.
  const categorySlices = [];
  let otherTotal = 0;
  let otherCount = 0;
  report.categories.forEach((row, position) => {
    if (position < MAX_SLICES) {
      categorySlices.push({
        label: row.name,
        value: doubleValue(row.total),
        colorHex: row.colorHex,
        detail: `${money.string(row.total)} (${money.percentString(row.percent)})`,
      });
    } else {
      otherTotal = saturatingAdd(otherTotal, row.total.minorUnits);
      otherCount += 1;
    }
  });
  if (otherCount > 0) {
    const other = makeMoney(otherTotal, code);
    categorySlices.push({
      label: `Other categories (${otherCount})`,
      value: doubleValue(other),
      colorHex: '#8E8E93',
      detail: `${money.string(other)} (${money.percentString(percentShare(other, report.total))})`,
    });
  }

  const paymentSlices = report.paymentMethods.map((row, position) => ({
    label: row.name,
    value: doubleValue(row.total),
    colorHex: METHOD_PALETTE[position % METHOD_PALETTE.length],
    detail: `${money.string(row.total)} (${money.percentString(row.percent)})`,
  }));

  const trendPoints = report.trend.map((bucket) => ({
    label: bucketLabel(bucket, report.trendGranularity, formatter),
    value: doubleValue(bucket.total),
  }));

  // Tables.
  const tables = [];

  if (report.categories.length > 0) {
    tables.push({
      title: 'Spending by category',
      headers: ['Category', 'Transactions', 'Amount', 'Share'],
      rows: report.categories.map((row) => [row.name, String(row.count), money.string(row.total), money.percentString(row.percent)]),
      footer: ['Total', String(report.count), money.string(report.total), '100%'],
    });
  }

  if (report.subcategories.some((row) => row.subcategoryID)) {
    tables.push({
      title: 'Spending by subcategory',
      headers: ['Category › Subcategory', 'Transactions', 'Amount'],
      rows: report.subcategories.map((row) => [`${row.categoryName} › ${row.name}`, String(row.count), money.string(row.total)]),
      footer: null,
    });
  }

  const trendRows = [];
  for (const bucket of report.trend) {
    if (report.trendGranularity === 'day' && bucket.total.minorUnits === 0) continue;
    trendRows.push([bucketLabel(bucket, report.trendGranularity, formatter), String(bucket.count), money.string(bucket.total)]);
  }
  if (trendRows.length > 0) {
    tables.push({
      title: `${TREND_TITLES[report.trendGranularity]} totals`,
      headers: ['Period', 'Transactions', 'Amount'],
      rows: trendRows,
      footer: ['Total', String(report.count), money.string(report.total)],
    });
  }

  if (report.paymentMethods.length > 0) {
    tables.push({
      title: 'Payment methods',
      headers: ['Method', 'Transactions', 'Amount', 'Share'],
      rows: report.paymentMethods.map((row) => [row.name, String(row.count), money.string(row.total), money.percentString(row.percent)]),
      footer: null,
    });
  }

  if (report.merchants.length > 0) {
    // Real merchants are ranked; spending with no merchant named is listed last so it never takes a rank.
    const rows = report.merchants.filter((row) => row.key !== '').slice(0, 10)
      .map((row) => [row.name, String(row.count), money.string(row.total), money.percentString(row.percent)]);
    const unnamed = report.merchants.find((row) => row.key === '');
    if (unnamed) rows.push([unnamed.name, String(unnamed.count), money.string(unnamed.total), money.percentString(unnamed.percent)]);
    tables.push({ title: 'Top merchants', headers: ['Merchant', 'Transactions', 'Amount', 'Share'], rows, footer: null });
  }

  if (report.topExpenses.length > 0) {
    tables.push({
      title: 'Top expenses',
      headers: ['Date', 'Description', 'Amount'],
      rows: report.topExpenses.map((e) => [formatter.day(e.localDay), labelFor(e, directory), money.string(e.amount)]),
      footer: null,
    });
  }

  const notes = [
    `All amounts are in ${code}. Percentages are rounded to one decimal place.`,
    'Average per day divides by the days of the period that have already happened.',
  ];
  const excluded = report.excludedOtherCurrencyCount;
  if (excluded === 1) {
    notes.push('1 transaction in another currency is not included. No currency conversion is done.');
  } else if (excluded > 1) {
    notes.push(`${excluded} transactions in other currencies are not included. No currency conversion is done.`);
  }

  return {
    title,
    rangeText: formatter.range(report.range),
    generatedText: `Generated ${formatter.timestamp(generatedAt, timeZone)}`,
    currencyCode: code,
    summary,
    categorySlices,
    paymentSlices,
    trendTitle: `${TREND_TITLES[report.trendGranularity]} spending`,
    trendPoints,
    tables,
    comparison: comparison ? buildComparisonSection(comparison, formatter) : null,
    notes,
  };
}

function buildComparisonSection(result, formatter) {
  const money = formatter.money;
  const metrics = [
    { title: `This period (${formatter.range(result.current.range)})`, value: money.string(result.current.total) },
    { title: `Earlier period (${formatter.range(result.previous.range)})`, value: money.string(result.previous.total) },
    { title: 'Difference', value: signed(result.totalDifference, money) },
  ];
  if (result.percentChange !== null) metrics.push({ title: 'Change', value: signedPercent(result.percentChange, money) });
  if (result.averageDifference && result.current.averagePerDay && result.previous.averagePerDay) {
    const currentText = money.string(result.current.averagePerDay);
    const previousText = money.string(result.previous.averagePerDay);
    metrics.push({
      title: 'Average per day',
      value: `${currentText} vs ${previousText} (${signed(result.averageDifference, money)})`,
    });
  }

  const rows = result.categoryChanges.slice(0, 10).map((change) => {
    let changeText = signed(change.difference, money);
    if (change.previous.minorUnits === 0 && change.current.minorUnits > 0) changeText += ' (new)';
    if (change.current.minorUnits === 0 && change.previous.minorUnits > 0) changeText += ' (none this period)';
    return [change.name, money.string(change.current), money.string(change.previous), changeText];
  });
  const table = {
    title: 'Category changes',
    headers: ['Category', 'This period', 'Earlier', 'Change'],
    rows,
    footer: null,
  };

  let note = result.percentNote;
  if (result.previousWasAligned) {
    const text = 'The earlier period was cut to the same number of days so the comparison is like for like.';
    note = note ? `${note} ${text}` : text;
  } else if (result.periodLengthsDiffer) {
    const text = `The periods have different lengths (${result.currentDayCount} and ${result.previousDayCount} days); compare the daily averages.`;
    note = note ? `${note} ${text}` : text;
  }
  return { title: 'Period comparison', metrics, note, table };
}
