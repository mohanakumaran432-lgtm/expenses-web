// Transactions: every expense, with search, filters, sorting, and a selection mode for exporting or deleting several at once.
// Long lists are drawn a screenful at a time (see transaction_list.js), so thousands of expenses stay quick.

import { debounced, fill, h, plural } from '../dom.js';
import { icon } from '../icons.js';
import { button, chip, emptyState, iconButton, navButton, page, searchField } from '../components.js';
import { filterActiveCount, filterIsActive, makeFilter, makeSort, runQuery, totalOf } from '../../core/query.js';
import { groupedExpenseList } from './transaction_list.js';
import { openExpenseForm } from './expense_form.js';
import { copyFilter, describeFilter, openFilterSheet, withoutFacet } from './filters.js';
import { exportExpensesCsv } from '../exports.js';

const SORT_CHOICES = Object.freeze([
  { field: 'date', ascending: false, label: 'Date, newest first', short: 'Newest first' },
  { field: 'date', ascending: true, label: 'Date, oldest first', short: 'Oldest first' },
  { field: 'amount', ascending: false, label: 'Amount, highest first', short: 'Highest amount' },
  { field: 'amount', ascending: true, label: 'Amount, lowest first', short: 'Lowest amount' },
  { field: 'category', ascending: true, label: 'Category, A to Z', short: 'Category A–Z' },
  { field: 'category', ascending: false, label: 'Category, Z to A', short: 'Category Z–A' },
  { field: 'merchant', ascending: true, label: 'Merchant, A to Z', short: 'Merchant A–Z' },
  { field: 'merchant', ascending: false, label: 'Merchant, Z to A', short: 'Merchant Z–A' },
]);

const choiceKey = (c) => `${c.field}:${c.ascending ? 'up' : 'down'}`;
const currentChoice = (sort) => SORT_CHOICES.find((c) => c.field === sort.field && c.ascending === sort.ascending) || SORT_CHOICES[0];

// Remembered while the app stays open, so coming back to the list shows the same search and filters.
const state = {
  searchText: '',
  filter: makeFilter(),
  sort: makeSort('date', false),
};

/** Turns on a filter before the list is shown (for example from another screen). */
export function showTransactionsFor(app, filter) {
  state.filter = copyFilter(filter);
  state.searchText = '';
  app.shell.selectTab('transactions');
}

