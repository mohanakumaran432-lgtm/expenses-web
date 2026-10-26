// Deleting one kind of data at a time (the "Delete data" screen in Settings). Every action is all-or-nothing, and none of
// them touches categories, payment methods, tags or settings. Wiping everything is a separate, more heavily confirmed
// action (LedgerStore.eraseEverything).

import { LedgerChangeSet } from './snapshot.js';

export class DataService {
  constructor(store, expenses) {
    this.store = store;
    this.expenses = expenses;
  }

  /** The expenses dated inside a DayRange (both ends included). */
  expensesInRange(range) {
    return this.store.snapshot.expenses.filter((expense) => range.contains(expense.localDay));
  }

  /** Deletes the expenses dated inside the range. Returns how many were deleted. */
  async deleteExpensesInRange(range) {
    return this.expenses.deleteMany(this.expensesInRange(range).map((expense) => expense.id));
  }

  /** Deletes every expense. Budgets, repeating expenses, categories and settings stay. Returns how many were deleted. */
  async deleteAllExpenses() {
    return this.expenses.deleteMany(this.store.snapshot.expenses.map((expense) => expense.id));
  }

  /** Deletes every budget. Expenses are not affected. Returns how many were deleted. */
  async deleteAllBudgets() {
    const ids = this.store.snapshot.budgets.map((budget) => budget.id);
    if (ids.length === 0) return 0;
    const changes = new LedgerChangeSet();
    changes.budgetIDsToDelete = ids;
    await this.store.commit(changes);
    return ids.length;
  }

  /**
   * Deletes every repeating-expense schedule and its history log. Expenses already recorded from them stay.
   * Returns how many schedules were deleted.
   */
  async deleteAllRepeating() {
    const snapshot = this.store.snapshot;
    const ids = snapshot.templates.map((template) => template.id);
    if (ids.length === 0 && snapshot.recurrenceLog.length === 0) return 0;
    const changes = new LedgerChangeSet();
    changes.templateIDsToDelete = ids;
    changes.logEntryIDsToDelete = snapshot.recurrenceLog.map((entry) => entry.id);
    await this.store.commit(changes);
    return ids.length;
  }
}
