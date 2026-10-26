// The lock settings kept next to the data, the passcode check, and the whole unlock flow with the app lock and the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger, rejectsWithCode } from './support.mjs';
import { TestClock } from './lock_support.mjs';
import { LedgerStore } from '../docs/js/data/ledger_store.js';
import { MemoryBackend } from '../docs/js/data/backend_memory.js';
import { BackendLockSettingsStore } from '../docs/js/data/lock_store.js';
import { PasscodeAuthenticator } from '../docs/js/data/passcode_authenticator.js';
import { bindLockToStore, confirmWithPasscode, unlockWithPasscode } from '../docs/js/data/unlock_flow.js';
import { META_KEYS } from '../docs/js/data/stores.js';
import { AppLock } from '../docs/js/core/app_lock.js';
import { SecureStoreError, makeLockSettings } from '../docs/js/core/lock_settings.js';

const FAST = { iterations: 100_000 };
const PASSCODE = '482915';
const NEXT = 'Another passcode 77';

async function protectedBackend() {
  const backend = new MemoryBackend();
  const store = await LedgerStore.open(backend);
  await store.initializeNew(new SampleLedger().snapshot, { passcode: PASSCODE, ...FAST });
  return backend;
}

async function plainBackend() {
  const backend = new MemoryBackend();
  const store = await LedgerStore.open(backend);
  await store.initializeNew(new SampleLedger().snapshot);
  return backend;
}

/** The app as it starts: store, lock settings, app lock, and the link between them. */
async function startApp(backend, clock = new TestClock()) {
  const store = await LedgerStore.open(backend);
  const lockStore = new BackendLockSettingsStore(backend);
  const appLock = await AppLock.open(lockStore, clock.read);
  const authenticator = new PasscodeAuthenticator(store);
  const unbind = bindLockToStore(appLock, store);
  const unlock = (passcode) => unlockWithPasscode({ appLock, store, authenticator, passcode });
  const confirm = (passcode) => confirmWithPasscode({ appLock, authenticator, passcode });
  return { backend, store, lockStore, appLock, authenticator, clock, unbind, unlock, confirm };
}

// Lock settings kept next to the data ------------------------------------------------------------

test('nothing saved means no lock settings and no wrong-passcode count', async () => {
  const lockStore = new BackendLockSettingsStore(new MemoryBackend());
  assert.equal(await lockStore.load(), null);
  assert.equal(await lockStore.loadAttempts(), null);
});

test('with a passcode the lock is on, because a keyring exists', async () => {
  const backend = await protectedBackend();
  const lockStore = new BackendLockSettingsStore(backend);
  assert.deepEqual(await lockStore.load(), makeLockSettings(true, 0));
  await lockStore.save(makeLockSettings(true, 300));
  assert.deepEqual(await lockStore.load(), makeLockSettings(true, 300));
  assert.deepEqual(backend.rawMeta(META_KEYS.lock), { timeout: 300 }, 'Only the timeout is stored');
});

test('without a passcode the lock is off, and the timeout is still remembered', async () => {
  const backend = await plainBackend();
  const lockStore = new BackendLockSettingsStore(backend);
  assert.equal(await lockStore.load(), null);
  await lockStore.save(makeLockSettings(false, 900));
  assert.deepEqual(await lockStore.load(), makeLockSettings(false, 900));
});

test('editing or deleting the stored settings cannot switch the lock off', async () => {
  const backend = await protectedBackend();
  const lockStore = new BackendLockSettingsStore(backend);
  backend.rawPutMeta(META_KEYS.lock, { isEnabled: false, timeout: 900 });
  assert.deepEqual(await lockStore.load(), makeLockSettings(true, 900));
  backend.rawPutMeta(META_KEYS.lock, { timeout: 12345 });
  assert.deepEqual(await lockStore.load(), makeLockSettings(true, 0), 'An unknown timeout becomes the strictest one');
  for (const junk of ['junk', 42, [], null]) {
    backend.rawPutMeta(META_KEYS.lock, junk);
    assert.equal((await lockStore.load()).isEnabled, true, `${JSON.stringify(junk)} still counts as locked`);
  }
  await backend.deleteMeta(META_KEYS.lock);
  assert.deepEqual(await lockStore.load(), makeLockSettings(true, 0));
});

