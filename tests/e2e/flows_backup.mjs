// Backing up, restoring and exporting for a spreadsheet, end to end in a real browser. Files are really saved (a download) or
// handed to a stand-in share sheet, then read back here and opened with the app's own backup code, so what the person would
// keep is checked, not just what is drawn on screen. Also covers the ways a backup can go wrong: wrong password, damaged file,
// a file that is not a backup, a backup from a newer version.
// Run: SHOTS_DIR=... node tests/e2e/flows_backup.mjs [light|dark]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, openApp, shot, startFresh, seed, seedExtras, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';
import { backupNeedsPassword, openBackup } from '../../docs/js/core/backup.js';
import { CSV_COLUMNS, parseCSV } from '../../docs/js/core/csv.js';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const { step, summary, settle } = makeRunner(page, `backup-${scheme}`);
const f = finders(page);
const leaks = [];
const snap = async (name) => { await shot(page, `${name}-${scheme}`); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const state = (fn, arg) => inApp(page, fn, arg);
const DOWNLOADS = fs.mkdtempSync(path.join(process.env.DOWNLOADS_DIR || os.tmpdir(), 'expenses-downloads-'));
let downloads = 0;
let failures = 0;

const T0 = new Date('2026-10-20T08:00:00Z');
const hoursLater = (hours) => new Date(T0.getTime() + hours * 3_600_000);
const FILE_DAY = '2026-10-20';
const BACKUP_NAME = `expenses-backup-${FILE_DAY}.json`;
const CSV_NAME = `expenses-${FILE_DAY}.csv`;
const BACKUP_PASSWORD = 'Tulip-Harbour-42';
const APP_PASSCODE = '482915';
// Words from the sample data. None of them may be readable in an encrypted backup or in encrypted storage.
const PROBES = ['Spinneys', 'Carrefour', 'Starbucks', 'Emirates Holidays', 'Careem', 'Landlord', 'Groceries'];

// ---------------------------------------------------------------------------------------------- helpers

const sheet = () => page.locator('.layer').last();
const waitSheet = (title) => page.locator('.layer .navbar-title', { hasText: new RegExp(`^\\s*${title}\\s*$`) }).last().waitFor({ timeout: 8000 });
const modeButton = (label) => sheet().locator('.seg').filter({ hasText: f.exact(label) });

/** Every "title: value" row of the sheet on top (or of the page on top). */
const factsOf = (locator) => locator.evaluate((root) => {
  const out = {};
  for (const row of root.querySelectorAll('.row')) {
    const title = row.querySelector('.row-title');
    const value = row.querySelector('.row-value');
    if (title && value) out[title.textContent.trim()] = value.textContent.trim();
  }
  return out;
});
const sheetFacts = () => factsOf(sheet());
const pageFacts = () => factsOf(page.locator(TOP).first());

/** What the app holds, as plain facts (the same fields are read from a backup file below, so the two can be compared). */
const ledger = () => state((app) => app.snapshot.expenses.map((e) => ({
  id: e.id, minor: e.amount.minorUnits, currency: e.amount.currencyCode, day: e.localDay.toString(), merchant: e.merchant, notes: e.notes,
  category: e.categoryID, subcategory: e.subcategoryID, method: e.paymentMethodID, tags: e.tags.join('|'), at: e.occurredAt,
  timed: e.hasExplicitTime, template: e.recurringTemplateID,
})));
const fromPayload = (expenses) => expenses.map((e) => ({
  id: e.id, minor: e.amount.minorUnits, currency: e.amount.currencyCode, day: e.localDay.toString(), merchant: e.merchant, notes: e.notes,
  category: e.categoryID, subcategory: e.subcategoryID, method: e.paymentMethodID, tags: e.tags.join('|'), at: e.occurredAt,
  timed: e.hasExplicitTime, template: e.recurringTemplateID,
}));
const sorted = (list) => list.map((item) => JSON.stringify(item)).sort();
const counts = () => state((app) => ({
  expenses: app.snapshot.expenses.length, budgets: app.snapshot.budgets.length, templates: app.snapshot.templates.length,
  categories: app.snapshot.categories.length,
}));

/** Replaces the browser's share sheet with a stand-in: 'ok' accepts the file, 'cancel' refuses like a closed sheet, 'none' has none. */
const shareSheet = (mode) => page.evaluate((m) => {
  window.__shares = [];
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: m === 'none' ? undefined : () => true });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: m === 'none' ? undefined : async (data) => {
      const file = data.files && data.files[0];
      window.__shares.push({ name: file ? file.name : null, type: file ? file.type : null, size: file ? file.size : null, text: file ? await file.text() : null });
      if (m === 'cancel') throw new DOMException('The share sheet was closed', 'AbortError');
    },
  });
}, mode);
const shares = () => page.evaluate(() => window.__shares);

