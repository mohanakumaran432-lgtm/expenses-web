// Repeating expenses and the messages Home shows about them (and about backups), end to end in a real browser: the form and what it
// says is missing, today's date waiting for a decision, confirming with a different amount, skipping, dates that already passed,
// automatic ones, the app being opened on a later day, pausing and resuming, editing, deleting, reminders, and the backup reminders.
// Run: SHOTS_DIR=... node tests/e2e/flows_recurring.mjs [light|dark]
import { launch, openApp, shot, startFresh, seed, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const { step, summary, settle } = makeRunner(page, `recurring-${scheme}`);
const f = finders(page);
const leaks = [];
const snap = async (name) => { await shot(page, `${name}-${scheme}`); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const state = (fn, arg) => inApp(page, fn, arg);
let failures = 0;

const T0 = new Date('2026-10-20T08:00:00Z'); // 20 Oct 2026, 12:00 in Dubai: "today" for the whole run, until the clock is moved on
const daysLater = (days) => new Date(T0.getTime() + days * 86_400_000);
const TODAY = '2026-10-20';
const isoDay = (offset) => new Date(Date.UTC(2026, 9, 20 + offset)).toISOString().slice(0, 10);

const sheet = () => page.locator('.layer').last();
const seg = (label) => sheet().locator('.seg').filter({ hasText: f.exact(label) });
const key = (digit) => sheet().locator('.keypad .key').filter({ hasText: new RegExp(`^${digit}$`) });
const backspace = () => sheet().getByRole('button', { name: 'Delete the last digit' });
const hint = () => sheet().locator('.form-hint');
const pageText = () => page.locator(TOP).first().innerText();
const toggle = (name) => sheet().getByRole('switch', { name });
const homeNotice = (text) => page.locator(`${TOP} .notice`, { hasText: text });

/** Taps digits on the on-screen keypad. */
async function typeAmount(text) {
  for (const digit of text) await key(digit).click();
}

const factsOf = (locator) => locator.evaluate((root) => {
  const out = {};
  for (const row of root.querySelectorAll('.row')) {
    const title = row.querySelector('.row-title');
    const value = row.querySelector('.row-value');
    if (title && value) out[title.textContent.trim()] = value.textContent.trim();
  }
  return out;
});
const pageFacts = () => factsOf(page.locator(TOP).first());

const expensesOf = (templateID) => state((app, id) => app.snapshot.expenses
  .filter((e) => e.recurringTemplateID === id)
  .map((e) => ({ id: e.id, day: e.localDay.toString(), minor: e.amount.minorUnits, key: e.occurrenceKey, category: app.snapshot.category(e.categoryID).name }))
  .sort((a, b) => (a.day < b.day ? -1 : 1)), templateID);
const templateNamed = (title) => state((app, name) => {
  const t = app.snapshot.templates.find((x) => x.title === name);
  return t ? { id: t.id, minor: t.amount.minorUnits, active: t.isActive, mode: t.mode, frequency: t.frequency, start: t.startDay.toString() } : null;
}, title);
const waiting = () => state((app) => app.waitingOccurrences().map((o) => ({ title: app.snapshot.templates.find((t) => t.id === o.templateID).title, due: o.dueDay.toString() })));
const expenseCount = () => state((app) => app.snapshot.expenses.length);
const skippedCount = (id) => state((app, templateID) => app.snapshot.recurrenceLog.filter((e) => e.templateID === templateID && e.outcome === 'skipped').length, id);

/** From the Settings tab to the list of repeating expenses. */
async function openList() {
  await state((app) => { app.ui.closeAll(); app.shell.popToRoot(); });
  await f.tab('Settings');
  await settle(250);
  await f.row('Repeating expenses').click();
  await settle(350);
  expectEqual(await f.pageTitle(), 'Repeating expenses', 'page title');
}
/** From the list to one schedule's page. */
async function openDetail(title) {
  await page.getByRole('button', { name: new RegExp(`^${title}, .*Open\\.$`) }).click();
  await settle(350);
}
async function chooseCategory(name) {
  await sheet().locator('.row', { hasText: 'Category' }).first().click();
  await settle(250);
  await f.sheetRow(name).click();
  await settle(250);
}
/** Fills the new-schedule form (not saved yet). */
async function fillForm({ name, amount, category, frequency = null, mode = null, start = null, past = null }) {
  await sheet().getByLabel('Name', { exact: true }).fill(name);
  await sheet().getByLabel('Name', { exact: true }).press('Enter');
  await typeAmount(amount);
  await chooseCategory(category);
  if (frequency) await seg(frequency).click();
  if (mode) await seg(mode).click();
  if (start) {
    await sheet().getByLabel('Starts', { exact: true }).fill(start);
    await sheet().getByLabel('Starts', { exact: true }).blur(); // the person closes the date picker
  }
  if (past) await seg(past).click();
}
async function openNewForm() {
  await page.getByRole('button', { name: 'Add a repeating expense' }).last().click();
  await settle(350);
}
async function save(toast = 'Repeating expense added') {
  await f.sheetAction('Save').click();
  await f.waitToast(toast);
  await f.noLayers();
  await settle(200);
}
async function waitSheetTitle(title) {
  await page.locator('.layer .navbar-title', { hasText: new RegExp(`^\\s*${title}\\s*$`) }).last().waitFor({ timeout: 8000 });
}
/** Empties the amount (extra taps on an empty amount do nothing) and types a new one. */
async function replaceAmount(text) {
  for (let i = 0; i < 12; i += 1) await backspace().click();
  await typeAmount(text);
}
/** An expense of today, added through the app's own service. */
const addExpense = (merchant, amountText) => page.evaluate(async ({ merchant: m, amountText: a }) => {
  const app = window.__expensesApp;
  const { makeDraft } = await import('/js/core/models.js');
  const { parseMoney } = await import('/js/core/money.js');
  const parsed = parseMoney(a, app.currency);
  await app.services.expenses.save(makeDraft({
    amount: parsed.money, day: app.today(), timeZoneID: app.timeZone(), categoryID: app.snapshot.categories[0].id, merchant: m,
  }), app.today());
}, { merchant, amountText });
const comeBack = () => page.evaluate(() => {
  const set = (value) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  set('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  set('visible');
  document.dispatchEvent(new Event('visibilitychange'));
});

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, { days: 30 });
  await f.tab('Settings');
  await settle(300);

  console.log(`\nRepeating expenses and Home messages (${scheme})`);

  // ------------------------------------------------------------------------------------------ the form

  await step('With none yet, the list invites the person to add one', async () => {
    expect((await f.row('Repeating expenses').innerText()).includes('0'), 'Settings counts zero');
    await f.row('Repeating expenses').click();
    await settle(350);
    expectEqual(await f.pageTitle(), 'Repeating expenses', 'page title');
    expect(/Nothing repeats yet/.test(await pageText()), 'the empty list says nothing repeats yet');
    await snap('180-recurring-empty');
  });

  await step('The form says what is missing, one thing at a time', async () => {
    await openNewForm();
    expectEqual(await sheet().locator('.navbar-title').innerText(), 'New repeating expense', 'sheet title');
    expect(await f.sheetAction('Save').isDisabled(), 'Save is off with nothing entered');
    expectEqual(await hint().innerText(), 'Give it a name.', 'first hint');
    await snap('181-recurring-new-empty');
    await sheet().getByLabel('Name', { exact: true }).fill('Rent');
    expectEqual(await hint().innerText(), 'Enter an amount.', 'second hint');
    expect(await sheet().locator('.keypad').isHidden(), 'while the name is being typed the keypad steps aside for the keyboard');
    await sheet().getByLabel('Name', { exact: true }).press('Enter');
    expect(await sheet().locator('.keypad').isVisible(), 'Return ends the typing and the keypad comes back');
    await typeAmount('6500');
    expectEqual(await hint().innerText(), 'Choose a category.', 'third hint');
    expect(await f.sheetAction('Save').isDisabled(), 'Save is still off');
    await chooseCategory('Rent & Housing');
    expectEqual(await hint().innerText(), '', 'nothing left to say');
    expect(!(await f.sheetAction('Save').isDisabled()), 'Save is on');
    expect(/Next: /.test(await sheet().innerText()), 'the form says when the next dates are');
    await snap('182-recurring-new-filled');
  });

  await step('"Every" needs a whole number, and a last date cannot come before the first', async () => {
    const every = sheet().getByLabel('Repeat every how many');
    for (const bad of ['0', '400']) {
      await every.fill(bad);
      expectEqual(await hint().innerText(), 'Repeat every a whole number from 1 to 365.', `hint for ${bad}`);
      expect(await f.sheetAction('Save').isDisabled(), `Save is off for ${bad}`);
    }
    await every.fill('1');
    expect(!(await f.sheetAction('Save').isDisabled()), 'a good number turns Save back on');
    await toggle(/Stop on a date/).check({ force: true });
    await sheet().getByLabel('Ends', { exact: true }).fill(isoDay(-1));
    expectEqual(await hint().innerText(), 'The last date cannot be before the start date.', 'hint for a last date before the first');
    expect(await f.sheetAction('Save').isDisabled(), 'Save is off');
    await sheet().getByLabel('Ends', { exact: true }).fill(isoDay(365));
    expect(!(await f.sheetAction('Save').isDisabled()), 'a later last date is fine');
    await toggle(/Stop on a date/).uncheck({ force: true });
  });

  await step('Closing a changed form asks before throwing it away', async () => {
    await f.sheetAction('Cancel').click();
    await f.waitDialog('Discard your changes?');
    await f.dialogButton('Keep editing').click();
    await settle(250);
    expectEqual(await sheet().locator('.navbar-title').innerText(), 'New repeating expense', 'the form is still open');
    expectEqual(await sheet().getByLabel('Name', { exact: true }).inputValue(), 'Rent', 'and keeps what was typed');
  });

  // ------------------------------------------------------------------------------------------ waiting, confirming

  let rent = null;
  await step('Saving adds the schedule, and today\'s date waits for the person to decide', async () => {
    const before = await expenseCount();
    await save();
    rent = await templateNamed('Rent');
    expect(rent, 'the schedule exists');
    expectEqual([rent.minor, rent.mode, rent.frequency, rent.start], [650000, 'askToConfirm', 'monthly', TODAY], 'what was saved');
    expectEqual(await expenseCount(), before, 'nothing was added to the expenses without a confirmation');
    expectEqual(await waiting(), [{ title: 'Rent', due: TODAY }], 'one date is waiting');
    const text = await pageText();
    expect(/Waiting for you/.test(text) && /Due today/.test(text), 'the list shows it waiting');
    expect(/Next 20 Nov/.test(text), `and the next date after it (page says "${text.replace(/\s+/g, ' ').slice(0, 300)}")`);
    await snap('183-recurring-list-waiting');
  });

  await step('Home says something is waiting; Review opens it', async () => {
    await f.tab('Home');
    await settle(350);
    expect(await homeNotice('A repeating expense is waiting').count() > 0, 'Home has the message');
    await snap('184-home-waiting');
    await page.locator(`${TOP} .notice button.link`, { hasText: 'Review' }).click();
    await waitSheetTitle('Waiting for you');
    expect(/Rent/.test(await sheet().innerText()) && /Due today/.test(await sheet().innerText()), 'the sheet lists Rent, due today');
    await snap('185-waiting-sheet');
    await sheet().locator('.row', { hasText: 'Rent' }).first().click();
    await waitSheetTitle('Confirm expense');
    const shown = await sheet().locator('.amount-display').innerText();
    expect(/6,500/.test(shown), `the usual amount is filled in (${shown})`);
    await snap('186-confirm-sheet');
  });

  await step('Confirming with a different amount adds a real expense dated on its due date', async () => {
    await replaceAmount('650');
    const shown = await sheet().locator('.amount-display').innerText();
    expect(/650/.test(shown) && !/6,500/.test(shown), `the amount can be changed first (${shown.replace(/\s+/g, ' ')})`);
    await f.sheetAction('Add').click();
    await f.waitToast('Expense added');
    await f.noLayers();
    const made = await expensesOf(rent.id);
    expectEqual(made.length, 1, 'one expense was added');
    expectEqual([made[0].day, made[0].minor, made[0].category, made[0].key], [TODAY, 65000, 'Rent & Housing', `${rent.id}#${TODAY}`], 'the expense');
    expectEqual((await templateNamed('Rent')).minor, 650000, 'the usual amount of the schedule is unchanged');
    expectEqual(await waiting(), [], 'nothing is waiting now');
    await settle(300);
    expect(await homeNotice('repeating expense').count() === 0, 'Home no longer shows the message');
  });

  await step('The page of one schedule shows its rules, what is coming and what was added', async () => {
    await openList();
    expect(!/Waiting for you/.test(await pageText()), 'nothing is waiting in the list');
    await openDetail('Rent');
    expectEqual(await f.pageTitle(), 'Rent', 'page title');
    const text = await pageText();
    expect(/Every month/.test(text) && /6,500\.00/.test(text), 'it shows the rhythm and the usual amount');
    for (const next of ['20 Nov 2026', '20 Dec 2026', '20 Jan 2027', '20 Feb 2027', '20 Mar 2027']) expect(text.includes(next), `Coming up lists ${next}`);
    const facts = await pageFacts();
    expectEqual([facts.Starts, facts.Ends, facts['On each date'], facts.Reminder], ['20 Oct 2026', 'Never', 'Ask me to confirm', 'Off'], 'schedule rows');
    expectEqual([facts['Added so far'], facts.Skipped], ['1', '0'], 'history rows');
    await snap('187-recurring-detail');
    await f.row('Added so far').click();
    await settle(400);
    expect(/Added from this schedule/.test(await pageText()), 'the history page opens');
    await snap('188-recurring-added-so-far');
    await f.back();
  });

  // ------------------------------------------------------------------------------------------ earlier dates, skipping

  await step('Dates that already passed can be offered, and a skipped one is never offered again', async () => {
    await f.back();
    await openNewForm();
    await fillForm({ name: 'Water', amount: '80', category: 'Bills & Utilities', frequency: 'Weekly', start: isoDay(-15) });
    const note = await sheet().innerText();
    expect(/3 earlier dates will not be added/.test(note), 'by default earlier dates are skipped, and it says how many');
    await seg('Add them').click();
    const earlier = await sheet().locator('section.section', { hasText: 'Dates already passed' }).innerText();
    expect(/3 earlier dates will be offered for you to confirm/.test(earlier), `choosing "Add them" changes the sentence (it says "${earlier.replace(/\s+/g, ' ')}")`);
    await snap('189-recurring-earlier-dates');
    await save();
    expectEqual((await waiting()).map((w) => w.due), [isoDay(-15), isoDay(-8), isoDay(-1)], 'three dates are waiting');

    await page.getByRole('button', { name: new RegExp(`^Water, due .*Confirm or skip\\.$`) }).first().click();
    await waitSheetTitle('Confirm expense');
    await f.sheetButton('Skip this one').click();
    await f.waitDialog('Skip this one?');
    await f.dialogButton('Skip').click();
    await f.waitToast('Skipped');
    await f.noLayers();
    expectEqual((await waiting()).map((w) => w.due), [isoDay(-8), isoDay(-1)], 'the skipped date is gone');
    const water = await templateNamed('Water');
    expectEqual(await skippedCount(water.id), 1, 'it is counted as skipped');
    await state((app) => app.afterOpen());
    await settle(300);
    expectEqual((await waiting()).map((w) => w.due), [isoDay(-8), isoDay(-1)], 'opening the app again does not offer it again');

    await page.getByRole('button', { name: new RegExp(`^Water, due .*Confirm or skip\\.$`) }).first().click();
    await waitSheetTitle('Confirm expense');
    await f.sheetAction('Add').click();
    await f.waitToast('Expense added');
    await f.noLayers();
    const made = await expensesOf(water.id);
    expectEqual(made.map((e) => [e.day, e.minor]), [[isoDay(-8), 8000]], 'the expense is dated on the day it was due, not today');
    expectEqual((await waiting()).map((w) => w.due), [isoDay(-1)], 'one date is still waiting');
  });

  await step('An automatic schedule adds what is due on its own, once, including earlier dates when asked', async () => {
    await openNewForm();
    await fillForm({ name: 'Gym', amount: '299', category: 'Fitness & Wellness', frequency: 'Weekly', mode: 'Add it', start: isoDay(-15), past: 'Add them' });
    expect(/3 earlier dates will be added to your expenses right away/.test(await sheet().innerText()), 'it says they are added right away');
    await save();
    await f.waitToast('3 repeating expenses were added');
    const gym = await templateNamed('Gym');
    const made = await expensesOf(gym.id);
    expectEqual(made.map((e) => [e.day, e.minor]), [[isoDay(-15), 29900], [isoDay(-8), 29900], [isoDay(-1), 29900]], 'three expenses on their own dates');
    const count = await expenseCount();
    await state((app) => app.afterOpen());
    await state((app) => app.afterOpen());
    await settle(400);
    expectEqual(await expenseCount(), count, 'opening the app again adds nothing twice');
    const text = await pageText();
    expect(/Gym/.test(text) && /Next 26 Oct/.test(text), `the list shows its next date (${text.replace(/\s+/g, ' ').slice(0, 400)})`);
    await snap('190-recurring-list-all');
  });

  // ------------------------------------------------------------------------------------------ edit

  await step('Editing changes the schedule from now on and leaves what was recorded alone', async () => {
    await openDetail('Rent');
    await f.button('Edit').click();
    await settle(400);
    expectEqual(await sheet().locator('.navbar-title').innerText(), 'Edit repeating expense', 'sheet title');
    expect(!(await f.sheetAction('Save').isDisabled()), 'a stored schedule can be saved as it is');
    await snap('191-recurring-edit');
    await sheet().getByLabel('Name', { exact: true }).fill('Rent (flat)');
    await sheet().getByLabel('Name', { exact: true }).press('Enter');
    await replaceAmount('6700');
    await save('Repeating expense updated');
    expectEqual(await f.pageTitle(), 'Rent (flat)', 'the page shows the new name');
    expect(/6,700\.00/.test(await pageText()), 'and the new usual amount');
    const edited = await templateNamed('Rent (flat)');
    expectEqual(edited.minor, 670000, 'stored amount');
    const made = await expensesOf(rent.id);
    expectEqual(made.map((e) => [e.day, e.minor]), [[TODAY, 65000]], 'the expense that was already added is untouched');
    expectEqual(await waiting(), [{ title: 'Water', due: isoDay(-1) }], 'editing did not make anything wait');
  });

  // ------------------------------------------------------------------------------------------ reminders on Home

  await step('A reminder shows on Home a few days before a date, and can be dismissed', async () => {
    await f.back();
    await f.back();
    await f.tab('Settings');
    await f.row('Notifications').click();
    await settle(300);
    await page.getByRole('switch', { name: /Repeating expense reminders/ }).check({ force: true });
    await settle(300);
    await f.back();
    await f.row('Repeating expenses').click();
    await settle(300);
    await openNewForm();
    await fillForm({ name: 'Internet', amount: '249', category: 'Bills & Utilities', start: isoDay(2) });
    await toggle(/Remind me on Home/).check({ force: true });
    await sheet().locator('button.row', { hasText: 'Remind me' }).click();
    await f.actionItem('3 days before').click();
    await settle(250);
    expect(/Reminders only appear while the app is open/.test(await sheet().innerText()), 'the form is honest that reminders appear only while the app is open');
    await snap('192-recurring-reminder-form');
    await save();
    await f.tab('Home');
    await settle(400);
    const notice = homeNotice('Internet is due in 2 days');
    expect(await notice.count() > 0, 'Home shows the reminder');
    expect(/249\.00 on 22 Oct 2026\. You will be asked to confirm it\./.test(await notice.first().innerText()), 'with the amount, the date and what will happen');
    await snap('193-home-reminder');
    await notice.first().getByRole('button', { name: 'Dismiss' }).click();
    await settle(250);
    expect(await homeNotice('Internet is due').count() === 0, 'dismissing hides it');
    await state((app) => app.shell.refresh());
    expect(await homeNotice('Internet is due').count() === 0, 'and it stays hidden while the app is open');
  });

  await step('Turning reminders off in Settings hides them', async () => {
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
    await page.waitForSelector('.tabbar', { timeout: 15_000 });
    await settle(400);
    expect(await homeNotice('Internet is due').count() > 0, 'after a restart the reminder shows again (dismissing lasts while the app stays open)');
    await f.tab('Settings');
    await f.row('Notifications').click();
    await settle(300);
    await page.getByRole('switch', { name: /Repeating expense reminders/ }).uncheck({ force: true });
    await settle(300);
    await f.back();
    await f.tab('Home');
    await settle(400);
    expect(await homeNotice('Internet is due').count() === 0, 'the reminder is gone');
  });

  // ------------------------------------------------------------------------------------------ a later day

  await step('When the app is opened on a later day, what fell due is added or offered', async () => {
    await page.clock.setFixedTime(daysLater(8)); // 28 Oct
    const gym = await templateNamed('Gym');
    const before = (await expensesOf(gym.id)).length;
    const recurringBefore = await state((app) => app.snapshot.expenses.filter((e) => e.recurringTemplateID).length);
    await comeBack();
    await page.waitForFunction((n) => window.__expensesApp.snapshot.expenses.filter((e) => e.recurringTemplateID).length > n, recurringBefore, { timeout: 8000 });
    await f.waitToast('1 repeating expense was added');
    const made = await expensesOf(gym.id);
    expectEqual(made.length, before + 1, 'one more Gym expense');
    expectEqual(made[made.length - 1].day, isoDay(6), 'dated on the day it fell due (26 Oct), not the day the app was opened');
    const w = await waiting();
    expect(w.some((x) => x.title === 'Water' && x.due === isoDay(6)), `Water's new date is waiting (${JSON.stringify(w)})`);
    await state((app) => app.shell.refresh());
    expect(await homeNotice('repeating expenses are waiting').count() > 0, 'Home says more than one is waiting');
    await snap('194-home-later-day');
  });

  await step('Pausing stops a schedule; resuming does not bring back the dates that passed meanwhile', async () => {
    await openList();
    await openDetail('Gym');
    await f.button('Pause').click();
    await f.waitToast('Paused');
    await settle(300);
    expect(/Paused/.test(await pageText()) && /Resuming does not add the dates that passed/.test(await pageText()), 'the page says it is paused');
    await snap('195-recurring-paused');
    const gym = await templateNamed('Gym');
    expectEqual(gym.active, false, 'stored as paused');
    const count = await expenseCount();
    await page.clock.setFixedTime(daysLater(22)); // 11 Nov
    await state((app) => app.afterOpen());
    await settle(500);
    expectEqual((await expensesOf(gym.id)).length, 4, 'nothing was added while it was paused');
    await f.button('Resume').click();
    await f.waitToast('Resumed');
    await settle(400);
    expectEqual((await expensesOf(gym.id)).length, 4, 'resuming added none of the dates that passed');
    expectEqual(await skippedCount(gym.id), 2, 'the two dates that passed (2 and 9 Nov) are marked skipped');
    expect(/16 Nov 2026/.test(await pageText()), 'the next date is the first one after today');
    await f.back();
    expectEqual(await expenseCount(), count, 'no other expense was added either');
  });

  // ------------------------------------------------------------------------------------------ deleting

  await step('A schedule can be deleted from its form or its page; what it recorded stays', async () => {
    const water = await templateNamed('Water');
    await openList();
    await openDetail('Water');
    await f.button('Edit').click();
    await settle(400);
    await sheet().getByRole('button', { name: 'Delete repeating expense' }).click();
    await f.waitDialog('Delete this repeating expense?');
    await f.dialogButton('Cancel').click();
    await settle(300);
    expect(await templateNamed('Water'), 'cancelling keeps it');
    expectEqual(await sheet().locator('.navbar-title').innerText(), 'Edit repeating expense', 'and the form stays open');
    await sheet().getByRole('button', { name: 'Delete repeating expense' }).click();
    await f.waitDialog('Delete this repeating expense?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Repeating expense deleted');
    await f.noLayers();
    await settle(400);
    expectEqual(await f.pageTitle(), 'Repeating expenses', 'the person lands on the list, not on a page about something that is gone');
    expectEqual(await templateNamed('Water'), null, 'Water is gone');
    expect(!(await waiting()).some((w) => w.title === 'Water'), 'its waiting dates are gone with it');
    expectEqual(await state((app, id) => app.snapshot.expenses.filter((e) => e.recurringTemplateID === id).length, water.id), 1, 'the expense it added is still there');

    await openDetail('Rent \\(flat\\)');
    await f.button('Delete').click();
    await f.waitDialog('Delete this repeating expense?');
    expect(/The 1 expense it already added stay/.test(await f.dialog().locator('.dialog-message').innerText()), 'the question says the added expense stays');
    await f.dialogButton('Cancel').click();
    await f.noLayers();
    expect(await templateNamed('Rent (flat)'), 'cancelling keeps it');
    await f.button('Delete').click();
    await f.waitDialog('Delete this repeating expense?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Repeating expense deleted');
    await settle(400);
    expectEqual(await f.pageTitle(), 'Repeating expenses', 'back on the list');
    expectEqual(await templateNamed('Rent (flat)'), null, 'Rent is gone');
    expectEqual((await expensesOf(rent.id)).length, 1, 'its expense stays');
    await snap('196-recurring-after-deletes');
  });

  // ------------------------------------------------------------------------------------------ the backup messages

  await step('Home asks for a first backup once the data is a couple of days old, and the message can be put off', async () => {
    await state((app) => app.shell.popToRoot());
    await f.tab('Home');
    await state((app) => app.shell.refresh());
    await settle(400);
    expect(await homeNotice('Make your first backup').count() > 0, 'Home asks for a first backup');
    await snap('197-home-first-backup');
    await homeNotice('Make your first backup').getByRole('button', { name: 'Dismiss' }).click();
    await settle(250);
    expect(await homeNotice('Make your first backup').count() === 0, 'dismissing hides it');
    await page.clock.setFixedTime(daysLater(22 + 3));
    await state((app) => app.shell.refresh());
    expect(await homeNotice('Make your first backup').count() === 0, 'it stays away for a week');
    await page.clock.setFixedTime(daysLater(22 + 9));
    await state((app) => app.shell.refresh());
    expect(await homeNotice('Make your first backup').count() > 0, 'and comes back after that');
    await homeNotice('Make your first backup').getByRole('button', { name: 'Back up' }).click();
    await settle(400);
    expectEqual(await f.pageTitle(), 'Back up and restore', 'its button goes to the backup page');
  });

  await step('After a backup, Home asks again only when a month has passed and something changed', async () => {
    const madeAt = daysLater(22 + 9);
    await page.evaluate((ms) => { localStorage.setItem('expenses.lastBackupAt', String(ms)); localStorage.removeItem('expenses.backupReminderSnoozedUntil'); }, madeAt.getTime());
    await state((app) => app.shell.popToRoot());
    await f.tab('Home');
    await page.clock.setFixedTime(daysLater(22 + 9 + 31));
    await state((app) => app.shell.refresh());
    await settle(300);
    expect(await homeNotice('Time for a new backup').count() === 0, 'a month later, with nothing changed since the backup, there is no message');
    await addExpense('Something new', '15.00');
    await settle(400);
    const notice = homeNotice('Time for a new backup');
    expect(await notice.count() > 0, 'once something was added, Home asks for a new backup');
    expect(/Your last backup was 31 days ago, and you have added or changed expenses since/.test(await notice.first().innerText()), 'it says how long ago and why');
    await snap('198-home-new-backup');
  });
} finally {
  console.log('\nproblems:', problems);
  console.log('leaked text:', leaks);
  failures = summary();
  await close();
}
process.exit(failures > 0 || problems.length > 0 || leaks.length > 0 ? 1 : 0);

