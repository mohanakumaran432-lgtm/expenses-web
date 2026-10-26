// Keeps the app-lock settings and the wrong-passcode count next to the data (same database, outside the records).
//
// The passcode itself is never stored. Whether the lock is ON is decided by one fact: is there a keyring (the
// passcode-locked data key)? If there is, the lock is on, whatever the settings value says. Editing or deleting the
// timeout therefore can never switch the lock off, and a backup can never change it (backups hold no lock settings).

import { SecureStoreError, makeLockSettings, LOCK_TIMEOUTS, DEFAULT_LOCK_TIMEOUT } from '../core/lock_settings.js';
import { META_KEYS } from './stores.js';

export class BackendLockSettingsStore {
  constructor(backend) {
    this.backend = backend;
  }

  /**
   * Returns the settings, or null when nothing was ever saved. Throws SecureStoreError('unreadable') only when the
   * storage itself cannot be read (then the app stays locked). A damaged timeout value is not a reason to lock the
   * person out: it falls back to the strictest timeout ("immediately").
   */
  async load() {
    let loaded;
    try {
      loaded = await this.backend.load({ rows: false });
    } catch {
      throw new SecureStoreError('unreadable');
    }
    const hasKeyring = loaded.meta[META_KEYS.keyring] !== undefined && loaded.meta[META_KEYS.keyring] !== null;
    const saved = loaded.meta[META_KEYS.lock];
    const savedTimeout = saved && typeof saved === 'object' && LOCK_TIMEOUTS.includes(saved.timeout) ? saved.timeout : DEFAULT_LOCK_TIMEOUT;
    if (!hasKeyring && (saved === undefined || saved === null)) return null;
    return makeLockSettings(hasKeyring, savedTimeout);
  }

  /** Saves the timeout. (Whether the lock is on is not saved here: the keyring says that.) */
  async save(settings) {
    try {
      await this.backend.putMeta(META_KEYS.lock, { timeout: settings.timeout });
    } catch {
      throw new SecureStoreError('unwritable');
    }
  }

  async loadAttempts() {
    let saved;
    try {
      saved = await this.backend.getMeta(META_KEYS.attempts);
    } catch {
      throw new SecureStoreError('unreadable');
    }
    if (saved === null) return null;
    if (typeof saved !== 'object' || !Number.isInteger(saved.failedAttempts) || saved.failedAttempts < 0
      || (saved.lockedUntil !== undefined && !Number.isFinite(saved.lockedUntil))) {
      throw new SecureStoreError('unreadable');
    }
    return { failedAttempts: saved.failedAttempts, lockedUntil: saved.lockedUntil ?? 0 };
  }

  async saveAttempts(attempts) {
    try {
      await this.backend.putMeta(META_KEYS.attempts, { failedAttempts: attempts.failedAttempts, lockedUntil: attempts.lockedUntil });
    } catch {
      throw new SecureStoreError('unwritable');
    }
  }
}
