// Looks at the Transactions tab: the list, search, the filter sheet, sorting and selection mode. Screenshots are for a person to look at.
import { launch, openApp, shot, startFresh, seed, leakedText } from './harness.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const tab = (name) => page.locator('.tabbar .tab', { hasText: name }).click();
const leaks = [];
const snap = async (name) => { await shot(page, name); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  await tab('Transactions');
  await page.waitForTimeout(400);
  await snap(`20-tx-${scheme}-top`);

  const scroller = page.locator('.tab-view:not([hidden]) .page-scroll, .page-scroll:visible').first();
  await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.page-scroll')].find((el) => el.offsetParent !== null);
    visible.scrollTop = 700;
  });
  await page.waitForTimeout(200);
  await snap(`21-tx-${scheme}-scrolled`);
  await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.page-scroll')].find((el) => el.offsetParent !== null);
    visible.scrollTop = 0;
  });

  // search
  const box = page.getByRole('searchbox').or(page.locator('input[type=search]')).first();
  await box.fill('spinn');
  await page.waitForTimeout(500);
  await snap(`22-tx-${scheme}-search`);
  await box.fill('');
  await page.waitForTimeout(400);

  // filter sheet
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(300);
  await snap(`23-tx-${scheme}-filters`);
  await page.getByRole('button', { name: /^Categories/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^Groceries/ }).click();
  await page.getByRole('button', { name: /^Food & Dining/ }).click();
  await snap(`24-tx-${scheme}-categories`);
  await page.locator('.sheet').last().getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Dates' }).click();
  await page.waitForTimeout(300);
  await snap(`25-tx-${scheme}-dates`);
  await page.getByRole('button', { name: /^Last 30 days/ }).click();
  await page.waitForTimeout(300);
  await snap(`26-tx-${scheme}-filters-set`);
  await page.locator('.sheet').last().getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(400);
  await snap(`27-tx-${scheme}-filtered`);

  // sorting
  await page.getByRole('button', { name: /^Sort/ }).click();
  await page.waitForTimeout(300);
  await snap(`28-tx-${scheme}-sort-sheet`);
  await page.getByRole('menuitemradio', { name: 'Amount, highest first' }).click();
  await page.waitForTimeout(400);
  await snap(`29-tx-${scheme}-sorted-amount`);

  // selection
  await page.getByRole('button', { name: 'Select expenses' }).click();
  await page.waitForTimeout(300);
  const rows = page.locator('.tab-view:not([hidden]) .row.with-badge, .page:visible .row.with-badge');
  console.log('rows visible', await rows.count());
  await rows.nth(0).click();
  await rows.nth(1).click();
  await rows.nth(2).click();
  await page.waitForTimeout(200);
  await snap(`30-tx-${scheme}-selecting`);
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForTimeout(300);
  await snap(`31-tx-${scheme}-delete-confirm`);
  await page.getByRole('button', { name: 'Cancel' }).click();
} finally {
  console.log('problems:', problems);
  console.log('leaked text:', leaks);
  await close();
}
