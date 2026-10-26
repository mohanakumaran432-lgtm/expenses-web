// Reports: where the money went in any period (15 ready-made periods or your own dates), and a side-by-side comparison of
// two periods. Every figure is written out as text next to the drawing it belongs to, and tapping a part of a chart lists the
// expenses it is made of.

import { fill, h, plural } from '../dom.js';
import { badge, emptyState, group, iconButton, moneyBig, notice, page, row, segmented, swatch } from '../components.js';
import { lineChart, rankingList, seenColor, stackedBar, tableTwin } from '../charts.js';
import { PERIOD_TITLES, PeriodResolver, isPeriodKind, periodSelection } from '../../core/periods.js';
import { TREND_TITLES, expensesForMerchant, expensesInDays, expensesWithPaymentMethod, generateReport } from '../../core/reports.js';
import { doubleValue, money as makeMoney } from '../../core/money.js';
import { saturatingAdd } from '../../core/util.js';
import { axisFormatter, categoryBreakdown, periodButton, reportGenerator, trendChart } from './report_parts.js';
import { expenseRow } from './rows.js';
import { openCategoryDetail } from './report_detail.js';
import { buildComparison, compareControls, compareSections, comparisonPair, newComparisonState } from './report_compare.js';
import { openDrilldown } from './drilldown.js';
import { openExpenseForm } from './expense_form.js';
import { chooseFromList, choosePeriod } from './pickers.js';
import { exportExpensesCsv } from '../exports.js';

/** One colour per payment method, by the method (not by its rank), so a method keeps its colour whatever is spent. */
const METHOD_COLORS = Object.freeze(['#2B6CB0', '#B7791F', '#2F855A', '#9F3A7A', '#2C7A7B', '#C05621']);
const NOT_SPECIFIED_COLOR = '#8E8E93';

// Remembered while the app stays open.
const view = {
  mode: 'overview',
  kind: null,
  start: null,
  end: null,
  granularity: null,
  currency: null,
  compare: newComparisonState(),
};

function initialKind(app) {
  const preferred = app.settings.defaultReportPeriod;
  return isPeriodKind(preferred) && preferred !== 'custom' ? preferred : 'thisMonth';
}

