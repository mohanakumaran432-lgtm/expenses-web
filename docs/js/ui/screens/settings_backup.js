// Backing up, restoring and exporting everything. A backup is one file the person keeps; nothing is ever sent anywhere by
// the app. The file goes to the iPhone's share sheet (Files, iCloud Drive, AirDrop, Mail...) and the person decides.

import { fill, h, plural } from '../dom.js';
import { group, notice, page, row, segmented, sheetContent, toggleRow } from '../components.js';
import { AppError } from '../../core/util.js';
import { makeBackup, openBackup, planRestore } from '../../core/backup.js';
import { normalizeSettings } from '../../core/models.js';
import { datedName } from '../files.js';
import { APP_VERSION } from '../version.js';
import { REMIND_AFTER_DAYS, daysBetween, lastBackupAt, rememberBackup } from '../backup_memory.js';
import { announceDelivery, buildCsvFile } from '../exports.js';
import { chooseAndOpenBackup } from './backup_flow.js';
import { passcodeFields } from './passcode_fields.js';
import { presentFileReady } from './file_ready.js';
import { reconfirmPasscode } from './reauth.js';

export function openBackupRestore(app) {
  app.shell.push(createBackupRestore);
}

function agoText(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function createBackupRestore(app) {
  const screen = page(app, { title: 'Back up and restore', back: true, backLabel: 'Settings' });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  function refresh() {
    const last = lastBackupAt();
    let status;
    if (last === null) {
      status = notice({
        kind: 'warn', glyph: 'warning', title: 'No backup made yet',
        body: 'Your expenses are stored only in this browser on this iPhone. If Safari\'s website data is cleared, or the Home Screen app is deleted, they are gone. A backup file is the way back.',
      });
    } else {
      const days = daysBetween(last, app.now());
      const old = days >= REMIND_AFTER_DAYS;
      status = notice({
        kind: old ? 'warn' : 'good', glyph: old ? 'warning' : 'shield', title: `Last backup ${agoText(days)}`,
        body: `${app.formatter.timestamp(last, app.timeZone())}. Anything added or changed after that is not in the file.`,
      });
    }
    const counts = app.snapshot.expenses.length;
    fill(holder,
      status,
      group([row({
        title: 'Back up now', sub: counts === 0 ? 'Nothing to back up yet' : `Makes a file with ${plural(counts, 'expense')}, budgets and settings`, chevron: true,
        onClick: () => startBackup(app),
      })], { title: 'Back up', footer: 'You choose where the file goes. It is never uploaded by the app. Keep a copy somewhere other than this iPhone, such as iCloud Drive.' }),
      group([row({
        title: 'Restore from a backup file', sub: 'Checks the file first and shows what will change', chevron: true,
        onClick: () => restoreBackup(app),
      })], { title: 'Restore', footer: 'Nothing changes until you confirm.' }));
  }

  return { el: screen.el, refresh };
}

// ---------------------------------------------------------------- making a backup

/** Asks whether to protect the file with a password. Resolves { password } ('' for none), or null when cancelled. */
function backupOptions(app) {
  const { closed } = app.ui.present((_, __, handle) => {
    let protect = false;
    let state = { ok: false };
    const sheet = sheetContent({
      title: 'Back up',
      onCancel: () => handle.close(null),
      actionLabel: 'Make backup',
      onAction: () => {
        if (protect && !state.ok) return;
        handle.close({ password: protect ? fields.read().passcode : '' });
      },
    });
    const updateAction = () => sheet.setActionDisabled(protect && !state.ok);
    const fields = passcodeFields({
      noun: 'password', label: 'Backup password', confirmLabel: 'Type it again', copied: 'the backup file', startWithText: true,
      hint: 'Use at least 8 letters and numbers, or 6 digits. There is no way to recover a forgotten backup password, and without it the backup cannot be opened.',
      onChange: (next) => { state = next; updateAction(); },
    });
    const passwordBox = h('div', { class: 'stack' }, fields.el);
    passwordBox.hidden = true;
    const toggle = toggleRow({
      title: 'Protect with a password', sub: 'Encrypts the file, so only the password opens it.', checked: false,
      onChange: (checked) => {
        protect = checked;
        passwordBox.hidden = !checked;
        updateAction();
        if (checked) fields.focus();
      },
    });
    sheet.body.append(h('div', { class: 'stack-l' },
      h('p', { class: 't-sub' }, 'A backup is one file with all your expenses, categories, budgets and settings. You choose where it goes next: Files, iCloud Drive, AirDrop, Mail. The app never uploads it.'),
      group([toggle], { footer: 'Without a password, anyone who gets the file can read every expense in it.' }),
      passwordBox,
      app.lockEnabled ? h('p', { class: 't-foot footnote' }, 'Your app passcode does not protect backup files. Only a backup password does.') : null));
    updateAction();
    return { el: sheet.el, label: 'Back up' };
  });
  return closed;
}

/** Makes the file, checks it by opening it again, then offers it to the person. */
export async function startBackup(app) {
  if (app.snapshot.expenses.length === 0 && app.snapshot.budgets.length === 0 && app.snapshot.templates.length === 0) {
    const go = await app.ui.confirm({
      title: 'Nothing to back up yet',
      message: 'There are no expenses, budgets or repeating expenses. A backup now would only hold your categories and settings.',
      confirmLabel: 'Back up anyway',
    });
    if (!go) return;
  }
  if (!(await reconfirmPasscode(app, { message: 'A backup holds all of your expenses.' }))) return;
  const options = await backupOptions(app);
  if (!options) return;

  const protectedFile = options.password !== '';
  const made = await app.perform('backup', async () => {
    const snapshot = app.snapshot;
    const when = app.now();
    const text = await makeBackup(snapshot, when, APP_VERSION, { password: options.password });
    // The new file is opened again before it is offered: a backup that cannot be read back is worse than none.
    const check = await openBackup(text, { password: options.password });
    if (check.payload.expenses.length !== snapshot.expenses.length || check.payload.categories.length !== snapshot.categories.length) {
      throw new AppError('backup', 'verifyFailed', 'The backup file could not be checked, so it was not offered. Nothing was lost; please try again.');
    }
    return { text, when, expenses: snapshot.expenses.length };
  }, { busy: protectedFile ? 'Encrypting the backup…' : 'Making the backup…', title: 'Could not make the backup' });
  if (!made.ok) return;

  const { text, when, expenses } = made.value;
  const filename = datedName('expenses-backup', app.today(), 'json');
  const blob = new Blob([text], { type: 'application/json' });
  const outcome = await presentFileReady(app, {
    title: 'Backup ready',
    filename,
    mime: 'application/json',
    blob,
    lead: 'The backup was made and checked by opening it again. It has not been saved anywhere yet.',
    facts: [
      { title: 'Expenses', value: String(expenses) },
      { title: 'Password', value: protectedFile ? 'Yes' : 'No' },
    ],
    buttonLabel: 'Save or share the backup',
    notes: [
      protectedFile
        ? 'Keep the password safe. It cannot be recovered, and without it this backup cannot be opened.'
        : 'This file is not encrypted. Keep it somewhere only you can open it, and delete copies you no longer need.',
      'Tap the button, then choose Save to Files, iCloud Drive or another place. Keep a copy off this iPhone.',
    ],
  });
  if (outcome) {
    rememberBackup(when);
    announceDelivery(app, outcome, filename, 'Backup');
    app.shell.refresh();
  }
}

// ---------------------------------------------------------------- restoring

/** Chooses a backup file, checks it, shows what restoring would do, and restores when the person confirms. Call from a tap. */
export async function restoreBackup(app) {
  const opened = await chooseAndOpenBackup(app);
  if (!opened) return;
  await restorePreview(app, opened);
}

function restorePreview(app, opened) {
  const { closed } = app.ui.present((_, __, handle) => {
    const current = app.snapshot;
    const empty = current.expenses.length === 0;
    let mode = empty ? 'replaceAll' : 'merge';
    const { info, payload, warnings } = opened;
    const f = app.formatter;

    const holder = h('div', { class: 'stack-l' });
    const sheet = sheetContent({ title: 'Restore', onCancel: () => handle.close(false), actionLabel: 'Restore', onAction: () => run() });
    const modeBar = segmented({
      label: 'How to restore',
      options: [{ value: 'merge', label: 'Add to this' }, { value: 'replaceAll', label: 'Replace all' }],
      value: mode,
      onChange: (value) => { mode = value; draw(); },
    });

    function backupRows() {
      const counts = info.counts;
      const span = counts.firstExpenseDay && counts.lastExpenseDay
        ? `${f.day(counts.firstExpenseDay)} to ${f.day(counts.lastExpenseDay)}`
        : 'No dated expenses';
      return group([
        row({ title: 'Made', value: f.timestamp(info.createdAt, app.timeZone()) }),
        row({ title: 'Expenses', value: String(counts.expenses) }),
        row({ title: 'Dates', value: span }),
        row({ title: 'Categories', value: String(counts.categories) }),
        row({ title: 'Budgets', value: String(counts.budgets) }),
        row({ title: 'Repeating', value: String(counts.templates) }),
      ], { title: 'In this backup' });
    }

    function draw() {
      const { preview } = planRestore(payload, app.snapshot, mode);
      const parts = [backupRows(), modeBar];
      if (mode === 'replaceAll') {
        parts.push(group([
          row({ title: 'Expenses now in the app', value: String(preview.currentExpenseCount) }),
          row({ title: 'Expenses after restoring', value: String(preview.backupExpenseCount) }),
        ], {
          title: 'What will happen',
          footer: preview.currentExpenseCount > 0
            ? 'Everything now in the app is removed and replaced by the backup, including settings. Your passcode stays.'
            : 'The app is empty, so the backup simply becomes your data. Your passcode stays.',
        }));
      } else {
        parts.push(group([
          row({ title: 'New expenses added', value: String(preview.expensesToAdd) }),
          row({ title: 'Updated from the backup', value: String(preview.expensesToUpdate), sub: 'Same expense, newer in the backup' }),
          row({ title: 'Left as they are', value: String(preview.expensesKept), sub: 'Already here, as new or newer' }),
          row({ title: 'Categories added', value: String(preview.categoriesToAdd) }),
          row({ title: 'Budgets added', value: String(preview.budgetsToAdd) }),
          row({ title: 'Repeating added', value: String(preview.templatesToAdd) }),
        ], {
          title: 'What will happen',
          footer: 'Nothing here is deleted. Expenses are matched by their own identity, so restoring the same file twice adds nothing the second time. Your settings stay as they are.',
        }));
        const backupCurrency = normalizeSettings(payload.settings).currencyCode;
        if (backupCurrency !== app.currency) {
          parts.push(notice({
            kind: 'warn', glyph: 'info', title: `This backup uses ${backupCurrency}`,
            body: `Your app uses ${app.currency}. Expenses in ${backupCurrency} are kept as they are and never converted, but totals count one currency at a time.`,
          }));
        }
      }
      if (warnings.length > 0) {
        parts.push(notice({ kind: 'warn', glyph: 'warning', title: 'Worth a look', body: h('div', { class: 'stack-s' }, warnings.map((text) => h('p', null, text))) }));
      } else {
        parts.push(h('p', { class: 't-foot footnote' }, 'The file passed every check: it is complete and unchanged.'));
      }
      fill(holder, ...parts);
    }

    async function run() {
      if (!(await reconfirmPasscode(app, { message: 'Restoring changes your data.' }))) return;
      const before = app.snapshot.expenses.length;
      if (mode === 'replaceAll' && before > 0) {
        const yes = await app.ui.confirm({
          title: 'Replace everything?',
          message: `The ${plural(before, 'expense')} now in the app will be removed and replaced by the ${plural(payload.expenses.length, 'expense')} in the backup. This cannot be undone. If you might want what is here now, make a backup of it first.`,
          confirmLabel: 'Replace everything',
          destructive: true,
        });
        if (!yes) return;
      }
      const result = await app.perform('restore', async () => {
        // Planned again against the data as it is right now, in case it changed while this sheet was open.
        const plan = planRestore(payload, app.snapshot, mode);
        await app.restoreSnapshot(plan.result);
        return plan.preview;
      }, { busy: 'Restoring…', title: 'Could not restore' });
      if (!result.ok) return;
      handle.close(true);
      const preview = result.value;
      app.ui.toast(mode === 'replaceAll'
        ? `Restored ${plural(preview.backupExpenseCount, 'expense')}.`
        : `Added ${plural(preview.expensesToAdd, 'expense')}${preview.expensesToUpdate > 0 ? `, updated ${preview.expensesToUpdate}` : ''}.`);
    }

    sheet.body.append(holder);
    draw();
    return { el: sheet.el, label: 'Restore' };
  });
  return closed;
}

// ---------------------------------------------------------------- everything as CSV

/** Puts every expense in a CSV file for a spreadsheet. */
export async function exportAllCsv(app) {
  const expenses = app.snapshot.expenses;
  if (expenses.length === 0) {
    await app.ui.alert({ title: 'Nothing to export', message: 'There are no expenses yet to put in a file.' });
    return;
  }
  if (!(await reconfirmPasscode(app, { message: 'Exporting puts every expense in a file.' }))) return;
  const file = buildCsvFile(app, expenses);
  const outcome = await presentFileReady(app, {
    title: 'Export ready',
    ...file,
    lead: `${plural(expenses.length, 'expense')} ${expenses.length === 1 ? 'is' : 'are'} in the file. It has not been saved anywhere yet.`,
    buttonLabel: 'Save or share the file',
    notes: [
      'The file opens in Numbers, Excel and Google Sheets. It is not encrypted, so keep it somewhere only you can open it.',
      'This is for reading and analysis. To keep a copy you can restore from, use a backup instead.',
    ],
  });
  if (outcome) announceDelivery(app, outcome, file.filename, plural(expenses.length, 'expense'));
}

