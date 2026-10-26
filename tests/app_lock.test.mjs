// The app-lock state machine: passcode success, cancel, failure, waiting periods, timeouts, clock changes, and the rule
// that the lock fails closed. Mirrors the iPhone app's AppLockTests, plus what the web version adds (remembered
// wrong-passcode count and waiting periods).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { authenticator, TestClock } from './lock_support.mjs';
import { AppLock, lockNoticeMessage } from '../docs/js/core/app_lock.js';
import {
  LOCKOUT_STARTS_AT, LOCK_TIMEOUTS, LOCK_TIMEOUT_TITLES, MemoryLockSettingsStore, SecureStoreError, lockSettingsFromStored,
  lockoutSeconds, makeLockSettings, waitText,
} from '../docs/js/core/lock_settings.js';
import { makeBackup } from '../docs/js/core/backup.js';
import { base64ToBytes, utf8Decode } from '../docs/js/core/encoding.js';

function setup() {
  const clock = new TestClock();
  const store = new MemoryLockSettingsStore();
  const make = (enabled = false, timeout = 0) => {
    if (enabled) store.stored = makeLockSettings(true, timeout);
    return AppLock.open(store, clock.read);
  };
  return { clock, store, make };
}

/** Wrong passcodes until the controller is waiting. */
async function failTimes(controller, count) {
  for (let i = 0; i < count; i += 1) {
    await controller.unlock(authenticator('failed'), 'Unlock');
    // Skip any waiting period so the next attempt is allowed.
    controller.lockedUntil = 0;
  }
}

// Starting up ------------------------------------------------------------------------------------

test('the lock is off until the owner turns it on', async () => {
  const { make } = setup();
  const controller = await make();
  assert.equal(controller.state, 'unlocked');
  assert.equal(controller.isLocked, false);
  assert.equal(controller.settings.isEnabled, false);
  assert.equal(controller.shouldPromptAutomatically, false);
  assert.equal(controller.settingsUnreadable, false);
});

test('a cold start with the lock on begins locked', async () => {
  const { make } = setup();
  const controller = await make(true, 300);
  assert.equal(controller.state, 'locked');
  assert.equal(controller.isLocked, true);
  assert.equal(controller.shouldPromptAutomatically, true);
  assert.equal(controller.settings.timeout, 300);
});

test('unreadable settings fail closed', async () => {
  const { store, make } = setup();
  store.stored = makeLockSettings(false);
  store.failLoad = true;
  const controller = await make();
  assert.equal(controller.state, 'locked', 'If the settings cannot be read, the app must not open unprotected');
  assert.equal(controller.settings.isEnabled, true);
  assert.equal(controller.settingsUnreadable, true);

  await controller.unlock(authenticator('success'), 'Unlock');
  assert.equal(controller.state, 'unlocked', 'The owner can still get in with the passcode');

  store.failLoad = false;
  assert.equal((await make()).state, 'unlocked', 'Once readable again, the saved setting (off) applies');
});

test('an unreadable setting is repaired when the owner saves one again', async () => {
  const { store, make } = setup();
  store.failLoad = true;
  const controller = await make();
  await controller.unlock(authenticator('success'), 'Unlock');
  store.failLoad = false;
  assert.equal(await controller.setTimeout(300), 'applied');
  assert.equal(controller.settingsUnreadable, false);
  assert.deepEqual(store.stored, makeLockSettings(true, 300));
  assert.equal(controller.state, 'unlocked');
});

test('an unreadable wrong-passcode count starts at the first waiting period', async () => {
  const { store, clock, make } = setup();
  store.stored = makeLockSettings(true, 0);
  store.attempts = null;
  const readable = await make();
  assert.equal(readable.failedAttempts, 0);

  store.failLoadAttempts = true;
  const controller = await make();
  assert.equal(controller.failedAttempts, LOCKOUT_STARTS_AT);
  assert.equal(controller.lockoutRemainingSeconds(), 30);
  clock.advance(31);
  assert.equal(controller.lockoutRemainingSeconds(), 0);
});

// Unlocking --------------------------------------------------------------------------------------

