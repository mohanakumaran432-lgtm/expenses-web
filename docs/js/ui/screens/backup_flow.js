// Choosing a backup file and checking it. Used on first start and in Settings. Nothing is restored here: the result is
// only a checked, readable backup that the caller can show a preview of.

import { openBackup, backupNeedsPassword } from '../../core/backup.js';
import { pickFile, readFileText } from '../files.js';

/**
 * Asks for a backup file (call from a tap), asks for its password when it has one, and checks it completely.
 * Resolves { info, payload, warnings } or null when cancelled or when the file could not be used (the person was told why).
 */
export async function chooseAndOpenBackup(app) {
  const file = await pickFile({ accept: '.json,application/json,text/plain' });
  if (!file) return null;
  let text;
  try {
    text = await readFileText(file);
  } catch (error) {
    await app.ui.alert({ title: 'Could not read that file', message: error.message });
    return null;
  }
  let password = '';
  if (backupNeedsPassword(text)) {
    for (;;) {
      const typed = await app.ui.prompt({
        title: 'Backup password',
        message: 'This backup is protected. Enter the password you chose when you made it.',
        secure: true,
        confirmLabel: 'Open',
        label: 'Backup password',
      });
      if (typed === null) return null;
      password = typed;
      const attempt = await tryOpen(app, text, password);
      if (attempt.opened) return attempt.opened;
      if (attempt.code !== 'wrongPassword' && attempt.code !== 'passwordRequired') return null;
    }
  }
  const attempt = await tryOpen(app, text, password);
  return attempt.opened || null;
}

async function tryOpen(app, text, password) {
  const done = app.ui.busy('Checking the backup…');
  try {
    return { opened: await openBackup(text, { password }) };
  } catch (error) {
    done();
    await app.ui.alert({ title: 'This backup cannot be used', message: app.errorMessage(error) });
    return { opened: null, code: error && error.code };
  } finally {
    done();
  }
}
