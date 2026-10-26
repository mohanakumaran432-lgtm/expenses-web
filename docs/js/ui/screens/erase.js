// "Erase everything" in one place, so the lock screen and Settings ask in exactly the same words.

export async function eraseWithConfirmation(app, { title = 'Erase everything?', message }) {
  const proceed = await app.ui.confirm({
    title,
    message: message || 'This permanently deletes every expense, budget, category and setting stored in this app on this iPhone, and removes the passcode. It cannot be undone. Make a backup first if you want to keep anything.',
    confirmLabel: 'Continue',
    destructive: true,
  });
  if (!proceed) return false;
  const typed = await app.ui.prompt({
    title: 'Type ERASE to confirm',
    message: 'Nothing can bring the data back after this.',
    placeholder: 'ERASE',
    confirmLabel: 'Erase everything',
    label: 'Type ERASE',
  });
  if (typed === null) return false;
  if (typed.trim().toUpperCase() !== 'ERASE') {
    await app.ui.alert({ title: 'Nothing was erased', message: 'The word ERASE was not typed, so everything is still here.' });
    return false;
  }
  const result = await app.perform('erase', () => app.eraseEverything(), { busy: 'Erasing…', title: 'Could not erase' });
  return result.ok;
}
