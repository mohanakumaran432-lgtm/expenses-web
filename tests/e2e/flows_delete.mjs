// Deleting data, end to end in a real browser: expenses in a date range (both ends included), all expenses (typed word), budgets,
// repeating expenses, and "Erase everything" (with and without a passcode). Each step checks what is left, not only what is shown.
// Run: SHOTS_DIR=... node tests/e2e/flows_delete.mjs [light|dark]
import { launch, openApp, shot, startFresh, seed, seedExtras, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const { step, summary, settle } = makeRunner(page, `delete-${scheme}`);
const f = finders(page);
const leaks = [];
const snap = async (name) => { await shot(page, `${name}-${scheme}`); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const state = (fn, arg) => inApp(page, fn, arg);
let failures = 0;
const APP_PASSCODE = '482915';

const sheet = () => page.locator('.layer').last();
const ledger = () => state((app) => app.snapshot.expenses.map((e) => ({ id: e.id, day: e.localDay.toString() })));
const counts = () => state((app) => ({
  expenses: app.snapshot.expenses.length, budgets: app.snapshot.budgets.length, templates: app.snapshot.templates.length,
  categories: app.snapshot.categories.length, methods: app.snapshot.paymentMethods.length, tags: app.snapshot.tags.length,
  currency: app.settings.currencyCode,
}));
const rowText = async (name) => (await f.row(name).innerText()).replace(/\s+/g, ' ').trim();

/** Fills the two dates of the "Delete expenses from" sheet. */
async function chooseDates(from, to) {
  await sheet().getByLabel('From', { exact: true }).fill(from);
  await sheet().getByLabel('To', { exact: true }).fill(to);
}

/** What the browser keeps for this app: database records and the small notes in local storage. */
const storedThings = () => page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  let records = 0;
  for (const { name } of dbs) {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    for (const store of Array.from(db.objectStoreNames)) {
      records += await new Promise((resolve, reject) => { const r = db.transaction(store, 'readonly').objectStore(store).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    }
    db.close();
  }
  const notes = Object.keys(localStorage).filter((key) => key.startsWith('expenses.'));
  return { records, notes };
});

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  await seedExtras(page, url);
  const start = await counts();
  const all = await ledger();
  await f.tab('Settings');
  await settle(300);

  console.log(`\nDelete data (${scheme})`);

  await step('The Delete data page shows what there is and says backup files are not touched', async () => {
    await f.row('Delete data').click();
    await settle(350);
    expectEqual(await f.pageTitle(), 'Delete data', 'page title');
    const text = await page.locator(TOP).innerText();
    expect(/Backup files are not touched/.test(text), 'it says backup files are not touched');
    expect((await rowText('All expenses')).includes(String(start.expenses)), 'the number of expenses is shown');
    expect((await rowText('All budgets')).includes('1'), 'the number of budgets is shown');
    expect((await rowText('All repeating expenses')).includes('1'), 'the number of repeating expenses is shown');
    await snap('170-delete-page');
  });

  // The busiest day, so that "both ends are included" has something to prove.
  const perDay = new Map();
  for (const e of all) perDay.set(e.day, (perDay.get(e.day) || 0) + 1);
  const busiest = [...perDay.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const within = (a, b) => all.filter((e) => e.day >= a && e.day <= b).length;

  await step('A range with no expenses says so and deletes nothing', async () => {
    await f.row('Expenses in a date range').click();
    await settle(300);
    await chooseDates('2020-01-01', '2020-01-31');
    await f.sheetAction('Review').click();
    await f.waitDialog('Nothing to delete');
    await f.dialogButton('OK').click();
    await f.noLayers();
    expectEqual((await counts()).expenses, start.expenses, 'nothing changed');
  });

  await step('An end date before the start date is refused where the dates are chosen', async () => {
    await f.row('Expenses in a date range').click();
    await settle(300);
    await chooseDates('2026-10-10', '2026-10-01');
    await f.sheetAction('Review').click();
    await settle(200);
    expect(/end date cannot be before the start date/i.test(await sheet().innerText()), 'it says the end date cannot be before the start date');
    expect(await sheet().locator('.navbar-title', { hasText: 'Delete expenses from' }).count() > 0, 'the sheet stays open');
    await snap('171-delete-range-error');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  await step('One day: both ends are included, and the days around it are left alone', async () => {
    const [day, many] = busiest;
    expect(many >= 1, 'the sample data has a day with expenses');
    await f.row('Expenses in a date range').click();
    await settle(300);
    await chooseDates(day, day);
    await snap('172-delete-range-sheet');
    await f.sheetAction('Review').click();
    await f.waitDialog(`Delete ${many} expense${many === 1 ? '' : 's'}?`);
    const message = await f.dialog().locator('.dialog-message').innerText();
    expect(/Budgets, categories and settings stay/.test(message) && /cannot be undone, except from a backup/.test(message), `the question says what stays and that it cannot be undone (${message})`);
    await snap('173-delete-range-confirm');
    await f.dialogButton('Cancel').click();
    await f.noLayers();
    expectEqual((await counts()).expenses, start.expenses, 'cancelling deletes nothing');

    await f.row('Expenses in a date range').click();
    await settle(300);
    await chooseDates(day, day);
    await f.sheetAction('Review').click();
    await f.waitDialog('Delete');
    await f.dialogButton(`Delete ${many} expense${many === 1 ? '' : 's'}`).click();
    await f.waitToast(`${many} expense${many === 1 ? '' : 's'} deleted`);
    const left = await ledger();
    expectEqual(left.length, start.expenses - many, 'only that day was deleted');
    expect(!left.some((e) => e.day === day), 'nothing from that day is left');
    expectEqual(left.length, all.length - within(day, day), 'the other days are untouched');
    const now = await counts();
    expectEqual([now.budgets, now.templates, now.categories, now.currency], [start.budgets, start.templates, start.categories, start.currency], 'budgets, repeating expenses, categories and settings stay');
  });

  await step('A longer range deletes exactly the expenses inside it', async () => {
    const before = await ledger();
    const first = '2026-09-01';
    const last = '2026-09-15';
    const expected = before.filter((e) => e.day >= first && e.day <= last).length;
    expect(expected > 5, `the range has expenses (${expected})`);
    await f.row('Expenses in a date range').click();
    await settle(300);
    await chooseDates(first, last);
    await f.sheetAction('Review').click();
    await f.waitDialog(`Delete ${expected} expenses?`);
    await f.dialogButton(`Delete ${expected} expenses`).click();
    await f.waitToast(`${expected} expenses deleted`);
    const after = await ledger();
    expectEqual(after.length, before.length - expected, 'count after');
    expect(!after.some((e) => e.day >= first && e.day <= last), 'nothing inside the range is left');
    expectEqual(after.filter((e) => e.day < first || e.day > last).length, before.filter((e) => e.day < first || e.day > last).length, 'everything outside the range is left');
    await settle(300);
    expect((await rowText('All expenses')).includes(String(after.length)), 'the page shows the new number');
  });

  await step('Deleting all expenses needs two steps and the word DELETE', async () => {
    const before = (await counts()).expenses;
    await f.row('All expenses').click();
    await f.waitDialog(`Delete all ${before} expenses?`);
    await f.dialogButton('Cancel').click();
    await f.noLayers();
    expectEqual((await counts()).expenses, before, 'cancelling at the first question deletes nothing');

    await f.row('All expenses').click();
    await f.waitDialog('Delete all');
    await f.dialogButton('Continue').click();
    await f.waitDialog('Type DELETE to confirm');
    await snap('174-delete-all-type');
    await f.dialogInput().fill('please');
    await f.dialogButton('Delete').click();
    await f.waitDialog('Nothing was deleted');
    await f.dialogButton('OK').click();
    await f.noLayers();
    expectEqual((await counts()).expenses, before, 'the wrong word deletes nothing');

    await f.row('All expenses').click();
    await f.waitDialog('Delete all');
    await f.dialogButton('Continue').click();
    await f.waitDialog('Type DELETE to confirm');
    await f.dialogInput().fill('delete');
    await f.dialogButton('Delete').click();
    await f.waitToast(`${before} expenses deleted`);
    const now = await counts();
    expectEqual(now.expenses, 0, 'no expenses are left');
    expectEqual([now.budgets, now.templates, now.categories, now.currency], [start.budgets, start.templates, start.categories, start.currency], 'budgets, repeating expenses, categories and settings stay');
    await settle(300);
    expect(await f.row('All expenses').isDisabled(), 'the row is switched off when there is nothing to delete');
    expect(/No expenses yet/.test(await rowText('Expenses in a date range')), 'the range row says there are no expenses yet');
    await snap('175-delete-none-left');
  });

  await step('Budgets and repeating expenses are deleted on their own, after one question each', async () => {
    await f.row('All budgets').click();
    await f.waitDialog('Delete 1 budget?');
    await f.dialogButton('Cancel').click();
    await f.noLayers();
    expectEqual((await counts()).budgets, 1, 'cancelling keeps the budget');
    await f.row('All budgets').click();
    await f.waitDialog('Delete 1 budget?');
    await f.dialogButton('Delete').click();
    await f.waitToast('1 budget deleted');
    expectEqual((await counts()).budgets, 0, 'the budget is gone');
    expect(await f.row('All budgets').isDisabled(), 'the budgets row is switched off now');

    await f.row('All repeating expenses').click();
    await f.waitDialog('Delete 1 repeating expense?');
    await f.dialogButton('Delete').click();
    await f.waitToast('1 repeating expense deleted');
    const now = await counts();
    expectEqual(now.templates, 0, 'the repeating expense is gone');
    expectEqual([now.categories, now.currency], [start.categories, start.currency], 'categories and settings stay');
    expect(await f.row('All repeating expenses').isDisabled(), 'the repeating row is switched off now');
  });

  await step('Erase everything asks twice, wants the word ERASE, and returns to the welcome screen', async () => {
    await state(async (app) => { await app.services.data.deleteAllExpenses(); });
    await seed(page, url, { days: 20 });
    await seedExtras(page, url);
    await settle(300);
    await f.row('Erase everything').click();
    await f.waitDialog('Erase everything?');
    await snap('176-erase-first');
    await f.dialogButton('Cancel').click();
    await f.noLayers();
    expect((await counts()).expenses > 0, 'cancelling erases nothing');

    await f.row('Erase everything').click();
    await f.waitDialog('Erase everything?');
    await f.dialogButton('Continue').click();
    await f.waitDialog('Type ERASE to confirm');
    await f.dialogInput().fill('erased');
    await f.dialogButton('Erase everything').click();
    await f.waitDialog('Nothing was erased');
    await f.dialogButton('OK').click();
    await f.noLayers();
    expect((await counts()).expenses > 0, 'the wrong word erases nothing');

    await f.row('Erase everything').click();
    await f.waitDialog('Erase everything?');
    await f.dialogButton('Continue').click();
    await f.waitDialog('Type ERASE to confirm');
    await f.dialogInput().fill('erase');
    await f.dialogButton('Erase everything').click();
    await page.getByRole('button', { name: 'Set up' }).waitFor({ timeout: 15_000 });
    await snap('177-after-erase');
    const kept = await storedThings();
    expectEqual(kept.records, 0, 'records left in the browser database');
    expectEqual(kept.notes, [], 'notes left in local storage');
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
    await page.getByRole('button', { name: 'Set up' }).waitFor({ timeout: 10_000 });
    expectEqual((await storedThings()).records, 0, 'records after reloading');
  });

  await step('With a passcode on, Erase everything asks for it first', async () => {
    await startFresh(page, { passcode: APP_PASSCODE });
    await seed(page, url, { days: 12 });
    await f.tab('Settings');
    await settle(300);
    await f.row('Delete data').click();
    await settle(350);
    await f.row('Erase everything').click();
    await f.waitDialog('Enter your passcode');
    await f.dialogInput().fill('000000');
    await f.dialogButton('Continue').click();
    await f.waitDialog('That passcode is not right');
    await f.dialogButton('OK').click();
    await f.noLayers();
    expect((await counts()).expenses > 0, 'a wrong passcode erases nothing and does not even ask about erasing');

    await f.row('Erase everything').click();
    await f.waitDialog('Enter your passcode');
    await f.dialogInput().fill(APP_PASSCODE);
    await f.dialogButton('Continue').click();
    await f.waitDialog('Erase everything?');
    await f.dialogButton('Continue').click();
    await f.waitDialog('Type ERASE to confirm');
    await f.dialogInput().fill('ERASE');
    await f.dialogButton('Erase everything').click();
    await page.getByRole('button', { name: 'Set up' }).waitFor({ timeout: 15_000 });
    expectEqual(await state((app) => app.lockEnabled), false, 'the passcode is gone too');
    const kept = await storedThings();
    expectEqual(kept.records, 0, 'records left in the browser database');
    expectEqual(kept.notes, [], 'notes left in local storage');
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
    await page.getByRole('button', { name: 'Set up' }).waitFor({ timeout: 10_000 });
    await snap('178-fresh-again');
  });
} finally {
  console.log('\nproblems:', problems);
  console.log('leaked text:', leaks);
  failures = summary();
  await close();
}
process.exit(failures > 0 || problems.length > 0 || leaks.length > 0 ? 1 : 0);
