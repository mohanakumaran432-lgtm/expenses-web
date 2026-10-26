// Date arithmetic for repeating expenses (no storing, no side effects).
//
// Every occurrence is computed from the template's start date and its index (start + n * interval), never from the
// previous occurrence. That is why a monthly bill that starts on January 31 lands on Feb 28, Mar 31, Apr 30 ...
// instead of drifting to the 28th forever.

import { compareText } from './util.js';
import { logEntryKey, occurrenceKey } from './models.js';

/** Safety limit on how many occurrences one scan may produce. */
export const MAX_OCCURRENCES_PER_SCAN = 5_000;

/** A due date of one template that has not been recorded or skipped yet. */
export function pendingOccurrence(templateID, dueDay) {
  return Object.freeze({ templateID, dueDay, key: occurrenceKey(templateID, dueDay) });
}

/** The day of occurrence number `index` (0 is the start day). */
export function dayOfOccurrence(index, template) {
  const step = Math.max(1, template.interval);
  switch (template.frequency) {
    case 'daily': return template.startDay.addingDays(index * step);
    case 'weekly': return template.startDay.addingDays(index * step * 7);
    case 'monthly': return template.startDay.addingMonths(index * step);
    case 'yearly': return template.startDay.addingYears(index * step);
    default: return template.startDay;
  }
}

/** A safe lower bound for the first occurrence index that can be on or after `day` (never too high). */
function lowerBoundIndex(template, day) {
  const step = Math.max(1, template.interval);
  const start = template.startDay;
  if (day.raw <= start.raw) return 0;
  switch (template.frequency) {
    case 'daily':
      return Math.max(0, Math.trunc(start.daysUntil(day) / step) - 1);
    case 'weekly':
      return Math.max(0, Math.trunc(start.daysUntil(day) / (7 * step)) - 1);
    case 'monthly': {
      const months = (day.year - start.year) * 12 + (day.month - start.month);
      return Math.max(0, Math.trunc(months / step) - 1);
    }
    case 'yearly':
      return Math.max(0, Math.trunc((day.year - start.year) / step) - 1);
    default:
      return 0;
  }
}

/** Due days between `from` and `through` (both included), honoring the template's start and end day. */
export function dueDays(template, from, through) {
  const result = [];
  let index = lowerBoundIndex(template, from);
  let scanned = 0;
  while (scanned < MAX_OCCURRENCES_PER_SCAN) {
    const candidate = dayOfOccurrence(index, template);
    if (candidate.raw > through.raw) break;
    if (template.endDay && candidate.raw > template.endDay.raw) break;
    if (candidate.raw >= from.raw && candidate.raw >= template.startDay.raw) result.push(candidate);
    index += 1;
    scanned += 1;
  }
  return result;
}

/** The next `count` due days strictly after `today` (for the "upcoming" list and reminders). */
export function upcomingDays(template, today, count) {
  if (!template.isActive || count <= 0) return [];
  const result = [];
  let index = lowerBoundIndex(template, today);
  let scanned = 0;
  while (result.length < count && scanned < MAX_OCCURRENCES_PER_SCAN) {
    const candidate = dayOfOccurrence(index, template);
    if (template.endDay && candidate.raw > template.endDay.raw) break;
    if (candidate.raw > today.raw) result.push(candidate);
    index += 1;
    scanned += 1;
  }
  return result;
}

/** The set of occurrence keys that are already decided: in the log, or carried by an expense. */
export function handledOccurrenceKeys(snapshot) {
  const handled = new Set();
  for (const entry of snapshot.recurrenceLog) handled.add(logEntryKey(entry));
  for (const expense of snapshot.expenses) {
    if (expense.occurrenceKey) handled.add(expense.occurrenceKey);
  }
  return handled;
}

/**
 * Occurrences that are due on or before `today` and neither recorded nor skipped.
 * An occurrence counts as handled if EITHER the log mentions it OR an expense carries its key,
 * so even after an interrupted save nothing can be recorded twice.
 */
export function pendingOccurrences(snapshot, today) {
  const handled = handledOccurrenceKeys(snapshot);
  const result = [];
  for (const template of snapshot.templates) {
    if (!template.isActive) continue;
    for (const due of dueDays(template, template.startDay, today)) {
      const occurrence = pendingOccurrence(template.id, due);
      if (!handled.has(occurrence.key)) result.push(occurrence);
    }
  }
  result.sort((a, b) => {
    if (a.dueDay.raw !== b.dueDay.raw) return a.dueDay.raw - b.dueDay.raw;
    return compareText(a.templateID, b.templateID);
  });
  return result;
}

/**
 * Repeating expenses coming up that the person asked to be reminded about: active, reminder switched on, and the next date
 * after today is within `reminderDaysBefore` days (at least 1). A date that is due today is not a reminder: an automatic
 * one is recorded when the app opens, and one that needs confirming is shown as waiting.
 * Returns [{ template, dueDay, daysAway, key }], soonest first.
 */
export function remindersDue(snapshot, today) {
  const handled = handledOccurrenceKeys(snapshot);
  const result = [];
  for (const template of snapshot.templates) {
    if (!template.isActive || !template.reminderEnabled) continue;
    const window = Math.max(1, template.reminderDaysBefore || 0);
    const [next] = upcomingDays(template, today, 1);
    if (!next) continue;
    const key = occurrenceKey(template.id, next);
    if (handled.has(key)) continue;
    const daysAway = today.daysUntil(next);
    if (daysAway > window) continue;
    result.push({ template, dueDay: next, daysAway, key });
  }
  result.sort((a, b) => (a.dueDay.raw - b.dueDay.raw) || compareText(a.template.id, b.template.id));
  return result;
}
