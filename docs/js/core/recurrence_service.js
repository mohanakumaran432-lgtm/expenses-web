// Creates, edits and processes recurring templates.
//
// A template is only a recipe. It adds nothing to any total until one of its occurrences becomes a real expense,
// either automatically or when the person confirms it. Every occurrence has a key ("templateID#date"); the key is
// stored on the expense and in a log, which is what makes processing idempotent.

import { AppError, newId } from './util.js';
import { LedgerChangeSet } from './snapshot.js';
import { MAX_MINOR_UNITS } from './money.js';
import { block, line, tags as normalizeTags } from './text.js';
import { logEntryKey, makeDraft, makeLogEntry, makeTemplate, occurrenceKey } from './models.js';
import { dueDays, handledOccurrenceKeys, pendingOccurrences } from './recurrence.js';

export const RECURRENCE_MESSAGES = Object.freeze({
  titleRequired: 'Give the recurring expense a name.',
  amountInvalid: 'Enter an amount greater than zero.',
  intervalInvalid: 'The repeat interval must be between 1 and 365.',
  categoryNotFound: 'That category no longer exists.',
  subcategoryNotInCategory: 'That subcategory does not belong to the chosen category.',
  endBeforeStart: 'The end date cannot be before the start date.',
  reminderInvalid: 'The reminder settings are not valid.',
  notFound: 'That recurring expense no longer exists.',
  occurrenceNotPending: 'That occurrence has already been handled.',
});

function fail(code) {
  return new AppError('recurrence', code, RECURRENCE_MESSAGES[code]);
}

/** At most this many "record automatically" occurrences are created per run (for example after months away). */
export const MAX_AUTO_RECORD_PER_RUN = 400;

export class RecurrenceService {
  constructor(store, expenses, clock = () => Date.now()) {
    this.store = store;
    this.expenses = expenses;
    this.clock = clock;
  }

