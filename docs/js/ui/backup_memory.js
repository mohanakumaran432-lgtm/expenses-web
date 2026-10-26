// What the app remembers about backups, on this device only: the moment the last one was made, and whether a reminder was
// put off. It is a convenience, not part of the data: it is not stored in backups, holds no financial information (only
// two moments in time), and a cleared browser simply forgets it. If the browser refuses to store it, the reminder just
// shows more often.

const LAST_BACKUP = 'expenses.lastBackupAt';
const SNOOZED_UNTIL = 'expenses.backupReminderSnoozedUntil';
const DAY_MS = 86_400_000;

/** How long after a backup the reminder comes back (when something changed since). */
export const REMIND_AFTER_DAYS = 30;
/** Fewer expenses than this are not worth a reminder. */
const MIN_EXPENSES = 5;

function read(key) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Storage is not available here; nothing to do.
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage is not available here; nothing to do.
  }
}

/** The moment (milliseconds) the last backup was made on this device, or null. */
export function lastBackupAt() {
  return read(LAST_BACKUP);
}

export function rememberBackup(nowMs) {
  write(LAST_BACKUP, nowMs);
  remove(SNOOZED_UNTIL);
}

/** Puts the reminder off for a number of days. */
export function snoozeBackupReminder(nowMs, days = 7) {
  write(SNOOZED_UNTIL, nowMs + days * DAY_MS);
}

/** Forgets everything remembered here (used by "Erase everything"). */
export function forgetBackupMemory() {
  remove(LAST_BACKUP);
  remove(SNOOZED_UNTIL);
}

/** Whole days between two moments, never negative. */
export function daysBetween(fromMs, toMs) {
  return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

/**
 * Whether a gentle backup reminder is due. Returns null, or { never: true } when no backup was ever made on this device,
 * or { never: false, days } with the days since the last one.
 */
export function backupReminder(app) {
  const expenses = app.snapshot.expenses;
  if (expenses.length < MIN_EXPENSES) return null;
  const now = app.now();
  const snoozed = read(SNOOZED_UNTIL);
  if (snoozed !== null && snoozed > now) return null;
  const last = lastBackupAt();
  if (last === null) {
    // A brand-new ledger is left alone for a couple of days.
    let oldest = now;
    for (const expense of expenses) if (expense.createdAt < oldest) oldest = expense.createdAt;
    return daysBetween(oldest, now) >= 2 ? { never: true, days: null } : null;
  }
  const days = daysBetween(last, now);
  if (days < REMIND_AFTER_DAYS) return null;
  // Only worth mentioning when something was added or changed since.
  const changed = expenses.some((expense) => expense.modifiedAt > last);
  return changed ? { never: false, days } : null;
}
