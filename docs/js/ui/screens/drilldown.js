// "What is behind this number?": a page listing the expenses a chart segment, a bar or a table row was made from.

import { fill, h } from '../dom.js';
import { emptyState, iconButton, page } from '../components.js';
import { totalOf } from '../../core/query.js';
import { compareNewestFirst } from '../../core/snapshot.js';
import { groupedExpenseList } from './transaction_list.js';
import { openExpenseForm } from './expense_form.js';
import { exportExpensesCsv } from '../exports.js';

/**
 * Opens the page on the current tab.
 * @param params.title     the page title (for example a category name)
 * @param params.subtitle  small text under the total (for example the period)
 * @param params.select    (app) => the expenses to list; called again whenever the data changes
 */
export function openDrilldown(app, params) {
  app.shell.push(createDrilldown, params);
}

export function createDrilldown(app, params) {
  const screen = page(app, { title: params.title, back: true, backLabel: params.backLabel || 'Back' });
  const summary = h('div', { class: 'drill-summary' });
  const holder = h('div');
  let list = null;
  let current = [];

  const exportButton = iconButton('share', 'Export these as a CSV file', () => exportExpensesCsv(app, current));
  screen.setTrailing(exportButton);
  screen.body.append(summary, holder);

  function refresh() {
    if (list) list.destroy();
    current = params.select(app).slice().sort(compareNewestFirst);
    const f = app.formatter;
    exportButton.hidden = current.length === 0;
    if (current.length === 0) {
      summary.replaceChildren();
      holder.replaceChildren(emptyState({ mark: '🧾', title: 'Nothing here', message: 'There are no expenses to show.' }));
      list = null;
      return;
    }
    const total = totalOf(current, app.currency);
    const others = current.filter((e) => e.amount.currencyCode !== app.currency).length;
    fill(summary,
      h('div', { class: 'drill-total num' }, f.money.string(total)),
      h('div', { class: 't-sub' }, [`${current.length} ${current.length === 1 ? 'transaction' : 'transactions'}`, params.subtitle].filter(Boolean).join(' · ')),
      others > 0 ? h('p', { class: 't-foot' }, `${others} in another currency ${others === 1 ? 'is' : 'are'} listed but not added into the total.`) : null);
    list = groupedExpenseList(app, current, { onOpen: (expense) => openExpenseForm(app, { expense }) });
    holder.replaceChildren(list.el);
  }

  return { el: screen.el, refresh, destroy() { if (list) list.destroy(); } };
}
