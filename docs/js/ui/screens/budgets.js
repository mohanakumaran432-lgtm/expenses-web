// Budgets: how much of each limit is spent, what is left, and a clearly labelled estimate of where spending is heading.
// Status is always written in words as well as colour ("Within budget", "Close to the limit", "Over budget").

import { fill, h, plural } from '../dom.js';
import { icon } from '../icons.js';
import { badge, button, emptyState, group, iconButton, navButton, notice, page, progress, row, toggleRow } from '../components.js';
import { budgetPeriod, budgetStatus, budgetStatuses } from '../../core/budgets.js';
import { BUDGET_PERIOD_TITLES } from '../../core/models.js';
import { subtract } from '../../core/money.js';
import { totalOf } from '../../core/query.js';
import { editBudget, defaultBudgetName } from './budget_editor.js';
import { openDrilldown } from './drilldown.js';

const LEVELS = Object.freeze({
  ok: { words: 'Within budget', kind: 'good' },
  approaching: { words: 'Close to the limit', kind: 'warn' },
  exceeded: { words: 'Over budget', kind: 'bad' },
});

export function budgetTitle(app, budget) {
  return budget.name !== '' ? budget.name : defaultBudgetName(app, budget.categoryID);
}

function scopeName(app, budget) {
  return budget.categoryID ? (app.snapshot.category(budget.categoryID) || { name: 'Unknown category' }).name : 'All spending';
}

/** "Monthly · October 2026", "Weekly · 19 Oct 2026 – 25 Oct 2026". */
export function budgetPeriodText(app, budget, range) {
  const f = app.formatter;
  const kind = BUDGET_PERIOD_TITLES[budget.periodKind];
  if (!range) return kind;
  return `${kind} · ${budget.periodKind === 'monthly' ? f.monthYear(range.start) : f.range(range)}`;
}

/** The expenses a budget counts in its current period (same rule as the budget measurement itself). */
export function expensesCountedBy(app, budget) {
  const range = budgetPeriod(budget, app.today(), app.settings.firstWeekday);
  if (!range) return [];
  const code = budget.amount.currencyCode;
  return app.snapshot.expenses.filter((e) => range.contains(e.localDay)
    && e.amount.currencyCode === code
    && (!budget.categoryID || e.categoryID === budget.categoryID));
}

// ---------------------------------------------------------------- one budget as a card

/** The estimate lines, or null when there is nothing sensible to say (period over, nothing spent yet, not started). */
function projectionLines(app, status, today) {
  if (!status.projectedTotal || today.raw >= status.range.end.raw) return null;
  const f = app.formatter;
  const money = (m) => f.money.string(m);
  const lines = [`At the current pace you would spend about ${money(status.projectedTotal)} by ${f.dayMonthShort(status.range.end)}.`];
  lines.push(status.projectedOverBy
    ? `That is about ${money(status.projectedOverBy)} more than the budget.`
    : 'That would stay within the budget.');
  lines.push(status.projectionIsEarly
    ? `Early estimate: only ${plural(status.elapsedDays, 'day')} of spending to go on.`
    : 'An estimate from your spending so far, not a promise.');
  return lines;
}

/**
 * @param onClick  makes the whole card a button (the list); leave null on the detail page
 */
