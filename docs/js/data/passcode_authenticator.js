// The "authenticator" the app lock uses: it checks a typed passcode against the stored keyring.
//
// The lock screen hands over what was typed with `supply(passcode)`, then asks the app lock to unlock with this object.
// On success the unlocked key is held here until the screen collects it with `takeKey()` and gives it to the store,
// which it does only if the app lock really did open (a late answer for an app that has already locked again is
// dropped, and so is its key).

import { subtle } from '../core/encoding.js';

export class PasscodeAuthenticator {
  constructor(store) {
    this.store = store;
    this.pending = null;
    this.key = null;
    /** After an 'unavailable' answer: the error code of the storage or keyring problem that caused it (no personal data). */
    this.lastProblem = null;
  }

  /** The text to check on the next `authenticate`. It is forgotten as soon as it has been used. */
  supply(passcode) {
    this.pending = typeof passcode === 'string' ? passcode : null;
  }

  canAuthenticate() {
    try {
      return Boolean(subtle());
    } catch {
      return false;
    }
  }

  /** 'success' | 'cancelled' (nothing typed) | 'failed' (wrong passcode) | 'unavailable' (the check itself could not run) */
  async authenticate() {
    const passcode = this.pending;
    this.pending = null;
    this.key = null;
    this.lastProblem = null;
    if (passcode === null || passcode === '') return 'cancelled';
    try {
      this.key = await this.store.verifyKey(passcode);
      return 'success';
    } catch (error) {
      if (error && error.code === 'wrongPasscode') return 'failed';
      this.lastProblem = error && error.code ? error.code : 'unknown';
      return 'unavailable';
    }
  }

  /** The key from the last successful check (once). */
  takeKey() {
    const key = this.key;
    this.key = null;
    return key;
  }

  /** Drops a key that was not used. */
  discard() {
    this.key = null;
    this.pending = null;
  }
}