test('a successful unlock', async () => {
  const { make } = setup();
  const controller = await make(true);
  const auth = authenticator('success');
  let stateWhileAsking = null;
  auth.whilePromptIsShowing = async () => { stateWhileAsking = controller.state; };

  await controller.unlock(auth, 'Unlock your expenses');
  assert.equal(stateWhileAsking, 'authenticating');
  assert.equal(controller.state, 'unlocked');
  assert.equal(controller.notice, 'none');
  assert.equal(controller.failedAttempts, 0);
  assert.equal(auth.promptCount, 1);
  assert.deepEqual(auth.reasons, ['Unlock your expenses']);
});

test('cancelled, failed and locked-out attempts stay locked with the right message', async () => {
  const { make } = setup();
  const controller = await make(true);

  await controller.unlock(authenticator('cancelled'), 'Unlock');
  assert.equal(controller.state, 'locked');
  assert.equal(controller.notice, 'cancelled');
  assert.equal(controller.failedAttempts, 0, 'Cancelling is not a failure');
  assert.equal(controller.shouldPromptAutomatically, false, 'A cancelled prompt must not reappear by itself');

  await controller.unlock(authenticator('failed'), 'Unlock');
  assert.equal(controller.notice, 'failed');
  assert.equal(controller.failedAttempts, 1);

  await controller.unlock(authenticator('lockedOut'), 'Unlock');
  assert.equal(controller.notice, 'lockedOut');
  assert.equal(controller.failedAttempts, 2);
  assert.equal(controller.state, 'locked');
  for (const notice of ['cancelled', 'failed', 'lockedOut', 'unavailable']) {
    assert.ok(lockNoticeMessage(notice, 30), notice);
  }
  assert.equal(lockNoticeMessage('none'), null);

  await controller.unlock(authenticator('success'), 'Unlock');
  assert.equal(controller.state, 'unlocked');
  assert.equal(controller.failedAttempts, 0, 'A successful unlock clears the failure count');
});

test('a browser that cannot do the secure operations cannot unlock and says why', async () => {
  const { make } = setup();
  const controller = await make(true);
  const auth = authenticator('success');
  auth.available = false;
  await controller.unlock(auth, 'Unlock');
  assert.equal(controller.state, 'locked');
  assert.equal(controller.notice, 'unavailable');
  assert.equal(auth.promptCount, 0, 'No check is attempted when it cannot be done');
});

test('unlocking when nothing is locked does nothing', async () => {
  const { make } = setup();
  const controller = await make();
  const auth = authenticator('success');
  await controller.unlock(auth, 'Unlock');
  assert.equal(auth.promptCount, 0);
  assert.equal(controller.state, 'unlocked');

  const locked = await make(true);
  await locked.unlock(authenticator('success'), 'Unlock');
  const again = authenticator('success');
  await locked.unlock(again, 'Unlock');
  assert.equal(again.promptCount, 0, 'Already unlocked, so no second check');
});

test('a second tap while the check is running is ignored', async () => {
  const { make } = setup();
  const controller = await make(true);
  const second = authenticator('success');
  const first = authenticator('success');
  first.whilePromptIsShowing = async () => { await controller.unlock(second, 'Second tap'); };
  await controller.unlock(first, 'First tap');
  assert.equal(second.promptCount, 0);
  assert.equal(first.promptCount, 1);
  assert.equal(controller.state, 'unlocked');
});

test('a late result cannot unlock an app that locked again', async () => {
  const { make } = setup();
  const controller = await make(true, 0);
  const auth = authenticator('success');
  auth.whilePromptIsShowing = async () => { controller.sceneDidEnterBackground(); };
  await controller.unlock(auth, 'Unlock');
  assert.equal(controller.state, 'locked', 'The app went out of sight while the check was running');
});

test('an old attempt cannot disturb a newer one', async () => {
  const { make } = setup();
  const controller = await make(true, 0);
  const second = authenticator('cancelled');
  const first = authenticator('success');
  first.whilePromptIsShowing = async () => {
    controller.sceneDidEnterBackground();
    controller.sceneWillEnterForeground();
    await controller.unlock(second, 'Again');
  };
  await controller.unlock(first, 'First');
  assert.equal(controller.state, 'locked');
  assert.equal(controller.notice, 'cancelled', 'Only the newest attempt decides');
});