export function budgetCard(app, status, { onClick = null } = {}) {
  const f = app.formatter;
  const money = (m) => f.money.string(m);
  const today = app.today();
  const { budget } = status;
  const title = budgetTitle(app, budget);
  const scope = scopeName(app, budget);
  const category = budget.categoryID ? app.snapshot.category(budget.categoryID) : null;
  const level = LEVELS[status.level];
  const over = status.isOver;
  const headline = over ? `${money(subtract(status.spent, status.limit))} over` : `${money(status.remaining)} left`;
  const periodText = budgetPeriodText(app, budget, status.range);
  const subtitle = title === scope ? periodText : `${scope} · ${periodText}`;

  let timeLine;
  if (today.raw < status.range.start.raw) timeLine = `Starts ${f.day(status.range.start)}`;
  else if (today.raw > status.range.end.raw) timeLine = `Ended ${f.day(status.range.end)}`;
  else if (status.daysLeft === 0) timeLine = 'Last day of this period';
  else timeLine = `${plural(status.daysLeft, 'day')} left after today`;

  const perDay = status.remainingPerDay && !over && today.raw <= status.range.end.raw
    ? `About ${money(status.remainingPerDay)} a day keeps you within the budget.`
    : null;
  const projection = projectionLines(app, status, today);
  const inactive = !budget.isActive;

  const words = [
    `${title}, ${periodText}.`,
    `${money(status.spent)} of ${money(status.limit)} spent, ${f.money.percentString(status.percentConsumed)}.`,
    `${headline}.`,
    inactive ? 'Paused.' : `${level.words}.`,
  ].join(' ');

  const body = [
    h('div', { class: 'budget-head' },
      category ? badge(category) : h('span', { class: 'badge', 'aria-hidden': 'true' }, icon('wallet', { size: '1.25rem' })),
      h('div', { class: 'budget-title' },
        h('div', { class: 'budget-name' }, title),
        h('div', { class: 'budget-period' }, subtitle))),
    h('div', { class: 'budget-left' },
      h('span', { class: ['budget-left-amount', 'num', over ? 'over' : ''] }, headline),
      h('span', { class: ['pill', inactive ? '' : level.kind] }, inactive ? 'Paused' : level.words)),
    progress(Math.min(100, status.percentConsumed), { kind: status.level }),
    h('div', { class: 'budget-figures' },
      h('span', { class: 'num' }, `${money(status.spent)} of ${money(status.limit)}`),
      h('span', { class: 'num' }, `${f.money.percentString(status.percentConsumed)} used`)),
    h('div', { class: 'budget-notes' },
      h('span', null, timeLine),
      perDay ? h('span', null, perDay) : null),
    projection
      ? h('div', { class: 'budget-projection' },
        h('div', { class: 'budget-projection-title' }, 'Projection'),
        projection.map((line, index) => h('span', { class: index === projection.length - 1 ? 't-hint' : 'budget-projection-line' }, line)))
      : null,
  ];

  if (onClick) {
    return h('button', { type: 'button', class: ['budget-card', inactive ? 'paused' : ''], 'aria-label': `${words} Open details.`, onClick }, body);
  }
  return h('section', { class: ['budget-card', inactive ? 'paused' : ''], 'aria-label': words }, body);
}

// ---------------------------------------------------------------- the tab

export function openBudgetDetail(app, budgetID) {
  app.shell.push(createBudgetDetail, { budgetID });
}

export async function addBudget(app, prefill = null) {
  return editBudget(app, { prefill });
}

export function createBudgets(app) {
  const screen = page(app, {
    title: 'Budgets',
    large: true,
    trailing: [iconButton('plus', 'Add a budget', () => addBudget(app))],
  });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  function refresh() {
    const f = app.formatter;
    const snapshot = app.snapshot;
    const today = app.today();
    const sections = [];

    for (const alert of app.alerts) {
      sections.push(notice({
        kind: 'warn',
        glyph: 'warning',
        title: alert.title,
        body: alert.body,
        onDismiss: () => app.dismissAlert(alert.id),
      }));
    }

    if (snapshot.budgets.length === 0) {
      sections.push(emptyState({
        mark: '👛',
        title: 'No budgets yet',
        message: 'Set a limit for a month, a week, or one category, and see how much is left as you spend.',
        action: button('Add a budget', { glyph: 'plus', onClick: () => addBudget(app) }),
      }));
      fill(holder, ...sections);
      return;
    }

    const statuses = budgetStatuses(snapshot.budgets, snapshot.expenses, app.directory, today, app.settings.firstWeekday);
    const measuredIDs = new Set(statuses.map((s) => s.budget.id));
    const others = snapshot.budgets.filter((b) => !measuredIDs.has(b.id));

    if (statuses.length > 0) {
      sections.push(h('div', { class: 'stack' }, statuses.map((status) => budgetCard(app, status, { onClick: () => openBudgetDetail(app, status.budget.id) }))));
    }

    if (others.length > 0) {
      sections.push(group(others.map((budget) => {
        const range = budgetPeriod(budget, today, app.settings.firstWeekday);
        const category = budget.categoryID ? snapshot.category(budget.categoryID) : null;
        return row({
          badge: category ? badge(category) : h('span', { class: 'badge', 'aria-hidden': 'true' }, icon('wallet', { size: '1.25rem' })),
          title: budgetTitle(app, budget),
          sub: budget.isActive ? `${budgetPeriodText(app, budget, range)} · cannot be measured` : `${budgetPeriodText(app, budget, range)} · paused`,
          value: f.money.string(budget.amount),
          chevron: true,
          onClick: () => openBudgetDetail(app, budget.id),
        });
      }), { title: 'Paused', footer: 'Paused budgets are not measured and give no alerts. Open one to resume it.' }));
    }

    sections.push(h('p', { class: 't-foot footnote' },
      'Projections are estimates from your spending so far in each period, not promises. Budgets only measure your expenses; they never change them. Amounts in another currency are not counted.'));
    fill(holder, ...sections);
  }

  return { el: screen.el, refresh };
}

