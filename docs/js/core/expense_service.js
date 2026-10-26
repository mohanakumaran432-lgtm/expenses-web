// Adds, edits and deletes expenses. All rules about what a valid expense is live here (and in validation.js).

import { AppError, newId } from './util.js';
import { CalendarContext, currentTimeZone } from './calendar.js';
import { LedgerChangeSet } from './snapshot.js';
import { block, line, tags as normalizeTags } from './text.js';
import { EXPENSE_PROBLEM_MESSAGES, validateDraft } from './validation.js';
import { draftFromExpense, makeExpense, makeLogEntry, makeTag } from './models.js';

/** Starts an edit from a saved expense (the form shows the time as it was on the clock where the money was spent). */
export function editDraft(expense) {
  const clock = new CalendarContext(expense.timeZoneID).hourAndMinute(expense.occurredAt);
  return draftFromExpense(expense, clock);
}

export function expenseProblemMessage(code) {
  return EXPENSE_PROBLEM_MESSAGES[code] || 'Something is not right with this expense.';
}

/** Builds the "invalid expense" error with a readable message made of every problem found. */
function invalidError(problems) {
  return new AppError('expense', 'invalid', problems.map(expenseProblemMessage).join(' '), { problems });
}

export class ExpenseService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
  }

  /** Cleans the text fields of a draft (trim, collapse spaces, normalize tags). */
  normalized(draft) {
    return { ...draft, merchant: line(draft.merchant), notes: block(draft.notes), tags: normalizeTags(draft.tags) };
  }

  todayInZone(timeZone = currentTimeZone()) {
    return new CalendarContext(timeZone).today(this.clock());
  }

  /** Validates without saving, so the form can show messages and enable or disable the Save button. */
  problems(draft, today = this.todayInZone()) {
    return validateDraft(this.normalized(draft), this.store.snapshot, today);
  }

  /**
   * Saves a new or edited expense. Saving a draft whose id already exists updates that expense instead of adding a
   * second one, so tapping Save twice can never create a duplicate.
   */
  async save(rawDraft, today = this.todayInZone()) {
    const prepared = this.prepare(rawDraft, this.store.snapshot, today);
    const changes = new LedgerChangeSet();
    changes.expensesToUpsert = [prepared.expense];
    changes.tagsToUpsert = prepared.newTags;
    await this.store.commit(changes);
    return prepared.expense;
  }

  /**
   * Validates a draft and builds the expense record WITHOUT storing it, so several can be committed together
   * (the recurrence service records many occurrences in one all-or-nothing step).
   */
  prepare(rawDraft, snapshot, today = this.todayInZone()) {
    const draft = this.normalized(rawDraft);
    const now = this.clock();

    const problems = validateDraft(draft, snapshot, today);
    if (problems.length > 0) throw invalidError(problems);

    const category = draft.categoryID ? snapshot.category(draft.categoryID) : null;
    if (!category) throw invalidError(['categoryRequired']);

    if (draft.occurrenceKey) {
      const clash = snapshot.expenses.some((e) => e.occurrenceKey === draft.occurrenceKey && e.id !== draft.id);
      if (clash) throw new AppError('expense', 'duplicateOccurrence', 'That recurring occurrence has already been recorded.');
    }

    const context = new CalendarContext(draft.timeZoneID);
    const occurredAt = context.instantFor(draft.day, draft.hasExplicitTime, draft.hour, draft.minute);

    const subcategory = draft.subcategoryID ? snapshot.subcategory(draft.subcategoryID) : null;
    const method = draft.paymentMethodID ? snapshot.paymentMethod(draft.paymentMethodID) : null;
    const existing = snapshot.expense(draft.id);

    const expense = makeExpense({
      id: draft.id,
      amount: draft.amount,
      occurredAt,
      timeZoneID: draft.timeZoneID,
      hasExplicitTime: draft.hasExplicitTime,
      localDay: draft.day,
      categoryID: category.id,
      subcategoryID: draft.subcategoryID,
      paymentMethodID: draft.paymentMethodID,
      categoryNameSnapshot: category.name,
      subcategoryNameSnapshot: subcategory ? subcategory.name : null,
      paymentMethodNameSnapshot: method ? method.name : null,
      merchant: draft.merchant,
      notes: draft.notes,
      tags: draft.tags,
      recurringTemplateID: draft.recurringTemplateID,
      occurrenceKey: draft.occurrenceKey,
      createdAt: existing ? existing.createdAt : now,
      modifiedAt: now,
    });

    return { expense, newTags: newTagRecords(draft.tags, snapshot, now) };
  }

  /** Permanently deletes one expense. The screen asks for confirmation before calling this. */
  async delete(id) {
    const removed = await this.deleteMany([id]);
    if (removed === 0) throw new AppError('expense', 'notFound', 'That expense no longer exists.');
  }

  /** Permanently deletes several expenses in one all-or-nothing step. Returns how many existed. */
  async deleteMany(ids) {
    const snapshot = this.store.snapshot;
    const wanted = new Set(ids);
    const existing = snapshot.expenses.filter((e) => wanted.has(e.id));
    if (existing.length === 0) return 0;

    const changes = new LedgerChangeSet();
    changes.expenseIDsToDelete = existing.map((e) => e.id);

    // If a recurring occurrence is deleted on purpose, remember it as skipped so it is not created again.
    const deleted = new Set(existing.map((e) => e.id));
    const now = this.clock();
    for (const entry of snapshot.recurrenceLog) {
      if (entry.expenseID && deleted.has(entry.expenseID)) {
        changes.logEntriesToUpsert.push(makeLogEntry({ ...entry, outcome: 'skipped', expenseID: null, decidedAt: now }));
      }
    }
    await this.store.commit(changes);
    return existing.length;
  }

  /** Categories ordered by how recently they were used, for the quick-pick row on the Add screen. */
  recentCategoryIDs(limit = 6) {
    const snapshot = this.store.snapshot;
    // Ordered by when expenses were ADDED (not edited), so a category merge cannot disturb "recent".
    const latest = new Map();
    for (const expense of snapshot.expenses) {
      const seen = latest.get(expense.categoryID);
      if (seen !== undefined && seen >= expense.createdAt) continue;
      latest.set(expense.categoryID, expense.createdAt);
    }
    const active = new Set(snapshot.activeCategories.map((c) => c.id));
    return Array.from(latest.entries())
      .filter(([id]) => active.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
  }

  /** The payment method of the most recently saved expense, used to pre-select the picker. */
  recentPaymentMethodID() {
    const snapshot = this.store.snapshot;
    const active = new Set(snapshot.activePaymentMethods.map((p) => p.id));
    let best = null;
    for (const expense of snapshot.expenses) {
      if (!expense.paymentMethodID || !active.has(expense.paymentMethodID)) continue;
      if (best === null || expense.createdAt > best.createdAt) best = { id: expense.paymentMethodID, createdAt: expense.createdAt };
    }
    return best ? best.id : null;
  }
}

function newTagRecords(tagNames, snapshot, now) {
  const known = new Set(snapshot.tags.map((t) => t.name.toLowerCase()));
  const created = [];
  for (const name of tagNames) {
    const key = name.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    created.push(makeTag({ id: newId(), name, createdAt: now }));
  }
  return created;
}