test('a check that blows up leaves the app locked and usable, never stuck on "authenticating"', async () => {
  const { store, make } = setup();
  const controller = await make(true);
  const broken = authenticator('success');
  broken.whilePromptIsShowing = async () => { throw new Error('the check crashed'); };
  await controller.unlock(broken, 'Unlock');
  assert.equal(controller.state, 'locked');
  assert.equal(controller.notice, 'unavailable');
  assert.equal(controller.failedAttempts, 0, 'A crash is not a wrong passcode');
  assert.equal(store.attempts, null);

  const throwsAtOnce = authenticator('success');
  throwsAtOnce.authenticate = () => { throw new Error('synchronous crash'); };
  await controller.unlock(throwsAtOnce, 'Unlock');
  assert.equal(controller.state, 'locked');

  await controller.unlock(authenticator('success'), 'Unlock');
  assert.equal(controller.state, 'unlocked', 'The next attempt works normally');
});

// Leaving and returning --------------------------------------------------------------------------

test('timeout boundaries', async () => {
  for (const timeout of [60, 300, 900]) {
    const { clock, make } = setup();
    const controller = await make(true, timeout);
    await controller.unlock(authenticator('success'), 'Unlock');

    controller.sceneDidEnterBackground();
    clock.advance(timeout - 1);
    controller.sceneWillEnterForeground();
    assert.equal(controller.state, 'unlocked', `${timeout}: one second early stays unlocked`);

    controller.sceneDidEnterBackground();
    clock.advance(timeout);
    controller.sceneWillEnterForeground();
    assert.equal(controller.state, 'locked', `${timeout}: exactly the timeout locks`);
    assert.equal(controller.shouldPromptAutomatically, true);
  }
});

test('an immediate timeout locks as soon as the app leaves the screen', async () => {
  const { make } = setup();
  const controller = await make(true, 0);
  await controller.unlock(authenticator('success'), 'Unlock');
  controller.sceneDidEnterBackground();
  assert.equal(controller.state, 'locked', 'Locked before the app-switcher snapshot is taken');
});

test('a clock moved backwards locks the app', async () => {
  const { clock, make } = setup();
  const controller = await make(true, 900);
  await controller.unlock(authenticator('success'), 'Unlock');
  controller.sceneDidEnterBackground();
  clock.advance(-100);
  controller.sceneWillEnterForeground();
  assert.equal(controller.state, 'locked');
});

test('nothing locks when the lock is off', async () => {
  const { clock, make } = setup();
  const controller = await make();
  controller.sceneDidEnterBackground();
  clock.advance(10_000);
  controller.sceneWillEnterForeground();
  assert.equal(controller.state, 'unlocked');
});

test('returning without having left does nothing', async () => {
  const { make } = setup();
  const controller = await make(true, 300);
  await controller.unlock(authenticator('success'), 'Unlock');
  controller.sceneWillEnterForeground();
  assert.equal(controller.state, 'unlocked');
});

test('a locked app starts fresh after being left with a message showing', async () => {
  const { make } = setup();
  const controller = await make(true, 300);
  await controller.unlock(authenticator('failed'), 'Unlock');
  assert.equal(controller.notice, 'failed');
  controller.sceneDidEnterBackground();
  controller.sceneWillEnterForeground();
  assert.equal(controller.state, 'locked');
  assert.equal(controller.notice, 'none');
  assert.equal(controller.shouldPromptAutomatically, true, 'Coming back asks for the passcode again');
});

test('the lock now button locks an unlocked app and does nothing when the lock is off', async () => {
  const { make } = setup();
  const off = await make();
  off.lockNow();
  assert.equal(off.state, 'unlocked');

  const on = await make(true, 900);
  await on.unlock(authenticator('success'), 'Unlock');
  on.lockNow();
  assert.equal(on.state, 'locked');
  assert.equal(on.notice, 'none');
});

// Wrong passcodes: the waiting periods (web only) --------------------------------------------------------------