test('a damaged timeout never locks the owner out of data that has no passcode', async () => {
  const backend = await plainBackend();
  const lockStore = new BackendLockSettingsStore(backend);
  backend.rawPutMeta(META_KEYS.lock, 'junk');
  assert.deepEqual(await lockStore.load(), makeLockSettings(false, 0));
  const appLock = await AppLock.open(lockStore);
  assert.equal(appLock.state, 'unlocked');
});

test('storage that cannot be read makes the lock fail closed', async () => {
  const backend = await protectedBackend();
  const lockStore = new BackendLockSettingsStore(backend);
  backend.failLoad = true;
  await assert.rejects(lockStore.load(), (error) => error instanceof SecureStoreError && error.code === 'unreadable');
  await assert.rejects(lockStore.loadAttempts(), (error) => error instanceof SecureStoreError && error.code === 'unreadable');
  const appLock = await AppLock.open(lockStore);
  assert.equal(appLock.state, 'locked');
  assert.equal(appLock.settingsUnreadable, true);
});

test('a setting that cannot be saved is reported', async () => {
  const backend = await protectedBackend();
  const lockStore = new BackendLockSettingsStore(backend);
  backend.failMeta = true;
  await assert.rejects(lockStore.save(makeLockSettings(true, 60)), (error) => error instanceof SecureStoreError && error.code === 'unwritable');
  await assert.rejects(lockStore.saveAttempts({ failedAttempts: 1, lockedUntil: 0 }), (error) => error.code === 'unwritable');
});

test('the wrong-passcode count is kept, and odd stored values are not trusted', async () => {
  const backend = await protectedBackend();
  const lockStore = new BackendLockSettingsStore(backend);
  await lockStore.saveAttempts({ failedAttempts: 6, lockedUntil: 1234 });
  assert.deepEqual(await lockStore.loadAttempts(), { failedAttempts: 6, lockedUntil: 1234 });
  backend.rawPutMeta(META_KEYS.attempts, { failedAttempts: 2 });
  assert.deepEqual(await lockStore.loadAttempts(), { failedAttempts: 2, lockedUntil: 0 });
  for (const junk of ['x', 5, { failedAttempts: -1 }, { failedAttempts: 1.5 }, { failedAttempts: '3' }, { failedAttempts: 1, lockedUntil: 'soon' }, {}]) {
    backend.rawPutMeta(META_KEYS.attempts, junk);
    await assert.rejects(lockStore.loadAttempts(), (error) => error.code === 'unreadable', JSON.stringify(junk));
  }
});

test('lock settings and the count are not touched by saving records, and survive them', async () => {
  const backend = await protectedBackend();
  const lockStore = new BackendLockSettingsStore(backend);
  await lockStore.save(makeLockSettings(true, 60));
  await lockStore.saveAttempts({ failedAttempts: 3, lockedUntil: 0 });
  const store = await LedgerStore.open(backend);
  await store.unlock(PASSCODE);
  await store.replaceAll(Fx.catalog());
  assert.deepEqual(await lockStore.load(), makeLockSettings(true, 60), 'A restore cannot change the lock');
  assert.deepEqual(await lockStore.loadAttempts(), { failedAttempts: 3, lockedUntil: 0 });
});

// The passcode check -----------------------------------------------------------------------------

