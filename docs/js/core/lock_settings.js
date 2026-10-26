// App-lock settings and the rules for wrong passcodes.
//
// The lock settings are NOT part of the expense data and never travel inside a backup, so restoring a backup (or editing
// it) can never switch the lock off.

import { AppError } from './util.js';

/** Seconds the app may stay in the background before it asks for the passcode again. 0 means "immediately". */
export const LOCK_TIMEOUTS = Object.freeze([0, 60, 300, 900]);
export const DEFAULT_LOCK_TIMEOUT = 0;

export const LOCK_TIMEOUT_TITLES = Object.freeze({
  0: 'Immediately',
  60: 'After 1 minute',
  300: 'After 5 minutes',
  900: 'After 15 minutes',
});

export function makeLockSettings(isEnabled = false, timeout = DEFAULT_LOCK_TIMEOUT) {
  return Object.freeze({
    isEnabled: isEnabled === true,
    timeout: LOCK_TIMEOUTS.includes(timeout) ? timeout : DEFAULT_LOCK_TIMEOUT,
  });
}

/** Thrown by a settings store. 'unreadable': something is stored but cannot be read. 'unwritable': it could not be saved. */
export class SecureStoreError extends AppError {
  constructor(code) {
    super('secureStore', code, code === 'unreadable' ? 'The lock settings could not be read.' : 'The lock settings could not be saved.');
  }
}

/**
 * Reads settings that were stored earlier. Tolerant on purpose: a missing field takes the default and an unknown timeout
 * becomes the strictest one ("immediately"). Anything that is not an object is unreadable.
 */
export function lockSettingsFromStored(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SecureStoreError('unreadable');
  return makeLockSettings(raw.isEnabled === true, Number.isInteger(raw.timeout) ? raw.timeout : DEFAULT_LOCK_TIMEOUT);
}

// Wrong passcodes ---------------------------------------------------------------------------------

/** The first four wrong passcodes in a row cost nothing; from the fifth on the app makes the person wait. */
export const LOCKOUT_STARTS_AT = 5;

/** The longest wait ever imposed. */
export const MAX_LOCKOUT_SECONDS = 3600;

/**
 * How long to wait after this many wrong passcodes in a row: 30 s, 1 min, 5 min, 15 min, then 1 hour each time.
 * The data is never erased automatically, so a slip can never destroy anything.
 */
export function lockoutSeconds(failedAttempts) {
  if (!(failedAttempts >= LOCKOUT_STARTS_AT)) return 0;
  const steps = [30, 60, 300, 900];
  return steps[failedAttempts - LOCKOUT_STARTS_AT] ?? MAX_LOCKOUT_SECONDS;
}

/** "30 seconds", "5 minutes", "1 hour": a wait in words. */
export function waitText(seconds) {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) return whole === 1 ? '1 second' : `${whole} seconds`;
  if (whole < 3600) {
    const minutes = Math.ceil(whole / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  const hours = Math.ceil(whole / 3600);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

// A store that keeps the settings in memory (tests and previews) ------------------------------------

/**
 * The shape every settings store has. `load` returns null when nothing was ever saved and throws when something IS
 * stored but cannot be read. `loadAttempts` / `saveAttempts` keep the wrong-passcode count, so closing and reopening
 * the app does not clear it.
 */
export class MemoryLockSettingsStore {
  constructor(stored = null) {
    this.stored = stored;
    this.attempts = null;
    /** Makes the saved settings unreadable (tests). */
    this.failLoad = false;
    /** Makes the saved wrong-passcode count unreadable (tests). */
    this.failLoadAttempts = false;
    this.failSave = false;
    this.saveCount = 0;
  }

  async load() {
    if (this.failLoad) throw new SecureStoreError('unreadable');
    return this.stored;
  }

  async save(settings) {
    if (this.failSave) throw new SecureStoreError('unwritable');
    this.stored = settings;
    this.saveCount += 1;
  }

  async loadAttempts() {
    if (this.failLoadAttempts) throw new SecureStoreError('unreadable');
    return this.attempts;
  }

  async saveAttempts(attempts) {
    if (this.failSave) throw new SecureStoreError('unwritable');
    this.attempts = attempts;
  }
}
