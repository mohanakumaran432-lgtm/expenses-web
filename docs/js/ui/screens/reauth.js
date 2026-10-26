// Asking for the passcode again before something sensitive: making a backup, restoring one, exporting everything,
// turning the passcode off, erasing. Without a passcode there is nothing to ask for and the action goes ahead.
//
// Wrong answers count exactly like wrong answers on the lock screen (the same waiting times apply).

/** Checks a passcode the person already typed. Tells them when it is wrong. Resolves true only for the right one. */
export async function checkTypedPasscode(app, typed) {
  let right = false;
  const result = await app.perform('lock-check', async () => { right = await app.confirmPasscode(typed); }, { title: 'Could not check the passcode' });
  if (!result.ok) return false;
  if (!right) {
    await app.ui.alert({ title: 'That passcode is not right', message: 'Nothing was changed.' });
    return false;
  }
  return true;
}

/**
 * Asks for the passcode when one is set. Resolves true when it is fine to go on (right passcode, or none is set).
 * @param message  why it is being asked, in one sentence
 */
export async function reconfirmPasscode(app, { title = 'Enter your passcode', message = null, confirmLabel = 'Continue' } = {}) {
  if (!app.lockEnabled) return true;
  const typed = await app.ui.prompt({ title, message, secure: true, confirmLabel, label: 'Passcode' });
  if (typed === null) return false;
  return checkTypedPasscode(app, typed);
}