export function createTransactions(app) {
  const screen = page(app, { title: 'Transactions', large: true });
  let selecting = false;
  const selected = new Set();
  let list = null;
  let results = [];

  // ---- controls that stay in place while the results change
  const search = searchField({
    value: state.searchText,
    placeholder: 'Search merchant, notes or amount',
    onInput: (text) => {
      state.searchText = text;
      redrawResults();
    },
  });
  const redrawResults = debounced(() => refresh(), 140);
  const filterButton = h('button', { type: 'button', class: 'tool-btn', onClick: openFilters });
  const sortButton = h('button', { type: 'button', class: 'tool-btn', onClick: chooseSort });
  const selectButton = h('button', { type: 'button', class: 'tool-btn plain', onClick: () => setSelecting(!selecting) });
  const toolbar = h('div', { class: 'toolbar' }, filterButton, sortButton, h('span', { class: 'grow' }), selectButton);
  const chipRow = h('div', { class: 'chip-wrap', hidden: true });
  const summary = h('div', { class: 'tx-summary' });
  const holder = h('div');
  screen.body.append(search, toolbar, chipRow, summary, holder);

  const addButton = iconButton('plus', 'Add an expense', () => openExpenseForm(app));
  const exportAll = iconButton('share', 'Export this list as a CSV file', () => exportExpensesCsv(app, results));
  screen.setTrailing(exportAll, addButton);

  // ---- the bar that appears while expenses are being selected
  const countLabel = h('span', { class: 'selection-count', 'aria-live': 'polite' });
  const exportSelected = button('Export', { variant: 'secondary', glyph: 'share', onClick: () => exportExpensesCsv(app, selectedExpenses()) });
  const deleteSelected = button('Delete', { variant: 'danger', glyph: 'trash', onClick: removeSelected });
  const selectionBar = h('div', { class: 'selection-bar', hidden: true }, countLabel, h('span', { class: 'grow' }), exportSelected, deleteSelected);
  screen.el.append(selectionBar);

  function selectedExpenses() {
    return [...selected].map((id) => app.snapshot.expense(id)).filter(Boolean);
  }

  function setSelecting(on) {
    selecting = on;
    if (!on) selected.clear();
    refresh();
  }

  function updateSelectionUI() {
    selectionBar.hidden = !selecting;
    screen.body.classList.toggle('with-selection', selecting);
    selectButton.textContent = selecting ? 'Done' : 'Select';
    selectButton.setAttribute('aria-label', selecting ? 'Done selecting' : 'Select expenses');
    countLabel.textContent = selected.size === 0 ? 'Tap expenses to select them' : `${selected.size} selected`;
    exportSelected.disabled = selected.size === 0;
    deleteSelected.disabled = selected.size === 0;
    const allSelected = results.length > 0 && selected.size === results.length;
    screen.setLeading(selecting && results.length > 0
      ? navButton(allSelected ? 'Select none' : 'Select all', () => {
        if (allSelected) selected.clear();
        else for (const expense of results) selected.add(expense.id);
        updateSelectionUI();
        if (list) list.refreshAllRows();
      })
      : null);
  }

  async function removeSelected() {
    const expenses = selectedExpenses();
    if (expenses.length === 0) return;
    const f = app.formatter;
    const total = totalOf(expenses, app.currency);
    const others = expenses.filter((e) => e.amount.currencyCode !== app.currency).length;
    const ok = await app.ui.confirm({
      title: `Delete ${plural(expenses.length, 'expense')}?`,
      message: `${f.money.string(total)}${others > 0 ? ` (not counting ${others} in another currency)` : ''} will be removed from your records. This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    const result = await app.perform('bulk-delete', () => app.services.expenses.deleteMany(expenses.map((e) => e.id)), { busy: 'Deleting…', title: 'Could not delete' });
    if (result.ok) {
      app.ui.toast(`Deleted ${plural(result.value, 'expense')}.`);
      setSelecting(false);
    }
  }

  async function openFilters() {
    const next = await openFilterSheet(app, state.filter);
    if (next) {
      state.filter = next;
      refresh();
    }
  }

  async function chooseSort() {
    const choice = currentChoice(state.sort);
    const picked = await app.ui.actions({
      title: 'Sort by',
      options: SORT_CHOICES.map((c) => ({ label: c.label, value: choiceKey(c), checked: c === choice })),
    });
    if (!picked) return;
    const next = SORT_CHOICES.find((c) => choiceKey(c) === picked);
    state.sort = makeSort(next.field, next.ascending);
    refresh();
  }

  function clearFilters() {
    state.filter = makeFilter();
    state.searchText = '';
    search.input.value = '';
    search.querySelector('.clear').hidden = true;
    refresh();
  }

  function refresh() {
    redrawResults.cancel();
    if (list) list.destroy();
    list = null;
    const f = app.formatter;
    const snapshot = app.snapshot;
    const everything = snapshot.expenses;

    // keep the selection to expenses that still exist
    for (const id of [...selected]) if (!snapshot.expense(id)) selected.delete(id);

    const filter = { ...state.filter, searchText: state.searchText };
    results = runQuery(everything, filter, state.sort, app.directory, app.searchIndex);
    const active = filterIsActive(filter);
    const choice = currentChoice(state.sort);

    // ---- toolbar
    const count = filterActiveCount(state.filter);
    fill(filterButton, icon('filter', { size: '1.05rem' }), h('span', null, 'Filters'), count > 0 ? h('span', { class: 'count' }, String(count)) : null);
    filterButton.setAttribute('aria-label', count > 0 ? `Filters, ${count} on` : 'Filters');
    filterButton.classList.toggle('on', count > 0);
    sortButton.replaceChildren(icon('sort', { size: '1.05rem' }), h('span', null, choice.short));
    sortButton.setAttribute('aria-label', `Sort: ${choice.label}`);
    selectButton.hidden = everything.length === 0;
    exportAll.hidden = results.length === 0 || selecting;
    addButton.hidden = selecting;

    // ---- the filters that are on, each removable
    const described = describeFilter(app, state.filter);
    chipRow.hidden = described.length === 0;
    chipRow.replaceChildren(...described.map((item) => chip(item.label, {
      removable: true,
      ariaLabel: `Remove filter: ${item.label}`,
      onClick: () => {
        state.filter = withoutFacet(state.filter, item.facet);
        refresh();
      },
    })));

    // ---- how many, and how much
    if (everything.length === 0) {
      summary.replaceChildren();
      holder.replaceChildren(emptyState({
        mark: '🧾',
        title: 'No expenses yet',
        message: 'Expenses you add will be listed here, newest first.',
        action: button('Add an expense', { glyph: 'plus', onClick: () => openExpenseForm(app) }),
      }));
      updateSelectionUI();
      return;
    }
    const total = totalOf(results, app.currency);
    const others = results.filter((e) => e.amount.currencyCode !== app.currency).length;
    fill(summary,
      h('div', { class: 'tx-summary-main' },
        h('span', { class: 'tx-count' }, active ? `${results.length} of ${everything.length} transactions` : plural(results.length, 'transaction')),
        h('span', { class: 'tx-total num' }, f.money.string(total))),
      active ? h('div', { class: 't-foot' }, 'Total of the expenses shown') : null,
      others > 0 ? h('div', { class: 't-foot' }, `${plural(others, 'expense')} in another currency ${others === 1 ? 'is' : 'are'} listed but not added into the total.`) : null);

    // ---- the list
    if (results.length === 0) {
      holder.replaceChildren(emptyState({
        mark: '🔍',
        title: 'No matching expenses',
        message: active ? 'Try different words, or clear the search and filters.' : 'There is nothing to show.',
        action: active ? button('Clear search and filters', { variant: 'secondary', onClick: clearFilters }) : null,
      }));
      updateSelectionUI();
      return;
    }
    list = groupedExpenseList(app, results, {
      grouped: state.sort.field === 'date',
      onOpen: (expense) => openExpenseForm(app, { expense }),
      selection: selecting ? {
        has: (id) => selected.has(id),
        toggle: (id) => {
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          list.refreshRow(id);
          updateSelectionUI();
        },
      } : null,
    });
    holder.replaceChildren(list.el);
    updateSelectionUI();
  }

  return {
    el: screen.el,
    refresh,
    destroy() {
      redrawResults.cancel();
      if (list) list.destroy();
    },
    onShow() {
      // leaving selection mode behind when coming back to the tab keeps the screen simple
      if (selecting) setSelecting(false);
    },
  };
}
