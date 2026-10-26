// The app-lock state machine. It has no screen and no crypto in it, so every path (success, wrong passcode, waiting
// period, timeout, clock changes) is covered by plain unit tests. It is the same design as the iPhone app's lock.
//
// Rules:
// - With the lock on, a cold start is always locked.
// - Leaving the app records the time; coming back locks it if the chosen timeout has passed. With "Immediately" the
//   app is already locked when it goes out of sight.
// - If the clock moved backwards, the app locks (a changed clock can never keep the app open longer).
// - If the lock settings cannot be read, the app stays locked ("fail closed"). It never opens unprotected by accident.
// - A result that arrives after the app already locked again is ignored.
// - Wrong passcodes are counted and remembered (also after the app is closed). From the fifth in a row the person must
//   wait: 30 seconds, then 1 minute, 5 minutes, 15 minutes, and 1 hour each time after that. Nothing is erased.
//   Leaving and returning does not clear the count. (This slows down someone typing guesses in the app; it cannot stop
//   someone who copies the stored data and guesses on their own computer. That is what a long passcode is for.)
//
// "Authenticator" is anything with canAuthenticate() and authenticate(reason) returning one of
// 'success' | 'cancelled' | 'failed' | 'lockedOut' | 'unavailable'. The real one checks the typed passcode.

import {
  LOCKOUT_STARTS_AT, MAX_LOCKOUT_SECONDS, lockoutSeconds, makeLockSettings, waitText,
} from './lock_settings.js';

export const LOCK_STATES = Object.freeze({ unlocked: 'unlocked', locked: 'locked', authenticating: 'authenticating' });

/** The text a lock screen shows after the last attempt. `remainingSeconds` is only used for 'lockedOut'. */
export function lockNoticeMessage(notice, remainingSeconds = 0) {
  switch (notice) {
    case 'cancelled':
      return 'Unlocking was cancelled. Enter your passcode to try again.';
    case 'failed':
      return 'That passcode did not work. Try again.';
    case 'lockedOut':
      return remainingSeconds > 0
        ? `Too many wrong passcodes. Try again in ${waitText(remainingSeconds)}.`
        : 'Too many wrong passcodes. Try again in a moment.';
    case 'unavailable':
      return 'This browser is not allowing the secure operations the app needs. Open the app from its Home Screen icon or its https address in Safari.';
    default:
      return null;
  }
}

export class AppLock {
  /** Reads the saved settings and wrong-passcode count, then builds the controller. Never throws. */
  static async open(store, now = () => Date.now()) {
    let settings = makeLockSettings();
    let settingsUnreadable = false;
    try {
      const saved = await store.load();
      if (saved) settings = saved;
    } catch {
      settings = makeLockSettings(true, 0);
      settingsUnreadable = true;
    }
    let attempts = { failedAttempts: 0, lockedUntil: 0 };
    try {
      const saved = await store.loadAttempts();
      if (saved && Number.isInteger(saved.failedAttempts) && saved.failedAttempts >= 0) {
        attempts = { failedAttempts: saved.failedAttempts, lockedUntil: Number.isFinite(saved.lockedUntil) ? saved.lockedUntil : 0 };
      }
    } catch {
      // The count cannot be read: assume the person was already at the first waiting period.
      attempts = { failedAttempts: LOCKOUT_STARTS_AT, lockedUntil: now() + lockoutSeconds(LOCKOUT_STARTS_AT) * 1000 };
    }
    return new AppLock({ settings, settingsUnreadable, ...attempts }, store, now);
  }

  constructor({ settings, settingsUnreadable, failedAttempts, lockedUntil }, store, now = () => Date.now()) {
    this.store = store;
    this.now = now;
    this.settings = settings;
    /** True when lock settings were stored but could not be read. */
    this.settingsUnreadable = settingsUnreadable;
    this.failedAttempts = failedAttempts;
    this.lockedUntil = lockedUntil;
    this.state = settings.isEnabled ? LOCK_STATES.locked : LOCK_STATES.unlocked;
    this.notice = 'none';
    this.backgroundedAt = null;
    /** Counts unlock attempts, so the late result of an old attempt can never be applied to a newer one. */
    this.attemptNumber = 0;
    this.listeners = new Set();
  }

