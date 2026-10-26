// Home: how much was spent in the chosen period, the latest expenses, and two small charts. The big green-free number on the
// ink-blue card is the one thing meant to be remembered about this screen; everything else is quiet.

import { h, plural } from '../dom.js';
import { icon } from '../icons.js';
import { badge, button, emptyState, group, moneyBig, notice, page, row, segmented } from '../components.js';
import { heroRuler } from '../charts.js';
import { DASHBOARD_KINDS, PERIOD_SHORT_TITLES, PERIOD_TITLES, PeriodResolver } from '../../core/periods.js';
import { generateReport, quickTotal, expensesInCategory, expensesInDays } from '../../core/reports.js';
import { remindersDue } from '../../core/recurrence.js';
import { backupReminder, snoozeBackupReminder } from '../backup_memory.js';
import { DayRange } from '../../core/dayrange.js';
import { expenseRow, categoryBadge } from './rows.js';
import { categoryBreakdown, trendChart } from './report_parts.js';
import { openExpenseForm } from './expense_form.js';
import { openDrilldown } from './drilldown.js';
import { chooseDateRange } from './pickers.js';

// Remembered while the app stays open, so coming back to Home shows the same period.
const chosen = { kind: null, start: null, end: null };
// Reminders the person closed this session (they come back the next time the app is opened).
const dismissedReminders = new Set();

const QUICK = Object.freeze([
  { kind: 'today', label: 'Today' },
  { kind: 'thisWeek', label: 'This week' },
  { kind: 'thisMonth', label: 'This month' },
  { kind: 'thisYear', label: 'This year' },
]);

function startingKind(app) {
  const preferred = app.settings.defaultReportPeriod;
  return DASHBOARD_KINDS.includes(preferred) && preferred !== 'custom' ? preferred : 'thisMonth';
}

/** One tick per day, week or month of the whole period (including the days still to come). */
function rulerTicks(report, range, today, firstWeekday) {
  const days = range.dayCount;
  if (days <= 1) return [];
  let buckets;
  if (days <= 35) buckets = range.days().map((day) => DayRange.single(day));
  else if (days <= 150) buckets = range.weekBuckets(firstWeekday);
  else buckets = range.monthBuckets();
  const perDay = new Map();
  for (const expense of report.expenses) perDay.set(expense.localDay.raw, (perDay.get(expense.localDay.raw) || 0) + expense.amount.minorUnits);
  return buckets.map((bucket) => {
    let minor = 0;
    for (const day of bucket.days()) minor += perDay.get(day.raw) || 0;
    return { value: minor, future: bucket.start.raw > today.raw, today: bucket.contains(today) };
  });
}

