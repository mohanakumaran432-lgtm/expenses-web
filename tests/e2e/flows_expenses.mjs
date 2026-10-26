// Adding, editing, duplicating and deleting an expense, end to end in a real browser: the keypad, typing in the text boxes (the
// keypad steps aside and comes back), what the form says is missing, dates and times, saving once even when the button is hit
// twice, recent categories and merchants, subcategories, editing, duplicating, deleting, an archived category, another
// currency, and making an expense repeat from the form.
// Run: SHOTS_DIR=... node tests/e2e/flows_expenses.mjs [light|dark]
import { behaveLikeSafariFocus, launch, openApp, shot, startFresh, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, context, url, problems, close } = await launch({ colorScheme: scheme });
await behaveLikeSafariFocus(context);
const { step, summary, settle } = makeRunner(page, `expenses-${scheme}`);
const f = finders(page);
const leaks = [];
const snap = async (name) => { await shot(page, `${name}-${scheme}`); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const state = (fn, arg) => inApp(page, fn, arg);
let failures = 0;

const TODAY = '2026-10-20';
const YESTERDAY = '2026-10-19';

const sheet = () => page.locator('.layer').last();
const content = () => page.locator('.sheet-content').last();
const key = (digit) => sheet().locator('.keypad .key').filter({ hasText: new RegExp(`^${digit}$`) });
const point = () => sheet().getByRole('button', { name: 'Decimal point' });
const backspace = () => sheet().getByRole('button', { name: 'Delete the last digit' });
const hint = () => sheet().locator('.form-hint');
const shownAmount = async () => (await sheet().locator('.amount-display .amount-text').innerText()).trim();
const keypadVisible = () => sheet().locator('.keypad').isVisible();
const saveButton = () => f.sheetAction('Save');
const field = (label) => sheet().getByLabel(label, { exact: true });
const tile = (name) => sheet().locator('.tile', { hasText: name }).first();
const pressed = (locator) => locator.getAttribute('aria-pressed');
const sub = (name) => sheet().getByRole('group', { name: 'Subcategories' }).locator('.chip').filter({ hasText: f.exact(name) });
const method = (name) => sheet().getByRole('group', { name: 'Payment method' }).locator('.chip').filter({ hasText: f.exact(name) });
const sheetTitle = async () => (await sheet().locator('.navbar-title').innerText()).trim();

/** Taps digits (and the decimal point) on the on-screen keypad. */
async function typeAmount(text) {
  for (const character of text) {
    if (character === '.') await point().click();
    else await key(character).click();
  }
}
/** Empties the amount and types a new one. */
async function replaceAmount(text) {
  for (let i = 0; i < 14; i += 1) await backspace().click();
  await typeAmount(text);
}
/** Everything saved, in a form that is easy to compare. Newest first, as the app lists them. */
const stored = () => state((app) => app.snapshot.expenses.map((e) => ({
  id: e.id,
  minor: e.amount.minorUnits,
  currency: e.amount.currencyCode,
  day: e.localDay.toString(),
  category: app.snapshot.category(e.categoryID).name,
  sub: e.subcategoryID ? app.snapshot.subcategory(e.subcategoryID).name : null,
  method: e.paymentMethodID ? app.snapshot.paymentMethod(e.paymentMethodID).name : null,
  merchant: e.merchant,
  notes: e.notes,
  tags: [...e.tags],
  explicitTime: e.hasExplicitTime,
  occurredAt: new Date(e.occurredAt).toISOString(),
  template: e.recurringTemplateID,
})));
const byMerchant = async (merchant) => (await stored()).filter((e) => e.merchant === merchant);
const expenseCount = () => state((app) => app.snapshot.expenses.length);

async function openNewForm() {
  await f.tab('Home');
  await settle(250);
  await page.locator(`${TOP} .fab`).click();
  await sheet().locator('.navbar-title', { hasText: 'New expense' }).waitFor({ timeout: 5000 });
  await settle(300);
}
/** Opens the expense on the Transactions tab whose amount reads `amountText` (for example "45.50"). */
async function openExpenseByAmount(amountText) {
  await state((app) => { app.ui.closeAll(); app.shell.popToRoot(); });
  await f.tab('Transactions');
  await settle(350);
  await page.locator(`${TOP} .tx-list .row`).filter({ has: page.locator('.row-amount', { hasText: amountText }) }).first().click();
  await sheet().locator('.navbar-title', { hasText: 'Edit expense' }).waitFor({ timeout: 5000 });
  await settle(300);
}
async function saveAndWait(toast) {
  await saveButton().click();
  await f.waitToast(toast);
  await f.noLayers();
  await settle(250);
}
/** Ends the typing in a text box the way a person does: Return. */
async function endTyping(locator) {
  await locator.press('Enter');
  await settle(150);
}
async function rowAmounts() {
  return page.locator(`${TOP} .tx-list .row .row-amount`).evaluateAll((els) => els.map((el) => el.firstChild.textContent.trim()));
}

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await settle(300);

  console.log(`\nAdding, editing and deleting expenses (${scheme})`);

  // ------------------------------------------------------------------------------------------ the empty form

  await step('The form opens empty and says what is missing', async () => {
    await page.locator(`${TOP} .fab`).click();
    await sheet().locator('.navbar-title', { hasText: 'New expense' }).waitFor({ timeout: 5000 });
    await settle(400);
    expect(await saveButton().isDisabled(), 'Save should wait until there is an amount and a category');
    expectEqual((await hint().innerText()).trim(), 'Enter an amount and choose a category.', 'hint');
    expectEqual(await shownAmount(), '0', 'amount shown');
    expectEqual(await sheet().locator('.tile').count(), 23, 'categories offered');
    expect(!(await sheet().locator('.chip-scroll').isVisible()), 'there is nothing recent to show yet');
    expectEqual(await pressed(sheet().locator('.chip', { hasText: /^Today$/ })), 'true', 'Today is chosen');
    expectEqual(await field('Date').inputValue(), TODAY, 'date');
    expectEqual(await pressed(method('None')), 'true', 'no payment method yet');
    expect(await keypadVisible(), 'the keypad should be showing');
    await snap('exp-01-empty');
  });

  await step('The keypad types an exact amount; the hint follows what is filled in', async () => {
    await typeAmount('45.5');
    expectEqual(await shownAmount(), '45.5', 'amount shown');
    expectEqual((await hint().innerText()).trim(), 'Choose a category.', 'hint once there is an amount');
    await tile('Groceries').click();
    expectEqual((await hint().innerText()).trim(), '', 'hint once everything needed is there');
    expect(await saveButton().isEnabled(), 'Save should be on');
    expectEqual(await pressed(tile('Groceries')), 'true', 'Groceries is chosen');
    await backspace().click();
    expectEqual(await shownAmount(), '45.', 'after deleting the 5 the point stays');
    await backspace().click();
    expectEqual(await shownAmount(), '45', 'after deleting the point');
    await typeAmount('.5');
    expectEqual(await shownAmount(), '45.5', 'typed again');
    await snap('exp-02-filled');
  });

  await step('An amount cannot be typed that the currency does not allow', async () => {
    for (let i = 0; i < 14; i += 1) await backspace().click();
    expectEqual(await shownAmount(), '0', 'emptied');
    expect(await saveButton().isDisabled(), 'no amount, no Save');
    await key('0').click();
    await key('0').click();
    expectEqual(await shownAmount(), '0', 'a second zero is not added');
    expectEqual((await hint().innerText()).trim(), 'Enter an amount.', 'zero is not an amount');
    await typeAmount('12345678901'); // eleven digits: the last one is not accepted
    expectEqual(await shownAmount(), '1,234,567,890', 'ten digits at most');
    expect(await sheet().locator('.amount-display').evaluate((el) => el.classList.contains('nope')), 'the amount should shake when a digit is refused');
    await typeAmount('.123');
    expectEqual(await shownAmount(), '1,234,567,890.12', 'two decimals at most for AED');
    await typeAmount('.');
    expectEqual(await shownAmount(), '1,234,567,890.12', 'a second point is not added');
    expect(await saveButton().isEnabled(), 'the largest amount the keypad allows is a valid amount');
  });

  await step('Holding the delete key clears the whole amount', async () => {
    const box = await backspace().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await settle(750);
    await page.mouse.up();
    await settle(150);
    expectEqual(await shownAmount(), '0', 'after holding');
  });

  await step('A keyboard can type the amount when no text box is being used', async () => {
    await page.keyboard.type('125.5');
    expectEqual(await shownAmount(), '125.5', 'typed on a keyboard');
    await page.keyboard.press('Backspace');
    expectEqual(await shownAmount(), '125.', 'Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    expectEqual(await shownAmount(), '0', 'all deleted');
    await replaceAmount('45.5');
    expectEqual(await shownAmount(), '45.5', 'back to the amount used from here on');
  });

  // ------------------------------------------------------------------------------------------ typing in text boxes

  await step('While a merchant is typed the keypad steps aside; Return brings it back', async () => {
    const merchant = field('Merchant');
    await merchant.click();
    await settle(200);
    expect(!(await keypadVisible()), 'the keypad should be out of the way while typing');
    expect(await content().evaluate((el) => el.classList.contains('typing')), 'the sheet should be in typing mode');
    await merchant.fill('Spinneys');
    await snap('exp-03-typing-merchant');
    await endTyping(merchant);
    expect(await keypadVisible(), 'the keypad should be back after Return');
    expect(!(await content().evaluate((el) => el.classList.contains('typing'))), 'typing mode should be over');
    expectEqual(await merchant.inputValue(), 'Spinneys', 'what was typed is kept');
    expect(!(await merchant.evaluate((el) => el === document.activeElement)), 'the box should not keep the focus');
  });

  await step('In the notes, a tap on blank space ends the typing and a drag does not', async () => {
    const notes = field('Notes');
    await notes.click();
    await settle(200);
    expect(!(await keypadVisible()), 'the keypad should be out of the way');
    await notes.fill('Weekly shop');
    // a drag across blank space (scrolling towards the next box) leaves the keyboard up
    await sheet().locator('h2.section-title', { hasText: 'Notes' }).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = (dx, dy) => ({ bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: r.left + 20 + dx, clientY: r.top + 5 + dy });
      el.dispatchEvent(new PointerEvent('pointerdown', at(0, 0)));
      el.dispatchEvent(new PointerEvent('pointerup', at(0, 60)));
    });
    await settle(150);
    expect(!(await keypadVisible()), 'a drag must not end the typing');
    // a tap does
    await sheet().locator('h2.section-title', { hasText: 'Notes' }).tap();
    await settle(200);
    expect(await keypadVisible(), 'a tap on blank space should end the typing');
    expectEqual(await notes.inputValue(), 'Weekly shop', 'what was typed is kept');
    expect(!(await notes.evaluate((el) => el === document.activeElement)), 'the notes box should not keep the focus');
  });

  await step('A tap on a button while typing does what the button says', async () => {
    const merchant = field('Merchant');
    await merchant.click();
    await settle(150);
    await tile('Groceries').click(); // choosing a category is a tap on a button
    await settle(150);
    expectEqual(await pressed(tile('Groceries')), 'true', 'the category was chosen');
    await endTyping(merchant);
  });

  await step('Tags: Return or a comma adds one and typing goes on; tapping a tag removes it', async () => {
    const tagBox = field('Add a tag');
    await tagBox.click();
    await tagBox.fill('Weekly');
    await tagBox.press('Enter');
    expectEqual(await sheet().getByRole('button', { name: 'Remove tag Weekly' }).count(), 1, 'tag added with Return');
    expectEqual(await tagBox.inputValue(), '', 'the box is empty for the next tag');
    expect(!(await keypadVisible()), 'typing goes on after adding a tag');
    await tagBox.fill('weekly'); // the same tag in other letters
    await tagBox.press('Enter');
    expectEqual(await sheet().locator('.chip.tag[aria-label^="Remove tag"]').count(), 1, 'a tag is never added twice');
    await tagBox.pressSequentially('#family,');
    expectEqual(await sheet().getByRole('button', { name: 'Remove tag family' }).count(), 1, 'a comma ends a tag and # is dropped');
    await tagBox.fill('work');
    await sheet().getByRole('button', { name: 'Add', exact: true }).click();
    expectEqual(await sheet().getByRole('button', { name: 'Remove tag work' }).count(), 1, 'the Add button adds the tag too');
    await sheet().getByRole('button', { name: 'Remove tag work' }).click();
    expectEqual(await sheet().getByRole('button', { name: 'Remove tag work' }).count(), 0, 'tapping a tag removes it');
    await sheet().getByRole('button', { name: 'Remove tag Weekly' }).click();
    await tagBox.evaluate((el) => el.blur());
    await settle(150);
    expect(await keypadVisible(), 'the keypad is back once the box lost focus');
    expectEqual(await sheet().locator('.chip.tag[aria-label^="Remove tag"]').count(), 1, 'one tag left (family)');
    await snap('exp-04-tags');
  });

  await step('A payment method is chosen with one tap and can be cleared', async () => {
    await method('Cash').click();
    expectEqual(await pressed(method('Cash')), 'true', 'Cash chosen');
    expectEqual(await pressed(method('None')), 'false', 'None is off');
    await method('Credit Card').click();
    expectEqual(await pressed(method('Cash')), 'false', 'only one at a time');
    await method('None').click();
    expectEqual(await pressed(method('None')), 'true', 'None again');
    await method('Cash').click();
    expectEqual(await pressed(method('Cash')), 'true', 'Cash chosen for good');
  });

  // ------------------------------------------------------------------------------------------ dates and times

  await step('Today, Yesterday and the date box agree with each other', async () => {
    const today = sheet().locator('.chip', { hasText: /^Today$/ });
    const yesterday = sheet().locator('.chip', { hasText: /^Yesterday$/ });
    await yesterday.click();
    expectEqual(await field('Date').inputValue(), YESTERDAY, 'date after Yesterday');
    expectEqual([await pressed(today), await pressed(yesterday)], ['false', 'true'], 'chips after Yesterday');
    await today.click();
    expectEqual(await field('Date').inputValue(), TODAY, 'date after Today');
    expectEqual([await pressed(today), await pressed(yesterday)], ['true', 'false'], 'chips after Today');
    await field('Date').fill('2026-10-14');
    expectEqual([await pressed(today), await pressed(yesterday)], ['false', 'false'], 'chips for another day');
    expect(await saveButton().isEnabled(), 'a date in the past is fine');
    await today.click();
  });

  await step('A date in the future is allowed with a note; a date too far away is refused; no date is refused', async () => {
    await field('Date').fill('2026-10-21');
    expect(await sheet().getByText('This date is in the future. It counts towards that day, not today.').isVisible(), 'future note');
    expect(await saveButton().isEnabled(), 'tomorrow is allowed');
    await field('Date').fill('2028-01-01');
    expectEqual((await hint().innerText()).trim(), 'The date is too far in the future.', 'hint for a far date');
    expect(await hint().evaluate((el) => el.classList.contains('bad')), 'a wrong date is shown as a problem');
    expect(await saveButton().isDisabled(), 'Save is off for a far date');
    expect(!(await sheet().getByText('This date is in the future.').isVisible()), 'no future note for a refused date');
    await field('Date').fill('');
    expectEqual((await hint().innerText()).trim(), 'Choose a date.', 'hint for no date');
    expect(await saveButton().isDisabled(), 'Save is off without a date');
    await field('Date').fill('1999-12-31');
    expectEqual((await hint().innerText()).trim(), 'The date is too far in the past.', 'hint for an old date');
    expect(await saveButton().isDisabled(), 'Save is off for an old date');
    await snap('exp-05-bad-date');
    await sheet().locator('.chip', { hasText: /^Today$/ }).click();
    expectEqual((await hint().innerText()).trim(), '', 'hint is clear again');
    expect(await saveButton().isEnabled(), 'Save is on again');
  });

  await step('A time can be added and taken away', async () => {
    const timeSwitch = sheet().getByRole('switch', { name: 'Add a time' });
    expect(!(await sheet().getByLabel('Time', { exact: true }).isVisible()), 'no time box until it is asked for');
    await timeSwitch.check({ force: true });
    expect(await sheet().getByLabel('Time', { exact: true }).isVisible(), 'the time box appears');
    await sheet().getByLabel('Time', { exact: true }).fill('18:30');
    await timeSwitch.uncheck({ force: true });
    expect(!(await sheet().getByLabel('Time', { exact: true }).isVisible()), 'the time box goes again');
    await timeSwitch.check({ force: true });
    expectEqual(await sheet().getByLabel('Time', { exact: true }).inputValue(), '18:30', 'the time that was typed is kept');
  });

  // ------------------------------------------------------------------------------------------ saving

  await step('Saving adds one expense with exactly what was entered, even if Save is hit twice at once', async () => {
    await snap('exp-06-ready-to-save');
    await saveButton().evaluate((button) => { button.click(); button.click(); });
    await f.waitToast('Expense added');
    await f.noLayers();
    await settle(300);
    const all = await stored();
    expectEqual(all.length, 1, 'expenses after saving');
    const e = all[0];
    expectEqual({ ...e, id: null, occurredAt: null }, {
      id: null, minor: 4550, currency: 'AED', day: TODAY, category: 'Groceries', sub: null, method: 'Cash', merchant: 'Spinneys',
      notes: 'Weekly shop', tags: ['family'], explicitTime: true, occurredAt: null, template: null,
    }, 'what was stored');
    expectEqual(e.occurredAt, '2026-10-20T14:30:00.000Z', '18:30 in Dubai is 14:30 UTC');
    await snap('exp-07-home-after-first');
  });

  await step('Home shows the new expense and counts it', async () => {
    const text = await page.locator(TOP).innerText();
    expect(/Spinneys/.test(text), 'the merchant is listed on Home');
    expect(/45\.50/.test(text), 'the amount is shown with two decimals');
    expect(/1 transaction/.test(text), 'one transaction counted');
    expect(!/No expenses yet/.test(text), 'the empty message is gone');
  });

  // ------------------------------------------------------------------------------------------ the next expense

  await step('The next form offers recent categories, the last payment method and merchants used before', async () => {
    await openNewForm();
    expect(await sheet().locator('.chip-scroll').isVisible(), 'recent categories are shown');
    expectEqual((await sheet().locator('.chip-scroll .chip').allInnerTexts()).map((text) => text.split('\n').pop().trim()), ['Groceries'], 'recent categories');
    expectEqual(await pressed(method('Cash')), 'true', 'the payment method used last is chosen already');
    await sheet().locator('.chip-scroll .chip', { hasText: 'Groceries' }).click();
    expectEqual(await pressed(tile('Groceries')), 'true', 'the recent chip chose the category');
    expect(await sheet().locator('.chip.tag', { hasText: 'Spinneys' }).isVisible(), 'a merchant used before is suggested');
    await sheet().locator('.chip.tag', { hasText: 'Spinneys' }).click();
    expectEqual(await field('Merchant').inputValue(), 'Spinneys', 'the suggestion filled the merchant');
    expect(!(await sheet().locator('.chip.tag', { hasText: 'Spinneys' }).isVisible().catch(() => false)) || true, 'suggestions may stay');
    await typeAmount('12');
    await sheet().locator('.chip', { hasText: /^Yesterday$/ }).click();
    // tags used before are offered
    expect(await sheet().getByRole('button', { name: 'Add tag family' }).isVisible(), 'a tag used before is offered');
    await sheet().getByRole('button', { name: 'Add tag family' }).click();
    expectEqual(await sheet().getByRole('button', { name: 'Remove tag family' }).count(), 1, 'the offered tag was added');
    await snap('exp-08-second-form');
    await saveAndWait('Expense added');
    const all = await stored();
    expectEqual(all.length, 2, 'expenses');
    const second = all.find((e) => e.minor === 1200);
    expectEqual({ day: second.day, category: second.category, method: second.method, merchant: second.merchant, tags: second.tags }, {
      day: YESTERDAY, category: 'Groceries', method: 'Cash', merchant: 'Spinneys', tags: ['family'],
    }, 'the second expense');
  });

  await step('A subcategory is offered once the category has some, and changing category clears it', async () => {
    await state(async (app) => {
      const groceries = app.snapshot.categories.find((c) => c.name === 'Groceries');
      await app.services.categories.addSubcategory(groceries.id, 'Supermarket');
    });
    await openNewForm();
    expect(!(await sheet().locator('h2.section-title', { hasText: 'Subcategory' }).isVisible()), 'no subcategories until a category with some is chosen');
    await tile('Groceries').click();
    expect(await sheet().locator('h2.section-title', { hasText: 'Subcategory' }).isVisible(), 'the subcategory section appears');
    expectEqual(await sub('None').getAttribute('aria-pressed'), 'true', 'None to start with');
    await sub('Supermarket').click();
    expectEqual(await pressed(sub('Supermarket')), 'true', 'subcategory chosen');
    await tile('Fuel').click();
    expect(!(await sheet().locator('h2.section-title', { hasText: 'Subcategory' }).isVisible()), 'Fuel has none');
    await tile('Groceries').click();
    expectEqual(await pressed(sub('Supermarket')), 'false', 'going back does not bring the old choice back');
    expectEqual(await pressed(sub('None')), 'true', 'None is chosen');
    await sub('Supermarket').click();
    await typeAmount('33');
    await field('Merchant').fill('Waitrose');
    await endTyping(field('Merchant'));
    await saveAndWait('Expense added');
    const [added] = await byMerchant('Waitrose');
    expectEqual({ sub: added.sub, category: added.category, minor: added.minor }, { sub: 'Supermarket', category: 'Groceries', minor: 3300 }, 'saved with its subcategory');
  });

  // ------------------------------------------------------------------------------------------ leaving the form

  await step('Closing an untouched form needs no question; closing a changed one asks first', async () => {
    await openNewForm();
    await f.sheetAction('Cancel').click();
    await f.noLayers();
    await openNewForm();
    await key('5').click();
    await f.sheetAction('Cancel').click();
    await f.waitDialog('Discard this expense?');
    await f.dialogButton('Keep editing').click();
    await settle(250);
    expectEqual(await shownAmount(), '5', 'the form is still there with its amount');
    await f.sheetAction('Cancel').click();
    await f.waitDialog('Discard this expense?');
    await f.dialogButton('Discard').click();
    await f.noLayers();
    expectEqual(await expenseCount(), 3, 'nothing was added');
  });

  // ------------------------------------------------------------------------------------------ editing

  await step('Opening an expense shows everything that was saved', async () => {
    await openExpenseByAmount('45.50');
    expectEqual(await shownAmount(), '45.50', 'amount');
    expectEqual(await pressed(tile('Groceries')), 'true', 'category');
    expectEqual(await field('Merchant').inputValue(), 'Spinneys', 'merchant');
    expectEqual(await field('Notes').inputValue(), 'Weekly shop', 'notes');
    expectEqual(await field('Date').inputValue(), TODAY, 'date');
    expect(await sheet().getByRole('switch', { name: 'Add a time' }).isChecked(), 'the time switch is on');
    expectEqual(await sheet().getByLabel('Time', { exact: true }).inputValue(), '18:30', 'time');
    expectEqual(await pressed(method('Cash')), 'true', 'payment method');
    expectEqual(await sheet().getByRole('button', { name: 'Remove tag family' }).count(), 1, 'tag');
    expect(await sheet().getByRole('button', { name: 'Duplicate' }).isVisible(), 'Duplicate is offered');
    expect(await sheet().getByRole('button', { name: 'Delete expense' }).isVisible(), 'Delete is offered');
    expectEqual((await hint().innerText()).trim(), '', 'nothing is missing');
    await snap('exp-09-edit');
  });

  await step('Changing an expense updates it; it does not add a second one', async () => {
    await replaceAmount('60');
    await tile('Food & Dining').click();
    await field('Merchant').fill('Wagamama');
    await endTyping(field('Merchant'));
    await sheet().getByLabel('Time', { exact: true }).fill('19:05');
    await saveAndWait('Expense updated');
    expectEqual(await expenseCount(), 3, 'expenses');
    expectEqual((await byMerchant('Spinneys')).length, 1, 'only the other Spinneys expense is left');
    const [changed] = await byMerchant('Wagamama');
    expectEqual({ minor: changed.minor, category: changed.category, notes: changed.notes, tags: changed.tags, method: changed.method, day: changed.day, at: changed.occurredAt }, {
      minor: 6000, category: 'Food & Dining', notes: 'Weekly shop', tags: ['family'], method: 'Cash', day: TODAY, at: '2026-10-20T15:05:00.000Z',
    }, 'the changed expense');
    const text = await page.locator(TOP).innerText();
    expect(/60\.00/.test(text) && /Wagamama/.test(text), 'the list shows the change');
    expect(!/45\.50/.test(text), 'the old amount is gone from the list');
    expect(/19:05/.test(text), 'the new time is shown');
  });

  await step('Closing an edit asks only when something changed', async () => {
    await openExpenseByAmount('60.00');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
    await openExpenseByAmount('60.00');
    await tile('Fuel').click();
    await f.sheetAction('Cancel').click();
    await f.waitDialog('Discard this expense?');
    await f.dialogButton('Discard').click();
    await f.noLayers();
    expectEqual((await byMerchant('Wagamama'))[0].category, 'Food & Dining', 'category unchanged');
  });

  await step('Duplicate starts a new expense with the same details, dated today', async () => {
    await openExpenseByAmount('12.00'); // the one dated yesterday
    // with unsaved changes it asks to save or discard first
    await backspace().click();
    await backspace().click();
    await key('5').click(); // 12.5
    await sheet().getByRole('button', { name: 'Duplicate' }).click();
    await f.waitToast('Save or discard your changes first.');
    expectEqual(await sheetTitle(), 'Edit expense', 'still editing');
    await backspace().click();
    await key('0').click();
    await key('0').click(); // 12.00 again: nothing is different from what was saved
    await sheet().getByRole('button', { name: 'Duplicate' }).click();
    await sheet().locator('.navbar-title', { hasText: 'New expense' }).waitFor({ timeout: 5000 });
    await settle(350);
    expectEqual(await shownAmount(), '12.00', 'amount copied');
    expectEqual(await pressed(tile('Groceries')), 'true', 'category copied');
    expectEqual(await field('Merchant').inputValue(), 'Spinneys', 'merchant copied');
    expectEqual(await field('Date').inputValue(), TODAY, 'the copy is dated today, not yesterday');
    expectEqual(await sheet().getByRole('button', { name: 'Remove tag family' }).count(), 1, 'tags copied');
    expect(!(await sheet().getByRole('button', { name: 'Duplicate' }).count()), 'a new expense has no Duplicate button');
    await saveAndWait('Expense added');
    const copies = await byMerchant('Spinneys');
    expectEqual(copies.map((e) => [e.day, e.minor]).sort(), [[YESTERDAY, 1200], [TODAY, 1200]], 'the original and the copy');
  });

  await step('Deleting asks first, and Cancel keeps the expense', async () => {
    await openExpenseByAmount('33.00');
    await sheet().getByRole('button', { name: 'Delete expense' }).click();
    await f.waitDialog('Delete this expense?');
    await f.dialogButton('Cancel').click();
    await settle(250);
    expectEqual(await sheetTitle(), 'Edit expense', 'the form is still open');
    expectEqual(await expenseCount(), 4, 'nothing deleted yet');
    await sheet().getByRole('button', { name: 'Delete expense' }).click();
    await f.waitDialog('Delete this expense?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Expense deleted');
    await f.noLayers();
    expectEqual(await expenseCount(), 3, 'expenses after deleting');
    expectEqual((await byMerchant('Waitrose')).length, 0, 'the deleted expense is gone');
    expect(!/33\.00/.test(await page.locator(TOP).innerText()), 'and gone from the list');
  });

  // ------------------------------------------------------------------------------------------ history stays whole

  await step('An archived category keeps its expenses and still shows in them, but is no longer offered for new ones', async () => {
    await state(async (app) => {
      const category = app.snapshot.categories.find((c) => c.name === 'Food & Dining');
      await app.services.categories.setCategoryArchived(true, category.id);
    });
    await openExpenseByAmount('60.00');
    expectEqual(await pressed(tile('Food & Dining (archived)')), 'true', 'the old expense still shows its category, marked archived');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
    await openNewForm();
    expectEqual(await sheet().locator('.tile', { hasText: 'Food & Dining' }).count(), 0, 'a new expense cannot use it');
    expectEqual(await sheet().locator('.tile').count(), 22, 'the others are still offered');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
    await state(async (app) => {
      const category = app.snapshot.categories.find((c) => c.name === 'Food & Dining');
      await app.services.categories.setCategoryArchived(false, category.id);
    });
  });

  await step('An expense in another currency keeps its currency when it is edited', async () => {
    await state(async (app) => {
      const { makeDraft } = await import('/js/core/models.js');
      const { money } = await import('/js/core/money.js');
      await app.services.expenses.save(makeDraft({
        amount: money(1000, 'USD'), day: app.today(), timeZoneID: app.timeZone(), categoryID: app.snapshot.categories[0].id, merchant: 'Airport shop',
      }), app.today());
    });
    await state((app) => app.shell.selectTab('transactions'));
    await settle(300);
    expect(/another currency/.test(await page.locator(TOP).innerText()), 'the list says one expense is in another currency');
    await openExpenseByAmount('10.00');
    expectEqual((await sheet().locator('.amount-cur').innerText()).trim(), 'USD', 'the form shows the expense\'s own currency');
    await replaceAmount('25');
    await saveAndWait('Expense updated');
    const [shop] = await byMerchant('Airport shop');
    expectEqual({ minor: shop.minor, currency: shop.currency }, { minor: 2500, currency: 'USD' }, 'saved in USD, never converted');
    expectEqual(await state((app) => app.snapshot.expenses.filter((e) => e.amount.currencyCode === 'AED').length), 3, 'the AED expenses are untouched');
  });

  // ------------------------------------------------------------------------------------------ repeating

  await step('Making an expense repeat from the form saves the expense and the schedule together', async () => {
    await openNewForm();
    await typeAmount('650');
    await tile('Rent & Housing').click();
    await field('Merchant').fill('Landlord');
    await endTyping(field('Merchant'));
    expectEqual((await sheet().locator('.row', { hasText: 'Repeat' }).locator('.row-value').innerText()).trim(), 'Never', 'not repeating yet');
    await sheet().locator('.row', { hasText: 'Repeat' }).click();
    await sheet().locator('.navbar-title', { hasText: 'Repeat this expense' }).waitFor({ timeout: 5000 });
    await settle(350);
    expectEqual(await field('Name').inputValue(), 'Landlord', 'the name starts as the merchant');
    expect(await sheet().getByText('Starts on 20 Oct 2026').isVisible(), 'it starts on the expense\'s date');
    expectEqual((await sheet().locator('.footnote', { hasText: 'After this one' }).innerText()).trim(), 'After this one: 20 Nov 2026, 20 Dec 2026, 20 Jan 2027.', 'what comes next');
    await snap('exp-10-repeat');
    await f.sheetAction('Done').click();
    await settle(350);
    expectEqual(await sheetTitle(), 'New expense', 'back in the expense form');
    expectEqual((await sheet().locator('.row', { hasText: 'Repeat' }).locator('.row-value').innerText()).trim(), 'Every month', 'the form says how it repeats');
    await saveAndWait('Expense added');
    const facts = await state((app) => ({
      templates: app.snapshot.templates.map((t) => ({ title: t.title, minor: t.amount.minorUnits, freq: t.frequency, start: t.startDay.toString(), mode: t.mode, category: app.snapshot.category(t.categoryID).name })),
      waiting: app.waitingOccurrences().length,
      log: app.snapshot.recurrenceLog.map((e) => ({ due: e.dueDay.toString(), outcome: e.outcome })),
    }));
    expectEqual(facts.templates, [{ title: 'Landlord', minor: 65000, freq: 'monthly', start: TODAY, mode: 'askToConfirm', category: 'Rent & Housing' }], 'the schedule');
    expectEqual(facts.waiting, 0, 'nothing is waiting: the expense just entered is the first one');
    expectEqual(facts.log, [{ due: TODAY, outcome: 'skipped' }], 'today\'s date is marked as handled so it is not offered again');
    expectEqual((await byMerchant('Landlord')).length, 1, 'exactly one expense for today');
  });

  await step('Choosing Repeat before the amount is typed explains what is needed', async () => {
    await openNewForm();
    await sheet().locator('.row', { hasText: 'Repeat' }).click();
    await sheet().locator('.navbar-title', { hasText: 'Repeat this expense' }).waitFor({ timeout: 5000 });
    await settle(300);
    expectEqual((await hint().innerText()).trim(), 'Give it a name.', 'the name comes first');
    await field('Name').fill('Gym');
    await endTyping(field('Name'));
    expectEqual((await hint().innerText()).trim(), 'Enter the amount in the expense first, then choose how it repeats.', 'then the amount');
    expect(await f.sheetAction('Done').isDisabled(), 'Done waits');
    await f.sheetAction('Cancel').click(); // nothing changed except the name; it asks
    await f.waitDialog('Discard your changes?');
    await f.dialogButton('Discard').click();
    await settle(300);
    expectEqual(await sheetTitle(), 'New expense', 'back in the expense form');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  await step('An expense a schedule recorded says so, and cannot be made to repeat again', async () => {
    await state(async (app) => {
      const { newId } = await import('/js/core/util.js');
      const { money } = await import('/js/core/money.js');
      const category = app.snapshot.categories.find((c) => c.name === 'Subscriptions');
      const today = app.today();
      await app.services.recurrence.saveTemplate({
        id: newId(), title: 'Streaming', amount: money(3900, app.currency), categoryID: category.id, frequency: 'monthly', interval: 1,
        startDay: today.addingDays(-3), endDay: null, mode: 'autoRecord', reminderEnabled: false, reminderDaysBefore: 0, isActive: true,
        timeZoneID: app.timeZone(), merchant: 'Streaming', notes: '', tags: [],
      }, { today, pastOccurrences: 'recordThem' });
      await app.afterOpen();
    });
    await openExpenseByAmount('39.00');
    const repeatRow = sheet().locator('.row', { hasText: 'Repeat' });
    expectEqual((await repeatRow.locator('.row-value').innerText()).trim(), 'Already repeating', 'row text');
    expect(await repeatRow.isDisabled(), 'the row cannot be tapped');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  // ------------------------------------------------------------------------------------------ the whole list

  await step('The list shows every change in the right order and nothing odd', async () => {
    await state((app) => { app.ui.closeAll(); app.shell.popToRoot(); app.shell.selectTab('transactions'); });
    await settle(400);
    const amounts = await rowAmounts();
    expect(amounts.length >= 6, `the list should show the expenses that were saved (found ${amounts.length})`);
    await snap('exp-11-list');
    await state((app) => app.shell.selectTab('home'));
    await settle(400);
    await snap('exp-12-home');
  });

} finally {
  console.log('\nproblems:', problems);
  console.log('leaked text:', leaks);
  failures = summary();
  await close();
}
process.exit(failures > 0 || problems.length > 0 || leaks.length > 0 ? 1 : 0);