  // Watching ----------------------------------------------------------------------------------------

  /** `listener(controller)` runs after every change. Returns a function that stops listening. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed() {
    for (const listener of Array.from(this.listeners)) listener(this);
  }

  get isLocked() {
    return this.state !== LOCK_STATES.unlocked;
  }

  /** True when the lock screen should focus the passcode field by itself: a fresh lock, not after a message. */
  get shouldPromptAutomatically() {
    return this.state === LOCK_STATES.locked && this.notice === 'none';
  }

  /** Seconds left of the current waiting period (0 when the person may try). */
  lockoutRemainingSeconds() {
    const cap = lockoutSeconds(this.failedAttempts);
    if (cap === 0 || !(this.lockedUntil > 0)) return 0;
    const left = this.lockedUntil - this.now();
    if (!(left > 0)) return 0;
    // If the clock was moved backwards to shorten the wait, the wait still never exceeds what it was meant to be.
    return Math.ceil(Math.min(left, cap * 1000) / 1000);
  }

  // Scene changes -----------------------------------------------------------------------------------

  sceneDidEnterBackground() {
    this.backgroundedAt = this.now();
    if (!this.settings.isEnabled) return;
    // A locked app that was left after a message starts fresh next time.
    if (this.state === LOCK_STATES.locked) this.notice = 'none';
    if (this.settings.timeout === 0 && this.state !== LOCK_STATES.locked) {
      this.attemptNumber += 1;
      this.state = LOCK_STATES.locked;
      this.notice = 'none';
    }
    this.changed();
  }

  sceneWillEnterForeground() {
    const since = this.backgroundedAt;
    if (since === null) return;
    this.backgroundedAt = null;
    if (!this.settings.isEnabled || this.state !== LOCK_STATES.unlocked) return;
    const elapsedSeconds = (this.now() - since) / 1000;
    if (elapsedSeconds < 0 || elapsedSeconds >= this.settings.timeout) {
      this.attemptNumber += 1;
      this.state = LOCK_STATES.locked;
      this.notice = 'none';
      this.changed();
    }
  }

  /** Locks right now (the "Lock now" button). */
  lockNow() {
    if (!this.settings.isEnabled || this.state === LOCK_STATES.locked) return;
    this.attemptNumber += 1;
    this.state = LOCK_STATES.locked;
    this.notice = 'none';
    this.changed();
  }

  // Unlocking ---------------------------------------------------------------------------------------

  async unlock(authenticator, reason) {
    if (!this.settings.isEnabled || this.state !== LOCK_STATES.locked) return;
    if (this.lockoutRemainingSeconds() > 0) {
      // Still waiting: do not even look at the passcode.
      this.notice = 'lockedOut';
      this.changed();
      return;
    }
    this.attemptNumber += 1;
    const attempt = this.attemptNumber;
    this.state = LOCK_STATES.authenticating;
    this.notice = 'none';
    this.changed();
    let outcome;
    try {
      outcome = authenticator.canAuthenticate() ? await authenticator.authenticate(reason) : 'unavailable';
    } catch {
      // A check that blows up must leave the app locked and usable again, never stuck on "authenticating".
      outcome = 'unavailable';
    }
    await this.finishAuthentication(outcome, attempt);
  }

  async finishAuthentication(outcome, attempt) {
    // The app may have locked again while the check was running, or a newer attempt may have started.
    // A late result must not unlock the app or disturb the newer attempt.
    if (this.state !== LOCK_STATES.authenticating || attempt !== this.attemptNumber) return;
    let save = false;
    switch (outcome) {
      case 'success':
        this.state = LOCK_STATES.unlocked;
        this.notice = 'none';
        save = this.failedAttempts !== 0 || this.lockedUntil !== 0;
        this.failedAttempts = 0;
        this.lockedUntil = 0;
        break;
      case 'cancelled':
        this.state = LOCK_STATES.locked;
        this.notice = 'cancelled';
        break;
      case 'failed':
      case 'lockedOut':
        this.state = LOCK_STATES.locked;
        this.countFailure();
        this.notice = this.lockedUntil > 0 ? 'lockedOut' : (outcome === 'lockedOut' ? 'lockedOut' : 'failed');
        save = true;
        break;
      default:
        this.state = LOCK_STATES.locked;
        this.notice = 'unavailable';
    }
    this.changed();
    if (save) await this.saveAttempts();
  }