export function createHome(app) {
  const screen = page(app, { title: 'Home', large: true, withFab: true });
  const resolver = () => new PeriodResolver(app.settings.firstWeekday);
  if (chosen.kind === null) chosen.kind = startingKind(app);

  const periodBar = segmented({
    label: 'Period',
    options: DASHBOARD_KINDS.map((kind) => ({ value: kind, label: PERIOD_SHORT_TITLES[kind] })),
    value: chosen.kind,
    onChange: (kind) => select(kind),
  });
  periodBar.classList.add('period-bar');
  const content = h('div', { class: 'home-content' });
  screen.body.append(periodBar, content);

  const fab = h('button', { type: 'button', class: 'fab', onClick: () => openExpenseForm(app) }, icon('plus'), 'Add expense');
  screen.el.append(fab);

  async function select(kind) {
    if (kind === 'custom') {
      const range = await chooseDateRange(app, { title: 'Choose dates', start: chosen.start, end: chosen.end, confirmLabel: 'Show' });
      if (!range) {
        periodBar.set(chosen.kind);
        return;
      }
      chosen.start = range.start;
      chosen.end = range.end;
    }
    chosen.kind = kind;
    periodBar.set(kind);
    refresh();
  }

  function currentRange(today) {
    if (chosen.kind === 'custom') {
      if (chosen.start && chosen.end) return DayRange.between(chosen.start, chosen.end);
      chosen.kind = startingKind(app);
      periodBar.set(chosen.kind);
    }
    return resolver().range(chosen.kind, today);
  }

  function refresh() {
    const f = app.formatter;
    const today = app.today();
    const snapshot = app.snapshot;
    const range = currentRange(today);
    const report = generateReport({
      expenses: snapshot.expenses, directory: app.directory, currencyCode: app.currency, range, today, firstWeekday: app.settings.firstWeekday,
    });
    const subtitle = f.range(range);
    const sections = [];

    // ---- messages first: things waiting for a decision
    const waiting = app.waitingOccurrences();
    if (waiting.length > 0) {
      sections.push(notice({
        kind: 'warn',
        glyph: 'repeat',
        title: waiting.length === 1 ? 'A repeating expense is waiting' : `${waiting.length} repeating expenses are waiting`,
        body: 'Confirm or skip them to keep your totals right.',
        actions: [h('button', { type: 'button', class: 'link', onClick: async () => (await import('./recurring.js')).reviewWaiting(app) }, 'Review')],
      }));
    }
    if (app.settings.recurringRemindersEnabled) {
      for (const reminder of remindersDue(snapshot, today)) {
        if (dismissedReminders.has(reminder.key)) continue;
        const when = reminder.daysAway === 1 ? 'tomorrow' : `in ${reminder.daysAway} days`;
        sections.push(notice({
          kind: '',
          glyph: 'calendar',
          title: `${reminder.template.title} is due ${when}`,
          body: `${f.money.string(reminder.template.amount)} on ${f.day(reminder.dueDay)}. ${reminder.template.mode === 'autoRecord' ? 'It is added when you open the app that day.' : 'You will be asked to confirm it.'}`,
          actions: [h('button', { type: 'button', class: 'link', onClick: async () => {
            const { createRecurringDetail } = await import('./recurring.js');
            app.shell.selectTab('settings');
            app.shell.push(createRecurringDetail, { id: reminder.template.id });
          } }, 'View')],
          onDismiss: () => { dismissedReminders.add(reminder.key); refresh(); },
        }));
      }
    }
    for (const alert of app.alerts) {
      sections.push(notice({
        kind: 'warn',
        glyph: 'warning',
        title: alert.title,
        body: alert.body,
        actions: [h('button', { type: 'button', class: 'link', onClick: () => { app.dismissAlert(alert.id); app.shell.selectTab('budgets'); } }, 'Open Budgets')],
        onDismiss: () => app.dismissAlert(alert.id),
      }));
    }

    const backup = backupReminder(app);
    if (backup) {
      sections.push(notice({
        kind: 'warn',
        glyph: 'shield',
        title: backup.never ? 'Make your first backup' : 'Time for a new backup',
        body: backup.never
          ? 'Your expenses exist only on this iPhone. A backup file is the way back if this app\'s data is ever cleared.'
          : `Your last backup was ${backup.days} days ago, and you have added or changed expenses since.`,
        actions: [h('button', { type: 'button', class: 'link', onClick: async () => {
          const { openBackupRestore } = await import('./settings_backup.js');
          app.shell.selectTab('settings');
          openBackupRestore(app);
        } }, 'Back up')],
        onDismiss: () => { snoozeBackupReminder(app.now(), 7); refresh(); },
      }));
    }

    // ---- the hero card
    const showAverage = report.averagePerDay && report.elapsedDays > 1;
    const ticks = rulerTicks(report, range, today, app.settings.firstWeekday);
    const hero = h('section', { class: 'hero', 'aria-label': `${PERIOD_TITLES[chosen.kind]} spending` },
      h('div', { class: 'hero-head' },
        h('h2', { class: 'hero-period' }, PERIOD_TITLES[chosen.kind]),
        chosen.kind === 'custom'
          ? h('button', { type: 'button', class: 'hero-edit', onClick: () => select('custom') }, subtitle, icon('edit', { size: '0.95rem' }))
          : h('span', { class: 'hero-range' }, subtitle)),
      moneyBig(f, report.total),
      h('p', { class: 'hero-meta' },
        report.count === 0 ? 'No expenses in this period yet.' : [plural(report.count, 'transaction'), showAverage ? `${f.money.string(report.averagePerDay)} a day` : null].filter(Boolean).join(' · ')),
      ticks.length > 0 ? h('div', { class: 'hero-ruler' }, heroRuler(ticks),
        h('div', { class: 'hero-axis', 'aria-hidden': 'true' }, h('span', null, f.dayMonthShort(range.start)), h('span', null, f.dayMonthShort(range.end)))) : null,
      report.excludedOtherCurrencyCount > 0
        ? h('p', { class: 'hero-foot' }, `${plural(report.excludedOtherCurrencyCount, 'expense')} in another currency ${report.excludedOtherCurrencyCount === 1 ? 'is' : 'are'} not included. Amounts are never converted.`)
        : null);
    sections.push(hero);

    // ---- quick totals
    const tiles = QUICK.map((quick) => {
      const quickRange = resolver().range(quick.kind, today);
      const result = quickTotal(snapshot.expenses, app.currency, quickRange);
      return h('button', {
        type: 'button', class: 'tile-total', 'aria-pressed': chosen.kind === quick.kind ? 'true' : 'false',
        'aria-label': `${quick.label}: ${f.money.string(result.total)}, ${plural(result.count, 'transaction')}. Show this period.`,
        onClick: () => select(quick.kind),
      },
      h('span', { class: 'tile-label' }, quick.label),
      h('span', { class: 'tile-amount num' }, f.money.string(result.total)),
      h('span', { class: 'tile-sub' }, plural(result.count, 'transaction')));
    });
    sections.push(h('div', { class: 'tile-totals' }, tiles));

    if (snapshot.expenses.length === 0) {
      sections.push(emptyState({
        mark: '🧾',
        title: 'No expenses yet',
        message: 'Add your first expense. It takes a few seconds: type the amount, tap a category, save.',
        action: button('Add expense', { glyph: 'plus', onClick: () => openExpenseForm(app) }),
      }));
      content.replaceChildren(...sections);
      return;
    }

    // ---- highlights of the period
    if (report.count > 0) {
      const top = report.highestCategory;
      const biggest = report.highest;
      const rows = [
        row({
          badge: badge({ iconSymbol: top.iconSymbol, colorHex: top.colorHex }), title: 'Top category', sub: top.name,
          amount: f.money.string(top.total), amountSub: f.money.percentString(top.percent),
          onClick: () => openDrilldown(app, { title: top.name, subtitle: subtitle, backLabel: 'Home', select: (a) => expensesInCategory(generate(a), top.categoryID) }),
        }),
        row({
          badge: categoryBadge(app, biggest.categoryID), title: 'Biggest expense', sub: app.directory.categoryName(biggest) + (biggest.merchant ? ` · ${biggest.merchant}` : ''),
          amount: f.money.string(biggest.amount), amountSub: f.day(biggest.localDay),
          onClick: () => openExpenseForm(app, { expense: biggest }),
        }),
      ];
      sections.push(group(rows, { title: 'Highlights' }));
    }

    // ---- latest expenses
    const recent = snapshot.expenses.slice(0, 5);
    sections.push(group(recent.map((expense) => expenseRow(app, expense, { showDay: true, today, onClick: () => openExpenseForm(app, { expense }) })), {
      title: 'Recent',
      titleAction: h('button', { type: 'button', class: 'section-link', onClick: () => app.shell.selectTab('transactions') }, 'See all'),
    }));

    // ---- charts for the period
    if (report.count > 0) {
      sections.push(h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'By category'),
        categoryBreakdown(app, report, {
          open: (slice) => openDrilldown(app, {
            title: slice.categoryIDs.length === 1 ? slice.name : 'Other categories', subtitle, backLabel: 'Home',
            select: (a) => generate(a).expenses.filter((e) => slice.categoryIDs.includes(e.categoryID)),
          }),
        })));
      sections.push(h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Over time'),
        trendChart(app, report, {
          onOpen: (point) => openDrilldown(app, { title: point.title, subtitle: '', backLabel: 'Home', select: (a) => expensesInDays(generate(a), point.range) }),
        })));
    }

    content.replaceChildren(...sections);

    /** The same report for the period that was on screen, regenerated when a drill-down page refreshes after a change. */
    function generate(a) {
      return generateReport({
        expenses: a.snapshot.expenses, directory: a.directory, currencyCode: a.currency, range, today: a.today(), firstWeekday: a.settings.firstWeekday,
      });
    }
  }

  return { el: screen.el, refresh };
}
