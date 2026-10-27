// The offline copy in a real browser (Chromium): it installs on the first visit, the app opens and keeps working with no connection,
// nothing is asked of any other website, About reports it truthfully, and a new version downloads quietly, waits, and takes over
// only when the app is opened from scratch. The app is served under /expenses-web/ like GitHub Pages serves it.
// Safari is a different engine: none of this proves how an iPhone behaves.
// Run: SHOTS_DIR=... node tests/e2e/flows_offline.mjs
import fs from 'node:fs';
import path from 'node:path';
import { HERE, SHOTS, launch, shot, startFresh, inApp } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';
import { fingerprint, rebuild } from '../../tools/build_sw.mjs';

// The test changes the app's files to make "a new version", so it works on a copy, never on docs/ itself.
const COPY = path.join(SHOTS, '_offline-copy');
fs.rmSync(COPY, { recursive: true, force: true });
fs.cpSync(path.join(HERE, '..', '..', 'docs'), COPY, { recursive: true });

const { page, context, url, problems, close } = await launch({ serviceWorkers: 'allow', docsRoot: COPY });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
const { step, summary, settle } = makeRunner(page, 'offline');
const f = finders(page);
const state = (fn, arg) => inApp(page, fn, arg);
const sites = new Set(); // every site the browser or the worker asked for anything
context.on('request', (request) => { if (/^https?:/.test(request.url())) sites.add(new URL(request.url()).origin); });
let failures = 0;

