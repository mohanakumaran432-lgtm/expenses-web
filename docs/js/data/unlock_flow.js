// Connects the three parts of the lock: the app lock (when to lock, how many wrong tries), the passcode check, and the
// store (which holds the decrypted data). The rules:
//
// - The data is opened only AFTER the app lock agreed to open. A check that finished after the app had already locked
//   again opens nothing, and its key is thrown away.
// - Whenever the app lock locks (leaving the app, a timeout, "Lock now", too many wrong tries in front of an open app),
//   the store forgets the key and the decrypted data.
// - If opening the data fails after the passcode was right (storage problem, damaged data), the app lock locks again, so
//   the person never sees a half-open app.

/**
 * Makes the store lock itself whenever the app lock is locked. Returns a function that undoes it.
 * Call it once, when the app starts.
 */
export function bindLockToStore(appLock, store) {
  const sync = () => {
    if (appLock.state === 'locked') store.lock();
  };
  sync();
  return appLock.subscribe(sync);
}

/**
 * Tries the typed passcode. Returns { unlocked, notice, problem }:
 *   unlocked  true when the app is open and the data is loaded
 *   notice    the app lock's message key ('failed', 'lockedOut', 'cancelled', 'unavailable', 'none')
 *   problem   an error code when the passcode could not be checked or the data could not be opened (else null)
 */
export async function unlockWithPasscode({ appLock, store, authenticator, passcode, reason = 'Unlock Expenses' }) {
  if (!appLock.isLocked) return { unlocked: true, notice: 'none', problem: null };
  authenticator.supply(passcode);
  await appLock.unlock(authenticator, reason);
  const key = authenticator.takeKey();
  const problem = authenticator.lastProblem;
  authenticator.discard();

  if (appLock.state !== 'unlocked') {
    // Wrong passcode, a wait, or the app locked again while the check ran: no data is opened.
    return { unlocked: false, notice: appLock.notice, problem };
  }
  if (key === null) {
    // The app lock is off, so there is nothing to open with a key.
    return { unlocked: true, notice: 'none', problem: null };
  }
  try {
    await store.unlockWithKey(key);
  } catch (error) {
    appLock.lockNow();
    return { unlocked: false, notice: 'unavailable', problem: error && error.code ? error.code : 'unknown' };
  }
  return { unlocked: true, notice: 'none', problem: null };
}

/**
 * Asks for the passcode again before something sensitive. Wrong answers count like wrong answers on the lock screen.
 * Returns true only when the passcode was right (or no lock is set).
 */
export async function confirmWithPasscode({ appLock, authenticator, passcode, reason = 'Confirm with your passcode' }) {
  authenticator.supply(passcode);
  const confirmed = await appLock.confirmIdentity(authenticator, reason);
  authenticator.discard();
  return confirmed;
}