/** The currencies that appear in the ledger, most used first. */
function currenciesInUse(app) {
  const counts = new Map();
  for (const expense of app.snapshot.expenses) counts.set(expense.amount.currencyCode, (counts.get(expense.amount.currencyCode) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
}

export function createReports(app) {
  const screen = page(app, { title: 'Reports', large: true });
  if (view.kind === null) view.kind = initialKind(app);
  let latest = null; // what the export button exports

  const modeBar = segmented({
    label: 'Kind of report',
    options: [{ value: 'overview', label: 'Overview' }, { value: 'compare', label: 'Compare' }],
    value: view.mode,
    onChange: (mode) => {
      view.mode = mode;
      refresh();
    },
  });
  const controls = h('div', { class: 'stack' });
  const content = h('div', { class: 'home-content' });
  screen.body.append(modeBar, controls, content);
  const exportButton = iconButton('share', 'Export this report', () => chooseExport());
  screen.setTrailing(exportButton);

  async function chooseExport() {
    if (!latest) return;
    const compare = view.mode === 'compare';
    const choice = await app.ui.actions({
      title: 'Export',
      options: [
        { label: compare ? 'PDF comparison report' : 'PDF report', value: 'pdf' },
        { label: compare ? 'CSV of this period’s expenses' : 'CSV of these expenses', value: 'csv' },
      ],
    });
    if (choice === 'csv') {
      await exportExpensesCsv(app, latest.expenses);
    } else if (choice === 'pdf') {
      const done = app.ui.busy('Preparing the report…');
      let module;
      try {
        module = await import('./report_pdf.js');
      } finally {
        done();
      }
      await module.openReportPdf(app, latest);
    }
  }

  function reportCurrency() {
    const used = currenciesInUse(app);
    if (view.currency && used.includes(view.currency)) return view.currency;
    return app.currency;
  }

  function currencyRow() {
    const used = currenciesInUse(app);
    if (used.length < 2) return null;
    const code = reportCurrency();
    return group([row({
      title: 'Currency',
      value: code,
      chevron: true,
      sub: 'Amounts in different currencies are never added together.',
      onClick: async () => {
        const picked = await chooseFromList(app, {
          title: 'Report currency', value: code,
          options: used.map((c) => ({ value: c, label: c })),
          footer: 'Reports cover one currency at a time. Nothing is converted.',
        });
        if (picked) {
          view.currency = picked;
          refresh();
        }
      },
    })]);
  }

  async function pickPeriod() {
    const picked = await choosePeriod(app, { title: 'Period', value: { kind: view.kind, start: view.start, end: view.end } });
    if (!picked) return;
    view.kind = picked.kind;
    view.start = picked.start;
    view.end = picked.end;
    refresh();
  }

  function refresh() {
    modeBar.set(view.mode);
    if (app.snapshot.expenses.length === 0) {
      latest = null;
      exportButton.hidden = true;
      fill(controls);
      fill(content, emptyState({ mark: '📊', title: 'No reports yet', message: 'Once you add expenses, this is where you see where the money went.' }));
      return;
    }
    exportButton.hidden = false;
    if (view.mode === 'overview') drawOverview();
    else drawComparison();
  }

  // ------------------------------------------------------------ overview

  function drawOverview() {
    const today = app.today();
    const f = app.formatter;
    const code = reportCurrency();
    const resolver = new PeriodResolver(app.settings.firstWeekday);
    let range = resolver.resolve(periodSelection(view.kind, view.start, view.end), today);
    if (!range) {
      view.kind = initialKind(app);
      range = resolver.range(view.kind, today);
    }
    const report = generateReport({
      expenses: app.snapshot.expenses, directory: app.directory, currencyCode: code, range, today, firstWeekday: app.settings.firstWeekday,
    });
    const title = view.kind === 'custom' ? 'Custom range' : PERIOD_TITLES[view.kind];
    latest = { report, comparison: null, title, expenses: report.expenses };
    const generate = reportGenerator(range, code);
    const subtitle = f.range(range);

    fill(controls, periodButton({ label: 'Period', title, subtitle, onClick: pickPeriod }), currencyRow());

    if (report.count === 0) {
      fill(content,
        emptyState({ mark: '🧾', title: 'No spending in this period', message: `Nothing was spent in ${code} between ${subtitle}. Try another period.` }),
        report.excludedOtherCurrencyCount > 0 ? notice({ glyph: 'info', body: `${plural(report.excludedOtherCurrencyCount, 'expense')} in another currency ${report.excludedOtherCurrencyCount === 1 ? 'is' : 'are'} not included.` }) : null);
      return;
    }
    fill(content,
      summarySection(app, report, title, subtitle, generate),
      metricTiles(app, report, subtitle, generate),
      report.excludedOtherCurrencyCount > 0
        ? notice({ glyph: 'info', body: `${plural(report.excludedOtherCurrencyCount, 'expense')} in another currency ${report.excludedOtherCurrencyCount === 1 ? 'is' : 'are'} not included. Amounts are never converted.` })
        : null,
      trendSection(app, report, generate),
      runningTotalSection(app, report, code, generate),
      categorySection(app, report, range, subtitle, generate, code),
      methodSection(app, report, subtitle, generate),
      merchantSection(app, report, subtitle, generate),
      topExpensesSection(app, report),
      allTransactionsSection(app, report, subtitle, generate));
  }

  // ------------------------------------------------------------ comparison

  function drawComparison() {
    const today = app.today();
    const code = reportCurrency();
    const state = view.compare;
    const pair = comparisonPair(app, state, today);
    fill(controls, ...compareControls(app, state, pair, today, refresh), currencyRow());
    if (!pair) {
      latest = null;
      exportButton.hidden = true;
      fill(content, emptyState({ mark: '⚖️', title: 'Choose two periods', message: 'Pick the periods you want to set side by side.' }));
      return;
    }
    const comparison = buildComparison(app, state, pair, today, code);
    latest = { report: comparison.current, comparison, title: 'Comparison', expenses: comparison.current.expenses };
    fill(content, ...compareSections(app, comparison, state, { today, currencyCode: code }));
  }

  return { el: screen.el, refresh };
}

// ---------------------------------------------------------------- the sections of the overview

function summarySection(app, report, title, subtitle, generate) {
  const f = app.formatter;
  const showAverage = report.averagePerDay && report.elapsedDays > 1;
  const meta = [plural(report.count, 'transaction'), showAverage ? `${f.money.string(report.averagePerDay)} a day` : null].filter(Boolean).join(' · ');
  return h('section', { class: 'hero', 'aria-label': `${title} spending` },
    h('div', { class: 'hero-head' }, h('h2', { class: 'hero-period' }, 'Total spending'), h('span', { class: 'hero-range' }, subtitle)),
    moneyBig(f, report.total),
    h('p', { class: 'hero-meta' }, meta),
    report.elapsedDays < report.range.dayCount
      ? h('p', { class: 'hero-foot' }, `${plural(report.elapsedDays, 'day')} of ${report.range.dayCount} so far. Averages use the days that have passed.`)
      : null);
}

function tile({ label, amount, sub, onClick }) {
  return h('button', { type: 'button', class: 'tile-total', onClick, 'aria-label': `${label}: ${amount}. ${sub}` },
    h('span', { class: 'tile-label' }, label),
    h('span', { class: 'tile-amount num' }, amount),
    h('span', { class: 'tile-sub' }, sub));
}

function metricTiles(app, report, subtitle, generate) {
  const f = app.formatter;
  const money = f.money;
  const tiles = [];
  const describeExpense = (expense) => [expense.merchant || app.directory.categoryName(expense), f.dayMonthShort(expense.localDay)].join(' · ');
  const openExpense = (expense) => () => openExpenseForm(app, { expense });
  const highest = report.highest;
  const lowest = report.lowest;
  if (highest && lowest && highest.id !== lowest.id) {
    tiles.push(tile({ label: 'Highest expense', amount: money.string(highest.amount), sub: describeExpense(highest), onClick: openExpense(highest) }));
    tiles.push(tile({ label: 'Lowest expense', amount: money.string(lowest.amount), sub: describeExpense(lowest), onClick: openExpense(lowest) }));
  } else if (highest) {
    tiles.push(tile({ label: 'Only expense', amount: money.string(highest.amount), sub: describeExpense(highest), onClick: openExpense(highest) }));
  }
  const openCategory = (category) => () => openDrilldown(app, {
    title: category.name, subtitle, backLabel: 'Reports',
    select: (a) => generate(a).expenses.filter((e) => e.categoryID === category.categoryID),
  });
  const top = report.highestCategory;
  const bottom = report.lowestCategory;
  if (top && bottom && top.categoryID !== bottom.categoryID) {
    tiles.push(tile({ label: 'Top category', amount: money.string(top.total), sub: `${top.name} · ${money.percentString(top.percent)}`, onClick: openCategory(top) }));
    tiles.push(tile({ label: 'Smallest category', amount: money.string(bottom.total), sub: `${bottom.name} · ${money.percentString(bottom.percent)}`, onClick: openCategory(bottom) }));
  } else if (top) {
    tiles.push(tile({ label: 'Only category', amount: money.string(top.total), sub: top.name, onClick: openCategory(top) }));
  }
  return h('div', { class: 'tile-totals' }, tiles);
}

function bucketsFor(report, granularity) {
  return granularity === 'day' ? report.daily : granularity === 'week' ? report.weekly : report.monthly;
}

function trendSection(app, report, generate) {
  const days = report.elapsedDays;
  const allowed = ['day', 'week', 'month'].filter((g) => {
    if (g === report.trendGranularity) return true;
    if (g === 'day') return days <= 93;
    if (g === 'week') return days >= 7 && days <= 400;
    return days >= 28;
  });
  let granularity = view.granularity && allowed.includes(view.granularity) ? view.granularity : report.trendGranularity;
  const holder = h('div', { class: 'stack' });
  const draw = () => fill(holder, trendChart(app, report, {
    granularity,
    buckets: bucketsFor(report, granularity),
    onOpen: (point) => openDrilldown(app, {
      title: point.title, subtitle: '', backLabel: 'Reports',
      select: (a) => expensesInDays(generate(a), point.range),
    }),
  }));
  draw();
  const switcher = allowed.length > 1
    ? segmented({
      label: 'Group spending by',
      options: allowed.map((g) => ({ value: g, label: TREND_TITLES[g] })),
      value: granularity,
      onChange: (next) => {
        granularity = next;
        view.granularity = next;
        draw();
      },
    })
    : null;
  return h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Spending over time'), h('div', { class: 'stack' }, switcher, holder));
}

function runningTotalSection(app, report, code, generate) {
  const f = app.formatter;
  const days = report.daily;
  if (days.length < 3) return null;
  const values = [];
  const exact = [];
  let minor = 0;
  for (const bucket of days) {
    minor = saturatingAdd(minor, bucket.total.minorUnits);
    const total = makeMoney(minor, code);
    exact.push(total);
    values.push(doubleValue(total));
  }
  const labels = days.map((bucket) => ({
    axisLabel: f.dayMonthShort(bucket.range.start),
    title: `${f.weekdayShort(bucket.range.start)}, ${f.day(bucket.range.start)}`,
  }));
  const chart = lineChart({
    series: [{ name: 'Running total', values }],
    labels,
    ariaLabel: 'Running total of spending through the period',
    formatAxis: axisFormatter(app, code),
    describe: (i) => ({
      title: labels[i].title,
      amountText: f.money.string(exact[i]),
      detail: `${f.money.string(days[i].total)} spent that day`,
      count: days[i].count,
      range: days[i].range,
    }),
    onOpen: (point) => openDrilldown(app, {
      title: point.title, subtitle: '', backLabel: 'Reports',
      select: (a) => expensesInDays(generate(a), point.range),
    }),
  });
  const twin = tableTwin({
    summary: 'Show these figures as a table',
    headers: ['Day', 'Spent', 'Running total'],
    rows: days.map((bucket, i) => [labels[i].title, f.money.string(bucket.total), f.money.string(exact[i])]),
    footer: ['Total', f.money.string(report.total), f.money.string(report.total)],
  });
  return h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Running total'),
    h('div', { class: 'stack' }, chart, h('p', { class: 't-foot' }, 'Adds up the spending day by day from the start of the period.'), twin));
}

function categorySection(app, report, range, subtitle, generate, code) {
  const breakdown = categoryBreakdown(app, report, {
    open: (slice) => openDrilldown(app, {
      title: slice.categoryIDs.length === 1 ? slice.name : 'Other categories', subtitle, backLabel: 'Reports',
      select: (a) => generate(a).expenses.filter((e) => slice.categoryIDs.includes(e.categoryID)),
    }),
  });
  const more = report.categories.length > 6 || report.subcategories.some((s) => s.subcategoryID !== null)
    ? group([row({
      title: 'Every category and subcategory', value: String(report.categories.length), chevron: true,
      onClick: () => openCategoryDetail(app, { range, currencyCode: code, subtitle }),
    })])
    : null;
  return h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'By category'), h('div', { class: 'stack' }, breakdown, more));
}

