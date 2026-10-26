// Deleting data: one kind at a time, or everything. Each action says exactly what it removes and what it leaves, and
// nothing here touches backup files already saved elsewhere.

import { fill, h, plural } from '../dom.js';
import { group, notice, page, row } from '../components.js';
import { DayRange } from '../../core/dayrange.js';
import { chooseDateRange } from './pickers.js';
import { eraseWithConfirmation } from './erase.js';
import { reconfirmPasscode } from './reauth.js';

export function openDeleteData(app) {
  app.shell.push(createDeleteData);
}

/** Asks for the word DELETE. Resolves true only when it was typed. */
async function typedDelete(app, { title, message }) {
  const typed = await app.ui.prompt({ title, message, placeholder: 'DELETE', confirmLabel: 'Delete', label: 'Type DELETE' });
  if (typed === null) return false;
  if (typed.trim().toUpperCase() !== 'DELETE') {
    await app.ui.alert({ title: 'Nothing was deleted', message: 'The word DELETE was not typed, so everything is still here.' });
    return false;
  }
  return true;
}

export function createDeleteData(app) {
  const screen = page(app, { title: 'Delete data', back: true, backLabel: 'Settings' });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  async function deleteRange() {
    const picked = await chooseDateRange(app, { title: 'Delete expenses from', confirmLabel: 'Review' });
    if (!picked) return;
    const range = DayRange.between(picked.start, picked.end);
    const count = app.services.data.expensesInRange(range).length;
    const f = app.formatter;
    if (count === 0) {
      await app.ui.alert({ title: 'Nothing to delete', message: `There are no expenses from ${f.range(range)}.` });
      return;
    }
    const yes = await app.ui.confirm({
      title: `Delete ${plural(count, 'expense')}?`,
      message: `Every expense from ${f.range(range)} will be deleted. Budgets, categories and settings stay. This cannot be undone, except from a backup file.`,
      confirmLabel: `Delete ${plural(count, 'expense')}`,
      destructive: true,
    });
    if (!yes) return;
    const result = await app.perform('delete-data', () => app.services.data.deleteExpensesInRange(range), { busy: count > 200 ? 'Deleting…' : null, title: 'Could not delete' });
    if (result.ok) app.ui.toast(`${plural(result.value, 'expense')} deleted`);
  }

  async function deleteAllExpenses() {
    const count = app.snapshot.expenses.length;
    if (count === 0) return;
    const yes = await app.ui.confirm({
      title: `Delete all ${plural(count, 'expense')}?`,
      message: 'Every expense is removed. Budgets, repeating expenses, categories, payment methods, tags and settings stay. This cannot be undone, except from a backup file.',
      confirmLabel: 'Continue',
      destructive: true,
    });
    if (!yes) return;
    if (!(await typedDelete(app, { title: 'Type DELETE to confirm', message: `This deletes ${plural(count, 'expense')}.` }))) return;
    const result = await app.perform('delete-data', () => app.services.data.deleteAllExpenses(), { busy: 'Deleting…', title: 'Could not delete' });
    if (result.ok) app.ui.toast(`${plural(result.value, 'expense')} deleted`);
  }

  async function deleteBudgets() {
    const count = app.snapshot.budgets.length;
    if (count === 0) return;
    const yes = await app.ui.confirm({
      title: `Delete ${plural(count, 'budget')}?`,
      message: 'Your expenses are not touched. This cannot be undone, except from a backup file.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!yes) return;
    const result = await app.perform('delete-data', () => app.services.data.deleteAllBudgets(), { title: 'Could not delete' });
    if (result.ok) app.ui.toast(`${plural(result.value, 'budget')} deleted`);
  }

  async function deleteRepeating() {
    const count = app.snapshot.templates.length;
    if (count === 0) return;
    const yes = await app.ui.confirm({
      title: `Delete ${plural(count, 'repeating expense')}?`,
      message: 'No more expenses will be added from them. Expenses they already recorded stay. This cannot be undone, except from a backup file.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!yes) return;
    const result = await app.perform('delete-data', () => app.services.data.deleteAllRepeating(), { title: 'Could not delete' });
    if (result.ok) app.ui.toast(`${plural(result.value, 'repeating expense')} deleted`);
  }

  async function eraseEverything() {
    if (!(await reconfirmPasscode(app, { title: 'Enter your passcode', message: 'Erasing removes everything in this app.' }))) return;
    await eraseWithConfirmation(app, {});
  }

  function refresh() {
    const snapshot = app.snapshot;
    const expenses = snapshot.expenses.length;
    fill(holder,
      notice({
        kind: '', glyph: 'info', title: 'Backup files are not touched',
        body: 'Deleting here removes data from this app only. Backup files you saved earlier still hold their copy; delete those files yourself if you want them gone.',
      }),
      group([
        row({ title: 'Expenses in a date range', sub: expenses === 0 ? 'No expenses yet' : 'Choose the first and last day', chevron: true, disabled: expenses === 0, onClick: deleteRange }),
        row({ title: 'All expenses', value: String(expenses), chevron: true, disabled: expenses === 0, destructive: true, onClick: deleteAllExpenses }),
      ], { title: 'Expenses', footer: 'Categories, payment methods, tags, budgets and settings are kept.' }),
      group([
        row({ title: 'All budgets', value: String(snapshot.budgets.length), chevron: true, disabled: snapshot.budgets.length === 0, onClick: deleteBudgets }),
        row({ title: 'All repeating expenses', value: String(snapshot.templates.length), chevron: true, disabled: snapshot.templates.length === 0, onClick: deleteRepeating }),
      ], { title: 'Other things' }),
      group([
        row({ title: 'Erase everything', sub: 'Removes all data, settings and the passcode, and starts the app fresh', destructive: true, chevron: true, onClick: eraseEverything }),
      ], {
        title: 'Everything',
        footer: 'Everything stored by this app in this browser is deleted, the way a browser deletes website data. Traces can remain in the phone\'s storage until it is overwritten, as with any deleted file.',
      }));
  }

  return { el: screen.el, refresh };
}
