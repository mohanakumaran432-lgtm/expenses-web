// Create, change and remove budgets. Budgets never change or delete expenses.

import { AppError } from './util.js';
import { LedgerChangeSet } from './snapshot.js';
import { MAX_MINOR_UNITS } from './money.js';
import { line } from './text.js';
import { makeBudget } from './models.js';

export const BUDGET_MESSAGES = Object.freeze({
  amountNotPositive: 'Enter a budget greater than zero.',
  amountTooLarge: 'That budget is too large.',
  invalidCustomRange: 'Choose a start date and an end date that is not before it.',
  categoryNotFound: 'That category no longer exists.',
  notFound: 'That budget no longer exists.',
  duplicate: 'You already have an active budget for this category and period.',
});

function fail(code) {
  return new AppError('budget', code, BUDGET_MESSAGES[code]);
}

function sameDay(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.raw === b.raw;
}

/** Thresholds as whole percentages from 1 to 1000, no duplicates, ascending. Falls back to 80 and 100. */
export function sanitizedThresholds(raw) {
  const cleaned = Array.from(new Set(raw.filter((t) => Number.isInteger(t) && t >= 1 && t <= 1000))).sort((a, b) => a - b);
  return cleaned.length === 0 ? [80, 100] : cleaned;
}

export class BudgetService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
  }

  /** Saves a new budget or an edited one (matched by id). */
  async save(draft) {
    const snapshot = this.store.snapshot;
    const name = line(draft.name);
    const alertThresholds = sanitizedThresholds(draft.alertThresholds || []);

    if (!(draft.amount.minorUnits > 0)) throw fail('amountNotPositive');
    if (draft.amount.minorUnits > MAX_MINOR_UNITS) throw fail('amountTooLarge');
    if (draft.categoryID && !snapshot.category(draft.categoryID)) throw fail('categoryNotFound');

    let customStart = draft.customStart || null;
    let customEnd = draft.customEnd || null;
    if (draft.periodKind === 'custom') {
      if (!customStart || !customEnd || customStart.raw > customEnd.raw) throw fail('invalidCustomRange');
    } else {
      customStart = null;
      customEnd = null;
    }

    const categoryID = draft.categoryID || null;
    const isActive = draft.isActive === undefined ? true : Boolean(draft.isActive);
    if (isActive) {
      const clash = snapshot.budgets.some((other) => other.id !== draft.id
        && other.isActive
        && (other.categoryID || null) === categoryID
        && other.periodKind === draft.periodKind
        && sameDay(other.customStart, customStart)
        && sameDay(other.customEnd, customEnd));
      if (clash) throw fail('duplicate');
    }

    const now = this.clock();
    const existing = snapshot.budgets.find((b) => b.id === draft.id);
    const budget = makeBudget({
      ...draft,
      name,
      categoryID,
      customStart,
      customEnd,
      alertThresholds,
      isActive,
      createdAt: existing ? existing.createdAt : now,
      modifiedAt: now,
    });

    const changes = new LedgerChangeSet();
    changes.budgetsToUpsert = [budget];
    await this.store.commit(changes);
    return budget;
  }

  async setActive(active, id) {
    const existing = this.store.snapshot.budgets.find((b) => b.id === id);
    if (!existing) throw fail('notFound');
    return this.save({ ...existing, isActive: active });
  }

  async delete(id) {
    if (!this.store.snapshot.budgets.some((b) => b.id === id)) throw fail('notFound');
    const changes = new LedgerChangeSet();
    changes.budgetIDsToDelete = [id];
    await this.store.commit(changes);
  }
}