function methodSection(app, report, subtitle, generate) {
  const f = app.formatter;
  const methods = report.paymentMethods;
  if (methods.length === 0) return null;
  const order = app.snapshot.paymentMethods.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((m) => m.id);
  const colorOf = (method) => {
    if (method.methodID === null) return NOT_SPECIFIED_COLOR;
    const index = order.indexOf(method.methodID);
    return METHOD_COLORS[(index < 0 ? order.length : index) % METHOD_COLORS.length];
  };
  const bar = stackedBar(methods.map((m) => ({ value: doubleValue(m.total), color: colorOf(m) })),
    `Spending by payment method: ${methods.map((m) => `${m.name} ${f.money.percentString(m.percent)}`).join(', ')}`);
  const rows = methods.map((method) => {
    const color = seenColor(colorOf(method));
    return row({
      badge: badge({ iconSymbol: method.iconSymbol, colorHex: color }),
      title: h('span', { class: 'legend-name' }, swatch(color), method.name),
      sub: plural(method.count, 'transaction'),
      amount: f.money.string(method.total),
      amountSub: f.money.percentString(method.percent),
      ariaLabel: `${method.name}, ${f.money.string(method.total)}, ${f.money.percentString(method.percent)}, ${plural(method.count, 'transaction')}. View transactions.`,
      onClick: () => openDrilldown(app, {
        title: method.name, subtitle, backLabel: 'Reports',
        select: (a) => expensesWithPaymentMethod(generate(a), method.methodID),
      }),
    });
  });
  return h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Payment methods'),
    h('div', { class: 'stack' }, h('div', { class: 'bar-card' }, bar), h('div', { class: 'group' }, rows)));
}

