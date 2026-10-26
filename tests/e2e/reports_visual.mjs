// Looks at the Reports tab: overview of a month, another period, and the comparison. Screenshots are for a person to look at.
import { launch, openApp, shot, startFresh, seed, leakedText, scrollThrough } from './harness.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const leaks = [];
const snap = async (name) => { await shot(page, name); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  await page.locator('.tabbar .tab', { hasText: 'Reports' }).click();
  await page.waitForTimeout(500);
  await snap(`40-rep-${scheme}-top`);
  await scrollThrough(page, snap, `41-rep-${scheme}`);

  // pick another period
  await page.getByRole('button', { name: /^Period:/ }).click();
  await page.waitForTimeout(300);
  await snap(`42-rep-${scheme}-periods`);
  await page.getByRole('button', { name: /^Last 90 days/ }).click();
  await page.waitForTimeout(500);
  await snap(`43-rep-${scheme}-90days`);
  await scrollThrough(page, snap, `44-rep-${scheme}-90`, { max: 3 });

  // comparison
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.waitForTimeout(500);
  await snap(`45-rep-${scheme}-compare`);
  await scrollThrough(page, snap, `46-rep-${scheme}-cmp`);
} finally {
  console.log('problems:', problems);
  console.log('leaked text:', leaks);
  await close();
}
