// A list of expenses grouped by day, each day with its subtotal. Long lists are drawn a screenful at a time, so a ledger with
// thousands of expenses opens instantly and scrolls smoothly.

import { h } from '../dom.js';
import { groupByDay } from '../../core/query.js';
import { expenseRow } from './rows.js';

/**
 * @param expenses  newest-first (or in any order the caller sorted them; days are grouped as they come)
 * @param options   onOpen(expense), selection: null | { has(id), toggle(id) }, pageSize,
 *                  grouped: false gives one plain list (no day headings) whose rows show their own day, for lists sorted by something other than date
 * @returns { el, destroy(), refreshRow(id) }
 */
export function groupedExpenseList(app, expenses, { onOpen, selection = null, pageSize = 60, grouped = true } = {}) {
  const formatter = app.formatter;
  const today = app.today();
  const groups = grouped ? groupByDay(expenses, app.currency) : (expenses.length > 0 ? [{ day: null, expenses, subtotal: null }] : []);
  const el = h('div', { class: 'tx-list' });
  const rows = new Map(); // expense id -> { el, expense }
  const more = h('div', { class: 'tx-more', hidden: true },
    h('button', { type: 'button', class: 'btn small secondary', onClick: () => draw() }, 'Show more'));
  el.append(more);

  let groupIndex = 0;
  let itemIndex = 0;
  let body = null;
  let observer = null;

  function makeRow(expense) {
    const selectable = selection ? selection.has(expense.id) : null;
    const node = expenseRow(app, expense, {
      today,
      selectable,
      showDay: !grouped,
      onClick: () => (selection ? selection.toggle(expense.id) : onOpen(expense)),
    });
    if (selection) node.setAttribute('aria-pressed', selectable ? 'true' : 'false');
    return node;
  }

  function draw() {
    let budget = pageSize;
    while (groupIndex < groups.length && budget > 0) {
      const group = groups[groupIndex];
      if (itemIndex === 0) {
        body = h('div', { class: 'group' });
        el.insertBefore(h('section', { class: 'tx-day' },
          group.day
            ? h('div', { class: 'day-head' },
              h('h3', { class: 'day-name' }, formatter.dayHeader(group.day, today)),
              h('span', { class: 'day-total num' }, formatter.money.string(group.subtotal)))
            : null,
          body), more);
      }
      while (itemIndex < group.expenses.length && budget > 0) {
        const expense = group.expenses[itemIndex];
        const node = makeRow(expense);
        rows.set(expense.id, { el: node, expense });
        body.appendChild(node);
        itemIndex += 1;
        budget -= 1;
      }
      if (itemIndex >= group.expenses.length) {
        groupIndex += 1;
        itemIndex = 0;
      }
    }
    const finished = groupIndex >= groups.length;
    more.hidden = finished;
    if (finished && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  draw();
  if (!more.hidden && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) draw();
    }, { rootMargin: '600px 0px' });
    observer.observe(more);
  }

  return {
    el,
    destroy() {
      if (observer) observer.disconnect();
      observer = null;
    },
    /** Redraws one row (for example after it was ticked or unticked). */
    refreshRow(id) {
      const entry = rows.get(id);
      if (!entry) return;
      const node = makeRow(entry.expense);
      entry.el.replaceWith(node);
      entry.el = node;
    },
    refreshAllRows() {
      for (const id of rows.keys()) this.refreshRow(id);
    },
  };
}
