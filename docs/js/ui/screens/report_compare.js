// The "Compare" side of Reports: two periods set side by side. It is honest about what it can and cannot say:
// a percentage is only written when the earlier period had spending, and periods of different lengths are flagged so the
// daily averages (which are fair across lengths) can be read instead.

import { h, plural } from '../dom.js';
import { badge, group, moneyBig, notice, row, toggleRow } from '../components.js';
import { lineChart, tableTwin } from '../charts.js';
import { COMPARISON_PRESETS, COMPARISON_TITLES, PeriodResolver } from '../../core/periods.js';
import { DayRange } from '../../core/dayrange.js';
import { compareRanges } from '../../core/comparison.js';
import { doubleValue, money as makeMoney } from '../../core/money.js';
import { saturatingAdd } from '../../core/util.js';
import { expensesInCategory } from '../../core/reports.js';
import { openDrilldown } from './drilldown.js';
import { axisFormatter, periodButton, reportGenerator } from './report_parts.js';
import { chooseDateRange, chooseFromList } from './pickers.js';

export function newComparisonState() {
  return { preset: 'thisMonthVsLastMonth', current: null, previous: null, aligned: true };
}

/** The two ranges for the chosen preset (or the two custom ranges). null while a custom pair is incomplete. */
export function comparisonPair(app, state, today) {
  if (state.preset === 'custom') {
    if (!state.current || !state.previous) return null;
    return {
      current: DayRange.between(state.current.start, state.current.end),
      previous: DayRange.between(state.previous.start, state.previous.end),
    };
  }
  return new PeriodResolver(app.settings.firstWeekday).comparisonRanges(state.preset, today);
}

/** True while the current period has started but not finished. Only then does "the same number of days" make sense. */
export function isRunning(pair, today) {
  return pair.current.start.raw <= today.raw && today.raw < pair.current.end.raw;
}

export function buildComparison(app, state, pair, today, currencyCode) {
  return compareRanges({
    expenses: app.snapshot.expenses,
    directory: app.directory,
    currencyCode: currencyCode || app.currency,
    current: pair.current,
    previous: pair.previous,
    today,
    firstWeekday: app.settings.firstWeekday,
    alignToElapsed: state.aligned && isRunning(pair, today),
  });
}

/** The controls above the comparison: which two periods, and whether to cut the earlier one to the same length. */
export function compareControls(app, state, pair, today, onChange) {
  const f = app.formatter;
  const nodes = [];
  const summary = pair ? `${f.range(pair.current)} vs ${f.range(pair.previous)}` : 'Choose the two periods';
  nodes.push(periodButton({
    label: 'Compare',
    title: COMPARISON_TITLES[state.preset],
    subtitle: summary,
    onClick: async () => {
      const resolver = new PeriodResolver(app.settings.firstWeekday);
      const picked = await chooseFromList(app, {
        title: 'Compare',
        value: state.preset,
        options: COMPARISON_PRESETS.map((preset) => {
          const ranges = preset === 'custom' ? null : resolver.comparisonRanges(preset, today);
          return { value: preset, label: COMPARISON_TITLES[preset], sub: ranges ? `${f.range(ranges.current)} vs ${f.range(ranges.previous)}` : 'Choose both periods yourself' };
        }),
      });
      if (!picked) return;
      if (picked === 'custom') {
        const first = await chooseDateRange(app, { title: 'This period', start: state.current && state.current.start, end: state.current && state.current.end, confirmLabel: 'Next' });
        if (!first) return;
        const second = await chooseDateRange(app, { title: 'Compare with', start: state.previous && state.previous.start, end: state.previous && state.previous.end, confirmLabel: 'Compare' });
        if (!second) return;
        state.current = first;
        state.previous = second;
      }
      state.preset = picked;
      onChange();
    },
  }));
  if (pair && isRunning(pair, today)) {
    nodes.push(h('div', { class: 'group' }, toggleRow({
      title: 'Compare the same number of days',
      sub: 'While a period is still running, the earlier one is cut to the same length so the comparison is fair.',
      checked: state.aligned,
      onChange: (checked) => {
        state.aligned = checked;
        onChange();
      },
    })));
  }
  return nodes;
}

