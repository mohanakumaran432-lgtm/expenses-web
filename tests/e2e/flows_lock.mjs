// The app lock, end to end in a real browser: turning a passcode on (and what that does to what is stored), the lock screen,
// wrong and right passcodes, changing it, turning it off, the cover shown when leaving the app, the waiting time after five wrong
// tries, and "Forgot passcode?". Run: SHOTS_DIR=... node tests/e2e/flows_lock.mjs [light|dark]
import { launch, openApp, shot, startFresh, seed, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const { step, summary, settle } = makeRunner(page, `lock-${scheme}`);
const f = finders(page);
const leaks = [];
const snap = async (name) => { await shot(page, `${name}-${scheme}`); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const state = (fn, arg) => inApp(page, fn, arg);
let failures = 0;

const PASSCODE = '482915';
const NEW_PASSCODE = '739204';
// Words that are in the sample data and must not be readable in storage once a passcode is on.
const PROBES = ['Spinneys', 'Carrefour', 'Starbucks', 'Emirates Holidays', 'Careem', 'Landlord', 'Groceries'];

/** Looks at every record the app keeps in the browser's database and says which probe words can be read in it. */
async function readableInStorage() {
  return page.evaluate(async (probes) => {
    const dbs = await indexedDB.databases();
    let text = '';
    let rows = 0;
    for (const { name } of dbs) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      for (const store of Array.from(db.objectStoreNames)) {
        const all = await new Promise((resolve, reject) => { const r = db.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        rows += all.length;
        text += JSON.stringify(all, (key, value) => {
          if (value instanceof ArrayBuffer) return `<${value.byteLength} bytes>`;
          if (ArrayBuffer.isView(value)) return `<${value.byteLength} bytes>`;
          return value;
        });
      }
      db.close();
    }
    const found = {};
    for (const probe of probes) found[probe] = text.includes(probe);
    return { rows, characters: text.length, found, passcodeVisible: text.includes('482915') || text.includes('739204') };
  }, PROBES);
}

const lockInput = () => page.getByLabel('Passcode');
async function typeOnLockScreen(code) {
  await lockInput().fill(code);
  await page.keyboard.press('Enter');
}
async function waitPhase(phase, ms = 20000) {
  await page.waitForFunction((wanted) => window.__expensesApp && window.__expensesApp.phase === wanted, phase, { timeout: ms });
}

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  const total = await state((app) => app.snapshot.expenses.length);
  const totalMinor = () => state((app) => app.snapshot.expenses.reduce((sum, e) => sum + e.amount.minorUnits, 0));
  const spentBefore = await totalMinor();
  await f.tab('Settings');
  await settle(300);

  console.log(`\nApp lock (${scheme})`);

  await step('Without a passcode the stored records can be read by anyone who copies them', async () => {
    const before = await readableInStorage();
    expect(before.rows > 100, `records exist (${before.rows})`);
    expect(before.found.Spinneys || before.found.Carrefour || before.found.Starbucks, `merchant names are readable in plain storage (${JSON.stringify(before.found)})`);
  });

  await step('The App lock page says that no passcode is set', async () => {
    await f.row('App lock').click();
    await settle(400);
    await snap('100-lock-off');
    const text = await page.locator(TOP).innerText();
    expect(/No passcode is set/.test(text), 'the warning is shown');
    expect(await f.button('Turn on a passcode').count() === 1, 'the button to turn it on is shown');
  });

  await step('The new passcode must be long enough and typed twice the same', async () => {
    await f.button('Turn on a passcode').click();
    await settle(400);
    const turnOn = f.sheetAction('Turn on');
    expect(await turnOn.isDisabled(), 'Turn on waits');
    await page.getByLabel('Passcode', { exact: true }).fill('123');
    await settle(150);
    let advice = await page.locator('.layer').last().locator('[role=status]').first().innerText();
    expect(/at least|short|6/i.test(advice), `short passcodes are refused (got: ${advice})`);
    await page.getByLabel('Passcode', { exact: true }).fill('123456');
    await settle(150);
    advice = await page.locator('.layer').last().locator('[role=status]').first().innerText();
    expect(/predictable/i.test(advice), `a well-known passcode is refused (got: ${advice})`);
    expect(await turnOn.isDisabled(), 'Turn on waits for something less predictable');
    await page.getByLabel('Passcode', { exact: true }).fill('111111');
    await page.getByLabel('Type it again').fill('111111');
    await settle(150);
    expect(await turnOn.isDisabled(), 'a run of one digit is refused even when typed twice');
    await page.getByLabel('Passcode', { exact: true }).fill(PASSCODE);
    await page.getByLabel('Type it again').fill('482916');
    await settle(150);
    advice = await page.locator('.layer').last().locator('[role=status]').first().innerText();
    expect(/not the same/i.test(advice), `a mismatch is explained (got: ${advice})`);
    expect(await turnOn.isDisabled(), 'Turn on still waits');
    await snap('101-lock-mismatch');
    await page.getByLabel('Passcode', { exact: true }).fill(PASSCODE);
    await page.getByLabel('Type it again').fill(PASSCODE);
    await settle(150);
    await snap('102-lock-ready');
    expect(!(await turnOn.isDisabled()), 'Turn on is ready');
  });

  await step('Turning it on encrypts what was stored, and the passcode is not stored', async () => {
    await f.sheetRow('Lock after').click();
    await settle(250);
    await f.actionItem('After 1 minute').click();
    await settle(250);
    await f.sheetAction('Turn on').click();
    await f.waitToast('Passcode is on');
    await f.noLayers();
    expectEqual(await state((app) => ({ on: app.lockEnabled, timeout: app.appLock.settings.timeout })), { on: true, timeout: 60 }, 'lock state');
    await settle(400);
    const text = await page.locator(TOP).innerText();
    expect(/Passcode is on/.test(text), 'the page says it is on');
    await snap('103-lock-on');
    const after = await readableInStorage();
    expect(after.rows > 100, `records are still there (${after.rows})`);
    const readable = Object.entries(after.found).filter(([, yes]) => yes).map(([word]) => word);
    expectEqual(readable, [], 'words readable in storage after turning the passcode on');
    expect(!after.passcodeVisible, 'the passcode is not in storage');
  });

  await step('The data is untouched by turning the passcode on', async () => {
    expectEqual(await state((app) => app.snapshot.expenses.length), total, 'expense count');
    expectEqual(await totalMinor(), spentBefore, 'total amount');
  });

  await step('Leaving the app puts a cover over the screen, and coming back removes it', async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle(150);
    expect(await page.locator('#cover').isVisible(), 'the cover is shown');
    await snap('104-cover');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle(250);
    expect(!(await page.locator('#cover').isVisible()), 'the cover is gone');
    expectEqual(await state((app) => app.phase), 'ready', 'still unlocked after a moment away (the wait is 1 minute)');
  });

  await step('Lock now shows a lock screen with nothing from the ledger on it', async () => {
    await f.row('Lock now').click();
    await waitPhase('locked');
    await settle(400);
    await snap('105-locked');
    const text = await page.locator('body').innerText();
    expect(/Enter your passcode/.test(text), 'asks for the passcode');
    expect(!/AED|Groceries|Spinneys|Settings|Home\b/.test(text), `no financial text or app navigation on the lock screen (got: ${text.replace(/\s+/g, ' ').slice(0, 200)})`);
    expect(await page.locator('.tabbar').count() === 0, 'no tab bar');
    const leftInPage = await page.evaluate(() => document.querySelectorAll('.row, .tabview, .page').length);
    expectEqual(leftInPage, 0, 'no screens of the app are left in the page');
  });

  await step('A wrong passcode is refused, with a message, and nothing opens', async () => {
    await typeOnLockScreen('000000');
    await page.waitForFunction(() => /not right|incorrect|wrong|try again/i.test(document.querySelector('.lock-message')?.textContent || ''), null, { timeout: 15000 });
    await snap('106-lock-wrong');
    expectEqual(await state((app) => app.phase), 'locked', 'still locked');
    expect(await page.locator('.lock-message.bad').count() === 1, 'the message is styled as a problem');
    expect((await lockInput().inputValue()) === '', 'the wrong passcode was cleared from the box');
  });

  await step('The right passcode opens the app and all the data is there', async () => {
    await typeOnLockScreen(PASSCODE);
    await waitPhase('ready');
    await settle(500);
    expectEqual(await state((app) => app.snapshot.expenses.length), total, 'expense count after unlocking');
    expectEqual(await totalMinor(), spentBefore, 'total amount after unlocking');
    await snap('107-unlocked');
  });

  await step('Changing the passcode asks for the current one first', async () => {
    await f.tab('Settings');
    await settle(300);
    await f.row('App lock').click();
    await settle(400);
    await f.row('Change passcode').click();
    await settle(400);
    await page.getByLabel('Current passcode').fill('999999');
    await page.getByLabel('New passcode').fill(NEW_PASSCODE);
    await page.getByLabel('Type the new one again').fill(NEW_PASSCODE);
    await settle(200);
    await snap('108-lock-change');
    await f.sheetAction('Change').click();
    await f.waitDialog('That passcode is not right');
    await f.dialogButton('OK').click();
    await settle(300);
    expect(await page.locator('.layer').count() === 1, 'the sheet stays open so it can be corrected');
    await page.getByLabel('Current passcode').fill(PASSCODE);
    await f.sheetAction('Change').click();
    await f.waitToast('Passcode changed');
    await f.noLayers();
    const stored = await readableInStorage();
    expectEqual(Object.values(stored.found).filter(Boolean).length, 0, 'still nothing readable in storage');
    expect(!stored.passcodeVisible, 'neither passcode is in storage');
  });

  await step('The old passcode no longer works; the new one does', async () => {
    await f.row('Lock now').click();
    await waitPhase('locked');
    await settle(300);
    await typeOnLockScreen(PASSCODE);
    await page.waitForFunction(() => /not right|incorrect|wrong|try again/i.test(document.querySelector('.lock-message')?.textContent || ''), null, { timeout: 15000 });
    expectEqual(await state((app) => app.phase), 'locked', 'the old passcode did not open it');
    await typeOnLockScreen(NEW_PASSCODE);
    await waitPhase('ready');
    await settle(400);
    expectEqual(await state((app) => app.snapshot.expenses.length), total, 'expense count');
    expectEqual(await totalMinor(), spentBefore, 'total amount');
  });

  await step('Turning the passcode off asks for it, then decrypts everything', async () => {
    await f.tab('Settings');
    await settle(300);
    await f.row('App lock').click();
    await settle(400);
    await f.row('Turn off passcode').click();
    await f.waitDialog('Turn off the passcode?');
    await f.dialogInput().fill('000000');
    await f.dialogButton('Turn off').click();
    await f.waitDialog('That passcode is not right');
    await f.dialogButton('OK').click();
    expectEqual(await state((app) => app.lockEnabled), true, 'a wrong passcode leaves the lock on');
    await f.row('Turn off passcode').click();
    await f.waitDialog('Turn off the passcode?');
    await f.dialogInput().fill(NEW_PASSCODE);
    await f.dialogButton('Turn off').click();
    await f.waitToast('Passcode turned off');
    await settle(400);
    expectEqual(await state((app) => app.lockEnabled), false, 'lock is off');
    const text = await page.locator(TOP).innerText();
    expect(/No passcode is set/.test(text), 'the page says so');
    const stored = await readableInStorage();
    expect(stored.found.Spinneys || stored.found.Carrefour || stored.found.Starbucks, 'records are plain again');
    expectEqual(await state((app) => app.snapshot.expenses.length), total, 'expense count');
    expectEqual(await totalMinor(), spentBefore, 'total amount');
  });

  await step('The data survives a full reload with no passcode', async () => {
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
    await page.waitForSelector('.tabbar', { timeout: 15000 });
    expectEqual(await state((app) => app.snapshot.expenses.length), total, 'expense count after reload');
  });

  await step('With a passcode, a reload starts on the lock screen', async () => {
    await f.tab('Settings');
    await settle(300);
    await f.row('App lock').click();
    await settle(400);
    await f.button('Turn on a passcode').click();
    await settle(400);
    await page.getByLabel('Passcode', { exact: true }).fill(PASSCODE);
    await page.getByLabel('Type it again').fill(PASSCODE);
    await f.sheetAction('Turn on').click();
    await f.waitToast('Passcode is on');
    await f.noLayers();
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
    await page.waitForSelector('.lock', { timeout: 15000 });
    const text = await page.locator('body').innerText();
    expect(!/AED|Groceries/.test(text), 'nothing from the ledger on the lock screen after a reload');
    await typeOnLockScreen(PASSCODE);
    await waitPhase('ready');
    expectEqual(await state((app) => app.snapshot.expenses.length), total, 'expense count after unlocking again');
  });

  await step('Five wrong passcodes in a row make the person wait; the right one is refused meanwhile', async () => {
    await inApp(page, (app) => app.lockNow());
    await waitPhase('locked');
    await settle(300);
    for (let n = 1; n <= 4; n += 1) {
      await typeOnLockScreen(`00000${n}`);
      await page.waitForFunction((count) => (window.__expensesApp.appLock.failedAttempts || 0) >= count, n, { timeout: 15000 });
      await settle(150);
    }
    expect(!(await lockInput().isDisabled()), 'four wrong tries cost no waiting');
    await typeOnLockScreen('000005');
    await page.waitForFunction(() => /second/i.test(document.querySelector('.lock-message')?.textContent || ''), null, { timeout: 15000 });
    await settle(300);
    await snap('109-lock-waiting');
    const message = await page.locator('.lock-message').innerText();
    expect(/30 seconds|wait/i.test(message), `the message names the wait (got: ${message})`);
    expect(await page.getByRole('button', { name: /Unlock|Checking/ }).isDisabled(), 'the Unlock button is disabled while waiting');
  });

  await step('The waiting time survives a reload', async () => {
    await page.reload();
    await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
    await page.waitForSelector('.lock', { timeout: 15000 });
    await settle(400);
    expect(await page.locator('.lock-input').isDisabled(), 'still waiting after a reload');
  });

  await step('"Forgot passcode?" erases everything after two confirmations and starts fresh', async () => {
    await page.getByRole('button', { name: 'Forgot passcode?' }).click();
    await f.waitDialog('Forgot your passcode?');
    await snap('110-forgot');
    await f.dialogButton('Continue').click();
    await f.waitDialog('Type ERASE to confirm');
    await f.dialogInput().fill('nope');
    await f.dialogButton('Erase everything').click();
    await f.waitDialog('Nothing was erased');
    await f.dialogButton('OK').click();
    expect(await page.locator('.lock').count() === 1, 'still on the lock screen after a wrong word');
    await page.getByRole('button', { name: 'Forgot passcode?' }).click();
    await f.dialogButton('Continue').click();
    await f.waitDialog('Type ERASE to confirm');
    await f.dialogInput().fill('erase');
    await f.dialogButton('Erase everything').click();
    await page.waitForSelector('button:has-text("Set up")', { timeout: 20000 });
    await snap('111-after-erase');
    const stored = await readableInStorage();
    expectEqual(Object.values(stored.found).filter(Boolean).length, 0, 'nothing readable in storage after erasing');
    expectEqual(await state((app) => app.phase), 'welcome', 'back to the welcome screen');
    expectEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0], 'nothing left in the small browser storage either');
  });
} finally {
  console.log('\nproblems:', problems);
  console.log('leaked text:', leaks);
  failures = summary();
  await close();
}
process.exit(failures > 0 || problems.length > 0 || leaks.length > 0 ? 1 : 0);
