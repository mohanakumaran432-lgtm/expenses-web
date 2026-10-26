// Looks at Home with sample spending, in light and dark, and at the Add Expense sheet. Prints problems the browser reported.
// Screenshots go to $SHOTS_DIR (they are for a person to look at; this script does not judge them).
import { launch, openApp, shot, startFresh, seed, inApp } from './harness.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  const saved = await seed(page, url, {});
  console.log('seeded');
  await page.waitForTimeout(400);
  await shot(page, `10-home-${scheme}-top`);

  // scroll through the Home screen
  const scroller = page.locator('.page-scroll').first();
  const height = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  console.log('home scroll', height);
  let index = 1;
  for (let y = height.clientHeight - 120; y < height.scrollHeight; y += height.clientHeight - 120) {
    await scroller.evaluate((el, top) => { el.scrollTop = top; }, y);
    await page.waitForTimeout(150);
    await shot(page, `11-home-${scheme}-scroll${index++}`);
  }
  await scroller.evaluate((el) => { el.scrollTop = 0; });

  // the Add Expense sheet
  await page.getByRole('button', { name: 'Add expense' }).first().click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(300);
  await shot(page, `12-add-${scheme}-empty`);
  for (const key of ['4', '5', '.', '5']) await page.getByRole('button', { name: key === '.' ? 'Decimal point' : key, exact: true }).first().click();
  await page.waitForTimeout(100);
  await shot(page, `13-add-${scheme}-amount`);
} finally {
  console.log('problems:', problems);
  await close();
}
