// The Transactions list end to end in a real browser: what it shows and adds up, how it loads a long list, searching, every
// filter and filters together, sorting, selecting several expenses to export or delete, and that nothing runs off the screen.
// What is expected is worked out here from the stored expenses (with its own small rules), not read back from the app's list code.
// Run: SHOTS_DIR=... node tests/e2e/flows_transactions.mjs [light|dark]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { behaveLikeSafariFocus, launch, openApp, shot, startFresh, seed, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';
import { CSV_COLUMNS, parseCSV } from '../../docs/js/core/csv.js';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, context, url, problems, close } = await launch({ colorScheme: scheme });
await behaveLikeSafariFocus(context);
const { step: run, summary, settle } = makeRunner(page, `transactions-${scheme}`);
const f = finders(page);
const leaks = [];
const snap = async (name) => { await shot(page, `${name}-${scheme}`); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const state = (fn, arg) => inApp(page, fn, arg);
const DOWNLOADS = fs.mkdtempSync(path.join(process.env.DOWNLOADS_DIR || os.tmpdir(), 'expenses-downloads-'));
let failures = 0;

// ------------------------------------------------------------------------------------------------ what is stored

/** Every expense, as plain facts (newest first, the order the app keeps them in). */
const stored = () => state((app) => app.snapshot.expenses.map((e) => ({
  id: e.id,
  minor: e.amount.minorUnits,
  currency: e.amount.currencyCode,
  day: e.localDay.toString(),
  merchant: e.merchant,
  notes: e.notes,
  category: app.snapshot.category(e.categoryID).name,
  sub: e.subcategoryID ? app.snapshot.subcategory(e.subcategoryID).name : '',
  method: e.paymentMethodID ? app.snapshot.paymentMethod(e.paymentMethodID).name : '',
  tags: [...e.tags],
})));
const fmt = (minor) => state(async (app, value) => {
  const { money } = await import('/js/core/money.js');
  return app.formatter.money.string(money(value, app.currency));
}, minor);
const dayName = (day) => state(async (app, iso) => {
  const { LocalDate } = await import('/js/core/localdate.js');
  return app.formatter.dayHeader(LocalDate.fromISO(iso), app.today());
}, day);

const sumOf = (list) => list.reduce((total, e) => total + (e.currency === 'AED' ? e.minor : 0), 0);
const plain = (minor) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
const fold = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** The words of a search must each appear somewhere in the expense (merchant, notes, category, subcategory, method, tags, amount). */
const matchesWords = (e, text) => {
  const blob = fold([e.merchant, e.notes, e.category, e.sub, e.method, ...e.tags, plain(e.minor)].join(' '));
  return fold(text).split(/\s+/).filter(Boolean).every((word) => blob.includes(word));
};
const ids = (list) => list.map((e) => e.id).sort();

// ------------------------------------------------------------------------------------------------ what is on screen

const sheet = () => page.locator('.layer').last();
const searchBox = () => page.locator(`${TOP} input[type=search]`);
const toolButton = (name) => page.locator(`${TOP} .toolbar .tool-btn`).filter({ hasText: name }).first();
const rowTitled = (parent, title) => parent.locator('.row').filter({ has: page.locator('.row-title', { hasText: f.exact(title) }) }).first();

/** Opens the rest of a long list ("Show more") until everything is drawn. */
async function showAll() {
  for (let i = 0; i < 40; i += 1) {
    const more = page.locator(`${TOP} .tx-more:not([hidden]) button`);
    if (await more.count() === 0) return;
    await more.click();
    await settle(60);
  }
}
/** What the list shows right now. */
const onScreen = () => page.locator(TOP).evaluate((root) => ({
  count: (root.querySelector('.tx-count') || {}).textContent || null,
  total: (root.querySelector('.tx-total') || {}).textContent || null,
  notes: [...root.querySelectorAll('.tx-summary .t-foot')].map((el) => el.textContent.trim()),
  chips: [...root.querySelectorAll('.chip-wrap .chip')].map((el) => el.textContent.trim()),
  chipLabels: [...root.querySelectorAll('.chip-wrap .chip')].map((el) => el.getAttribute('aria-label')),
  heads: [...root.querySelectorAll('.tx-list .tx-day')].filter((day) => day.querySelector('.day-head')).map((day) => ({
    name: day.querySelector('.day-name') ? day.querySelector('.day-name').textContent.trim() : null,
    total: day.querySelector('.day-total') ? day.querySelector('.day-total').textContent.trim() : null,
    rows: day.querySelectorAll('.row').length,
  })),
  rows: [...root.querySelectorAll('.tx-list .row')].map((row) => ({
    title: row.querySelector('.row-title').textContent.trim(),
    amount: row.querySelector('.row-amount').firstChild.textContent.trim(),
    amountSub: row.querySelector('.row-amount .sub') ? row.querySelector('.row-amount .sub').textContent.trim() : '',
    sub: row.querySelector('.row-sub') ? row.querySelector('.row-sub').textContent.trim() : '',
    pressed: row.getAttribute('aria-pressed'),
  })),
  empty: (root.querySelector('.empty .empty-title') || {}).textContent || null,
  filterLabel: (root.querySelector('.toolbar .tool-btn') || {}).getAttribute ? root.querySelector('.toolbar .tool-btn').getAttribute('aria-label') : null,
  sortLabel: (root.querySelectorAll('.toolbar .tool-btn')[1] || {}).getAttribute ? root.querySelectorAll('.toolbar .tool-btn')[1].getAttribute('aria-label') : null,
  selectLabel: (root.querySelector('.toolbar .tool-btn.plain') || {}).textContent || null,
}));

/** The list must be exactly these expenses: how many, how much, and which ones (all rows drawn first). */
async function expectList(expected, label) {
  await showAll();
  const screen = await onScreen();
  const everything = (await stored()).length;
  if (expected.length === 0) {
    expectEqual(screen.empty, 'No matching expenses', `${label}: empty message`);
    return screen;
  }
  expectEqual(screen.rows.length, expected.length, `${label}: rows drawn`);
  expectEqual(screen.total, await fmt(sumOf(expected)), `${label}: total`);
  const noun = (n) => (n === 1 ? '1 transaction' : `${n} transactions`);
  const wanted = expected.length === everything ? noun(expected.length) : `${expected.length} of ${noun(everything)}`;
  expectEqual(screen.count.replace(/\s+/g, ' ').trim(), wanted, `${label}: count`);
  return screen;
}

async function typeSearch(text) {
  await searchBox().fill(text);
  await settle(450);
}
async function clearSearchBox() {
  await searchBox().fill('');
  await settle(450);
}

/** Opens the Filters sheet. */
async function openFilters() {
  await toolButton('Filters').click();
  await sheet().locator('.navbar-title', { hasText: 'Filters' }).waitFor({ timeout: 5000 });
  await settle(250);
}
/** In the Filters sheet: opens one of its rows, ticks the named choices, and closes it with Done. */
async function choose(rowName, names) {
  await rowTitled(sheet(), rowName).click();
  await settle(300);
  for (const name of names) {
    await rowTitled(sheet(), name).click();
    await settle(80);
  }
  await f.sheetAction('Done').click();
  await settle(250);
}
async function applyFilters() {
  await f.sheetAction('Done').click();
  await f.noLayers();
  await settle(350);
}
/** Switches every filter and the search off, the way a person would: the chips and the search box. */
async function resetEverything() {
  await state((app) => { app.ui.closeAll(); app.shell.popToRoot(); app.shell.selectTab('transactions'); });
  await settle(250);
  const done = page.getByRole('button', { name: 'Done selecting' });
  if (await done.count() > 0) await done.click();
  await searchBox().fill('');
  await settle(450);
  for (let i = 0; i < 8; i += 1) {
    const chip = page.locator(`${TOP} .chip-wrap .chip`).first();
    if (await chip.count() === 0 || !(await chip.isVisible())) break;
    await chip.click();
    await settle(250);
  }
  await chooseSortOption('Date, newest first');
}
async function chooseSortOption(label) {
  await toolButton('Sort').or(page.locator(`${TOP} .toolbar .tool-btn[aria-label^="Sort"]`)).first().click();
  await f.actionItem(label).click();
  await settle(350);
}

async function takeDownload(trigger) {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const file = path.join(DOWNLOADS, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  return { name: download.suggestedFilename(), text: fs.readFileSync(file, 'utf8') };
}

const parseAmountText = (text) => text.replace(/[^\d.]/g, '');

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await settle(300);

  console.log(`\nThe Transactions list (${scheme})`);

  // ------------------------------------------------------------------------------------------ nothing yet

  await run('With no expenses the list invites the person to add one and offers nothing to select or export', async () => {
    await f.tab('Transactions');
    await settle(350);
    const screen = await onScreen();
    expectEqual(screen.empty, 'No expenses yet', 'empty title');
    expect(await page.locator(`${TOP} .tool-btn.plain`).isHidden(), 'there is nothing to select');
    expectEqual(await page.locator(`${TOP} button[aria-label="Export this list as a CSV file"]`).isHidden(), true, 'there is nothing to export');
    await snap('tx-01-empty');
    await page.locator(`${TOP} .empty button`, { hasText: 'Add an expense' }).click();
    await f.waitSheetTitle?.('New expense');
    await sheet().locator('.navbar-title', { hasText: 'New expense' }).waitFor({ timeout: 5000 });
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  // from here on, every step starts from the plain list: no search, no filter, newest first, nothing selected
  const step = (title, fn) => run(title, async () => { await resetEverything(); await fn(); });

  await seed(page, url, {}); // about 170 expenses over 76 days, with notes, tags, methods and one very large, very long-named one
  await state(async (app) => {
    const { makeDraft } = await import('/js/core/models.js');
    const { money } = await import('/js/core/money.js');
    const category = app.snapshot.categories.find((c) => c.name === 'Coffee & Snacks');
    await app.services.expenses.save(makeDraft({
      amount: money(1850, app.currency), day: app.today(), timeZoneID: app.timeZone(), categoryID: category.id, merchant: 'Café Nero', notes: 'Crème brûlée',
    }), app.today());
  });
  await f.tab('Home');
  await settle(300);
  await f.tab('Transactions');
  await settle(500);
  const everything = await stored();
  const N = everything.length;
  console.log(`  (${N} expenses loaded)`);

  // ------------------------------------------------------------------------------------------ the whole list

  await step('The list shows every expense, newest first, grouped by day with each day\'s subtotal', async () => {
    const screen = await expectList(everything, 'whole list');
    const days = [...new Set(everything.map((e) => e.day))];
    expectEqual(screen.heads.length, days.length, 'day groups');
    for (const [index, day] of days.entries()) {
      const forDay = everything.filter((e) => e.day === day);
      expectEqual(screen.heads[index].rows, forDay.length, `rows under ${day}`);
      expectEqual(screen.heads[index].name, await dayName(day), `heading of ${day}`);
      expectEqual(screen.heads[index].total, await fmt(sumOf(forDay)), `subtotal of ${day}`);
    }
    expect(days.every((d, i) => i === 0 || days[i - 1] > d), 'days run from newest to oldest');
    expectEqual(screen.heads[0].name, 'Today', 'the first heading is Today');
    expectEqual(screen.filterLabel, 'Filters', 'no filter is on');
    expectEqual(screen.sortLabel, 'Sort: Date, newest first', 'the sort is described');
    expectEqual(screen.chips, [], 'no filter chips');
    await snap('tx-02-list');
  });

  await step('A long list is drawn a screenful at a time and the rest is one tap away', async () => {
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
    await f.tab('Transactions');
    await settle(500);
    const firstScreen = await onScreen();
    expect(N > 100, `the sample should be long enough to need several screens (found ${N})`);
    expectEqual(firstScreen.rows.length, 60, 'rows drawn at first');
    expect(await page.locator(`${TOP} .tx-more:not([hidden]) button`).isVisible(), 'Show more is offered');
    await page.locator(`${TOP} .tx-more:not([hidden]) button`).click();
    await settle(200);
    expectEqual((await onScreen()).rows.length, 120, 'rows after one more');
    await showAll();
    expectEqual((await onScreen()).rows.length, N, 'rows when everything is shown');
    expect(await page.locator(`${TOP} .tx-more:not([hidden])`).count() === 0, 'Show more goes when there is no more');
  });

  // ------------------------------------------------------------------------------------------ searching

  await step('Searching finds words in merchants, notes, categories and amounts, and says how many matched', async () => {
    for (const text of ['spinneys', 'monthly rent', 'dewa', '512.40', 'Bills', 'debit carrefour']) {
      await typeSearch(text);
      const expected = everything.filter((e) => matchesWords(e, text));
      expect(expected.length > 0, `the sample should have something for "${text}"`);
      const screen = await expectList(expected, `search "${text}"`);
      expect(screen.notes.includes('Total of the expenses shown'), `"${text}": says the total is of the expenses shown`);
    }
    await typeSearch('spinneys');
    await snap('tx-03-search');
    await typeSearch('family');
    const tagged = everything.filter((e) => matchesWords(e, 'family'));
    expect(tagged.length > 0, 'something is tagged family');
    await expectList(tagged, 'search "family" finds tags');
  });

  await step('A search ignores capitals and accents, and every word has to be there', async () => {
    await typeSearch('SPINNEYS');
    await expectList(everything.filter((e) => matchesWords(e, 'spinneys')), 'capitals');
    await typeSearch('cafe');
    const cafe = everything.filter((e) => e.merchant === 'Café Nero');
    expectEqual(cafe.length, 1, 'one expense is at Café Nero');
    await expectList(everything.filter((e) => matchesWords(e, 'cafe')), 'accents');
    await typeSearch('CRÈME brulee');
    await expectList(everything.filter((e) => matchesWords(e, 'creme brulee')), 'accents and capitals in two words');
    expectEqual((await onScreen()).rows.map((r) => r.title), ['Café Nero'], 'the one expense found');
    await typeSearch('spinneys cash');
    await expectList(everything.filter((e) => matchesWords(e, 'spinneys cash')), 'two words that do not go together');
  });

  await step('A search with no result says so, and one tap brings everything back', async () => {
    await typeSearch('zzzzzz');
    const screen = await onScreen();
    expectEqual(screen.empty, 'No matching expenses', 'title');
    expect(/Try different words, or clear the search and filters\./.test(await page.locator(TOP).innerText()), 'advice');
    await snap('tx-04-no-match');
    await page.locator(`${TOP} .empty button`, { hasText: 'Clear search and filters' }).click();
    await settle(450);
    expectEqual(await searchBox().inputValue(), '', 'the search box is emptied');
    await expectList(everything, 'after clearing');
  });

  await step('The small cross in the search box clears it, and Return puts the keyboard away', async () => {
    await searchBox().click();
    await searchBox().pressSequentially('careem');
    await settle(450);
    await expectList(everything.filter((e) => matchesWords(e, 'careem')), 'typed');
    await searchBox().press('Enter');
    expect(!(await searchBox().evaluate((el) => el === document.activeElement)), 'Return ends the typing');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await settle(450);
    expectEqual(await searchBox().inputValue(), '', 'cleared');
    await expectList(everything, 'after the cross');
  });

  // ------------------------------------------------------------------------------------------ filters

  await step('The category filter keeps only the chosen categories, and its chip takes the filter off', async () => {
    await openFilters();
    await snap('tx-05-filters-sheet');
    await choose('Categories', ['Groceries', 'Fuel']);
    expectEqual((await rowTitled(sheet(), 'Categories').locator('.row-value').innerText()).trim(), '2 categories', 'the sheet says what is chosen');
    await applyFilters();
    const expected = everything.filter((e) => ['Groceries', 'Fuel'].includes(e.category));
    const screen = await expectList(expected, 'two categories');
    expectEqual(screen.chips, ['2 categories'], 'chip');
    expectEqual(screen.filterLabel, 'Filters, 1 on', 'the Filters button says one is on');
    expect(screen.notes.includes('Total of the expenses shown'), 'the total is of what is shown');
    await snap('tx-06-category-filter');
    await page.getByRole('button', { name: 'Remove filter: 2 categories' }).click();
    await settle(350);
    await expectList(everything, 'after taking the chip off');
  });

  await step('One category, one payment method and one tag each filter on their own', async () => {
    await openFilters();
    await choose('Payment methods', ['Cash']);
    await applyFilters();
    await expectList(everything.filter((e) => e.method === 'Cash'), 'Cash');
    expectEqual((await onScreen()).chips, ['Cash'], 'chip says which method');
    await resetEverything();

    await openFilters();
    await choose('Tags', ['#family']);
    await applyFilters();
    await expectList(everything.filter((e) => e.tags.includes('family')), 'tag family');
    expectEqual((await onScreen()).chips, ['#family'], 'chip says which tag');
    await resetEverything();

    await openFilters();
    await choose('Tags', ['#family', '#work']);
    await applyFilters();
    await expectList(everything.filter((e) => e.tags.includes('family') || e.tags.includes('work')), 'tags family or work');
    expectEqual((await onScreen()).chips, ['2 tags'], 'chip counts the tags');
    await resetEverything();
  });

  await step('The date filter works with a ready-made period and with two chosen days, both days included', async () => {
    await openFilters();
    await rowTitled(sheet(), 'Dates').click();
    await settle(300);
    await rowTitled(sheet(), 'This month').click();
    await settle(300);
    await applyFilters();
    const inMonth = everything.filter((e) => e.day >= '2026-10-01' && e.day <= '2026-10-31');
    expect(inMonth.length > 10 && inMonth.length < N, 'the sample has some expenses this month and some earlier');
    const screen = await expectList(inMonth, 'this month');
    expect(/Oct/.test(screen.chips[0]) && /2026/.test(screen.chips[0]), `the chip names the dates (${screen.chips[0]})`);
    await resetEverything();

    await openFilters();
    await rowTitled(sheet(), 'Dates').click();
    await settle(300);
    await rowTitled(sheet(), 'Custom range').click();
    await settle(300);
    await sheet().getByLabel('From', { exact: true }).fill('2026-09-10');
    await sheet().getByLabel('To', { exact: true }).fill('2026-09-20');
    await f.sheetAction('Use').click();
    await settle(300);
    await applyFilters();
    const inRange = everything.filter((e) => e.day >= '2026-09-10' && e.day <= '2026-09-20');
    expect(inRange.some((e) => e.day === '2026-09-10') && inRange.some((e) => e.day === '2026-09-20'), 'the sample has expenses on both end days');
    await expectList(inRange, 'two chosen days');
    await snap('tx-07-date-filter');
    await resetEverything();
  });

  await step('A custom range cannot end before it starts', async () => {
    await openFilters();
    await rowTitled(sheet(), 'Dates').click();
    await settle(300);
    await rowTitled(sheet(), 'Custom range').click();
    await settle(300);
    await sheet().getByLabel('From', { exact: true }).fill('2026-09-20');
    await sheet().getByLabel('To', { exact: true }).fill('2026-09-10');
    await f.sheetAction('Use').click();
    await settle(250);
    expect(/The end date cannot be before the start date\./.test(await sheet().innerText()), 'the sheet says why');
    await f.sheetAction('Cancel').click(); // the two days
    await settle(250);
    await f.sheetAction('Cancel').click(); // the list of periods
    await settle(250);
    await f.sheetAction('Cancel').click(); // the filters
    await f.noLayers();
    await expectList(everything, 'nothing was filtered');
  });

  await step('Filters and a search all have to match together', async () => {
    await openFilters();
    await choose('Categories', ['Groceries']);
    await choose('Payment methods', ['Debit Card']);
    await rowTitled(sheet(), 'Dates').click();
    await settle(300);
    await rowTitled(sheet(), 'This month').click();
    await settle(300);
    await applyFilters();
    const three = everything.filter((e) => e.category === 'Groceries' && e.method === 'Debit Card' && e.day >= '2026-10-01' && e.day <= '2026-10-31');
    expect(three.length > 0, 'the sample has some');
    const screen = await expectList(three, 'three filters');
    expectEqual(screen.filterLabel, 'Filters, 3 on', 'the button counts the filters');
    expectEqual(screen.chips.length, 3, 'three chips');
    await typeSearch('carrefour');
    const withSearch = three.filter((e) => matchesWords(e, 'carrefour'));
    await expectList(withSearch, 'three filters and a search');
    expectEqual((await onScreen()).filterLabel, 'Filters, 3 on', 'the search is not counted as a filter');
    await snap('tx-08-combined');
    // each chip takes off only its own filter
    await clearSearchBox();
    await page.getByRole('button', { name: 'Remove filter: Debit Card' }).click();
    await settle(350);
    await expectList(everything.filter((e) => e.category === 'Groceries' && e.day >= '2026-10-01' && e.day <= '2026-10-31'), 'after taking off the payment method');
    await resetEverything();
  });

  await step('Cancelling the filter sheet changes nothing; Clear all filters empties it', async () => {
    await openFilters();
    await choose('Categories', ['Fuel']);
    await f.sheetAction('Cancel').click();
    await f.noLayers();
    await settle(300);
    await expectList(everything, 'after cancelling');
    await openFilters();
    await choose('Categories', ['Fuel']);
    await choose('Payment methods', ['Credit Card']);
    await applyFilters();
    expectEqual((await onScreen()).filterLabel, 'Filters, 2 on', 'two on');
    await openFilters();
    await sheet().getByRole('button', { name: 'Clear all filters' }).click();
    await settle(250);
    expectEqual((await rowTitled(sheet(), 'Categories').locator('.row-value').innerText()).trim(), 'Any', 'categories are Any again');
    await applyFilters();
    await expectList(everything, 'after clearing all');
  });

  await step('Search and filters are still there when the person comes back from another tab', async () => {
    await openFilters();
    await choose('Categories', ['Groceries']);
    await applyFilters();
    await typeSearch('lulu');
    const expected = everything.filter((e) => e.category === 'Groceries' && matchesWords(e, 'lulu'));
    await expectList(expected, 'before leaving');
    await f.tab('Home');
    await settle(400);
    await f.tab('Transactions');
    await settle(400);
    expectEqual(await searchBox().inputValue(), 'lulu', 'the search text is still in the box');
    await expectList(expected, 'after coming back');
    await resetEverything();
  });

  // ------------------------------------------------------------------------------------------ sorting

  await step('Sorting by amount lists them highest or lowest first, with each one\'s own day', async () => {
    await chooseSortOption('Amount, highest first');
    let screen = await onScreen();
    expectEqual(screen.sortLabel, 'Sort: Amount, highest first', 'the sort is described');
    expectEqual(screen.heads.length, 0, 'no day headings when sorted by amount');
    await showAll();
    screen = await onScreen();
    expectEqual(screen.rows.length, N, 'every expense is listed');
    const biggest = Math.max(...everything.map((e) => e.minor));
    expectEqual(screen.rows[0].amount, await fmt(biggest), 'the largest comes first');
    expect(screen.rows[0].title.startsWith('Emirates Holidays'), 'and it is the holiday');
    const minors = screen.rows.map((r) => Number(parseAmountText(r.amount).replace('.', '')));
    expect(minors.every((m, i) => i === 0 || minors[i - 1] >= m), 'amounts never go up as the list goes down');
    expect(screen.rows.every((r) => r.amountSub !== ''), 'each row says its own day');
    await snap('tx-09-sort-amount');
    await chooseSortOption('Amount, lowest first');
    await showAll();
    screen = await onScreen();
    const upward = screen.rows.map((r) => Number(parseAmountText(r.amount).replace('.', '')));
    expect(upward.every((m, i) => i === 0 || upward[i - 1] <= m), 'amounts never go down as the list goes down');
    expectEqual(upward[0], Math.min(...everything.map((e) => e.minor)), 'the smallest comes first');
  });

  await step('Sorting by merchant or category puts them in alphabetical order, either way round', async () => {
    const sorted = (names, up) => names.every((n, i) => i === 0 || (up ? names[i - 1] <= n : names[i - 1] >= n));
    await chooseSortOption('Merchant, A to Z');
    await showAll();
    let screen = await onScreen();
    let names = screen.rows.map((r) => fold(r.title));
    expect(sorted(names, true), 'merchants A to Z');
    expectEqual(names[0], fold(everything.map((e) => e.merchant).sort((a, b) => (fold(a) < fold(b) ? -1 : 1))[0]), 'first merchant');
    await chooseSortOption('Merchant, Z to A');
    await showAll();
    screen = await onScreen();
    names = screen.rows.map((r) => fold(r.title));
    expect(sorted(names, false), 'merchants Z to A');
    await chooseSortOption('Category, A to Z');
    await showAll();
    screen = await onScreen();
    const categoryOf = new Map();
    // rows show the merchant as their title; the category is the first part of the line under it
    names = screen.rows.map((r) => fold(r.sub.split(' · ')[0].split(' › ')[0]));
    expect(sorted(names, true), 'categories A to Z');
    expectEqual(names[0], 'bills & utilities', 'the first category');
    void categoryOf;
    await chooseSortOption('Category, Z to A');
    await showAll();
    screen = await onScreen();
    names = screen.rows.map((r) => fold(r.sub.split(' · ')[0].split(' › ')[0]));
    expect(sorted(names, false), 'categories Z to A');
  });

  await step('Sorting by date, oldest first, still groups by day and starts with the earliest day', async () => {
    await chooseSortOption('Date, oldest first');
    const screen = await expectList(everything, 'oldest first');
    const days = [...new Set(everything.map((e) => e.day))].sort();
    expectEqual(screen.heads.length, days.length, 'day groups');
    expectEqual(screen.heads[0].name, await dayName(days[0]), 'first heading is the earliest day');
    expectEqual(screen.heads[0].total, await fmt(sumOf(everything.filter((e) => e.day === days[0]))), 'its subtotal');
    expectEqual(screen.heads[screen.heads.length - 1].name, 'Today', 'the last heading is today');
    await chooseSortOption('Date, newest first');
    expectEqual((await onScreen()).heads[0].name, 'Today', 'back to newest first');
  });

  await step('A filtered list can be sorted too', async () => {
    await openFilters();
    await choose('Categories', ['Groceries']);
    await applyFilters();
    await chooseSortOption('Amount, highest first');
    const groceries = everything.filter((e) => e.category === 'Groceries');
    const screen = await expectList(groceries, 'Groceries by amount');
    expectEqual(screen.rows[0].amount, await fmt(Math.max(...groceries.map((e) => e.minor))), 'the largest grocery bill is first');
    await resetEverything();
  });

  // ------------------------------------------------------------------------------------------ selecting

  await step('Select mode: tap to tick, count them, select all or none; tapping a row does not open it', async () => {
    await page.getByRole('button', { name: 'Select expenses' }).click();
    await settle(300);
    let text = await page.locator(TOP).innerText();
    expect(/Tap expenses to select them/.test(text), 'the bar says what to do');
    expect(await page.locator(`${TOP} .selection-bar button`, { hasText: 'Export' }).isDisabled(), 'Export waits for a selection');
    expect(await page.locator(`${TOP} .selection-bar button`, { hasText: 'Delete' }).isDisabled(), 'Delete waits for a selection');
    expectEqual((await onScreen()).selectLabel.trim(), 'Done', 'the button now says Done');
    expect(await page.locator(`${TOP} button[aria-label="Add an expense"]`).isHidden(), 'adding is out of the way');
    const rows = page.locator(`${TOP} .tx-list .row`);
    await rows.nth(0).click();
    await rows.nth(2).click();
    await rows.nth(3).click();
    await settle(200);
    expect(await page.locator('.layer').count() === 0, 'no editor opened');
    text = await page.locator(TOP).innerText();
    expect(/3 selected/.test(text), 'the bar counts them');
    expectEqual(await rows.nth(0).getAttribute('aria-pressed'), 'true', 'first is ticked');
    expectEqual(await rows.nth(1).getAttribute('aria-pressed'), 'false', 'second is not');
    await snap('tx-10-selecting');
    await rows.nth(2).click();
    await settle(150);
    expect(/2 selected/.test(await page.locator(TOP).innerText()), 'tapping again unticks');
    await page.locator(`${TOP} .navbar button`, { hasText: 'Select all' }).click();
    await settle(300);
    await showAll();
    expect(new RegExp(`${N} selected`).test(await page.locator(TOP).innerText()), 'Select all ticks every expense in the list');
    await page.locator(`${TOP} .navbar button`, { hasText: 'Select none' }).click();
    await settle(200);
    expect(/Tap expenses to select them/.test(await page.locator(TOP).innerText()), 'Select none unticks them');
    await page.getByRole('button', { name: 'Done selecting' }).click();
    await settle(300);
    expectEqual((await onScreen()).selectLabel.trim(), 'Select', 'back to normal');
  });

  await step('Select all with a filter on selects only what the filter shows', async () => {
    await openFilters();
    await choose('Categories', ['Fuel']);
    await applyFilters();
    const fuel = everything.filter((e) => e.category === 'Fuel');
    await page.getByRole('button', { name: 'Select expenses' }).click();
    await settle(250);
    await page.locator(`${TOP} .navbar button`, { hasText: 'Select all' }).click();
    await settle(250);
    expect(new RegExp(`${fuel.length} selected`).test(await page.locator(TOP).innerText()), `all ${fuel.length} fuel expenses are ticked, and nothing else`);
    await page.getByRole('button', { name: 'Done selecting' }).click();
    await resetEverything();
  });

  await step('Exporting the selected expenses writes a CSV file with just those', async () => {
    await page.getByRole('button', { name: 'Select expenses' }).click();
    await settle(250);
    const rows = page.locator(`${TOP} .tx-list .row`);
    const picked = [];
    for (const index of [1, 4, 7]) {
      picked.push(await rows.nth(index).evaluate((row) => ({ title: row.querySelector('.row-title').textContent.trim(), amount: row.querySelector('.row-amount').firstChild.textContent.trim() })));
      await rows.nth(index).click();
    }
    await settle(200);
    const file = await takeDownload(() => page.locator(`${TOP} .selection-bar button`, { hasText: 'Export' }).click());
    expect(/^expenses-2026-10-20\.csv$/.test(file.name), `file name (${file.name})`);
    await f.waitToast('3 expenses saved as expenses-2026-10-20.csv');
    const table = parseCSV(file.text);
    expectEqual(table[0], [...CSV_COLUMNS], 'the header row');
    expectEqual(table.length - 1, 3, 'one row for each selected expense');
    const col = (name) => CSV_COLUMNS.indexOf(name);
    const written = table.slice(1).map((r) => `${r[col('Merchant')] || r[col('Category')]}|${r[col('Amount')]}`).sort();
    const wanted = picked.map((p) => `${p.title}|${parseAmountText(p.amount)}`).sort();
    expectEqual(written, wanted, 'the expenses in the file are the ones that were ticked');
    await page.getByRole('button', { name: 'Done selecting' }).click();
    await settle(250);
  });

  await step('Exporting the list while a filter is on writes only what the filter shows', async () => {
    await openFilters();
    await choose('Categories', ['Fuel']);
    await applyFilters();
    const fuel = everything.filter((e) => e.category === 'Fuel');
    const file = await takeDownload(() => page.getByRole('button', { name: 'Export this list as a CSV file' }).click());
    const table = parseCSV(file.text);
    expectEqual(table.length - 1, fuel.length, 'rows in the file');
    expect(table.slice(1).every((r) => r[CSV_COLUMNS.indexOf('Category')] === 'Fuel'), 'every row is a fuel expense');
    expectEqual(table.slice(1).map((r) => r[CSV_COLUMNS.indexOf('ID')]).sort(), ids(fuel), 'exactly those expenses');
    await resetEverything();
  });

  await step('Deleting selected expenses asks first and shows what they add up to; Cancel keeps them, Delete removes exactly those and leaves select mode', async () => {
    await page.getByRole('button', { name: 'Select expenses' }).click();
    await settle(250);
    const rows = page.locator(`${TOP} .tx-list .row`);
    const picked = [];
    for (const index of [0, 1]) {
      picked.push(await rows.nth(index).evaluate((row) => row.querySelector('.row-amount').firstChild.textContent.trim()));
      await rows.nth(index).click();
    }
    await page.locator(`${TOP} .selection-bar button`, { hasText: 'Delete' }).click();
    await f.waitDialog('Delete 2 expenses?');
    const sum = (await stored()).slice(0, 2).reduce((total, e) => total + e.minor, 0);
    const message = await f.dialog().locator('.dialog-message').innerText();
    expect(message.includes(await fmt(sum)), `the question says what they add up to (${message})`);
    expect(/cannot be undone/.test(message), 'and that it cannot be undone');
    await snap('tx-11-delete-ask');
    await f.dialogButton('Cancel').click();
    await settle(300);
    expectEqual((await stored()).length, N, 'nothing deleted yet');
    expect(/2 selected/.test(await page.locator(TOP).innerText()), 'the selection is still there');
    // now for real
    const before = await stored();
    const going = before.slice(0, 2);
    await page.locator(`${TOP} .selection-bar button`, { hasText: 'Delete' }).click();
    await f.waitDialog('Delete 2 expenses?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Deleted 2 expenses.');
    await settle(400);
    const after = await stored();
    expectEqual(after.length, N - 2, 'expenses left');
    expect(after.every((e) => !ids(going).includes(e.id)), 'the two are gone');
    expectEqual(ids(after), ids(before.slice(2)), 'and nothing else was touched');
    expectEqual((await onScreen()).selectLabel.trim(), 'Select', 'select mode is over');
    const screen = await onScreen();
    expectEqual(screen.count.replace(/\s+/g, ' ').trim(), `${N - 2} transactions`, 'the count follows');
    expectEqual(screen.total, await fmt(sumOf(after)), 'and the total');
  });

  await step('Leaving the tab while selecting ends select mode', async () => {
    await page.getByRole('button', { name: 'Select expenses' }).click();
    await settle(250);
    await page.locator(`${TOP} .tx-list .row`).first().click();
    await f.tab('Home');
    await settle(300);
    await f.tab('Transactions');
    await settle(400);
    expectEqual((await onScreen()).selectLabel.trim(), 'Select', 'back to normal');
    expect(!/selected/.test(await page.locator(TOP).innerText()), 'nothing stays ticked');
  });

  // ------------------------------------------------------------------------------------------ edit from the list and layout

  await step('Tapping an expense opens it, and a change shows in the list at once', async () => {
    await typeSearch('emirates');
    await page.locator(`${TOP} .tx-list .row`).first().click();
    await sheet().locator('.navbar-title', { hasText: 'Edit expense' }).waitFor({ timeout: 5000 });
    await settle(300);
    await sheet().getByLabel('Notes', { exact: true }).fill('Flights and hotel for the whole family');
    await sheet().locator('h2.section-title', { hasText: 'Notes' }).tap();
    await f.sheetAction('Save').click();
    await f.waitToast('Expense updated');
    await f.noLayers();
    await settle(300);
    await typeSearch('whole family');
    expectEqual((await onScreen()).rows.length, 1, 'the new words in the notes are found by the search');
    await resetEverything();
  });

  await step('No row, heading or number runs past the edge of the screen, even the very long merchant name', async () => {
    await typeSearch('extremely long');
    expectEqual((await onScreen()).rows.length, 1, 'the long-named expense');
    const wide = await page.locator(TOP).evaluate((root) => {
      const limit = document.documentElement.clientWidth;
      return [...root.querySelectorAll('.tx-list *, .tx-summary *, .toolbar *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > limit + 0.5 || r.left < -0.5);
      }).map((el) => `${el.tagName}.${el.className}`);
    });
    expectEqual(wide, [], 'elements wider than the screen');
    await snap('tx-12-long-name');
    await resetEverything();
    const wideList = await page.locator(TOP).evaluate((root) => {
      const limit = document.documentElement.clientWidth;
      return [...root.querySelectorAll('.tx-list *, .tx-summary *, .toolbar *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > limit + 0.5 || r.left < -0.5);
      }).length;
    });
    expectEqual(wideList, 0, 'elements wider than the screen in the whole list');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'the page does not scroll sideways');
  });

  await step('Another currency is listed but never added into the total', async () => {
    await state(async (app) => {
      const { makeDraft } = await import('/js/core/models.js');
      const { money } = await import('/js/core/money.js');
      await app.services.expenses.save(makeDraft({
        amount: money(250000, 'USD'), day: app.today(), timeZoneID: app.timeZone(), categoryID: app.snapshot.categories[0].id, merchant: 'Hotel in New York',
      }), app.today());
    });
    await f.tab('Home');
    await settle(250);
    await f.tab('Transactions');
    await settle(400);
    const now = await stored();
    const screen = await expectList(now, 'with a dollar expense');
    expect(screen.notes.some((n) => /1 expense in another currency is listed but not added into the total\./.test(n)), `says so (${screen.notes.join(' / ')})`);
    expectEqual(screen.total, await fmt(sumOf(now)), 'the total is dirhams only');
    await snap('tx-13-other-currency');
  });
} finally {
  console.log('\nproblems:', problems);
  console.log('leaked text:', leaks);
  failures = summary();
  await close();
}
process.exit(failures > 0 || problems.length > 0 || leaks.length > 0 ? 1 : 0);