test('the waiting periods grow and are capped', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(lockoutSeconds), [0, 0, 0, 0, 0]);
  assert.deepEqual([5, 6, 7, 8, 9, 10, 50].map(lockoutSeconds), [30, 60, 300, 900, 3600, 3600, 3600]);
  assert.equal(lockoutSeconds(Number.NaN), 0);
  assert.equal(lockoutSeconds(undefined), 0);
  assert.equal(waitText(1), '1 second');
  assert.equal(waitText(30), '30 seconds');
  assert.equal(waitText(29.2), '30 seconds');
  assert.equal(waitText(60), '1 minute');
  assert.equal(waitText(61), '2 minutes');
  assert.equal(waitText(900), '15 minutes');
  assert.equal(waitText(3600), '1 hour');
});

test('four wrong passcodes cost nothing, the fifth starts a wait', async () => {
  const { clock, make } = setup();
  const controller = await make(true);
  for (let i = 1; i <= 4; i += 1) {
    await controller.unlock(authenticator('failed'), 'Unlock');
    assert.equal(controller.notice, 'failed', `attempt ${i}`);
    assert.equal(controller.lockoutRemainingSeconds(), 0);
  }
  await controller.unlock(authenticator('failed'), 'Unlock');
  assert.equal(controller.failedAttempts, 5);
  assert.equal(controller.notice, 'lockedOut');
  assert.equal(controller.lockoutRemainingSeconds(), 30);
  assert.equal(controller.state, 'locked');
  assert.match(lockNoticeMessage(controller.notice, controller.lockoutRemainingSeconds()), /Try again in 30 seconds/);

  // While waiting, even the RIGHT passcode is not looked at.
  const right = authenticator('success');
  await controller.unlock(right, 'Unlock');
  assert.equal(right.promptCount, 0);
  assert.equal(controller.state, 'locked');
  assert.equal(controller.notice, 'lockedOut');

  clock.advance(29);
  assert.equal(controller.lockoutRemainingSeconds(), 1);
  clock.advance(1);
  assert.equal(controller.lockoutRemainingSeconds(), 0);
  await controller.unlock(right, 'Unlock');
  assert.equal(right.promptCount, 1);
  assert.equal(controller.state, 'unlocked');
  assert.equal(controller.failedAttempts, 0, 'The right passcode clears the count');
  assert.equal(controller.lockedUntil, 0);
});

test('each further wrong passcode waits longer', async () => {
  const { clock, make } = setup();
  const controller = await make(true);
  const expected = [30, 60, 300, 900, 3600, 3600];
  await failTimes(controller, 4);
  for (const seconds of expected) {
    await controller.unlock(authenticator('failed'), 'Unlock');
    assert.equal(controller.lockoutRemainingSeconds(), seconds);
    clock.advance(seconds);
  }
});

test('closing the app and opening it again does not clear the wrong-passcode count', async () => {
  const { clock, store, make } = setup();
  const first = await make(true);
  await failTimes(first, 4);
  await first.unlock(authenticator('failed'), 'Unlock');
  assert.equal(first.lockoutRemainingSeconds(), 30);
  assert.deepEqual(store.attempts, { failedAttempts: 5, lockedUntil: first.lockedUntil });

  // A fresh start of the app, as if the page were reloaded.
  const second = await AppLock.open(store, clock.read);
  assert.equal(second.state, 'locked');
  assert.equal(second.failedAttempts, 5);
  assert.equal(second.lockoutRemainingSeconds(), 30);
  const right = authenticator('success');
  await second.unlock(right, 'Unlock');
  assert.equal(right.promptCount, 0, 'Reloading does not skip the wait');
});

test('going to the background and coming back does not clear the count either', async () => {
  const { clock, make } = setup();
  const controller = await make(true, 300);
  await controller.unlock(authenticator('success'), 'Unlock');
  controller.lockNow();
  await failTimes(controller, 3);
  assert.equal(controller.failedAttempts, 3);
  controller.sceneDidEnterBackground();
  clock.advance(10_000);
  controller.sceneWillEnterForeground();
  assert.equal(controller.failedAttempts, 3);
});

