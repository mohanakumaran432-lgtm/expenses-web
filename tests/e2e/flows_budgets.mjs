// Budgets end to end in a real browser: the form (amount, what it covers, how often, warning levels, alerts), what each budget
// card says about the month so far, the detail page, pausing, editing, deleting, and in-app alerts. What the cards should say is
// worked out here from the stored expenses with its own small rules, not read back from the app's budget code.
// Run: SHOTS_DIR=... node tests/e2e/flows_budgets.mjs [light|dark]
import { behaveLikeSafariFocus, launch, openApp, shot, startFresh, seed, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, context, url, problems, close } = await launch({ colorScheme: scheme });
await behaveLikeSafariFocus(context);
const { step: run, summary, settle } = makeRunner(page, `budgets-${scheme}`);
const f = finders(page);
const leaks = [];
const snap = async (name) => { await shot(page, `${name}-${scheme}`); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const state = (fn, arg) => inApp(page, fn, arg);
let failures = 0;

const TODAY = '2026-10-20'; // a Tuesday; weeks start on Monday, so this week is 19 to 25 October
const MONTH = ['2026-10-01', '2026-10-31'];
const WEEK = ['2026-10-19', '2026-10-25'];

const sheet = () => page.locator('.layer').last();
const key = (digit) => sheet().locator('.keypad .key').filter({ hasText: new RegExp(`^${digit}$`) });
const point = () => sheet().getByRole('button', { name: 'Decimal point' });
const hint = () => sheet().locator('.form-hint');
const shownAmount = async () => (await sheet().locator('.amount-display .amount-text').innerText()).trim();
const keypadVisible = () => sheet().locator('.keypad').isVisible();
const saveButton = () => f.sheetAction('Save');
const field = (label) => sheet().getByLabel(label, { exact: true });
const seg = (label) => sheet().locator('.seg').filter({ hasText: f.exact(label) });
const level = (text) => sheet().getByRole('group', { name: 'Warning levels' }).locator('.chip').filter({ hasText: f.exact(text) });
const sheetTitle = async () => (await sheet().locator('.navbar-title').innerText()).trim();
const pressed = (locator) => locator.getAttribute('aria-pressed');

async function typeAmount(text) {
  for (const character of text) {
    if (character === '.') await point().click();
    else await key(character).click();
  }
}

// ------------------------------------------------------------------------------------------------ what is stored

const stored = () => state((app) => app.snapshot.expenses.map((e) => ({
  id: e.id, minor: e.amount.minorUnits, currency: e.amount.currencyCode, day: e.localDay.toString(), category: app.snapshot.category(e.categoryID).name,
})));
const budgetsStored = () => state((app) => app.snapshot.budgets.map((b) => ({
  id: b.id, name: b.name, category: b.categoryID ? app.snapshot.category(b.categoryID).name : null, period: b.periodKind, minor: b.amount.minorUnits,
  levels: [...b.alertThresholds], alerts: b.notificationsEnabled, active: b.isActive, start: b.customStart ? b.customStart.toString() : null, end: b.customEnd ? b.customEnd.toString() : null,
})));
const fmt = (minor) => state(async (app, value) => {
  const { money } = await import('/js/core/money.js');
  return app.formatter.money.string(money(value, app.currency));
}, minor);
const spentIn = (list, [from, to], category = null) => list
  .filter((e) => e.currency === 'AED' && e.day >= from && e.day <= to && (category === null || e.category === category))
  .reduce((sum, e) => sum + e.minor, 0);
const dirhams = (minor) => Math.ceil(minor / 100);

// ------------------------------------------------------------------------------------------------ what is on screen

async function goToBudgets() {
  await state((app) => { app.ui.closeAll(); app.shell.popToRoot(); app.shell.selectTab('budgets'); });
  await settle(350);
}
const cards = () => page.locator(`${TOP} .budget-card`).evaluateAll((els) => els.map((el) => ({
  name: el.querySelector('.budget-name').textContent.trim(),
  period: el.querySelector('.budget-period').textContent.trim(),
  left: el.querySelector('.budget-left-amount').textContent.trim(),
  over: el.querySelector('.budget-left-amount').classList.contains('over'),
  pill: el.querySelector('.pill').textContent.trim(),
  figures: [...el.querySelectorAll('.budget-figures span')].map((s) => s.textContent.trim()),
  notes: [...el.querySelectorAll('.budget-notes span')].map((s) => s.textContent.trim()),
  projection: [...el.querySelectorAll('.budget-projection > *')].map((s) => s.textContent.trim()),
  paused: el.classList.contains('paused'),
  label: el.getAttribute('aria-label'),
})));
const cardNamed = async (name) => (await cards()).find((c) => c.name === name);
const pageFacts = () => page.locator(TOP).first().evaluate((root) => {
  const out = {};
  for (const row of root.querySelectorAll('.row')) {
    const title = row.querySelector('.row-title');
    const value = row.querySelector('.row-value');
    if (title && value) out[title.textContent.trim()] = value.textContent.trim();
  }
  return out;
});
const notices = () => page.locator(`${TOP} .notice`).evaluateAll((els) => els.map((el) => ({
  title: (el.querySelector('.notice-title') || {}).textContent || '', body: (el.querySelector('.notice-body > div:not(.notice-title)') || {}).textContent || '',
})));

async function openNewBudget() {
  await goToBudgets();
  await page.locator(`${TOP} button[aria-label="Add a budget"]`).first().click();
  await sheet().locator('.navbar-title', { hasText: 'New budget' }).waitFor({ timeout: 5000 });
  await settle(300);
}
async function chooseCovers(name) {
  await sheet().locator('.row', { hasText: 'Covers' }).click();
  await sheet().locator('.navbar-title', { hasText: 'This budget covers' }).waitFor({ timeout: 5000 });
  await settle(200);
  await sheet().locator('.row').filter({ has: page.locator('.row-title', { hasText: f.exact(name) }) }).first().click();
  await settle(250);
}
/** Makes a budget through the form: { amount (typed on the keypad), name, covers, repeats, alerts, levels } and saves it. */
async function makeBudget({ amount, name = null, covers = null, repeats = null, alerts = false }) {
  await openNewBudget();
  await typeAmount(amount);
  if (covers) await chooseCovers(covers);
  if (repeats) await seg(repeats).click();
  if (name) {
    await field('Budget name').fill(name);
    await field('Budget name').press('Enter');
  }
  if (alerts) await sheet().getByRole('switch', { name: /Alert me inside the app/ }).check({ force: true });
  await saveButton().click();
  await f.waitToast('Budget added');
  await f.noLayers();
  await settle(350);
}
async function addExpenseAED(minor, categoryName, merchant = 'Test') {
  await state(async (app, input) => {
    const { makeDraft } = await import('/js/core/models.js');
    const { money } = await import('/js/core/money.js');
    const category = app.snapshot.categories.find((c) => c.name === input.categoryName);
    await app.services.expenses.save(makeDraft({
      amount: money(input.minor, app.currency), day: app.today(), timeZoneID: app.timeZone(), categoryID: category.id, merchant: input.merchant,
    }), app.today());
  }, { minor, categoryName, merchant });
  await settle(400);
}

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await settle(300);
  console.log(`\nBudgets (${scheme})`);

  // ------------------------------------------------------------------------------------------ nothing yet

  await run('With no budgets the tab invites the person to add one', async () => {
    await goToBudgets();
    expectEqual((await page.locator(`${TOP} .empty .empty-title`).innerText()).trim(), 'No budgets yet', 'empty title');
    await snap('bud-01-empty');
    await page.locator(`${TOP} .empty button`, { hasText: 'Add a budget' }).click();
    await sheet().locator('.navbar-title', { hasText: 'New budget' }).waitFor({ timeout: 5000 });
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  await seed(page, url, {});
  const data = await stored();
  const step = (title, fn) => run(title, async () => { await goToBudgets(); await fn(); });

  // ------------------------------------------------------------------------------------------ the form

  await step('The new budget form starts with sensible choices and says what is missing', async () => {
    await openNewBudget();
    expect(await saveButton().isDisabled(), 'Save waits for an amount');
    expectEqual((await hint().innerText()).trim(), 'Enter how much you can spend.', 'hint');
    expectEqual((await sheet().locator('.row', { hasText: 'Covers' }).locator('.row-value').innerText()).trim(), 'All spending', 'covers');
    expectEqual(await pressed(seg('Monthly')), 'true', 'repeats monthly');
    expectEqual(await field('Budget name').getAttribute('placeholder'), 'All spending', 'the name it would get');
    expectEqual([await pressed(level('80%')), await pressed(level('100%')), await pressed(level('50%'))], ['true', 'true', 'false'], 'warning levels');
    expect(!(await sheet().getByRole('switch', { name: /Alert me inside the app/ }).isChecked()), 'alerts start off');
    expectEqual(await sheet().getByRole('button', { name: 'Delete budget' }).count(), 0, 'a new budget cannot be deleted');
    expectEqual(await sheet().getByRole('switch', { name: 'Active' }).count(), 0, 'and has no Active switch');
    expect(/Starts again on the 1st of every month\. This month: October 2026\./.test(await sheet().innerText()), 'the monthly note');
    await snap('bud-02-form-empty');
    await typeAmount('5000');
    expectEqual(await shownAmount(), '5,000', 'amount typed (thousands are grouped)');
    expect(await saveButton().isEnabled(), 'Save is on');
    expectEqual((await hint().innerText()).trim(), '', 'nothing is missing');
    await f.sheetAction('Cancel').click(); // changed: asks
    await f.waitDialog('Discard this budget?');
    await f.dialogButton('Keep editing').click();
    await settle(200);
    expectEqual(await shownAmount(), '5,000', 'still there after Keep editing');
    await f.sheetAction('Cancel').click();
    await f.waitDialog('Discard this budget?');
    await f.dialogButton('Discard').click();
    await f.noLayers();
    expectEqual((await budgetsStored()).length, 0, 'nothing was saved');
  });

  await step('Typing a name moves the keypad aside and Return brings it back', async () => {
    await openNewBudget();
    await typeAmount('100');
    const name = field('Budget name');
    await name.click();
    await settle(200);
    expect(!(await keypadVisible()), 'the keypad is out of the way while typing');
    await name.fill('Everything');
    await endTyping(name);
    expect(await keypadVisible(), 'the keypad is back after Return');
    expectEqual(await name.inputValue(), 'Everything', 'the name is kept');
    await f.sheetAction('Cancel').click();
    await f.dialogButton('Discard').click();
    await f.noLayers();
  });

  await step('What a budget covers is chosen from a list; the name it would get follows', async () => {
    await openNewBudget();
    await sheet().locator('.row', { hasText: 'Covers' }).click();
    await sheet().locator('.navbar-title', { hasText: 'This budget covers' }).waitFor({ timeout: 5000 });
    await settle(250);
    const rows = await sheet().locator('.row .row-title').allInnerTexts();
    expectEqual(rows[0].trim(), 'All spending', 'first choice');
    expectEqual(rows.length, 24, 'all spending plus the 23 categories');
    expect(/counts only that category/.test(await sheet().innerText()), 'the explanation');
    await sheet().getByLabel('Search', { exact: true }).fill('groc');
    await settle(200);
    expectEqual((await sheet().locator('.row .row-title').allInnerTexts()).map((t) => t.trim()), ['Groceries'], 'the list can be searched');
    await sheet().locator('.row', { hasText: 'Groceries' }).click();
    await settle(250);
    expectEqual((await sheet().locator('.row', { hasText: 'Covers' }).locator('.row-value').innerText()).trim(), 'Groceries', 'covers');
    expectEqual(await field('Budget name').getAttribute('placeholder'), 'Groceries', 'the name it would get');
    await f.sheetAction('Cancel').click();
    await f.dialogButton('Discard').click();
    await f.noLayers();
  });

  await step('Weekly, monthly and custom periods each explain themselves; a custom period needs sensible dates', async () => {
    await openNewBudget();
    await typeAmount('800');
    await seg('Weekly').click();
    let text = await sheet().innerText();
    expect(/Starts again every Monday\. This week: 19 Oct 2026 – 25 Oct 2026\. The first day of the week is set in Settings\./.test(text), `weekly note (${text.slice(0, 40)}…)`);
    await seg('Custom').click();
    expect(await field('From').isVisible() && await field('To').isVisible(), 'the two dates appear');
    expect(/One fixed period that does not repeat\. Both days are included\./.test(await sheet().innerText()), 'custom note');
    expectEqual(await field('From').inputValue(), MONTH[0], 'it starts with this month');
    expectEqual(await field('To').inputValue(), MONTH[1], 'to the end of this month');
    expect(await saveButton().isEnabled(), 'valid as it is');
    await field('To').fill('2026-09-30');
    expectEqual((await hint().innerText()).trim(), 'The end date cannot be before the start date.', 'hint');
    expect(await hint().evaluate((el) => el.classList.contains('bad')), 'shown as a problem');
    expect(await saveButton().isDisabled(), 'Save is off');
    await snap('bud-03-bad-dates');
    await field('From').fill('');
    expectEqual((await hint().innerText()).trim(), 'Choose both dates.', 'hint with a date missing');
    await field('From').fill('2026-09-01');
    expect(await saveButton().isEnabled(), 'valid again');
    await seg('Monthly').click();
    expect(await field('From').isHidden(), 'the dates go away for a monthly budget');
    expect(await saveButton().isEnabled(), 'and a monthly budget does not care about them');
    await f.sheetAction('Cancel').click();
    await f.dialogButton('Discard').click();
    await f.noLayers();
  });

  await step('Warning levels can be switched, added, and one must always stay', async () => {
    await openNewBudget();
    await typeAmount('100');
    await level('50%').click();
    expectEqual(await pressed(level('50%')), 'true', '50% on');
    await level('80%').click();
    await level('100%').click();
    expectEqual([await pressed(level('80%')), await pressed(level('100%')), await pressed(level('50%'))], ['false', 'false', 'true'], 'only 50% is left');
    await level('50%').click(); // the last one: refused
    await f.waitToast('Keep at least one warning level.');
    expectEqual(await pressed(level('50%')), 'true', '50% stays on');
    // another level
    await sheet().getByRole('button', { name: 'Other…' }).click();
    await f.waitDialog('Other warning level');
    await f.dialogInput().fill('95');
    await f.dialogButton('Add').click();
    await settle(250);
    expectEqual(await pressed(level('95%')), 'true', '95% added and on');
    // a level that is not a whole number from 1 to 1000
    for (const bad of ['0', '1001', 'abc', '12.5']) {
      await sheet().getByRole('button', { name: 'Other…' }).click();
      await f.waitDialog('Other warning level');
      await f.dialogInput().fill(bad);
      await f.dialogButton('Add').click();
      await f.waitDialog('Not a valid level');
      await f.dialogButton('OK').click();
      await settle(150);
    }
    expectEqual(await sheet().getByRole('group', { name: 'Warning levels' }).locator('.chip').allInnerTexts(), ['50%', '75%', '80%', '90%', '95%', '100%', 'Other…'], 'the level chips');
    // cancel the prompt: nothing added
    await sheet().getByRole('button', { name: 'Other…' }).click();
    await f.waitDialog('Other warning level');
    await f.dialogButton('Cancel').click();
    await settle(150);
    expectEqual(await sheet().getByRole('group', { name: 'Warning levels' }).locator('.chip').count(), 7, 'still seven chips');
    await f.sheetAction('Cancel').click();
    await f.dialogButton('Discard').click();
    await f.noLayers();
  });

  await step('The alert switch explains that alerts only show inside the app, and what Settings must say', async () => {
    await openNewBudget();
    const text = await sheet().innerText();
    expect(/Alerts only appear while the app is open\. This app has no server, so it cannot wake your iPhone to tell you\./.test(text), 'inside the app only');
    expect(!/Budget alerts are switched off in Settings/.test(text), 'no warning while the alert switch is off');
    await sheet().getByRole('switch', { name: /Alert me inside the app/ }).check({ force: true });
    expect(/Budget alerts are switched off in Settings, so none will show until you switch them on there\./.test(await sheet().innerText()), 'says Settings has them off');
    await f.sheetAction('Cancel').click();
    await f.dialogButton('Discard').click();
    await f.noLayers();
  });

  // ------------------------------------------------------------------------------------------ the cards

  // One active budget per category and period is deliberate (the app refuses a second one), so the three states use three categories.
  const LATER = new Set(['Food & Dining', 'Fuel', 'Entertainment', 'Shopping']); // later steps make their own budgets for these
  const monthSpend = new Map();
  for (const e of data) if (e.currency === 'AED' && e.day >= MONTH[0] && e.day <= MONTH[1]) monthSpend.set(e.category, (monthSpend.get(e.category) || 0) + e.minor);
  const picks = [...monthSpend.entries()].filter(([name, minor]) => !LATER.has(name) && minor > 20000).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const plan = ['over', 'close', 'within'].map((kind, i) => {
    const [category, S] = picks[i] || ['(missing)', 20001];
    const limit = kind === 'over' ? Math.max(1, Math.floor(S / 100 / 2)) : kind === 'close' ? dirhams(S / 0.9) : dirhams(S * 3);
    return { kind, category, S, limit, name: `${category} ${kind}` };
  });
  const [overPlan, closePlan, withinPlan] = plan;
  const relaxedName = `${withinPlan.category} (relaxed)`;

  await step('Three budgets in three categories show Within, Close to the limit and Over, worked out from the real spending', async () => {
    expect(picks.length === 3, `the sample has three categories with enough spending this month (${picks.map((p) => p[0])})`);
    for (const p of [withinPlan, closePlan, overPlan]) await makeBudget({ amount: String(p.limit), name: p.name, covers: p.category, alerts: false });
    await goToBudgets();
    const shown = await cards();
    expectEqual(shown.map((c) => c.name), [overPlan.name, closePlan.name, withinPlan.name], 'cards run from most used to least used');
    const [over, close, within] = shown;
    expectEqual(over.pill, 'Over budget', 'over: words');
    expect(over.over, 'over: the left amount is marked');
    expectEqual(over.left, `${await fmt(overPlan.S - overPlan.limit * 100)} over`, 'over: how much over');
    expectEqual(close.pill, 'Close to the limit', 'close: words');
    expectEqual(close.left, `${await fmt(closePlan.limit * 100 - closePlan.S)} left`, 'close: how much is left');
    expectEqual(within.pill, 'Within budget', 'within: words');
    expectEqual(within.left, `${await fmt(withinPlan.limit * 100 - withinPlan.S)} left`, 'within: how much is left');
    for (const [card, p] of [[over, overPlan], [close, closePlan], [within, withinPlan]]) {
      expectEqual(card.figures[0], `${await fmt(p.S)} of ${await fmt(p.limit * 100)}`, `${card.name}: spent of limit`);
      const percent = Number(card.figures[1].replace(/[^\d.]/g, ''));
      expect(Math.abs(percent - (p.S / (p.limit * 100)) * 100) < 0.6, `${card.name}: ${percent}% used should be about ${(p.S / (p.limit * 100)) * 100}`);
      expectEqual(card.period, `${p.category} · Monthly · October 2026`, `${card.name}: subtitle`);
      expect(/^11 days left after today$/.test(card.notes[0]), `${card.name}: time left (${card.notes[0]})`);
      expect(card.projection[0] === 'Projection', `${card.name}: projection heading`);
      expect(/^At the current pace you would spend about AED\s[\d,.]+ by 31 Oct\.$/.test(card.projection[1]), `${card.name}: projection (${card.projection[1]})`);
      expect(/^An estimate from your spending so far, not a promise\.$/.test(card.projection[card.projection.length - 1]), `${card.name}: honest about it being an estimate`);
    }
    expect(/^That is about AED\s[\d,.]+ more than the budget\.$/.test(over.projection[2]), 'over: says by how much the pace overshoots');
    expect(/^About AED\s[\d,.]+ a day keeps you within the budget\.$/.test(within.notes[1]), 'within: says what a day may cost');
    expect(over.notes.length === 1, 'over: no daily allowance is offered when already over');
    const projected = Number(/AED\s([\d,.]+)\sby/.exec(close.projection[1])[1].replace(/,/g, '')) * 100;
    expect(Math.abs(projected - Math.round((closePlan.S * 31) / 20)) <= 1, `the projection is spending so far × 31 / 20 days (${projected} vs ${Math.round((closePlan.S * 31) / 20)})`);
    await snap('bud-04-cards');
  });

  await step('A budget for all spending is listed first; weekly and custom budgets count only their own days', async () => {
    await makeBudget({ amount: '30000', name: 'Everything this week', repeats: 'Weekly' });
    await openNewBudget();
    await typeAmount('9000');
    await chooseCovers('Food & Dining');
    await seg('Custom').click();
    await field('From').fill('2026-10-05');
    await field('To').fill('2026-10-12');
    await saveButton().click();
    await f.waitToast('Budget added');
    await f.noLayers();
    await goToBudgets();
    const shown = await cards();
    expectEqual(shown[0].name, 'Everything this week', 'the all-spending budget comes first');
    const week = spentIn(data, WEEK);
    expectEqual(shown[0].figures[0], `${await fmt(week)} of ${await fmt(3000000)}`, 'weekly: spent this week only');
    expectEqual(shown[0].period, 'All spending · Weekly · 19 Oct 2026 – 25 Oct 2026', 'weekly: the week is named');
    const custom = shown.find((c) => c.name === 'Food & Dining');
    const food = spentIn(data, ['2026-10-05', '2026-10-12'], 'Food & Dining');
    expectEqual(custom.figures[0], `${await fmt(food)} of ${await fmt(900000)}`, 'custom: both end days counted');
    expectEqual(custom.period, 'Custom period · 5 Oct 2026 – 12 Oct 2026', 'custom: the dates are named (the name is the category, so the subtitle does not repeat it)');
    expect(/^Ended 12 Oct 2026$/.test(custom.notes[0]), `custom: says it has ended (${custom.notes[0]})`);
    expectEqual(custom.projection.length, 0, 'custom: no projection for a period that is over');
    await snap('bud-05-more-cards');
  });

  await step('Opening a budget shows its rules and exactly the expenses it counts', async () => {
    await page.locator(`${TOP} .budget-card`).filter({ hasText: closePlan.name }).click();
    await settle(400);
    expectEqual(await f.pageTitle(), closePlan.name, 'page title');
    const facts = await pageFacts();
    const counted = data.filter((e) => e.category === closePlan.category && e.currency === 'AED' && e.day >= MONTH[0] && e.day <= MONTH[1]);
    expectEqual(facts['Expenses counted'], `${counted.length} · ${await fmt(closePlan.S)}`, 'expenses counted');
    expectEqual(facts.Covers, closePlan.category, 'covers');
    expectEqual(facts.Repeats, 'Monthly', 'repeats');
    expectEqual(facts['Warning levels'], '80%, 100%', 'levels');
    expectEqual(facts['Alerts inside the app'], 'Off', 'alerts');
    await snap('bud-06-detail');
    await page.locator(`${TOP} .row`, { hasText: 'Expenses counted' }).click();
    await settle(400);
    expectEqual(await f.pageTitle(), closePlan.name, 'the list of what is counted');
    expectEqual(await page.locator(`${TOP} .row .row-amount`).count(), counted.length, 'one row for each counted expense');
    await f.back();
    await f.back();
    expectEqual(await f.pageTitle(), 'Budgets', 'back on the list');
  });

  await step('Editing shows what was saved, and a change updates the card', async () => {
    await page.locator(`${TOP} .budget-card`).filter({ hasText: withinPlan.name }).click();
    await settle(350);
    await f.navButton('Edit').click();
    await sheet().locator('.navbar-title', { hasText: 'Edit budget' }).waitFor({ timeout: 5000 });
    await settle(300);
    expectEqual(await shownAmount(), `${withinPlan.limit}.00`.replace(/(\d)(?=(\d{3})+\.)/g, '$1,'), 'amount');
    expectEqual(await field('Budget name').inputValue(), withinPlan.name, 'name');
    expectEqual((await sheet().locator('.row', { hasText: 'Covers' }).locator('.row-value').innerText()).trim(), withinPlan.category, 'covers');
    expectEqual(await pressed(seg('Monthly')), 'true', 'repeats');
    expect(await sheet().getByRole('switch', { name: 'Active' }).isChecked(), 'active');
    expect(await sheet().getByRole('button', { name: 'Delete budget' }).isVisible(), 'delete is offered');
    await snap('bud-07-edit');
    // a different name and the 90% level
    await field('Budget name').fill(relaxedName);
    await endTyping(field('Budget name'));
    await level('90%').click();
    await saveButton().click();
    await f.waitToast('Budget updated');
    await f.noLayers();
    await settle(300);
    expectEqual(await f.pageTitle(), relaxedName, 'the detail page has the new name');
    const [edited] = (await budgetsStored()).filter((b) => b.name === relaxedName);
    expectEqual(edited.levels, [80, 90, 100], 'the new level is saved in order');
    expectEqual((await budgetsStored()).length, 5, 'still five budgets: edited, not added');
    await f.back();
    expectEqual((await cards()).map((c) => c.name).includes(relaxedName), true, 'the card has the new name');
  });

  await step('Pausing takes a budget off the cards and into a Paused list; resuming brings it back', async () => {
    await page.locator(`${TOP} .budget-card`).filter({ hasText: relaxedName }).click();
    await settle(350);
    const active = page.locator(`${TOP}`).getByRole('switch', { name: /Active/ });
    expect(await active.isChecked(), 'active to begin with');
    await active.uncheck({ force: true });
    await settle(400);
    expect(/Paused/.test(await page.locator(TOP).locator('.budget-card').innerText()), 'the card on the detail page says Paused');
    await f.back();
    expect((await cards()).every((c) => c.name !== relaxedName), 'it is no longer a card');
    expect(/Paused budgets are not measured and give no alerts\. Open one to resume it\./.test(await page.locator(TOP).innerText()), 'there is a Paused list');
    expect((await page.locator(`${TOP} .group`, { hasText: 'Paused' }).innerText()).includes(relaxedName), 'with the budget in it');
    expect(/Monthly · October 2026 · paused/.test(await page.locator(`${TOP} .group`, { hasText: 'Paused' }).innerText()), 'saying why');
    await snap('bud-08-paused');
    await page.locator(`${TOP} .row`, { hasText: relaxedName }).click();
    await settle(350);
    await page.locator(TOP).getByRole('switch', { name: /Active/ }).check({ force: true });
    await settle(400);
    await f.back();
    expect((await cards()).some((c) => c.name === relaxedName), 'back among the cards');
    expect(!(await page.locator(`${TOP} .group`, { hasText: 'Paused' }).count()), 'and the Paused list is gone');
  });

  await step('Deleting a budget asks first, never touches expenses, and works from the page and from the form', async () => {
    const before = (await stored()).length;
    await page.locator(`${TOP} .budget-card`).filter({ hasText: 'Everything this week' }).click();
    await settle(350);
    await page.locator(TOP).getByRole('button', { name: 'Delete budget' }).click();
    await f.waitDialog('Delete this budget?');
    expect(/Your expenses are not affected\. This cannot be undone\./.test(await f.dialog().innerText()), 'what it says');
    await f.dialogButton('Cancel').click();
    await settle(250);
    expectEqual((await budgetsStored()).length, 5, 'Cancel keeps it');
    await page.locator(TOP).getByRole('button', { name: 'Delete budget' }).click();
    await f.waitDialog('Delete this budget?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Budget deleted');
    await settle(400);
    expectEqual(await f.pageTitle(), 'Budgets', 'back on the list');
    expectEqual((await budgetsStored()).length, 4, 'one budget fewer');
    // from the edit form
    await page.locator(`${TOP} .budget-card`).filter({ hasText: 'Food & Dining' }).click();
    await settle(350);
    await f.navButton('Edit').click();
    await sheet().locator('.navbar-title', { hasText: 'Edit budget' }).waitFor({ timeout: 5000 });
    await sheet().getByRole('button', { name: 'Delete budget' }).click();
    await f.waitDialog('Delete this budget?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Budget deleted');
    await f.noLayers();
    await settle(400);
    expectEqual(await f.pageTitle(), 'Budgets', 'the page behind the form is gone too, so it lands on the list');
    expectEqual((await budgetsStored()).length, 3, 'another budget fewer');
    expectEqual((await stored()).length, before, 'no expense was touched');
  });

  // ------------------------------------------------------------------------------------------ alerts

  await step('A budget with alerts on stays quiet while Settings has budget alerts off', async () => {
    const fuel = spentIn(data, MONTH, 'Fuel');
    const limit = dirhams(fuel * 3) + 100;
    await makeBudget({ amount: String(limit), name: 'Fuel alerts', covers: 'Fuel', alerts: true });
    const [saved] = (await budgetsStored()).filter((b) => b.name === 'Fuel alerts');
    expect(saved.alerts, 'alerts are on for this budget');
    await addExpenseAED(limit * 100 - fuel + 100, 'Fuel', 'Big fill'); // over the limit and every level
    await goToBudgets();
    expectEqual((await notices()).filter((n) => /Budget alert|over budget/.test(n.title)).length, 0, 'no alert while Settings has them off');
    await f.tab('Home');
    await settle(300);
    expectEqual((await notices()).filter((n) => /Budget alert|over budget/.test(n.title)).length, 0, 'none on Home either');
  });

  await step('With alerts switched on in Settings a newly crossed level shows a plain alert that can be dismissed', async () => {
    await f.tab('Settings');
    await settle(300);
    await f.row('Notifications').click();
    await settle(350);
    await page.locator(TOP).getByRole('switch', { name: /Budget alerts/ }).check({ force: true });
    await settle(400);
    expect(/Budget alert/.test(await page.locator(TOP).locator('.sample').innerText()), 'the example alert is the plain one');
    await state((app) => { app.shell.popToRoot(); });
    const entertain = spentIn(data, MONTH, 'Entertainment');
    const limit = dirhams(entertain * 3) + 100;
    await makeBudget({ amount: String(limit), name: 'Fun alerts', covers: 'Entertainment', alerts: true });
    await addExpenseAED(limit * 100 - entertain + 100, 'Entertainment', 'Big night out');
    await goToBudgets();
    const shown = await notices();
    const alert = shown.find((n) => n.title === 'Budget alert');
    expect(Boolean(alert), `an alert is shown (${JSON.stringify(shown)})`);
    expectEqual(alert.body, 'One of your budgets needs attention. Open Budgets to review it.', 'it names no budget and no amount');
    await snap('bud-09-alert');
    await f.tab('Home');
    await settle(300);
    expect((await notices()).some((n) => n.title === 'Budget alert'), 'the same alert is on Home');
    await page.locator(`${TOP} .notice`, { hasText: 'Budget alert' }).getByRole('button', { name: 'Dismiss' }).click();
    await settle(300);
    expect(!(await notices()).some((n) => n.title === 'Budget alert'), 'dismissed');
    await f.tab('Budgets');
    await settle(300);
    expect(!(await notices()).some((n) => n.title === 'Budget alert'), 'and gone from Budgets too');
  });

  await step('The same level is never announced twice, even after the app is opened again', async () => {
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
    await f.tab('Home');
    await settle(500);
    expect(!(await notices()).some((n) => n.title === 'Budget alert'), 'nothing comes back after a reload');
  });

  await step('With amounts allowed in alerts, an alert names the budget and the figures', async () => {
    await f.tab('Settings');
    await settle(300);
    await f.row('Notifications').click();
    await settle(350);
    await page.locator(TOP).getByRole('switch', { name: /Show amounts in alerts/ }).check({ force: true });
    await settle(400);
    expect(/Groceries: 80% used/.test(await page.locator(TOP).locator('.sample').innerText()), 'the example shows what it would say');
    await state((app) => { app.shell.popToRoot(); });
    const shopping = spentIn(data, MONTH, 'Shopping');
    const limit = dirhams(shopping * 3) + 100;
    await makeBudget({ amount: String(limit), name: 'Shopping watch', covers: 'Shopping', alerts: true });
    const extra = limit * 100 - shopping + 100;
    await addExpenseAED(extra, 'Shopping', 'Sale');
    await goToBudgets();
    const shown = await notices();
    const alert = shown.find((n) => n.title === 'Shopping watch: over budget');
    expect(Boolean(alert), `a detailed alert is shown (${JSON.stringify(shown)})`);
    const spent = shopping + extra;
    expectEqual(alert.body, `${await fmt(spent)} of ${await fmt(limit * 100)} spent. Over by ${await fmt(spent - limit * 100)}.`, 'what it says');
    await snap('bud-10-alert-with-amounts');
  });
} finally {
  console.log('\nproblems:', problems);
  console.log('leaked text:', leaks);
  failures = summary();
  await close();
}
process.exit(failures > 0 || problems.length > 0 || leaks.length > 0 ? 1 : 0);

/** Ends the typing in a text box the way a person does: Return. */
async function endTyping(locator) {
  await locator.press('Enter');
  await settle(150);
}
