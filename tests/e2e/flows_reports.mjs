// The release-critical parts of Home and Reports in a real browser (Chromium): the totals on screen agree with what is stored,
// and exporting from Reports says plainly that PDF is not available yet while the CSV works and holds the report's expenses.
// The expected figures are worked out here from the stored expenses, not read back from the app's report code.
// Run: SHOTS_DIR=... node tests/e2e/flows_reports.mjs [light|dark]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, openApp, shot, startFresh, seed, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const { step, summary, settle } = makeRunner(page, `reports-${scheme}`);
const f = finders(page);
const state = (fn, arg) => inApp(page, fn, arg);
const leaks = [];
const DOWNLOADS = fs.mkdtempSync(path.join(process.env.DOWNLOADS_DIR || os.tmpdir(), 'expenses-reports-'));

const MONTH = ['2026-10-01', '2026-10-31'];
const LAST_MONTH = ['2026-09-01', '2026-09-30'];

const stored = () => state((app) => app.snapshot.expenses.map((e) => ({
  id: e.id, minor: e.amount.minorUnits, currency: e.amount.currencyCode, day: e.localDay.toString(),
})));
const inRange = (data, [from, to]) => data.filter((e) => e.currency === 'AED' && e.day >= from && e.day <= to);
const sum = (rows) => rows.reduce((total, e) => total + e.minor, 0);
/** "AED 1,234.50", with every kind of space turned into a plain one so the comparison does not depend on the app's no-break space. */
const aed = (minor) => `AED ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (text) => text.replace(/\s+/g, ' ').trim();
const bigTotal = async () => plain(await page.locator(`${TOP} .money-big .sr-only`).first().textContent());

/** The records of a CSV file (RFC 4180: quoted fields may hold commas, quotes and line breaks). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\r' || c === '\n') {
      if (c === '\r' && body[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const openExportSheet = async () => {
  await page.getByRole('button', { name: 'Export this report' }).click();
  await settle(300);
};

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  // A phone that cannot share files: the file is downloaded, which is how this test can read it.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  });
  const data = await stored();
  const thisMonth = inRange(data, MONTH);
  const lastMonth = inRange(data, LAST_MONTH);
  expect(thisMonth.length > 5 && lastMonth.length > 5, `the sample ledger has spending in both months (${thisMonth.length}, ${lastMonth.length})`);
  console.log('\nHome and Reports');

  await step('Home shows this month\'s total and number of transactions as stored', async () => {
    await f.tab('Home');
    await settle(500);
    const hero = page.locator(`${TOP} .hero`);
    expectEqual((await hero.locator('.hero-period').innerText()).trim(), 'This month', 'Home opens on this month');
    expectEqual(await bigTotal(), aed(sum(thisMonth)), 'the big total');
    const meta = await hero.locator('.hero-meta').innerText();
    expectEqual(Number((/^(\d+) transaction/.exec(meta) || [])[1]), thisMonth.length, `the count in "${meta}"`);
    await shot(page, `rep-01-home-${scheme}`);
  });

  await step('Reports shows the same month, and Last month adds up too', async () => {
    await f.tab('Reports');
    await settle(500);
    expectEqual(await bigTotal(), aed(sum(thisMonth)), 'this month on Reports');
    await page.getByRole('button', { name: /^Period:/ }).click();
    await settle(300);
    await page.getByRole('button', { name: /^Last month/ }).click();
    await settle(500);
    expectEqual(await bigTotal(), aed(sum(lastMonth)), 'last month on Reports');
    await shot(page, `rep-02-last-month-${scheme}`);
    await page.getByRole('button', { name: /^Period:/ }).click();
    await settle(300);
    await page.getByRole('button', { name: /^This month/ }).click();
    await settle(500);
    expectEqual(await bigTotal(), aed(sum(thisMonth)), 'and back to this month');
  });

  await step('Export says PDF is not available yet and offers only the CSV', async () => {
    await openExportSheet();
    const sheet = page.locator('.action-sheet');
    const text = plain(await sheet.innerText());
    expect(/PDF reports are not available yet/.test(text), `the sheet says so (${text})`);
    const choices = (await sheet.locator('.action-group').first().locator('button').allInnerTexts()).map(plain);
    expectEqual(choices, ['CSV of these expenses'], 'the only choice is the CSV');
    await sheet.locator('.cancel').click();
    await settle(300);
    expectEqual(await page.locator('.action-sheet').count(), 0, 'Cancel closes the sheet');
  });

  await step('The CSV holds exactly this month\'s expenses', async () => {
    await openExportSheet();
    const [download] = await Promise.all([page.waitForEvent('download'), f.sheetButton('CSV of these expenses').click()]);
    const file = path.join(DOWNLOADS, download.suggestedFilename());
    await download.saveAs(file);
    expect(/^expenses-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), `the file name (${download.suggestedFilename()})`);
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    const header = rows[0];
    expectEqual(header.slice(0, 4), ['Date', 'Time', 'Amount', 'Currency'], 'the header');
    const records = rows.slice(1).filter((r) => r.length > 1);
    const column = (name) => header.indexOf(name);
    expectEqual(records.map((r) => r[column('ID')]).sort(), thisMonth.map((e) => e.id).sort(), 'the same expenses, by their own ids');
    const minor = records.reduce((total, r) => total + Math.round(Number(r[column('Amount')]) * 100), 0);
    expectEqual(minor, sum(thisMonth), 'the amounts add up to the month\'s total');
    expect(records.every((r) => r[column('Currency')] === 'AED'), 'one currency');
    await settle(400);
    expect(/saved as expenses-/.test(await page.locator('.toast-stack').innerText()), 'and the app says where it went');
  });

  for (const text of await leakedText(page)) leaks.push(text);
} finally {
  const failed = summary();
  console.log('problems:', JSON.stringify(problems));
  console.log('leaked text:', JSON.stringify(leaks));
  await close();
  if (failed || problems.length || leaks.length) process.exitCode = 1;
}