test('moving the clock back cannot make the wait longer than it was meant to be, or shorter', async () => {
  const { clock, make } = setup();
  const controller = await make(true);
  await failTimes(controller, 4);
  await controller.unlock(authenticator('failed'), 'Unlock');
  assert.equal(controller.lockoutRemainingSeconds(), 30);
  clock.advance(-86_400); // someone sets the clock back a day
  assert.equal(controller.lockoutRemainingSeconds(), 30, 'Still at most the 30 seconds it was meant to be');
  clock.advance(86_400 + 31);
  assert.equal(controller.lockoutRemainingSeconds(), 0);
});

test('a failed save of the count does not break the lock', async () => {
  const { store, make } = setup();
  const controller = await make(true);
  store.failSave = true;
  await failTimes(controller, 4);
  await controller.unlock(authenticator('failed'), 'Unlock');
  assert.equal(controller.failedAttempts, 5, 'It is still counted in memory');
  assert.equal(controller.lockoutRemainingSeconds(), 30);
});

test('the wrong-passcode count is passed to listeners as it changes', async () => {
  const { make } = setup();
  const controller = await make(true);
  const seen = [];
  const stop = controller.subscribe((c) => seen.push(`${c.state}/${c.notice}`));
  await controller.unlock(authenticator('failed'), 'Unlock');
  stop();
  await controller.unlock(authenticator('failed'), 'Unlock');
  assert.deepEqual(seen, ['authenticating/none', 'locked/failed']);
});

// Sensitive actions ------------------------------------------------------------------------------

test('sensitive actions ask again only when the lock is on', async () => {
  const { make } = setup();
  const off = await make();
  const noPrompt = authenticator('failed');
  assert.equal(await off.confirmIdentity(noPrompt, 'Erase'), true);
  assert.equal(noPrompt.promptCount, 0);

  const on = await make(true);
  await on.unlock(authenticator('success'), 'Unlock');
  const confirmed = await on.confirmIdentity(authenticator('success'), 'Erase');
  const cancelled = await on.confirmIdentity(authenticator('cancelled'), 'Erase');
  const failed = await on.confirmIdentity(authenticator('failed'), 'Erase');
  const noCheck = authenticator('success');
  noCheck.available = false;
  const unavailable = await on.confirmIdentity(noCheck, 'Erase');
  assert.equal(confirmed, true);
  assert.equal(cancelled, false);
  assert.equal(failed, false);
  assert.equal(unavailable, false);
  assert.equal(noCheck.promptCount, 0);
});

test('a confirmation whose check blows up is "not confirmed" and does not count as a wrong passcode', async () => {
  const { make } = setup();
  const controller = await make(true);
  await controller.unlock(authenticator('success'), 'Unlock');
  const broken = authenticator('success');
  broken.whilePromptIsShowing = async () => { throw new Error('the check crashed'); };
  assert.equal(await controller.confirmIdentity(broken, 'Erase'), false);
  assert.equal(controller.failedAttempts, 0);
  assert.equal(controller.state, 'unlocked');
  assert.equal(await controller.confirmIdentity(authenticator('success'), 'Erase'), true);
});

test('wrong answers to a confirmation count, and the fifth locks the app', async () => {
  const { clock, make } = setup();
  const controller = await make(true, 900);
  await controller.unlock(authenticator('success'), 'Unlock');

  for (let i = 1; i <= 4; i += 1) {
    assert.equal(await controller.confirmIdentity(authenticator('failed'), 'Erase'), false);
    assert.equal(controller.state, 'unlocked', `attempt ${i}`);
  }
  assert.equal(await controller.confirmIdentity(authenticator('failed'), 'Erase'), false);
  assert.equal(controller.state, 'locked', 'Someone is guessing in front of an unlocked app');
  assert.equal(controller.notice, 'lockedOut');
  assert.equal(controller.lockoutRemainingSeconds(), 30);

  // Even the right passcode is refused during the wait.
  clock.advance(1);
  const right = authenticator('success');
  assert.equal(await controller.confirmIdentity(right, 'Erase'), false);
  assert.equal(right.promptCount, 0);
});

