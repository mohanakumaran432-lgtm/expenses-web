// Looks at the Budgets tab: empty state, the editor (made with taps and the keypad), the list of cards and the detail page.
import { launch, openApp, shot, startFresh, seed, inApp, leakedText, scrollThrough } from './harness.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const tab = (name) => page.locator('.tabbar .tab', { hasText: name }).click();
const leaks = [];
const snap = async (name) => { await shot(page, name); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const keys = async (text) => { for (const ch of text) await page.getByRole('button', { name: ch === '.' ? 'Decimal point' : ch, exact: true }).click(); };
try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  await tab('Budgets');
  await page.waitForTimeout(300);
  await snap(`50-bud-${scheme}-empty`);

  // Make an overall monthly budget with taps and the keypad
  await page.getByRole('button', { name: 'Add a budget' }).first().click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(250);
  await snap(`51-bud-${scheme}-editor-empty`);
  await keys('9500');
  await page.waitForTimeout(150);
  await snap(`52-bud-${scheme}-editor-filled`);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(500);

  // The rest through the real service (faster), including the awkward cases
  await inApp(page, async (app) => {
    const { money } = await import('/js/core/money.js');
    const { newId } = await import('/js/core/util.js');
    const cat = (name) => app.snapshot.categories.find((c) => c.name === name).id;
    const today = app.today();
    const save = (draft) => app.services.budgets.save({ id: newId(), alertThresholds: [80, 100], notificationsEnabled: true, isActive: true, ...draft });
    await save({ name: '', categoryID: cat('Groceries'), periodKind: 'monthly', amount: money(250000, 'AED') });
    await save({ name: 'Eating out and coffee, a long name that has to wrap neatly on a narrow screen', categoryID: cat('Food & Dining'), periodKind: 'weekly', amount: money(40000, 'AED') });
    await save({ name: '', categoryID: cat('Entertainment'), periodKind: 'monthly', amount: money(20000, 'AED') });
    await save({ name: 'Autumn trip', categoryID: cat('Travel & Holidays'), periodKind: 'custom', customStart: today.addingDays(-20), customEnd: today.addingDays(40), amount: money(1500000, 'AED') });
    await save({ name: 'Old holiday plan', categoryID: null, periodKind: 'monthly', amount: money(80000, 'AED'), isActive: false });
  });
  await page.waitForTimeout(600);
  await snap(`53-bud-${scheme}-list-top`);
  const stops = await scrollThrough(page, snap, `54-bud-${scheme}-list`, { max: 4 });
  console.log('list stops', stops);

  // Detail page
  await page.evaluate(() => { const v = [...document.querySelectorAll('.page-scroll')].find((el) => el.offsetParent !== null); v.scrollTop = 0; });
  await page.locator('.budget-card').first().click();
  await page.waitForTimeout(500);
  await snap(`55-bud-${scheme}-detail`);
  await scrollThrough(page, snap, `56-bud-${scheme}-detail`, { max: 2 });

  // Edit sheet from the detail page
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(300);
  await snap(`57-bud-${scheme}-editor-edit`);
  await page.evaluate(() => { const s = document.querySelector('.sheet .sheet-scroll'); s.scrollTop = 600; });
  await page.waitForTimeout(200);
  await snap(`58-bud-${scheme}-editor-edit-scrolled`);
} finally {
  console.log('problems:', problems);
  console.log('leaked text:', leaks);
  await close();
}
