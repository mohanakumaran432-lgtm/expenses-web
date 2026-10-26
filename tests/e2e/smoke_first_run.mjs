// First look: the welcome screens, then the (placeholder) tabs. Prints problems the browser reported.
import { launch, openApp, shot, startFresh } from './harness.mjs';

const { page, url, problems, close } = await launch();
try {
  await openApp(page, url);
  console.log('welcome:', await page.title());
  await shot(page, '01-welcome');
  await page.getByRole('button', { name: 'Set up' }).click();
  await shot(page, '02-setup');
  await page.getByRole('switch', { name: /Protect with a passcode/ }).uncheck({ force: true });
  await shot(page, '03-setup-no-passcode');
  await page.getByRole('button', { name: 'Start tracking' }).click();
  await page.waitForSelector('.tabbar');
  await shot(page, '04-home-placeholder');
  console.log('phase:', await page.evaluate(() => window.__expensesApp.phase));
} finally {
  console.log('problems:', problems);
  await close();
}