test('a right answer to a confirmation clears earlier mistakes', async () => {
  const { store, make } = setup();
  const controller = await make(true);
  await controller.unlock(authenticator('success'), 'Unlock');
  await controller.confirmIdentity(authenticator('failed'), 'Erase');
  await controller.confirmIdentity(authenticator('failed'), 'Erase');
  assert.equal(controller.failedAttempts, 2);
  assert.equal(await controller.confirmIdentity(authenticator('success'), 'Erase'), true);
  assert.equal(controller.failedAttempts, 0);
  assert.deepEqual(store.attempts, { failedAttempts: 0, lockedUntil: 0 });
});

// Changing the lock ------------------------------------------------------------------------------

test('turning the protection on opens the app and remembers the timeout', async () => {
  const { store, make } = setup();
  const controller = await make();
  assert.equal(await controller.didEnableProtection(300), 'applied');
  assert.deepEqual(controller.settings, makeLockSettings(true, 300));
  assert.deepEqual(store.stored, controller.settings);
  assert.equal(controller.state, 'unlocked', 'The owner just proved who they are, so no second check');
  assert.equal((await make()).state, 'locked', 'The next start is locked');
});

test('turning the protection on still works when the timeout cannot be saved', async () => {
  const { store, make } = setup();
  const controller = await make();
  store.failSave = true;
  assert.equal(await controller.didEnableProtection(60), 'couldNotSave');
  assert.equal(controller.settings.isEnabled, true, 'The data is already protected, so the screen must say so');
});

test('turning the protection off', async () => {
  const { store, make } = setup();
  const controller = await make(true, 60);
  await controller.unlock(authenticator('success'), 'Unlock');
  assert.equal(await controller.didDisableProtection(), 'applied');
  assert.equal(controller.settings.isEnabled, false);
  assert.equal(store.stored.isEnabled, false);
  assert.equal((await make()).state, 'unlocked');
});

test('changing the timeout', async () => {
  const { store, make } = setup();
  const controller = await make(true, 60);
  assert.equal(await controller.setTimeout(900), 'applied');
  assert.equal(controller.settings.timeout, 900);
  assert.equal(store.stored.timeout, 900);
  store.failSave = true;
  assert.equal(await controller.setTimeout(0), 'couldNotSave');
  assert.equal(controller.settings.timeout, 900, 'A failed save changes nothing');
});

// Stored settings --------------------------------------------------------------------------------

test('stored settings are tolerant of old or odd data', () => {
  assert.deepEqual(lockSettingsFromStored({}), makeLockSettings());
  assert.deepEqual(lockSettingsFromStored({ isEnabled: true, timeout: 300 }), makeLockSettings(true, 300));
  assert.equal(lockSettingsFromStored({ isEnabled: true, timeout: 7 }).timeout, 0, 'An unknown timeout becomes the strictest one');
  assert.equal(lockSettingsFromStored({ isEnabled: 'yes', timeout: 60 }).isEnabled, false, 'Only a real true counts');
  const original = makeLockSettings(true, 900);
  assert.deepEqual(lockSettingsFromStored(JSON.parse(JSON.stringify(original))), original);
  for (const bad of [null, 'text', 42, [], undefined]) {
    assert.throws(() => lockSettingsFromStored(bad), (error) => error instanceof SecureStoreError && error.code === 'unreadable');
  }
  assert.deepEqual([...LOCK_TIMEOUTS], [0, 60, 300, 900]);
  assert.equal(LOCK_TIMEOUT_TITLES[0], 'Immediately');
  assert.equal(makeLockSettings(true, 12345).timeout, 0);
});

test('lock settings never travel inside a backup', async () => {
  const sample = new SampleLedger();
  const text = await makeBackup(sample.snapshot, Fx.now, '1.0');
  const envelope = JSON.parse(text);
  const payload = utf8Decode(base64ToBytes(envelope.payload));
  assert.ok(!payload.includes('"timeout"'));
  assert.ok(!payload.toLowerCase().includes('locksettings'));
  assert.ok(!payload.toLowerCase().includes('applock'));
  assert.ok(!payload.includes('failedAttempts'));
  assert.ok(!payload.includes('lockedUntil'));
});
