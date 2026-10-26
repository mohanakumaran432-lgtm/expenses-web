// The back gesture. The app adds one browser-history step while something is open on top of a screen, so swiping back closes
// the top sheet or page instead of leaving the app, and takes the step away again afterwards. These tests check that the two
// never get out of step (an extra step back would leave the app, which in a Safari tab means leaving the page).
// Run: node tests/e2e/history_back.mjs
import { launch, openApp, startFresh, inApp } from './harness.mjs';
import { expect, expectEqual, finders, makeRunner } from './steps.mjs';

const { page, url, problems, close } = await launch();
const { step, summary, settle } = makeRunner(page, 'history');
const f = finders(page);
const here = () => page.evaluate(() => ({ href: location.href, length: history.length, app: Boolean(window.__expensesApp) }));
const layers = () => inApp(page, (app) => ({ armed: app.ui.armed, unwinding: app.ui.unwinding, open: app.ui.layers.length, pages: app.shell.pageDepth }));
const phoneBack = async () => { await page.evaluate(() => history.back()); await settle(200); };
let failures = 0;
let start;

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await f.tab('Settings');
  await settle(300);
  start = await here();
  console.log('\nBack gesture');

  await step('Nothing open: nothing is armed', async () => {
    expectEqual(await layers(), { armed: false, unwinding: false, open: 0, pages: 0 }, 'idle state');
  });

  await step('A sheet closing and a dialog opening straight after it never steps too far back', async () => {
    await inApp(page, async (app) => {
      const { closed, handle } = app.ui.present(() => ({ el: document.createElement('div'), label: 'x' }));
      handle.close('chosen');
      await closed;
      app.ui.confirm({ title: 'Use this?', message: 'x', confirmLabel: 'Yes' });
    });
    await settle(500);
    expectEqual((await layers()).open, 1, 'the dialog is open');
    expectEqual((await layers()).armed, true, 'one step is held while it is open');
    await inApp(page, (app) => { app.ui.closeAll(); });
    await settle(500);
    const now = await here();
    expectEqual(now.href, start.href, 'still on the app');
    expectEqual(now.length, start.length, 'no history was added or lost');
    expectEqual(await layers(), { armed: false, unwinding: false, open: 0, pages: 0 }, 'back to idle');
  });

  await step('The phone\'s back gesture closes the top sheet and nothing else', async () => {
    await f.row('Currency').click();
    await settle(400);
    expectEqual((await layers()).open, 1, 'the currency sheet is open');
    await phoneBack();
    expectEqual((await layers()).open, 0, 'the sheet is closed');
    const now = await here();
    expect(now.app && now.href === start.href, 'still in the app, on the same address');
    await settle(300);
    expectEqual(await layers(), { armed: false, unwinding: false, open: 0, pages: 0 }, 'idle again');
  });

  await step('The back gesture closes a pushed page, then a sheet on it, one at a time', async () => {
    await f.row('Categories').click();
    await settle(400);
    expectEqual((await layers()).pages, 1, 'a page is pushed');
    await page.getByRole('button', { name: 'Add a category' }).click();
    await settle(400);
    expectEqual((await layers()).open, 1, 'the new-category sheet is open');
    await phoneBack();
    expectEqual((await layers()).open, 0, 'the sheet closed first');
    expectEqual((await layers()).pages, 1, 'the page is still there');
    await settle(200);
    await phoneBack();
    expectEqual((await layers()).pages, 0, 'then the page closed');
    expectEqual(await f.pageTitle(), 'Settings', 'back on Settings');
    const now = await here();
    expect(now.app && now.href === start.href, 'still in the app');
    await settle(300);
    expectEqual(await layers(), { armed: false, unwinding: false, open: 0, pages: 0 }, 'idle again');
  });

  await step('Opening things quickly, again and again, keeps the history in step', async () => {
    for (let round = 0; round < 25; round += 1) {
      await inApp(page, async (app, n) => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const sheet = app.ui.present(() => ({ el: document.createElement('div'), label: 'a' }));
        await wait((n * 7) % 40);
        sheet.handle.close('x');
        await wait((n * 13) % 120);
        const dialog = app.ui.confirm({ title: 'b', message: 'c' });
        await wait((n * 11) % 90);
        app.ui.closeAll();
        await dialog;
        if (n % 3 === 0) {
          app.shell.push((a) => ({ el: document.createElement('section') }));
          await wait((n * 5) % 100);
          app.shell.pop();
        }
      }, round);
    }
    await settle(800);
    const now = await here();
    expect(now.app && now.href === start.href, `still in the app (now at ${now.href})`);
    expect(now.length <= start.length + 1, `history did not grow without bound (was ${start.length}, now ${now.length})`);
    expectEqual(await layers(), { armed: false, unwinding: false, open: 0, pages: 0 }, 'idle after all that');
  });

  await step('After all that, the back gesture still works the same way', async () => {
    await f.row('Currency').click();
    await settle(400);
    await phoneBack();
    expectEqual((await layers()).open, 0, 'the sheet is closed by the gesture');
    expect((await here()).app, 'still in the app');
  });
} finally {
  console.log('\nproblems:', problems);
  failures = summary();
  await close();
}
process.exit(failures > 0 || problems.length > 0 ? 1 : 0);