  /** Counts one wrong passcode and starts the waiting period when it is due. */
  countFailure() {
    this.failedAttempts += 1;
    const wait = lockoutSeconds(this.failedAttempts);
    this.lockedUntil = wait > 0 ? this.now() + wait * 1000 : 0;
  }

  async saveAttempts() {
    try {
      await this.store.saveAttempts({ failedAttempts: this.failedAttempts, lockedUntil: this.lockedUntil });
    } catch {
      // The count stays in memory; a store that cannot save cannot be helped from here.
    }
  }

  // Sensitive actions -------------------------------------------------------------------------------

  /**
   * Asks for the passcode again before something sensitive (turning the lock off, erasing everything, exporting).
   * Returns true straight away when the lock is off, because there is nothing to confirm with. Wrong answers count like
   * wrong answers on the lock screen, so this cannot be used to guess the passcode without limit.
   */
  async confirmIdentity(authenticator, reason) {
    if (!this.settings.isEnabled) return true;
    if (!authenticator.canAuthenticate()) return false;
    if (this.lockoutRemainingSeconds() > 0) return false;
    let outcome;
    try {
      outcome = await authenticator.authenticate(reason);
    } catch {
      // The check could not run: the answer is "not confirmed", and it does not count as a wrong passcode.
      return false;
    }
    if (outcome === 'success') {
      if (this.failedAttempts !== 0 || this.lockedUntil !== 0) {
        this.failedAttempts = 0;
        this.lockedUntil = 0;
        await this.saveAttempts();
        this.changed();
      }
      return true;
    }
    if (outcome === 'failed' || outcome === 'lockedOut') {
      this.countFailure();
      const startedWaiting = this.lockedUntil > 0;
      await this.saveAttempts();
      // Guessing in front of an unlocked app: once the waiting period starts, lock the app.
      if (startedWaiting) {
        this.lockNow();
        this.notice = 'lockedOut';
      }
      this.changed();
    }
    return false;
  }

  // Changing settings -------------------------------------------------------------------------------

  /**
   * Call after the passcode was created and the data protected. The protection itself is stored with the data, so it is
   * already in force; this records the timeout and opens the app (the person just proved who they are).
   */
  async didEnableProtection(timeout) {
    const updated = makeLockSettings(true, timeout);
    this.settings = updated;
    this.settingsUnreadable = false;
    this.attemptNumber += 1;
    this.state = LOCK_STATES.unlocked;
    this.notice = 'none';
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    this.changed();
    try {
      await this.store.save(updated);
      await this.store.saveAttempts({ failedAttempts: 0, lockedUntil: 0 });
      return 'applied';
    } catch {
      return 'couldNotSave';
    }
  }

  /** Call after the passcode was removed (this needed the current passcode). */
  async didDisableProtection() {
    const updated = makeLockSettings(false, this.settings.timeout);
    this.settings = updated;
    this.settingsUnreadable = false;
    this.attemptNumber += 1;
    this.state = LOCK_STATES.unlocked;
    this.notice = 'none';
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    this.changed();
    try {
      await this.store.save(updated);
      await this.store.saveAttempts({ failedAttempts: 0, lockedUntil: 0 });
      return 'applied';
    } catch {
      return 'couldNotSave';
    }
  }

  /** Changes how long the app may stay in the background. Nothing changes if the new value cannot be saved. */
  async setTimeout(timeout) {
    const updated = makeLockSettings(this.settings.isEnabled, timeout);
    try {
      await this.store.save(updated);
    } catch {
      return 'couldNotSave';
    }
    this.settings = updated;
    this.settingsUnreadable = false;
    this.changed();
    return 'applied';
  }
}

export { MAX_LOCKOUT_SECONDS };