test('the passcode check answers success, failed, cancelled or unavailable', async () => {
  const backend = await protectedBackend();
  const store = await LedgerStore.open(backend);
  const authenticator = new PasscodeAuthenticator(store);
  assert.equal(authenticator.canAuthenticate(), true);

  assert.equal(await authenticator.authenticate(), 'cancelled', 'nothing supplied');
  authenticator.supply('');
  assert.equal(await authenticator.authenticate(), 'cancelled');
  authenticator.supply(12345);
  assert.equal(await authenticator.authenticate(), 'cancelled');

  authenticator.supply('000000');
  assert.equal(await authenticator.authenticate(), 'failed');
  assert.equal(authenticator.takeKey(), null);
  assert.equal(authenticator.lastProblem, null);

  authenticator.supply(PASSCODE);
  assert.equal(await authenticator.authenticate(), 'success');
  const key = authenticator.takeKey();
  assert.equal(key.dek.extractable, false);
  assert.equal(authenticator.takeKey(), null, 'The key can be taken once');

  backend.rawPutMeta(META_KEYS.keyring, { junk: true });
  authenticator.supply(PASSCODE);
  assert.equal(await authenticator.authenticate(), 'unavailable');
  assert.equal(authenticator.lastProblem, 'damaged');
});

test('what was typed is forgotten as soon as it has been checked', async () => {
  const store = await LedgerStore.open(await protectedBackend());
  const authenticator = new PasscodeAuthenticator(store);
  authenticator.supply('000000');
  await authenticator.authenticate();
  assert.equal(authenticator.pending, null);
  authenticator.supply(PASSCODE);
  await authenticator.authenticate();
  authenticator.discard();
  assert.equal(authenticator.takeKey(), null, 'A key that was not used is dropped');
  assert.equal(authenticator.pending, null);
});

test('storage problems while checking are reported as the check being unavailable', async () => {
  const backend = await protectedBackend();
  const store = await LedgerStore.open(backend);
  const authenticator = new PasscodeAuthenticator(store);
  backend.failLoad = true;
  authenticator.supply(PASSCODE);
  assert.equal(await authenticator.authenticate(), 'unavailable');
  assert.equal(authenticator.lastProblem, 'unavailable');
});

// The whole flow ---------------------------------------------------------------------------------

test('a cold start with a passcode is locked, and the right passcode opens the data', async () => {
  const app = await startApp(await protectedBackend());
  assert.equal(app.appLock.state, 'locked');
  assert.equal(app.store.state, 'locked');
  assert.equal(app.store.snapshot.expenses.length, 0);

  const result = await app.unlock(PASSCODE);
  assert.deepEqual(result, { unlocked: true, notice: 'none', problem: null });
  assert.equal(app.appLock.state, 'unlocked');
  assert.equal(app.store.state, 'ready');
  assert.equal(app.store.snapshot.expenses.length, 8);
});

test('a wrong passcode opens nothing, and is counted', async () => {
  const app = await startApp(await protectedBackend());
  const result = await app.unlock('000000');
  assert.equal(result.unlocked, false);
  assert.equal(result.notice, 'failed');
  assert.equal(app.appLock.state, 'locked');
  assert.equal(app.store.state, 'locked');
  assert.equal(app.appLock.failedAttempts, 1);
  assert.deepEqual(await app.lockStore.loadAttempts(), { failedAttempts: 1, lockedUntil: 0 });
});

test('closing and reopening the app does not clear the wrong passcodes; the fifth makes the person wait', async () => {
  const clock = new TestClock();
  const backend = await protectedBackend();
  let app = await startApp(backend, clock);
  for (let i = 0; i < 3; i += 1) await app.unlock('000000');
  app.unbind();

  app = await startApp(backend, clock); // "closing and reopening the app"
  assert.equal(app.appLock.failedAttempts, 3);
  await app.unlock('000000');
  await app.unlock('000000');
  assert.equal(app.appLock.failedAttempts, 5);
  assert.ok(app.appLock.lockoutRemainingSeconds() > 0);

  const waiting = await app.unlock(PASSCODE);
  assert.equal(waiting.unlocked, false, 'Even the right passcode is refused during the wait');
  assert.equal(waiting.notice, 'lockedOut');
  assert.equal(app.store.state, 'locked');

  app.unbind();
  app = await startApp(backend, clock); // the wait survives closing the app too
  assert.ok(app.appLock.lockoutRemainingSeconds() > 0);
  clock.advance(31);
  assert.equal(app.appLock.lockoutRemainingSeconds(), 0);
  const ok = await app.unlock(PASSCODE);
  assert.equal(ok.unlocked, true);
  assert.equal(app.store.snapshot.expenses.length, 8);
  assert.deepEqual(await app.lockStore.loadAttempts(), { failedAttempts: 0, lockedUntil: 0 }, 'A right passcode clears the count');
});

