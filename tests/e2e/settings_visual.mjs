// Looks at the Settings tab and everything behind it: the lists (categories, payment methods, tags), display choices,
// notifications, the privacy and limitation pages, About. Run: SHOTS_DIR=... node tests/e2e/settings_visual.mjs [light|dark]
import { launch, openApp, shot, startFresh, seed, leakedText, scrollThrough } from './harness.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const tab = (name) => page.locator('.tabbar .tab', { hasText: name }).click();
const leaks = [];
const snap = async (name) => { await shot(page, name); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const settle = (ms = 350) => page.waitForTimeout(ms);
const top = '.tabview:not([hidden]) > .page:last-child';
const row = (name) => page.locator(`${top} .row`, { hasText: name }).first();
const back = async () => { await page.locator(`${top} .navbar .nav-btn`).first().click(); await settle(300); };
try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  await tab('Settings');
  await settle();
  await snap(`60-set-${scheme}-root`);
  await scrollThrough(page, snap, `61-set-${scheme}-root`, { max: 3 });

  // Choosers
  await row('Week').click();
  await page.waitForSelector('.sheet, .action-sheet, [role=dialog]');
  await settle();
  await snap(`62-set-${scheme}-weekstart`);
  await page.keyboard.press('Escape');
  await settle();

  // Formats
  await row('Formats').click();
  await settle();
  await snap(`63-set-${scheme}-formats`);
  await back();

  // Categories
  await row('Categories').click();
  await settle();
  await snap(`64-set-${scheme}-categories`);
  await scrollThrough(page, snap, `65-set-${scheme}-categories`, { max: 2 });
  await row('Groceries').click();
  await settle(500);
  await snap(`66-set-${scheme}-category-page`);
  await back();

  // Payment methods
  await back();
  await row('Payment methods').click();
  await settle();
  await snap(`67-set-${scheme}-methods`);
  await back();

  // Tags
  await row('Tags').click();
  await settle();
  await snap(`68-set-${scheme}-tags`);
  await back();

  // Notifications
  await row('Notifications').click();
  await settle();
  await snap(`69-set-${scheme}-notifications`);
  await back();

  // Privacy and limitations and About
  await row('Privacy').click();
  await settle();
  await snap(`70-set-${scheme}-privacy`);
  await scrollThrough(page, snap, `71-set-${scheme}-privacy`, { max: 3 });
  await back();
  await row('Known limitations').click();
  await settle();
  await snap(`72-set-${scheme}-limits`);
  await back();
  await row('About this app').click();
  await settle(600);
  await snap(`73-set-${scheme}-about`);
  await scrollThrough(page, snap, `74-set-${scheme}-about`, { max: 3 });
  await back();
} finally {
  console.log('problems:', problems);
  console.log('leaked text:', leaks);
  await close();
}