const APP = `${url}/expenses-web/`;
const open = async (address = APP) => {
  await page.goto(address);
  await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
};
const waitFor = async (check, what, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await page.waitForTimeout(150);
  }
};
const worker = () => page.evaluate(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  return {
    controlled: Boolean(navigator.serviceWorker.controller),
    waiting: Boolean(registration && registration.waiting),
    installing: Boolean(registration && registration.installing),
    caches: (await caches.keys()).sort(),
  };
});
const keptPaths = (name) => page.evaluate(async (cacheName) => (await (await caches.open(cacheName)).keys())
  .map((request) => new URL(request.url).pathname.replace(/^\/expenses-web\//, '')), name);
const count = () => state((app) => app.snapshot.expenses.length);
const addExpense = (minor, merchant) => state(async (app, input) => {
  const { makeDraft } = await import('./js/core/models.js');
  const { money } = await import('./js/core/money.js');
  const category = app.snapshot.categories.find((c) => c.name === 'Groceries');
  await app.services.expenses.save(makeDraft({
    amount: money(input.minor, app.currency), day: app.today(), timeZoneID: app.timeZone(), categoryID: category.id, merchant: input.merchant,
  }), app.today());
}, { minor, merchant });
const rows = () => page.locator(TOP).first().evaluate((root) => {
  const out = {};
  for (const row of root.querySelectorAll('.row')) {
    const title = row.querySelector('.row-title');
    const value = row.querySelector('.row-value');
    if (title) out[title.textContent.trim()] = value ? value.textContent.trim() : '';
  }
  return out;
});
const aboutVersion = async () => (await page.locator(`${TOP} .about-head .t-sub`).innerText()).trim();
const openAbout = async () => {
  await f.tab('Settings');
  await settle(300);
  await f.row('About').click();
  await settle(500);
};
const editVersionFile = (from, to) => {
  const file = path.join(COPY, 'js/ui/version.js');
  const text = fs.readFileSync(file, 'utf8');
  assert(text.includes(`'${from}'`), `version.js should hold ${from}`);
  fs.writeFileSync(file, text.replace(`'${from}'`, `'${to}'`));
};
function assert(condition, message) { if (!condition) throw new Error(message); }

try {
  console.log('\nOffline copy');

  await step('The first visit saves an offline copy of every file the app is made of', async () => {
    await open();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await waitFor(async () => (await worker()).controlled, 'the worker to take control of the first page');
    const { version, files } = await fingerprint(COPY);
    const now = await worker();
    expectEqual(now.caches, [`expenses-${version}`], 'one cache, named after the version');
    const kept = await keptPaths(now.caches[0]);
    expectEqual(kept.filter((p) => p !== '').sort(), files, 'every file is kept');
    expect(kept.includes(''), 'and the address of the page itself');
  });

  await step('With no connection the app opens and keeps what was entered', async () => {
    await startFresh(page, { passcode: null });
    await addExpense(1250, 'Offline coffee');
    // Chromium sometimes drops a reload that arrives while the page is still settling its own history entry. That is the
    // browser's timing, not the app's, so the test lets the page finish before it goes offline and reloads.
    await settle(800);
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
    expectEqual(await count(), 1, 'the expense is there after reopening with no connection');
    await addExpense(800, 'Offline lunch');
    await open(`${APP}?from=home-screen`);
    expectEqual(await count(), 2, 'an address with extra words after the ? still opens the app, and both expenses are kept');
    await f.tab('Transactions');
    await settle(400);
    const list = await page.locator(TOP).first().innerText();
    expect(/Offline coffee/.test(list) && /Offline lunch/.test(list), 'both show in the list');
    await shot(page, 'off-01-offline');
  });

  await step('Nothing is asked of any other website', async () => {
    expectEqual([...sites], [new URL(url).origin], 'the only site contacted is the one serving the app');
  });

  await step('About says the offline copy is ready, and its summary holds no amounts or names', async () => {
    await openAbout();
    const facts = await rows();
    expectEqual(facts['Works offline'], 'Ready', 'works offline');
    expectEqual(facts['Opened from'], 'Safari tab', 'opened from (Chromium here is not a Home Screen app)');
    await page.locator(TOP).getByRole('button', { name: 'Copy summary' }).click();
    await f.waitToast('Summary copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(/^Expenses 1\.0\.0\n/.test(copied) && /Expenses: 2\n/.test(copied), `the copied summary has the counts (${copied.split('\n').slice(0, 2)})`);
    expect(!/AED|\b12\.50\b|\b8\.00\b|coffee|lunch|Groceries/.test(copied), 'and no amount, merchant or category');
    const keep = page.locator(`${TOP} .row`, { hasText: 'Ask the browser to keep it' });
    if (await keep.count()) {
      await keep.click();
      await settle(700);
      if (await page.locator('.dialog').count()) {
        expect(/Not guaranteed/.test(await page.locator('.dialog').innerText()), 'a refusal is said plainly');
        await f.dialogButton('OK').click();
      } else {
        await f.waitToast('protected from automatic clearing');
      }
    }
    await shot(page, 'off-02-about');
  });

  await step('A new version downloads in the background and waits; the open app is not changed', async () => {
    await context.setOffline(false);
    await openAbout();
    editVersionFile('1.0.0', '1.0.1-test');
    await rebuild(COPY);
    await f.row('Check for a new version').click();
    await f.waitDialog('A new version is ready');
    expect(/It has been downloaded\./.test(await page.locator('.dialog').innerText()), 'it says it has been downloaded');
    await f.dialogButton('OK').click();
    await settle(400);
    const now = await worker();
    expect(now.waiting, 'the new version is waiting');
    expectEqual(now.caches.length, 2, 'two copies side by side: the one in use and the new one');
    expectEqual(await aboutVersion(), 'Version 1.0.0', 'the app that is open is still the old version');
    expect('A new version is ready' in await rows(), 'About says one is ready');
    await shot(page, 'off-03-update-waiting');
  });

  await step('Opening the app again from scratch uses the new version, removes the old copy and keeps the data', async () => {
    await page.goto('about:blank');
    await settle(1000);
    await open();
    await waitFor(async () => (await worker()).caches.length === 1, 'the old copy to be removed');
    const { version } = await fingerprint(COPY);
    expectEqual((await worker()).caches, [`expenses-${version}`], 'only the new copy is left');
    expectEqual(await count(), 2, 'both expenses survived the update');
    await openAbout();
    expectEqual(await aboutVersion(), 'Version 1.0.1-test', 'the app now is the new version');
    expect(!('A new version is ready' in await rows()), 'and nothing is waiting any more');
  });

  await step('A version that cannot be downloaded in full is dropped and the working copy carries on', async () => {
    const before = await worker();
    editVersionFile('1.0.1-test', '1.0.2-broken');
    await rebuild(COPY);
    fs.rmSync(path.join(COPY, 'css', 'screens.css')); // the new worker lists this file, so its download fails
    await page.evaluate(async () => { try { await (await navigator.serviceWorker.getRegistration()).update(); } catch { /* the failed install is expected */ } });
    await waitFor(async () => !(await worker()).installing, 'the failed install to finish');
    const after = await worker();
    expect(!after.waiting, 'nothing is waiting: a partial version is never kept');
    expectEqual(after.caches, before.caches, 'and no half-filled copy is left behind');
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
    expectEqual(await count(), 2, 'the app still opens offline, with its data');
    await context.setOffline(false);
  });

  await step('Still nothing was asked of any other website', async () => {
    expectEqual([...sites], [new URL(url).origin], 'the only site contacted is the one serving the app');
  });
} finally {
  console.log('\nproblems:', problems);
  failures = summary();
  await close();
  fs.rmSync(COPY, { recursive: true, force: true });
}
process.exit(failures > 0 || problems.length > 0 ? 1 : 0);