test('leaving the app locks it and drops the decrypted data', async () => {
  const app = await startApp(await protectedBackend());
  await app.unlock(PASSCODE);
  assert.equal(app.store.state, 'ready');
  app.appLock.sceneDidEnterBackground(); // the default timeout is "immediately"
  assert.equal(app.appLock.state, 'locked');
  assert.equal(app.store.state, 'locked');
  assert.equal(app.store.snapshot.expenses.length, 0);
  app.appLock.sceneWillEnterForeground();
  assert.equal((await app.unlock(PASSCODE)).unlocked, true);
  assert.equal(app.store.snapshot.expenses.length, 8);
});

test('a timeout longer than zero keeps the app open for that long, then locks and drops the data', async () => {
  const clock = new TestClock();
  const backend = await protectedBackend();
  await new BackendLockSettingsStore(backend).save(makeLockSettings(true, 60));
  const app = await startApp(backend, clock);
  await app.unlock(PASSCODE);

  app.appLock.sceneDidEnterBackground();
  clock.advance(30);
  app.appLock.sceneWillEnterForeground();
  assert.equal(app.store.state, 'ready', 'Back within the minute: still open');

  app.appLock.sceneDidEnterBackground();
  clock.advance(61);
  app.appLock.sceneWillEnterForeground();
  assert.equal(app.appLock.state, 'locked');
  assert.equal(app.store.state, 'locked');
});

test('"Lock now" drops the data', async () => {
  const app = await startApp(await protectedBackend());
  await app.unlock(PASSCODE);
  app.appLock.lockNow();
  assert.equal(app.store.state, 'locked');
});

test('a check that finishes after the app locked again opens nothing', async () => {
  const app = await startApp(await protectedBackend());
  const original = app.authenticator.authenticate.bind(app.authenticator);
  app.authenticator.authenticate = async (reason) => {
    const outcome = await original(reason);
    app.appLock.sceneDidEnterBackground(); // the app went out of sight while the passcode was being checked
    return outcome;
  };
  const result = await app.unlock(PASSCODE);
  assert.equal(result.unlocked, false);
  assert.equal(app.appLock.state, 'locked');
  assert.equal(app.store.state, 'locked', 'The data was never opened');
  assert.equal(app.store.snapshot.expenses.length, 0);
  assert.equal(app.authenticator.takeKey(), null, 'The key was thrown away');
});

test('if the data cannot be opened after a right passcode, the app locks again and says why', async () => {
  const backend = await protectedBackend();
  const app = await startApp(backend);
  const original = app.store.unlockWithKey.bind(app.store);
  app.store.unlockWithKey = async (key) => {
    backend.failLoad = true;
    try {
      return await original(key);
    } finally {
      backend.failLoad = false;
    }
  };
  const result = await app.unlock(PASSCODE);
  assert.equal(result.unlocked, false);
  assert.equal(result.problem, 'unavailable');
  assert.equal(app.appLock.state, 'locked');
  assert.equal(app.store.state, 'locked');
  app.store.unlockWithKey = original;
  assert.equal((await app.unlock(PASSCODE)).unlocked, true, 'Trying again works');
});

test('a passcode changed in another window between the check and the opening locks the app again', async () => {
  const backend = await protectedBackend();
  const app = await startApp(backend);
  const other = await LedgerStore.open(backend);
  await other.unlock(PASSCODE);
  const original = app.authenticator.authenticate.bind(app.authenticator);
  app.authenticator.authenticate = async (reason) => {
    const outcome = await original(reason);
    await other.changePasscode(PASSCODE, NEXT, FAST);
    return outcome;
  };
  const result = await app.unlock(PASSCODE);
  assert.equal(result.unlocked, false);
  assert.equal(result.problem, 'conflict');
  assert.equal(app.store.state, 'locked');
  app.authenticator.authenticate = original;
  assert.equal((await app.unlock(PASSCODE)).unlocked, false, 'The old passcode no longer works');
  assert.equal((await app.unlock(NEXT)).unlocked, true);
});