  validated(draft, snapshot) {
    const template = {
      ...draft,
      title: line(draft.title),
      merchant: line(draft.merchant || ''),
      notes: block(draft.notes || ''),
      tags: normalizeTags(draft.tags || []),
    };
    if (template.title === '') throw fail('titleRequired');
    if (!(template.amount.minorUnits > 0) || template.amount.minorUnits > MAX_MINOR_UNITS) throw fail('amountInvalid');
    if (!Number.isInteger(template.interval) || template.interval < 1 || template.interval > 365) throw fail('intervalInvalid');
    if (!snapshot.category(template.categoryID)) throw fail('categoryNotFound');
    if (template.subcategoryID) {
      const sub = snapshot.subcategory(template.subcategoryID);
      if (!sub || sub.categoryID !== template.categoryID) throw fail('subcategoryNotInCategory');
    }
    if (template.endDay && template.endDay.raw < template.startDay.raw) throw fail('endBeforeStart');
    const before = template.reminderDaysBefore ?? 0;
    const hour = template.reminderHour ?? 9;
    const minute = template.reminderMinute ?? 0;
    if (before < 0 || before > 30 || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw fail('reminderInvalid');
    return template;
  }

  /**
   * Saves a new or edited template. Editing changes only occurrences that have not been recorded yet;
   * expenses already created are never touched.
   *
   * pastOccurrences: 'skipThem' (default) marks occurrences before today as skipped so only today and the future count;
   *                  'recordThem' leaves them pending so they are recorded (or offered) like any other due occurrence.
   * Editing an existing schedule never makes dates that have already passed due: any such date that the new rules add
   *                  (an earlier start day, a shorter interval, a later end day) is marked skipped.
   *
   * startDayAlreadyEntered: for a template made from an expense the person is entering by hand. That expense IS the
   *                  occurrence on the start day, so the start day is marked as handled and the schedule carries on
   *                  from the next date. Without it, an automatic template starting today would record the same
   *                  payment a second time.
   */
  async saveTemplate(draft, { pastOccurrences = 'skipThem', startDayAlreadyEntered = false, today }) {
    const snapshot = this.store.snapshot;
    const checked = this.validated(draft, snapshot);
    const now = this.clock();
    const existing = snapshot.templates.find((t) => t.id === checked.id) || null;
    const isNew = existing === null;
    const template = makeTemplate({
      ...checked,
      createdAt: existing ? existing.createdAt : now,
      modifiedAt: now,
    });

    const changes = new LedgerChangeSet();
    changes.templatesToUpsert = [template];

    if (isNew && pastOccurrences === 'skipThem' && template.isActive) {
      const yesterday = today.addingDays(-1);
      if (template.startDay.raw <= yesterday.raw) {
        for (const due of dueDays(template, template.startDay, yesterday)) {
          changes.logEntriesToUpsert.push(this.skippedEntry(template.id, due, now));
        }
      }
    }

    // Editing must never bring back dates that have already passed. A new start day, interval, frequency or end day can
    // make earlier dates due that were not due before; those are marked skipped. Dates that were already waiting under the
    // old rules stay waiting, because they are real.
    if (!isNew && existing.isActive && template.isActive) {
      const yesterday = today.addingDays(-1);
      const handled = handledOccurrenceKeys(snapshot);
      const wasDue = new Set(dueDays(existing, existing.startDay, yesterday).map((due) => due.raw));
      for (const due of dueDays(template, template.startDay, yesterday)) {
        if (wasDue.has(due.raw) || handled.has(occurrenceKey(template.id, due))) continue;
        changes.logEntriesToUpsert.push(this.skippedEntry(template.id, due, now));
      }
    }

    if (isNew && startDayAlreadyEntered) {
      const alreadyMarked = changes.logEntriesToUpsert.some((entry) => entry.dueDay.raw === template.startDay.raw);
      if (!alreadyMarked) changes.logEntriesToUpsert.push(this.skippedEntry(template.id, template.startDay, now));
    }

    await this.store.commit(changes);
    return template;
  }

  skippedEntry(templateID, dueDay, now) {
    return makeLogEntry({ id: newId(), templateID, dueDay, outcome: 'skipped', expenseID: null, decidedAt: now });
  }

  /**
   * Stops (or resumes) future occurrences. Expenses already recorded stay.
   *
   * Resuming does not backfill: occurrences that fell due before today while the template was stopped are marked
   * skipped, so pausing a bill for three months never records three bills the moment it is switched back on.
   */
  async setActive(active, templateID, today) {
    const snapshot = this.store.snapshot;
    const existing = snapshot.templates.find((t) => t.id === templateID);
    if (!existing) throw fail('notFound');
    if (existing.isActive === active) return;
    const now = this.clock();
    const template = makeTemplate({ ...existing, isActive: active, modifiedAt: now });
    const changes = new LedgerChangeSet();
    changes.templatesToUpsert = [template];

    if (active) {
      const handled = handledOccurrenceKeys(snapshot);
      const yesterday = today.addingDays(-1);
      if (template.startDay.raw <= yesterday.raw) {
        for (const due of dueDays(template, template.startDay, yesterday)) {
          if (handled.has(occurrenceKey(template.id, due))) continue;
          changes.logEntriesToUpsert.push(this.skippedEntry(template.id, due, now));
        }
      }
    }
    await this.store.commit(changes);
  }

  /** Removes the template and its decision log. Expenses it already created are kept. */
  async deleteTemplate(id) {
    const snapshot = this.store.snapshot;
    if (!snapshot.templates.some((t) => t.id === id)) throw fail('notFound');
    const changes = new LedgerChangeSet();
    changes.templateIDsToDelete = [id];
    changes.logEntryIDsToDelete = snapshot.recurrenceLog.filter((entry) => entry.templateID === id).map((entry) => entry.id);
    await this.store.commit(changes);
  }

  // Processing ----------------------------------------------------------------------------------

  draftFor(template, dueDay, amount) {
    return makeDraft({
      id: newId(),
      amount: amount || template.amount,
      day: dueDay,
      hasExplicitTime: false,
      hour: 12,
      minute: 0,
      timeZoneID: template.timeZoneID,
      categoryID: template.categoryID,
      subcategoryID: template.subcategoryID,
      paymentMethodID: template.paymentMethodID,
      merchant: template.merchant === '' ? template.title : template.merchant,
      notes: template.notes,
      tags: template.tags,
      recurringTemplateID: template.id,
      occurrenceKey: occurrenceKey(template.id, dueDay),
    });
  }

  /**
   * Call when the app opens or returns to the foreground. Records every due occurrence of "record automatically"
   * templates in ONE all-or-nothing step, and reports the "ask me to confirm" ones that are waiting.
   * Running it again immediately records nothing new.
   */
  async run(today) {
    const snapshot = this.store.snapshot;
    const now = this.clock();
    const result = { recorded: [], awaitingConfirmation: [], failedTemplateIDs: [] };
    const changes = new LedgerChangeSet();
    const knownTags = new Set(snapshot.tags.map((t) => t.name.toLowerCase()));
    let autoCount = 0;

    const templatesByID = new Map(snapshot.templates.map((t) => [t.id, t]));

    for (const occurrence of pendingOccurrences(snapshot, today)) {
      const template = templatesByID.get(occurrence.templateID);
      if (!template) continue;
      if (template.mode === 'askToConfirm') {
        result.awaitingConfirmation.push(occurrence);
        continue;
      }
      if (autoCount >= MAX_AUTO_RECORD_PER_RUN) continue;
      try {
        const prepared = this.expenses.prepare(this.draftFor(template, occurrence.dueDay, null), snapshot, today);
        changes.expensesToUpsert.push(prepared.expense);
        for (const tag of prepared.newTags) {
          const key = tag.name.toLowerCase();
          if (knownTags.has(key)) continue;
          knownTags.add(key);
          changes.tagsToUpsert.push(tag);
        }
        changes.logEntriesToUpsert.push(makeLogEntry({
          id: newId(), templateID: template.id, dueDay: occurrence.dueDay, outcome: 'recorded',
          expenseID: prepared.expense.id, decidedAt: now,
        }));
        result.recorded.push(prepared.expense);
        autoCount += 1;
      } catch {
        if (!result.failedTemplateIDs.includes(template.id)) result.failedTemplateIDs.push(template.id);
      }
    }
    await this.store.commit(changes);
    return result;
  }

  stillPending(snapshot, occurrence, today) {
    return pendingOccurrences(snapshot, today).some((p) => p.key === occurrence.key);
  }

  /** Records one waiting occurrence as a real expense. `amount` lets the person adjust it (a bill that varies). */
  async confirm(occurrence, amount, today) {
    const snapshot = this.store.snapshot;
    const template = snapshot.templates.find((t) => t.id === occurrence.templateID);
    if (!template) throw fail('notFound');
    if (!this.stillPending(snapshot, occurrence, today)) throw fail('occurrenceNotPending');

    const prepared = this.expenses.prepare(this.draftFor(template, occurrence.dueDay, amount), snapshot, today);
    const changes = new LedgerChangeSet();
    changes.expensesToUpsert = [prepared.expense];
    changes.tagsToUpsert = prepared.newTags;
    changes.logEntriesToUpsert = [makeLogEntry({
      id: newId(), templateID: template.id, dueDay: occurrence.dueDay, outcome: 'recorded',
      expenseID: prepared.expense.id, decidedAt: this.clock(),
    })];
    await this.store.commit(changes);
    return prepared.expense;
  }

  /** Declines one waiting occurrence. It will not be offered again. */
  async skip(occurrence, today) {
    const snapshot = this.store.snapshot;
    if (!this.stillPending(snapshot, occurrence, today)) throw fail('occurrenceNotPending');
    const changes = new LedgerChangeSet();
    changes.logEntriesToUpsert = [this.skippedEntry(occurrence.templateID, occurrence.dueDay, this.clock())];
    await this.store.commit(changes);
  }
}

/**
 * Starting values for a new repeating expense that is made from an expense the person is entering or editing
 * ("Make this a repeating expense" in the Add / Edit form). The schedule starts on the expense's own day; that
 * expense is the first occurrence, so the template is saved with `startDayAlreadyEntered`.
 *
 * Choices that are no longer offered (an archived category, subcategory or payment method) are left empty rather
 * than copied, because the schedule editor only lists current ones and an invisible selection would be confusing.
 */
export function recurringPrefill(draft, snapshot) {
  let category = null;
  if (draft.categoryID) {
    const found = snapshot.category(draft.categoryID);
    if (found && !found.isArchived) category = found;
  }

  let subcategoryID = null;
  if (draft.subcategoryID && category) {
    const found = snapshot.subcategory(draft.subcategoryID);
    if (found && found.categoryID === category.id && !found.isArchived) subcategoryID = found.id;
  }

  let paymentMethodID = null;
  if (draft.paymentMethodID) {
    const found = snapshot.paymentMethod(draft.paymentMethodID);
    if (found && !found.isArchived) paymentMethodID = found.id;
  }

  const merchant = line(draft.merchant);
  return {
    title: merchant === '' ? (category ? category.name : '') : merchant,
    amount: draft.amount.minorUnits > 0 ? draft.amount : null,
    currencyCode: draft.amount.currencyCode,
    categoryID: category ? category.id : null,
    subcategoryID,
    paymentMethodID,
    merchant,
    notes: block(draft.notes),
    tags: normalizeTags(draft.tags),
    startDay: draft.day,
  };
}

export { logEntryKey };