function merchantSection(app, report, subtitle, generate) {
  const f = app.formatter;
  const named = report.merchants.filter((m) => m.key !== '');
  if (named.length === 0) return null;
  const rows = named.slice(0, 10);
  const biggest = doubleValue(rows[0].total) || 1;
  const list = rankingList(rows.map((m) => ({
    key: m.key,
    name: m.name,
    color: null,
    amountText: f.money.string(m.total),
    subText: `${f.money.percentString(m.percent)} · ${plural(m.count, 'transaction')}`,
    share: doubleValue(m.total) / biggest,
  })), {
    onOpen: (item) => openDrilldown(app, {
      title: item.name, subtitle, backLabel: 'Reports',
      select: (a) => expensesForMerchant(generate(a), item.key),
    }),
  });
  return h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Top merchants'),
    h('div', { class: 'stack' }, list,
      h('p', { class: 't-foot' }, 'Spending grouped by merchant name. Capital letters and extra spaces are ignored. Expenses with no merchant are not listed here.')));
}

function topExpensesSection(app, report) {
  const today = app.today();
  const top = report.topExpenses;
  if (top.length < 2) return null;
  return group(top.map((expense) => expenseRow(app, expense, { showDay: true, today, onClick: () => openExpenseForm(app, { expense }) })), {
    title: `Biggest ${top.length} expenses`,
  });
}

function allTransactionsSection(app, report, subtitle, generate) {
  return group([row({
    title: 'All transactions in this period',
    value: String(report.count),
    chevron: true,
    onClick: () => openDrilldown(app, { title: 'All transactions', subtitle, backLabel: 'Reports', select: (a) => generate(a).expenses }),
  })]);
}