function directionClass(money) {
  if (money.minorUnits > 0) return 'up';
  if (money.minorUnits < 0) return 'down';
  return 'same';
}

/** Running totals, day by day, from a report's daily buckets: { values (numbers for the drawing), exact (Money) }. */
function runningTotals(report, positions) {
  const values = [];
  const exact = [];
  let minor = 0;
  for (let i = 0; i < positions; i += 1) {
    if (i < report.daily.length) {
      minor = saturatingAdd(minor, report.daily[i].total.minorUnits);
      const m = makeMoney(minor, report.currencyCode);
      exact.push(m);
      values.push(doubleValue(m));
    } else {
      exact.push(null);
      values.push(null);
    }
  }
  return { values, exact };
}

export function compareSections(app, comparison, state, { today, currencyCode }) {
  const f = app.formatter;
  const money = f.money;
  const code = currencyCode || app.currency;
  const { current, previous } = comparison;
  const sections = [];

  // ---- the headline: how much it changed
  const difference = comparison.totalDifference;
  const headline = difference.minorUnits > 0 ? 'Spending went up' : difference.minorUnits < 0 ? 'Spending went down' : 'No change in spending';
  const percentLine = comparison.percentChange !== null
    ? `${money.signedPercentString(comparison.percentChange)} compared with the earlier period`
    : comparison.percentNote;
  sections.push(h('section', { class: 'hero', 'aria-label': 'Change in spending' },
    h('div', { class: 'hero-head' },
      h('h2', { class: 'hero-period' }, headline),
      h('span', { class: 'hero-range' }, COMPARISON_TITLES[state.preset])),
    moneyBig(f, difference, { plusSign: true }),
    h('p', { class: 'hero-meta' }, percentLine)));

  // ---- the two periods
  const averageNow = current.averagePerDay;
  const averageBefore = previous.averagePerDay;
  const averageRow = averageNow && averageBefore
    ? row({
      title: 'Average per day',
      sub: `${money.string(averageNow)} now, ${money.string(averageBefore)} before`,
      amount: comparison.averageDifference ? money.signedString(comparison.averageDifference) : null,
      amountSub: comparison.averagePercentChange !== null ? money.signedPercentString(comparison.averagePercentChange) : null,
    })
    : null;
  if (averageRow && comparison.averageDifference) averageRow.classList.add(directionClass(comparison.averageDifference));
  sections.push(group([
    row({
      title: 'This period', sub: f.range(current.range) + (current.elapsedDays < current.range.dayCount ? ` (${plural(current.elapsedDays, 'day')} so far)` : ''),
      amount: money.string(current.total), amountSub: plural(current.count, 'transaction'),
    }),
    row({
      title: 'Earlier period', sub: f.range(previous.range) + (comparison.previousWasAligned ? ' (cut to the same number of days)' : ''),
      amount: money.string(previous.total), amountSub: plural(previous.count, 'transaction'),
    }),
    averageRow,
  ], { title: 'The two periods' }));

  if (comparison.periodLengthsDiffer && !comparison.previousWasAligned) {
    sections.push(notice({
      kind: '',
      glyph: 'info',
      title: 'The periods are different lengths',
      body: `${plural(comparison.currentDayCount, 'day')} against ${plural(comparison.previousDayCount, 'day')}. The totals are not like for like, so compare the averages per day instead.`,
    }));
  }
  if (current.excludedOtherCurrencyCount + previous.excludedOtherCurrencyCount > 0) {
    sections.push(notice({
      kind: '',
      glyph: 'info',
      body: `Only ${code} is compared. Expenses in other currencies are left out and never converted.`,
    }));
  }

  // ---- the running totals, drawn together
  const positions = Math.max(current.daily.length, previous.daily.length);
  if (positions >= 2 && (current.count > 0 || previous.count > 0)) {
    const now = runningTotals(current, positions);
    const before = runningTotals(previous, positions);
    const labels = Array.from({ length: positions }, (_, i) => ({ axisLabel: String(i + 1), title: `Day ${i + 1}` }));
    const perDayNow = (i) => (i < current.daily.length ? current.daily[i].total : null);
    const dateNow = (i) => (i < current.daily.length ? f.dayMonthShort(current.daily[i].range.start) : null);
    const dateBefore = (i) => (i < previous.daily.length ? f.dayMonthShort(previous.daily[i].range.start) : null);
    const chart = lineChart({
      series: [{ name: 'This period', values: now.values }, { name: 'Earlier period', values: before.values, dashed: true }],
      labels,
      ariaLabel: 'Running total of spending, this period against the earlier period',
      formatAxis: axisFormatter(app, code),
      initialIndex: Math.min(positions - 1, Math.max(0, current.daily.length - 1)),
      describe: (i) => ({
        title: `Day ${i + 1}${dateNow(i) ? ` · ${dateNow(i)}` : ''}`,
        amountText: now.exact[i] ? money.string(now.exact[i]) : 'Not yet',
        detail: `Earlier period${dateBefore(i) ? ` (${dateBefore(i)})` : ''}: ${before.exact[i] ? money.string(before.exact[i]) : 'no data'}`,
        count: 0,
      }),
      maxLabels: 6,
    });
    const legend = h('div', { class: 'legend-keys', 'aria-hidden': 'true' },
      keyLine('main', 'This period'), keyLine('other dashed', 'Earlier period'));
    const rows = [];
    for (let i = 0; i < positions; i += 1) {
      const todayRow = perDayNow(i);
      rows.push([`Day ${i + 1}`, now.exact[i] ? money.string(now.exact[i]) : '–', before.exact[i] ? money.string(before.exact[i]) : '–', todayRow ? money.string(todayRow) : '–']);
    }
    sections.push(h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Running total'),
      h('div', { class: 'stack' }, legend, chart,
        h('p', { class: 't-foot' }, 'Each line adds up the spending day by day from the start of its period.'),
        tableTwin({
          summary: 'Show these figures as a table',
          headers: ['Day', 'This period', 'Earlier period', 'Spent that day'],
          rows,
          footer: ['Total', money.string(current.total), money.string(previous.total), ''],
        }))));
  }

  // ---- which categories moved
  const range = (side) => (side === 'now' ? current.range : previous.range);
  const categoryRow = (change, side, kind) => {
    const item = row({
      badge: badge({ iconSymbol: change.iconSymbol, colorHex: change.colorHex }),
      title: change.name,
      sub: kind === 'new'
        ? `${money.string(change.current)} now, nothing before`
        : kind === 'gone'
          ? `${money.string(change.previous)} before, nothing now`
          : `${money.string(change.current)} now, ${money.string(change.previous)} before`,
      amount: money.signedString(change.difference),
      amountSub: kind === 'new' ? 'New' : kind === 'gone' ? 'None now' : (change.percentChange !== null ? money.signedPercentString(change.percentChange) : null),
      ariaLabel: `${change.name}: ${money.signedString(change.difference)}${kind === 'new' ? ', new this period' : kind === 'gone' ? ', no spending this period' : ''}. View transactions.`,
      onClick: () => {
        const chosen = range(side);
        openDrilldown(app, {
          title: change.name, subtitle: f.range(chosen), backLabel: 'Reports',
          select: (a) => expensesInCategory(reportGenerator(chosen, code)(a), change.categoryID),
        });
      },
    });
    item.classList.add(directionClass(change.difference));
    return item;
  };
  const list = (title, items, side, kind, footer = null) => {
    if (items.length === 0) return;
    sections.push(group(items.map((c) => categoryRow(c, side, kind)), { title, footer }));
  };
  list('Biggest increases', comparison.biggestIncreases, 'now', 'change');
  list('Biggest decreases', comparison.biggestDecreases, 'now', 'change');
  list('New this period', comparison.newCategories, 'now', 'new', 'Categories with spending now and none in the earlier period.');
  list('No spending this period', comparison.goneCategories, 'before', 'gone', 'Categories with spending in the earlier period and none now.');
  if (comparison.categoryChanges.length === 0 && current.count === 0 && previous.count === 0) {
    sections.push(h('p', { class: 't-foot padded' }, 'There is no spending in either period.'));
  }
  return sections;
}

/** A short line sample for the legend of a two-line chart. */
function keyLine(kind, text) {
  const sample = h('span', { class: ['key-line', ...kind.split(' ')] });
  return h('span', { class: 'legend-key' }, sample, text);
}