// ---------------------------------------------------------------- one budget in detail

export function createBudgetDetail(app, params) {
  const screen = page(app, { title: 'Budget', back: true, backLabel: 'Budgets' });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);
  const editButton = navButton('Edit', async () => {
    const budget = app.snapshot.budgets.find((b) => b.id === params.budgetID);
    if (!budget) return;
    const result = await editBudget(app, { budget });
    if (result === 'deleted') app.shell.pop();
  }, { strong: true });
  screen.setTrailing(editButton);

  function refresh() {
    const f = app.formatter;
    const budget = app.snapshot.budgets.find((b) => b.id === params.budgetID);
    if (!budget) {
      editButton.hidden = true;
      fill(holder, emptyState({ mark: '👛', title: 'This budget is gone', message: 'It was deleted or replaced. Go back to see your budgets.' }));
      return;
    }
    editButton.hidden = false;
    screen.setTitle(budgetTitle(app, budget));
    const today = app.today();
    const status = budgetStatus(budget, app.snapshot.expenses, app.directory, today, app.settings.firstWeekday);
    const sections = [];

    if (!status) {
      sections.push(notice({ kind: 'warn', glyph: 'warning', title: 'This budget cannot be measured', body: 'It has no start and end date. Edit it to choose them.' }));
    } else {
      sections.push(budgetCard(app, status));
    }

    const counted = expensesCountedBy(app, budget);
    const countedTotal = totalOf(counted, budget.amount.currencyCode);
    const levels = budget.alertThresholds.map((t) => `${t}%`).join(', ');
    sections.push(group([
      row({
        title: 'Expenses counted',
        sub: status ? f.range(status.range) : null,
        value: `${counted.length} · ${f.money.string(countedTotal)}`,
        chevron: counted.length > 0,
        onClick: counted.length > 0 ? () => openDrilldown(app, {
          title: budgetTitle(app, budget),
          subtitle: status ? f.range(status.range) : '',
          backLabel: 'Budget',
          select: (a) => {
            const latest = a.snapshot.budgets.find((b) => b.id === params.budgetID);
            return latest ? expensesCountedBy(a, latest) : [];
          },
        }) : null,
      }),
      row({ title: 'Covers', value: scopeName(app, budget) }),
      row({ title: 'Repeats', value: BUDGET_PERIOD_TITLES[budget.periodKind] }),
      row({ title: 'Warning levels', value: levels }),
      row({ title: 'Alerts inside the app', value: budget.notificationsEnabled ? (app.settings.budgetAlertsEnabled ? 'On' : 'On, but off in Settings') : 'Off' }),
    ]));

    sections.push(group([toggleRow({
      title: 'Active',
      sub: 'A paused budget is not measured and gives no alerts.',
      checked: budget.isActive,
      onChange: async (checked, input) => {
        const result = await app.perform('budget-write', () => app.services.budgets.setActive(checked, budget.id), { title: 'Could not change the budget' });
        if (!result.ok) input.checked = !checked;
      },
    })]));

    sections.push(button('Delete budget', {
      variant: 'danger', block: true,
      onClick: async () => {
        const yes = await app.ui.confirm({ title: 'Delete this budget?', message: 'Your expenses are not affected. This cannot be undone.', confirmLabel: 'Delete', destructive: true });
        if (!yes) return;
        const result = await app.perform('budget-write', () => app.services.budgets.delete(budget.id), { title: 'Could not delete the budget' });
        if (!result.ok) return;
        app.ui.toast('Budget deleted');
        app.shell.pop();
      },
    }));
    fill(holder, ...sections);
  }

  return { el: screen.el, refresh };
}