/** Taps the button that hands over the file that is ready, and keeps the downloaded copy. */
async function takeDownload(buttonName) {
  const [download] = await Promise.all([page.waitForEvent('download'), f.sheetButton(buttonName).click()]);
  downloads += 1;
  const file = path.join(DOWNLOADS, `${downloads}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  return { name: download.suggestedFilename(), text: fs.readFileSync(file, 'utf8'), path: file };
}

/** Opens "Back up", optionally protects the file, and stops on the "Backup ready" sheet. */
async function startBackupFlow({ password = null } = {}) {
  await f.row('Back up now').click();
  await waitSheet('Back up');
  if (password !== null) {
    await sheet().getByRole('switch', { name: /Protect with a password/ }).check({ force: true });
    await sheet().getByLabel('Backup password', { exact: true }).fill(password);
    await sheet().getByLabel('Type it again', { exact: true }).fill(password);
  }
  await f.sheetAction('Make backup').click();
  await waitSheet('Backup ready');
}

/** Makes a backup through the screens and keeps the downloaded file. */
async function backupToFile({ password = null } = {}) {
  await shareSheet('none');
  await startBackupFlow({ password });
  const file = await takeDownload('Save or share the backup');
  await f.noLayers();
  return file;
}

/** Chooses a file on the "Back up and restore" page (as the file chooser would) and waits for whatever comes next. */
async function chooseBackupFile(content, { name = 'backup.json', mimeType = 'application/json' } = {}) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), f.row('Restore from a backup file').click()]);
  await chooser.setFiles({ name, mimeType, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') });
}

/** Chooses a file that cannot be used and reads the message the person is shown. */
async function messageForBadFile(content, options) {
  await chooseBackupFile(content, options);
  await f.waitDialog('This backup cannot be used');
  const message = await f.dialog().locator('.dialog-message').innerText();
  await snap(`14x-bad-${message.slice(0, 12).replace(/[^a-z]/gi, '').toLowerCase()}`);
  await f.dialogButton('OK').click();
  await f.noLayers();
  expectEqual(await f.pageTitle(), 'Back up and restore', 'still on the backup page');
  return message;
}

/** Choose a good file, pick the mode, and press Restore (answering the extra question when replacing). */
async function restoreFrom(content, { mode = null } = {}) {
  await chooseBackupFile(content);
  await waitSheet('Restore');
  if (mode) await modeButton(mode).click();
  await settle(150);
}

async function storageReadable(words) {
  return page.evaluate(async (probes) => {
    const dbs = await indexedDB.databases();
    let text = '';
    for (const { name } of dbs) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      for (const store of Array.from(db.objectStoreNames)) {
        const all = await new Promise((resolve, reject) => { const r = db.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        text += JSON.stringify(all, (key, value) => (value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? `<${value.byteLength} bytes>` : value));
      }
      db.close();
    }
    return probes.filter((probe) => text.includes(probe));
  }, words);
}

/** Expenses with text a spreadsheet could run as a formula, quotes, commas, line breaks and Arabic. */
async function addTrickyExpenses() {
  return page.evaluate(async () => {
    const app = window.__expensesApp;
    const { makeDraft } = await import('/js/core/models.js');
    const { parseMoney } = await import('/js/core/money.js');
    const category = app.snapshot.categories.find((c) => c.name === 'Shopping');
    const today = app.today();
    const rows = [
      { merchant: '=HYPERLINK("http://example.invalid/x","Open me")', notes: '@SUM(A1:A9)', amount: '12.50' },
      { merchant: '+971 Taxi', notes: '-2+3', amount: '30.00' },
      { merchant: 'Café "Le Roi", Souq', notes: 'First line\nSecond line, with "quotes"', amount: '45.75' },
      { merchant: 'مطعم الشام ☕', notes: '', amount: '99.00' },
    ];
    for (const row of rows) {
      const parsed = parseMoney(row.amount, app.currency);
      await app.services.expenses.save(makeDraft({
        amount: parsed.money, day: today, timeZoneID: app.timeZone(), categoryID: category.id, merchant: row.merchant, notes: row.notes, tags: ['csv-test'],
      }), today);
    }
    return rows.length;
  });
}

// ---------------------------------------------------------------------------------------------- the run

let plain = null; // text of the first plain backup (made at the start, when nothing has been changed)
let original = null; // the ledger as it was then
let total = 0;
let originalCounts = null;

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  await seedExtras(page, url);
  original = await ledger();
  total = original.length;
  originalCounts = await counts();
  await f.tab('Settings');
  await settle(300);

  console.log(`\nBackup, restore and export (${scheme})`);

  // ------------------------------------------------------------------------------------------ making backups

  await step('Before any backup, Settings and the backup page say so', async () => {
    const settingsRow = await f.row('Back up and restore').innerText();
    expect(/Never/.test(settingsRow) && /No backup made yet/.test(settingsRow), `Settings should say Never and No backup made yet (it says "${settingsRow.replace(/\s+/g, ' ')}")`);
    await f.row('Back up and restore').click();
    await settle(350);
    expectEqual(await f.pageTitle(), 'Back up and restore', 'page title');
    expect(await page.locator(`${TOP} .notice`, { hasText: 'No backup made yet' }).count() > 0, 'the page warns that no backup was made');
    const row = await f.row('Back up now').innerText();
    expect(row.includes(`${total} expenses`), `"Back up now" says how many expenses go in the file (it says "${row.replace(/\s+/g, ' ')}")`);
    await snap('120-backup-never');
  });

  await step('The Back up sheet explains what a backup is and asks about a password', async () => {
    await f.row('Back up now').click();
    await waitSheet('Back up');
    await settle(250);
    const text = await sheet().innerText();
    expect(/never uploads it/i.test(text), 'it says the app never uploads the backup');
    expect(/anyone who gets the file can read every expense/i.test(text), 'it warns that an unprotected file can be read by anyone who gets it');
    expect(!(await f.sheetAction('Make backup').isDisabled()), 'without a password the file can be made at once');
    await snap('121-backup-options');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  await step('A password for the backup must be typed twice and be long enough', async () => {
    await f.row('Back up now').click();
    await waitSheet('Back up');
    const protect = sheet().getByRole('switch', { name: /Protect with a password/ });
    await protect.check({ force: true });
    await settle(200);
    expect(await f.sheetAction('Make backup').isDisabled(), 'Make backup waits for a password');
    const first = sheet().getByLabel('Backup password', { exact: true });
    const second = sheet().getByLabel('Type it again', { exact: true });
    await first.fill('abc');
    await second.fill('abc');
    expect(await f.sheetAction('Make backup').isDisabled(), 'a short password is refused');
    expect(/at least/i.test(await sheet().innerText()), 'it says how long a password must be');
    await first.fill(BACKUP_PASSWORD);
    await second.fill('Tulip-Harbour-43');
    expect(await f.sheetAction('Make backup').isDisabled(), 'two different passwords are refused');
    expect(/not the same/i.test(await sheet().innerText()), 'it says they differ');
    await second.fill(BACKUP_PASSWORD);
    expect(!(await f.sheetAction('Make backup').isDisabled()), 'the same password twice is accepted');
    await snap('122-backup-password');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  await step('Closing the share sheet without saving leaves the backup unrecorded', async () => {
    await shareSheet('cancel');
    await startBackupFlow();
    const facts = await sheetFacts();
    expectEqual(facts.File, BACKUP_NAME, 'file name');
    expectEqual(facts.Expenses, String(total), 'expenses in the file');
    expectEqual(facts.Password, 'No', 'password');
    expect(/KB|MB|bytes/.test(facts.Size), `the size is shown (${facts.Size})`);
    await snap('123-backup-ready');
    await f.sheetButton('Save or share the backup').click();
    await settle(500);
    expectEqual((await shares()).length, 1, 'the share sheet was opened once');
    expect(await f.sheetButton('Save or share the backup').isVisible(), 'the file is still waiting');
    expect(!(await f.sheetButton('Save or share the backup').isDisabled()), 'and can be offered again');
    const remembered = await page.evaluate(() => localStorage.getItem('expenses.lastBackupAt'));
    expectEqual(remembered, null, 'no backup was recorded');
    await f.sheetAction('Close').click();
    await f.noLayers();
    expect(await page.locator(`${TOP} .notice`, { hasText: 'No backup made yet' }).count() > 0, 'the page still says no backup was made');
  });

  await step('Handing the file to the share sheet saves it as a real, checked backup', async () => {
    await shareSheet('ok');
    await startBackupFlow();
    await f.sheetButton('Save or share the backup').click();
    await f.waitToast('Backup exported');
    await f.noLayers();
    const handed = await shares();
    expectEqual(handed.length, 1, 'one file was shared');
    expectEqual(handed[0].name, BACKUP_NAME, 'shared file name');
    expectEqual(handed[0].type, 'application/json', 'shared file type');
    expect(!backupNeedsPassword(handed[0].text), 'it is not password protected');
    const opened = await openBackup(handed[0].text);
    expectEqual(opened.payload.expenses.length, total, 'expenses in the file');
    expectEqual(opened.info.counts.budgets, 1, 'budgets in the file');
    expectEqual(opened.info.counts.templates, 1, 'repeating expenses in the file');
    expectEqual(opened.warnings, [], 'no warnings');
    expectEqual(sorted(fromPayload(opened.payload.expenses)), sorted(original), 'the file holds exactly the expenses that are in the app');
    plain = handed[0].text;
    const note = await page.locator(`${TOP} .notice`).first().innerText();
    expect(/Last backup today/.test(note), `the page now says the last backup was today (it says "${note.replace(/\s+/g, ' ')}")`);
    await snap('124-backup-done');
  });

  await step('Without a share sheet the file is downloaded instead, under the same name', async () => {
    const file = await backupToFile();
    expectEqual(file.name, BACKUP_NAME, 'downloaded file name');
    await f.waitToast(`Backup saved as ${BACKUP_NAME}`);
    expect(!backupNeedsPassword(file.text), 'not password protected');
    expectEqual(sorted(fromPayload((await openBackup(file.text)).payload.expenses)), sorted(original), 'same expenses');
    expect(file.text.charCodeAt(0) === 0x7B, 'the file starts with an opening brace (plain JSON, nothing before it)');
  });

  let protectedFile = null;
  await step('A backup with a password is encrypted: no word of the data can be read in it', async () => {
    protectedFile = await backupToFile({ password: BACKUP_PASSWORD });
    expectEqual(protectedFile.name, BACKUP_NAME, 'file name');
    expect(backupNeedsPassword(protectedFile.text), 'the file says it needs a password');
    const envelope = JSON.parse(protectedFile.text);
    expectEqual(envelope.payloadEncoding, 'aes-256-gcm+pbkdf2-sha256+json+base64', 'encoding');
    expect(envelope.kdf.iterations >= 600_000, `key stretching is strong (${envelope.kdf.iterations} rounds)`);
    expectEqual(envelope.counts, undefined, 'the readable header does not give away how many expenses there are');
    const decoded = Buffer.from(envelope.payload, 'base64').toString('latin1');
    const readable = PROBES.filter((word) => protectedFile.text.includes(word) || decoded.includes(word));
    expectEqual(readable, [], 'sample words readable in the protected file');
    expect(!protectedFile.text.includes(BACKUP_PASSWORD), 'the password is not in the file');
    await openBackup(protectedFile.text).then(() => { throw new Error('opened without a password'); }, (error) => expectEqual(error.code, 'passwordRequired', 'no password'));
    await openBackup(protectedFile.text, { password: 'Tulip-Harbour-00' }).then(() => { throw new Error('opened with a wrong password'); }, (error) => expectEqual(error.code, 'wrongPassword', 'wrong password'));
    const opened = await openBackup(protectedFile.text, { password: BACKUP_PASSWORD });
    expectEqual(sorted(fromPayload(opened.payload.expenses)), sorted(original), 'the right password opens the same expenses');
  });

  await step('The backup page and Settings now say a backup was made today', async () => {
    const note = await page.locator(`${TOP} .notice`).first().innerText();
    expect(/Last backup today/.test(note), 'the page says today');
    await f.back();
    const row = await f.row('Back up and restore').innerText();
    expect(/Today/.test(row) && !/No backup made yet/.test(row), `Settings says Today (it says "${row.replace(/\s+/g, ' ')}")`);
    await f.row('Back up and restore').click();
    await settle(300);
  });

  // ------------------------------------------------------------------------------------------ restoring

  await step('Restoring a file that is already in the app adds nothing and changes nothing', async () => {
    await restoreFrom(plain);
    expectEqual(await modeButton('Add to this').getAttribute('aria-pressed'), 'true', 'a ledger with data starts in "Add to this"');
    const facts = await sheetFacts();
    expectEqual(facts.Expenses, String(total), 'expenses in the backup');
    expectEqual(facts['New expenses added'], '0', 'new expenses');
    expectEqual(facts['Updated from the backup'], '0', 'updated');
    expectEqual(facts['Left as they are'], String(total), 'left as they are');
    expect(/passed every check/.test(await sheet().innerText()), 'it says the file passed every check');
    await snap('125-restore-same-file');
    await f.sheetAction('Restore').click();
    await f.waitToast('Added 0 expenses');
    await f.noLayers();
    expectEqual(sorted(await ledger()), sorted(original), 'the ledger is exactly as it was');
  });

  await step('Restoring adds back what was deleted, and only that', async () => {
    const gone = await state((app) => app.snapshot.expenses.slice(0, 7).map((e) => e.id));
    await state((app, ids) => app.services.expenses.deleteMany(ids), gone);
    expectEqual((await counts()).expenses, total - 7, 'seven expenses are gone');
    await restoreFrom(plain);
    const facts = await sheetFacts();
    expectEqual(facts['New expenses added'], '7', 'seven come back');
    expectEqual(facts['Left as they are'], String(total - 7), 'the rest are left alone');
    await snap('126-restore-add-back');
    await f.sheetAction('Restore').click();
    await f.waitToast('Added 7 expenses');
    await f.noLayers();
    expectEqual(sorted(await ledger()), sorted(original), 'the ledger is whole again');
  });

  let edited = null;
  let editedBackup = null;
  await step('A newer change in the app is kept; a newer one in the backup wins', async () => {
    // The app's clock is stopped at one moment in the tests, so time is moved on by hand.
    await page.clock.setFixedTime(hoursLater(1));
    edited = await page.evaluate(async () => {
      const app = window.__expensesApp;
      const { draftFromExpense } = await import('/js/core/models.js');
      const target = app.snapshot.expenses.find((e) => !e.hasExplicitTime);
      const draft = draftFromExpense(target, { hour: 12, minute: 0 });
      draft.merchant = 'Edited Later Cafe';
      await app.services.expenses.save(draft, app.today());
      return { id: target.id, before: target.merchant };
    });
    await restoreFrom(plain);
    let facts = await sheetFacts();
    expectEqual(facts['Updated from the backup'], '0', 'the older copy in the file does not overwrite');
    expectEqual(facts['Left as they are'], String(total), 'the edited expense is left as it is');
    await f.sheetAction('Restore').click();
    await f.waitToast('Added 0 expenses');
    await f.noLayers();
    const kept = await state((app, id) => app.snapshot.expenses.find((e) => e.id === id).merchant, edited.id);
    expectEqual(kept, 'Edited Later Cafe', 'the newer edit is still there');

    // A backup that includes the edit, then back to the old data, then the newer backup is merged in.
    editedBackup = (await backupToFile()).text;
    await page.clock.setFixedTime(hoursLater(2));
    await restoreFrom(plain, { mode: 'Replace all' });
    facts = await sheetFacts();
    expectEqual(facts['Expenses now in the app'], String(total), 'expenses now');
    expectEqual(facts['Expenses after restoring'], String(total), 'expenses after');
    await f.sheetAction('Restore').click();
    await f.waitDialog('Replace everything?');
    await f.dialogButton('Replace everything').click();
    await f.waitToast('Restored');
    await f.noLayers();
    const reverted = await state((app, id) => app.snapshot.expenses.find((e) => e.id === id).merchant, edited.id);
    expectEqual(reverted, edited.before, 'replacing brought the old merchant back');
    await restoreFrom(editedBackup);
    facts = await sheetFacts();
    expectEqual(facts['Updated from the backup'], '1', 'one expense is newer in the backup');
    await snap('127-restore-updates');
    await f.sheetAction('Restore').click();
    await f.waitToast('updated 1');
    await f.noLayers();
    const updated = await state((app, id) => app.snapshot.expenses.find((e) => e.id === id).merchant, edited.id);
    expectEqual(updated, 'Edited Later Cafe', 'the newer copy from the backup was taken');
  });

  await step('Replace all asks first, can be cancelled, and then makes the app match the backup', async () => {
    await page.evaluate(async () => {
      const app = window.__expensesApp;
      const { makeDraft } = await import('/js/core/models.js');
      const { parseMoney } = await import('/js/core/money.js');
      const parsed = parseMoney('77.00', app.currency);
      await app.services.expenses.save(makeDraft({
        amount: parsed.money, day: app.today(), timeZoneID: app.timeZone(), categoryID: app.snapshot.categories[0].id, merchant: 'Only In The App',
      }), app.today());
    });
    expectEqual((await counts()).expenses, total + 1, 'one extra expense that no backup has');
    await restoreFrom(plain, { mode: 'Replace all' });
    const facts = await sheetFacts();
    expectEqual(facts['Expenses now in the app'], String(total + 1), 'now');
    expectEqual(facts['Expenses after restoring'], String(total), 'after');
    expect(/removed and replaced by the backup/.test(await sheet().innerText()), 'it says everything now in the app is replaced');
    await snap('128-restore-replace');
    await f.sheetAction('Restore').click();
    await f.waitDialog('Replace everything?');
    const message = await f.dialog().locator('.dialog-message').innerText();
    expect(message.includes(`${total + 1} expenses`) && message.includes(`${total} expenses`), `the question gives both numbers (${message})`);
    await snap('129-restore-replace-confirm');
    await f.dialogButton('Cancel').click();
    await settle(300);
    expectEqual((await counts()).expenses, total + 1, 'cancelling changes nothing');
    expect(await sheet().locator('.navbar-title', { hasText: 'Restore' }).count() > 0, 'the Restore sheet is still open');
    await f.sheetAction('Restore').click();
    await f.waitDialog('Replace everything?');
    await f.dialogButton('Replace everything').click();
    await f.waitToast(`Restored ${total} expenses`);
    await f.noLayers();
    expectEqual(sorted(await ledger()), sorted(original), 'the app now matches the backup exactly');
    const now = await counts();
    expectEqual(now.budgets, originalCounts.budgets, 'budgets match');
    expectEqual(now.templates, originalCounts.templates, 'repeating expenses match');
  });

  await step('An empty app is filled from a backup without extra questions', async () => {
    await state((app) => app.services.data.deleteAllExpenses());
    expectEqual((await counts()).expenses, 0, 'everything deleted');
    await chooseBackupFile(plain);
    await waitSheet('Restore');
    expectEqual(await modeButton('Replace all').getAttribute('aria-pressed'), 'true', 'an empty app starts in "Replace all"');
    expect(/app is empty/.test(await sheet().innerText()), 'it says the app is empty');
    await f.sheetAction('Restore').click();
    await f.waitToast(`Restored ${total} expenses`);
    await f.noLayers();
    expectEqual(sorted(await ledger()), sorted(original), 'all expenses are back');
  });

  await step('A backup with a password asks for it, and a wrong one is refused', async () => {
    await chooseBackupFile(protectedFile.text);
    await f.waitDialog('Backup password');
    await snap('140-restore-password');
    await f.dialogInput().fill('Tulip-Harbour-00');
    await f.dialogButton('Open').click();
    await f.waitDialog('This backup cannot be used');
    const message = await f.dialog().locator('.dialog-message').innerText();
    expect(/password is wrong/i.test(message), `it says the password is wrong (${message})`);
    await snap('141-restore-password-wrong');
    await f.dialogButton('OK').click();
    await f.waitDialog('Backup password');
    await f.dialogButton('Cancel').click();
    await f.noLayers();
    expectEqual(await f.pageTitle(), 'Back up and restore', 'cancelling leaves the person where they were');
  });

  await step('The right password opens the backup and shows what it holds', async () => {
    await chooseBackupFile(protectedFile.text);
    await f.waitDialog('Backup password');
    await f.dialogInput().fill(BACKUP_PASSWORD);
    await f.dialogButton('Open').click();
    await waitSheet('Restore');
    const facts = await sheetFacts();
    expectEqual(facts.Expenses, String(total), 'expenses in the backup');
    expectEqual(facts.Budgets, '1', 'budgets in the backup');
    expectEqual(facts.Repeating, '1', 'repeating expenses in the backup');
    await f.sheetAction('Restore').click();
    await f.waitToast('Added 0 expenses');
    await f.noLayers();
  });

  await step('A damaged file is refused and nothing changes', async () => {
    const envelope = JSON.parse(plain);
    const flipped = envelope.payload.slice(0, 200) + (envelope.payload[200] === 'A' ? 'B' : 'A') + envelope.payload.slice(201);
    const message = await messageForBadFile(JSON.stringify({ ...envelope, payload: flipped }));
    expect(/damaged or was modified/i.test(message), `it says the file is damaged or was modified (${message})`);
    expectEqual(sorted(await ledger()), sorted(original), 'the data is untouched');
  });

  await step('A file that is not a backup is refused in plain words', async () => {
    const csv = 'Date,Amount\n2026-10-20,12.50\n';
    expectEqual(await messageForBadFile(csv, { name: 'expenses.csv', mimeType: 'text/csv' }), 'This file is not a backup made by this app.', 'a spreadsheet');
    expectEqual(await messageForBadFile('', { name: 'empty.json' }), 'This file is not a backup made by this app.', 'an empty file');
    expectEqual(await messageForBadFile('{"hello": "world"}'), 'This file is not a backup made by this app.', 'some other JSON');
    expectEqual(await messageForBadFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]), { name: 'photo.json' }), 'This file is not a backup made by this app.', 'a picture');
  });

  await step('A backup from a newer version of the app says so', async () => {
    const envelope = JSON.parse(plain);
    const message = await messageForBadFile(JSON.stringify({ ...envelope, formatVersion: 2 }));
    expect(/newer version of the app/i.test(message), `it says the backup is from a newer version (${message})`);
  });

  await step('A backup saved with a byte-order mark in front still opens', async () => {
    await restoreFrom(`﻿${plain}`);
    expectEqual((await sheetFacts()).Expenses, String(total), 'expenses in the backup');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  // ------------------------------------------------------------------------------------------ exporting for a spreadsheet

  await step('Export all as CSV gives a spreadsheet file that reads back exactly', async () => {
    const added = await addTrickyExpenses();
    const now = await ledger();
    expectEqual(now.length, total + added, 'the awkward expenses were added');
    await f.back();
    await shareSheet('none');
    await f.row('Export all as CSV').click();
    await waitSheet('Export ready');
    const facts = await sheetFacts();
    expectEqual(facts.File, CSV_NAME, 'file name');
    await snap('150-export-ready');
    const file = await takeDownload('Save or share the file');
    await f.waitToast(`${total + added} expenses saved as ${CSV_NAME}`);
    await f.noLayers();
    expectEqual(file.name, CSV_NAME, 'downloaded name');
    expect(file.text.charCodeAt(0) === 0xFEFF, 'the file starts with a byte-order mark so spreadsheets read Arabic and accents correctly');

    const rows = parseCSV(file.text);
    expectEqual(rows[0], [...CSV_COLUMNS], 'the header row');
    expectEqual(rows.length - 1, total + added, 'one row for each expense');
    // Rows end with CRLF (a line break inside a note is a bare LF inside quotes), and the file ends with one.
    expectEqual(file.text.split('\r\n').length, rows.length + 1, 'rows are separated by CRLF and the file ends with one');
    const byId = new Map(rows.slice(1).map((row) => [row[CSV_COLUMNS.indexOf('ID')], row]));
    expectEqual(sorted([...byId.keys()].map((id) => ({ id }))), sorted(now.map((e) => ({ id: e.id }))), 'the same expenses');
    for (const row of rows.slice(1)) expectEqual(row.length, CSV_COLUMNS.length, 'every row has every column');

    const col = (row, name) => row[CSV_COLUMNS.indexOf(name)];
    // Amounts and dates are exact and machine-readable; times only when one was entered.
    const timeIn = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (const e of now) {
      const row = byId.get(e.id);
      expectEqual(col(row, 'Amount'), (e.minor / 100).toFixed(2), `amount of ${e.id}`);
      expectEqual(col(row, 'Date'), e.day, `date of ${e.id}`);
      expectEqual(col(row, 'Currency'), e.currency, `currency of ${e.id}`);
      expectEqual(col(row, 'Time'), e.timed ? timeIn.format(e.at) : '', `time of ${e.id}`);
    }
    // Text that a spreadsheet would run as a formula gets a leading apostrophe; nothing else is changed.
    const tricky = (merchant) => rows.slice(1).find((row) => col(row, 'Merchant').replace(/^'/, '') === merchant);
    const formula = tricky('=HYPERLINK("http://example.invalid/x","Open me")');
    expect(formula, 'the formula-looking expense is in the file');
    expectEqual(col(formula, 'Merchant'), '\'=HYPERLINK("http://example.invalid/x","Open me")', 'merchant starting with =');
    expectEqual(col(formula, 'Notes'), '\'@SUM(A1:A9)', 'notes starting with @');
    const plus = tricky('+971 Taxi');
    expectEqual(col(plus, 'Merchant'), '\'+971 Taxi', 'merchant starting with +');
    expectEqual(col(plus, 'Notes'), '\'-2+3', 'notes starting with -');
    const cafe = rows.slice(1).find((row) => col(row, 'Merchant') === 'Café "Le Roi", Souq');
    expect(cafe, 'quotes and commas come through exactly');
    expectEqual(col(cafe, 'Notes'), 'First line\nSecond line, with "quotes"', 'a line break and quotes inside notes');
    expectEqual(col(cafe, 'Tags'), 'csv-test', 'tag');
    expect(rows.slice(1).some((row) => col(row, 'Merchant') === 'مطعم الشام ☕'), 'Arabic and emoji come through exactly');
    // No text column anywhere starts with a character a spreadsheet treats as a formula.
    for (const row of rows.slice(1)) {
      for (const name of ['Category', 'Subcategory', 'Payment Method', 'Merchant', 'Notes', 'Tags']) {
        expect(!/^[=+\-@\t\r]/.test(col(row, name)), `${name} "${col(row, name)}" could be run as a formula`);
      }
    }
    // A repeating-expense flag and the expense id are there for the spreadsheet user.
    expect(rows.slice(1).every((row) => ['Yes', 'No'].includes(col(row, 'Recurring'))), 'the Recurring column is Yes or No');
  });

  await step('Nothing to export says so instead of making an empty file', async () => {
    await state((app) => app.services.data.deleteAllExpenses());
    await f.row('Export all as CSV').click();
    await f.waitDialog('Nothing to export');
    await f.dialogButton('OK').click();
    await f.noLayers();
    await state((app) => app.services.data.deleteAllExpenses());
  });

  // ------------------------------------------------------------------------------------------ a new install, from a backup

  await step('A new install is filled from a backup file, with a passcode', async () => {
    await state((app) => app.eraseEverything());
    const restoreButton = page.getByRole('button', { name: 'Restore from a backup' });
    await restoreButton.waitFor({ timeout: 10_000 });
    await snap('160-welcome-after-erase');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), restoreButton.click()]);
    await chooser.setFiles({ name: BACKUP_NAME, mimeType: 'application/json', buffer: Buffer.from(plain, 'utf8') });
    await page.getByRole('button', { name: 'Restore my data' }).waitFor({ timeout: 10_000 });
    const text = await page.locator('main').innerText();
    expect(text.includes(String(total)) && /passed every check/.test(text), 'the restore page shows what is in the backup');
    await snap('161-welcome-restore');
    expect(await page.getByRole('button', { name: 'Restore my data' }).isDisabled(), 'restoring waits for a passcode');
    const fields = page.locator('.page input[type=password], .page input[type=text]');
    await fields.nth(0).fill(APP_PASSCODE);
    await fields.nth(1).fill(APP_PASSCODE);
    await page.getByRole('button', { name: 'Restore my data' }).click();
    await page.waitForSelector('.tabbar', { timeout: 30_000 });
    await settle(400);
    expectEqual(sorted(await ledger()), sorted(original), 'every expense is back');
    const now = await counts();
    expectEqual(now.budgets, originalCounts.budgets, 'budgets are back');
    expectEqual(now.templates, originalCounts.templates, 'repeating expenses are back');
    expect(await state((app) => app.lockEnabled), 'the passcode is on');
    expectEqual(await storageReadable(PROBES), [], 'sample words readable in the stored data');
    await snap('162-after-first-restore');
  });

  await step('With a passcode on, backing up and exporting ask for it first', async () => {
    await f.tab('Settings');
    await settle(300);
    await f.row('Back up and restore').click();
    await settle(350);
    await f.row('Back up now').click();
    await f.waitDialog('Enter your passcode');
    await f.dialogInput().fill('000000');
    await f.dialogButton('Continue').click();
    await f.waitDialog('That passcode is not right');
    await f.dialogButton('OK').click();
    await f.noLayers();
    await f.row('Back up now').click();
    await f.waitDialog('Enter your passcode');
    await f.dialogInput().fill(APP_PASSCODE);
    await f.dialogButton('Continue').click();
    await waitSheet('Back up');
    expect(/does not protect backup files/i.test(await sheet().innerText()), 'it says the app passcode does not protect the file');
    await snap('163-backup-with-passcode');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
    await f.back();
    await f.row('Export all as CSV').click();
    await f.waitDialog('Enter your passcode');
    await f.dialogButton('Cancel').click();
    await f.noLayers();
  });
} finally {
  console.log('\nproblems:', problems);
  console.log('leaked text:', leaks);
  failures = summary();
  await close();
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
}
process.exit(failures > 0 || problems.length > 0 || leaks.length > 0 ? 1 : 0);