test('when no passcode is set there is nothing to unlock', async () => {
  const app = await startApp(await plainBackend());
  assert.equal(app.appLock.state, 'unlocked');
  assert.equal(app.store.state, 'ready');
  assert.deepEqual(await app.unlock('anything'), { unlocked: true, notice: 'none', problem: null });
  app.appLock.sceneDidEnterBackground();
  assert.equal(app.store.state, 'ready', 'Nothing locks without a passcode');
});

// Setting, removing and changing the passcode, start to finish ------------------------------------

test('setting a passcode: the data is protected, the app opens, and the next start is locked', async () => {
  const backend = await plainBackend();
  const app = await startApp(backend);
  await app.store.enableProtection(PASSCODE, FAST);
  assert.equal(await app.appLock.didEnableProtection(300), 'applied');
  assert.equal(app.appLock.state, 'unlocked');
  assert.equal(app.store.state, 'ready');

  app.unbind();
  const next = await startApp(backend);
  assert.equal(next.appLock.state, 'locked');
  assert.equal(next.appLock.settings.timeout, 300);
  assert.equal(next.store.state, 'locked');
  assert.equal((await next.unlock(PASSCODE)).unlocked, true);
});

test('removing the passcode asks for it again, counts wrong answers, then stores plain data', async () => {
  const backend = await protectedBackend();
  const app = await startApp(backend);
  await app.unlock(PASSCODE);

  assert.equal(await app.confirm('000000'), false);
  assert.equal(app.appLock.failedAttempts, 1);
  assert.equal(await app.confirm(PASSCODE), true);
  assert.equal(app.appLock.failedAttempts, 0);
  await app.store.disableProtection(PASSCODE);
  assert.equal(await app.appLock.didDisableProtection(), 'applied');

  app.unbind();
  const next = await startApp(backend);
  assert.equal(next.appLock.state, 'unlocked');
  assert.equal(next.store.state, 'ready');
  assert.equal(next.store.snapshot.expenses.length, 8);
  assert.deepEqual(await next.lockStore.loadAttempts(), { failedAttempts: 0, lockedUntil: 0 });
});

test('changing the passcode: confirm with the old one, then only the new one works', async () => {
  const backend = await protectedBackend();
  const app = await startApp(backend);
  await app.unlock(PASSCODE);
  assert.equal(await app.confirm(PASSCODE), true);
  await app.store.changePasscode(PASSCODE, NEXT, FAST);

  app.appLock.lockNow();
  assert.equal((await app.unlock(PASSCODE)).unlocked, false);
  assert.equal((await app.unlock(NEXT)).unlocked, true);
  assert.equal(app.store.snapshot.expenses.length, 8);
});

test('guessing the passcode in front of an open app is limited and locks the app', async () => {
  const app = await startApp(await protectedBackend());
  await app.unlock(PASSCODE);
  for (let i = 0; i < 4; i += 1) assert.equal(await app.confirm('000000'), false);
  assert.equal(app.appLock.state, 'unlocked');
  assert.equal(await app.confirm('000000'), false);
  assert.equal(app.appLock.state, 'locked', 'The fifth wrong answer locks the app');
  assert.equal(app.store.state, 'locked', 'and drops the data');
  assert.equal(await app.confirm(PASSCODE), false, 'Even the right passcode is refused during the wait');
});

test('forgot the passcode: erasing everything starts over with an unlocked, empty app', async () => {
  const backend = await protectedBackend();
  const app = await startApp(backend);
  for (let i = 0; i < 6; i += 1) await app.unlock('000000');
  assert.equal(app.appLock.state, 'locked');
  await app.store.eraseEverything();

  app.unbind();
  const fresh = await startApp(backend);
  assert.equal(fresh.appLock.state, 'unlocked');
  assert.equal(fresh.appLock.failedAttempts, 0, 'The count went with the data');
  assert.equal(fresh.store.state, 'empty');
  assert.equal(backend.dump().includes('Spinneys'), false);
});
