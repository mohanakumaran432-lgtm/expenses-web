// The real store, run against the in-memory backend: saving, reloading, the passcode, tampering and two windows at once.
// (The in-memory backend follows the same rules as the browser's database; tests/backend_contract.mjs holds both to them.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger, rejectsWithCode } from './support.mjs';
import { LedgerStore } from '../docs/js/data/ledger_store.js';
import { MemoryBackend } from '../docs/js/data/backend_memory.js';
import { META_KEYS, ROW_STORES } from '../docs/js/data/stores.js';
import { LedgerChangeSet } from '../docs/js/core/snapshot.js';
import { ExpenseService } from '../docs/js/core/expense_service.js';
import { CategoryService } from '../docs/js/core/catalog_service.js';
import { payloadToWire } from '../docs/js/core/backup.js';
import { defaultSettings, makeDraft, normalizeSettings, settingsToWire, toWire } from '../docs/js/core/models.js';
import { openRecord } from '../docs/js/core/vault.js';

// The real setting is 600,000 rounds; the tests use the smallest value the app accepts, to stay quick.
const FAST = { iterations: 100_000 };
const PASSCODE = '482915';
const NEXT = 'Another passcode 77';

// Helpers ----------------------------------------------------------------------------------------

/** A snapshot reduced to JSON-ready lists in a fixed order, so two snapshots can be compared exactly. */
function canonical(snapshot) {
  const wire = payloadToWire(snapshot);
  for (const key of Object.keys(wire)) {
    if (Array.isArray(wire[key])) wire[key].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return wire;
}

async function emptyStore() {
  const backend = new MemoryBackend();
  return { backend, store: await LedgerStore.open(backend) };
}

async function plainStore(sample = new SampleLedger()) {
  const { backend, store } = await emptyStore();
  await store.initializeNew(sample.snapshot);
  return { backend, store, sample };
}

async function protectedStore(sample = new SampleLedger()) {
  const { backend, store } = await emptyStore();
  await store.initializeNew(sample.snapshot, { passcode: PASSCODE, ...FAST });
  return { backend, store, sample };
}

/** A second window of the app: a new store on the same storage, unlocked when `passcode` is given. */
async function otherWindow(backend, passcode = null) {
  const store = await LedgerStore.open(backend);
  if (passcode !== null) await store.unlock(passcode);
  return store;
}

const draft = (amount, category, { id, ...rest } = {}) => makeDraft({
  id, amount: Fx.money(amount), day: Fx.today, timeZoneID: Fx.dubai, categoryID: category.id, ...rest,
});

const expenseService = (store) => new ExpenseService(store, () => Fx.now);

/** Adds one expense through the real service. */
async function addExpense(store, amount = '10', id = undefined) {
  const category = store.snapshot.categories[0];
  return expenseService(store).save(draft(amount, category, { id }), Fx.today);
}

function copyOf(backend) {
  const copy = new MemoryBackend();
  copy.rows = new Map(Array.from(backend.rows, ([name, map]) => [name, new Map(Array.from(map, ([id, row]) => [id, structuredClone(row)]))]));
  copy.meta = new Map(Array.from(backend.meta, ([key, value]) => [key, structuredClone(value)]));
  return copy;
}

const SECRETS = ['Spinneys', 'Carrefour', 'Reel Cinemas', 'Groceries', 'Entertainment', 'currencyCode', 'minorUnits', 'merchant', 'family'];

// Plain data -------------------------------------------------------------------------------------

test('a new storage is empty, and nothing can be saved before the first ledger exists', async () => {
  const { store, backend } = await emptyStore();
  assert.equal(store.state, 'empty');
  assert.equal(store.isReady, false);
  assert.equal(store.isProtected, false);
  assert.equal(store.snapshot.expenses.length, 0);
  assert.equal(store.unreadableCount, 0);
  const changes = new LedgerChangeSet();
  changes.settings = normalizeSettings({ ...defaultSettings(), currencyCode: 'USD' });
  await rejectsWithCode(store.commit(changes), 'empty');
  await rejectsWithCode(store.saveFiredAlertKeys(['x']), 'empty');
  await rejectsWithCode(store.replaceAll(new SampleLedger().snapshot), 'empty');
  assert.equal(backend.commitCount, 0);
});

test('the first ledger is stored in one step and survives closing and reopening the app', async () => {
  const { backend, store, sample } = await plainStore();
  assert.equal(store.state, 'ready');
  assert.equal(backend.commitCount, 1, 'One all-or-nothing write');
  assert.equal(store.snapshot.expenses.length, 8);
  assert.deepEqual(canonical(store.snapshot), canonical(sample.snapshot));
  assert.deepEqual(backend.rawMeta(META_KEYS.format), { schema: 1 });
  assert.equal(backend.rawMeta(META_KEYS.keyring), null);

  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.state, 'ready', 'Without a passcode the data opens straight away');
  assert.deepEqual(canonical(reopened.snapshot), canonical(sample.snapshot));
  assert.equal(reopened.unreadableCount, 0);
});

test('the first ledger can only be made once', async () => {
  const { store, backend } = await plainStore();
  await rejectsWithCode(store.initializeNew(new SampleLedger().snapshot), 'alreadyInitialized');
  await rejectsWithCode(store.initializeNew(new SampleLedger().snapshot, { passcode: PASSCODE, ...FAST }), 'alreadyInitialized');
  assert.equal(backend.commitCount, 1);
});

test('plain rows are readable JSON in exactly the format a backup uses', async () => {
  const { backend, sample } = await plainStore();
  const row = backend.rawRow('expenses', sample.e[0].id);
  assert.deepEqual(Object.keys(row).sort(), ['id', 'plain']);
  assert.deepEqual(row.plain, toWire.expense(sample.e[0]));
  assert.deepEqual(backend.rawRow('settings', 'settings').plain, settingsToWire(sample.snapshot.settings));
  assert.equal(backend.rawRows('categories').length, sample.snapshot.categories.length);
  const text = backend.dump();
  for (const secret of SECRETS) assert.ok(text.includes(secret), `${secret} is readable when no passcode is set`);
});

test('saving through the real services reaches the storage and survives reopening', async () => {
  const { backend, store } = await plainStore();
  const before = backend.commitCount;
  const saved = await addExpense(store, '99.99');
  assert.equal(backend.commitCount, before + 1, 'One transaction per save');
  assert.equal(store.snapshot.expenses.length, 9);
  assert.ok(store.snapshot.expense(saved.id));

  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.snapshot.expenses.length, 9);
  assert.equal(reopened.snapshot.expense(saved.id).amount.minorUnits, 9999);
  assert.deepEqual(canonical(reopened.snapshot), canonical(store.snapshot));
});

test('editing and deleting reach the storage', async () => {
  const { backend, store, sample } = await plainStore();
  const service = expenseService(store);
  const target = sample.e[0];
  await service.save(draft('77', sample.groceries, { id: target.id }), Fx.today);
  assert.equal(store.snapshot.expense(target.id).amount.minorUnits, 7700);
  assert.equal(backend.rawRow('expenses', target.id).plain.amount.minorUnits, 7700);
  assert.equal(backend.rawRows('expenses').length, 8, 'Editing does not add a row');

  await service.delete(sample.e[1].id);
  await service.deleteMany([sample.e[2].id, sample.e[3].id]);
  assert.equal(backend.rawRows('expenses').length, 5);
  assert.equal(backend.rawRow('expenses', sample.e[1].id), null);

  const reopened = await LedgerStore.open(backend);
  assert.deepEqual(canonical(reopened.snapshot), canonical(store.snapshot));
});

test('a change that touches several kinds of record is stored as one write', async () => {
  const { backend, store, sample } = await plainStore();
  const categories = new CategoryService(store, () => Fx.now);
  const before = backend.commitCount;
  await categories.mergeCategory(sample.transport.id, sample.groceries.id);
  assert.equal(backend.commitCount, before + 1, 'Expenses and categories changed together');
  const reopened = await LedgerStore.open(backend);
  assert.deepEqual(canonical(reopened.snapshot), canonical(store.snapshot));
  assert.ok(reopened.snapshot.expenses.every((e) => e.categoryID !== sample.transport.id));
});

test('changing the settings is stored too', async () => {
  const { backend, store } = await plainStore();
  const changes = new LedgerChangeSet();
  changes.settings = normalizeSettings({ ...store.snapshot.settings, currencyCode: 'USD', firstWeekday: 1 });
  await store.commit(changes);
  assert.equal(store.snapshot.settings.currencyCode, 'USD');
  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.snapshot.settings.currencyCode, 'USD');
  assert.equal(reopened.snapshot.settings.firstWeekday, 1);
});

test('a save with nothing in it writes nothing', async () => {
  const { backend, store } = await plainStore();
  const before = backend.commitCount;
  await store.commit(new LedgerChangeSet());
  assert.equal(backend.commitCount, before);
});

// A save is all-or-nothing -----------------------------------------------------------------------

test('a failed save changes neither the storage nor what the screens see, and the next save works', async () => {
  for (const code of ['failed', 'full', 'unavailable']) {
    const { backend, store } = await plainStore();
    const service = expenseService(store);
    const seen = canonical(store.snapshot);
    let notified = 0;
    store.subscribe(() => { notified += 1; });

    backend.failNext = code;
    await rejectsWithCode(service.save(draft('5', store.snapshot.categories[0]), Fx.today), code);
    assert.deepEqual(canonical(store.snapshot), seen, 'The screens never saw the unsaved expense');
    assert.equal(backend.rawRows('expenses').length, 8);
    assert.equal(notified, 0, 'Nobody was told about a change that did not happen');

    await addExpense(store);
    assert.equal(store.snapshot.expenses.length, 9);
    assert.equal(notified, 1);
  }
});

test('a failed save does not leave the store refusing further saves', async () => {
  const { backend, store } = await plainStore();
  backend.failNext = 'full';
  await rejectsWithCode(addExpense(store), 'full');
  assert.equal(store.isStale, false, 'Only a conflict makes the store refuse saves');
  await addExpense(store);
  await addExpense(store);
  assert.equal(backend.rawRows('expenses').length, 10);
});

test('saves that are started together run one after the other and all succeed', async () => {
  const { backend, store } = await plainStore();
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => addExpense(store, String(index + 1), Fx.uuid(1000 + index))));
  assert.equal(results.length, 25);
  assert.equal(store.snapshot.expenses.length, 33);
  assert.equal(backend.rawRows('expenses').length, 33);
  assert.equal(store.isStale, false, 'Saves from one window never conflict with each other');
  const reopened = await LedgerStore.open(backend);
  assert.deepEqual(canonical(reopened.snapshot), canonical(store.snapshot));
});

test('one failing save among several does not spoil the others', async () => {
  const { backend, store } = await plainStore();
  backend.failNext = 'full';
  const outcomes = await Promise.allSettled([addExpense(store, '1'), addExpense(store, '2'), addExpense(store, '3')]);
  assert.equal(outcomes[0].status, 'rejected');
  assert.equal(outcomes[0].reason.code, 'full');
  assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal(outcomes[2].status, 'fulfilled');
  assert.equal(store.snapshot.expenses.length, 10);
  assert.equal(backend.rawRows('expenses').length, 10);
});

test('listeners are told about saves, and a screen that fails does not stop the saving', async () => {
  const { backend } = await emptyStore();
  const reported = [];
  const store = await LedgerStore.open(backend, { reportListenerError: (error) => reported.push(error.message) });
  const reasons = [];
  const stop = store.subscribe((_, reason) => reasons.push(reason));
  store.subscribe(() => { throw new Error('a broken screen'); });
  await store.initializeNew(new SampleLedger().snapshot);
  await addExpense(store);
  await store.replaceAll(new SampleLedger().snapshot);
  assert.deepEqual(reasons, ['state', 'commit', 'replace']);
  assert.deepEqual(reported, ['a broken screen', 'a broken screen', 'a broken screen']);
  stop();
  await addExpense(store);
  assert.equal(reasons.length, 3, 'Stopped listening');
});

// Replacing everything (restoring a backup) ------------------------------------------------------

test('replacing everything removes what is not in the new data, in one step', async () => {
  const { backend, store } = await plainStore();
  await store.saveFiredAlertKeys(['old-alert']);
  const fresh = Fx.catalog();
  fresh.expenses.push(Fx.expense('1', Fx.today, Fx.category('Fuel', fresh), { id: Fx.uuid(4242) }));
  const before = backend.commitCount;
  await store.replaceAll(fresh);
  assert.equal(backend.commitCount, before + 1);
  assert.equal(store.snapshot.expenses.length, 1);
  assert.equal(backend.rawRows('expenses').length, 1);
  assert.equal(backend.rawRows('categories').length, fresh.categories.length);
  assert.equal(store.firedAlertKeys.size, 0, 'The memory of shown alerts starts again');
  const reopened = await LedgerStore.open(backend);
  assert.deepEqual(canonical(reopened.snapshot), canonical(fresh));
});

test('a failed replace leaves the old data', async () => {
  const { backend, store, sample } = await plainStore();
  backend.failNext = 'failed';
  await rejectsWithCode(store.replaceAll(Fx.catalog()), 'failed');
  assert.equal(store.snapshot.expenses.length, 8);
  assert.equal(backend.rawRows('expenses').length, 8);
  assert.deepEqual(canonical(store.snapshot), canonical(sample.snapshot));
});

test('replacing everything also clears records that could not be read', async () => {
  const { backend, store } = await plainStore();
  backend.rawPut('expenses', { id: Fx.uuid(31337), plain: { nonsense: true } });
  await store.reload();
  assert.equal(store.unreadableCount, 1);
  await store.replaceAll(Fx.catalog());
  assert.equal(store.unreadableCount, 0);
  assert.equal(backend.rawRow('expenses', Fx.uuid(31337)), null);
});

// The memory of shown budget alerts --------------------------------------------------------------

test('shown alerts are remembered across reopening', async () => {
  const { backend, store } = await plainStore();
  assert.equal(store.firedAlertKeys.size, 0);
  await store.saveFiredAlertKeys(['key-b', 'key-a']);
  assert.deepEqual([...store.firedAlertKeys].sort(), ['key-a', 'key-b']);
  const reopened = await LedgerStore.open(backend);
  assert.deepEqual([...reopened.firedAlertKeys].sort(), ['key-a', 'key-b']);
  await reopened.saveFiredAlertKeys([]);
  assert.equal((await LedgerStore.open(backend)).firedAlertKeys.size, 0);
});

test('the returned set of shown alerts is a copy', async () => {
  const { store } = await plainStore();
  await store.saveFiredAlertKeys(['a']);
  store.firedAlertKeys.add('hacked');
  assert.deepEqual([...store.firedAlertKeys], ['a']);
});

test('an unreadable memory of shown alerts simply starts again, without counting as damage', async () => {
  const { backend, store } = await plainStore();
  await store.saveFiredAlertKeys(['a']);
  backend.rawPut('extras', { id: 'firedAlerts', plain: { keys: 'not a list' } });
  await store.reload();
  assert.equal(store.firedAlertKeys.size, 0);
  assert.equal(store.unreadableCount, 0);
});

// Records that cannot be read (no passcode) ------------------------------------------------------

test('records that are not valid are left out and counted, and the rest still opens', async () => {
  const { backend, sample } = await plainStore();
  const good = backend.rawRow('expenses', sample.e[0].id);
  // wrong shape, wrong id for its place, not an object at all
  backend.rawPut('expenses', { id: sample.e[1].id, plain: { ...good.plain, id: sample.e[1].id, amount: 'free' } });
  backend.rawPut('expenses', { id: Fx.uuid(555), plain: good.plain });
  backend.rawPut('expenses', { id: Fx.uuid(556), plain: 'text' });
  backend.rawPut('expenses', { id: Fx.uuid(557) });
  backend.rawPut('budgets', { id: Fx.uuid(558), plain: { id: Fx.uuid(558) } });

  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.state, 'ready');
  assert.equal(reopened.snapshot.expenses.length, 7, 'Seven good ones are shown');
  assert.equal(reopened.unreadableCount, 5);
  assert.deepEqual(reopened.unreadableByStore, { expenses: 4, budgets: 1 });
});

test('missing settings are replaced by the defaults and counted', async () => {
  const { backend } = await plainStore();
  backend.rawDelete('settings', 'settings');
  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.state, 'ready');
  assert.deepEqual(reopened.snapshot.settings, defaultSettings());
  assert.deepEqual(reopened.unreadableByStore, { settings: 1 });
});

test('an unreadable record does not stop other saves, and saving it again heals it', async () => {
  const { backend, sample } = await plainStore();
  backend.rawPut('expenses', { id: sample.e[1].id, plain: { broken: true } });
  const store = await LedgerStore.open(backend);
  assert.equal(store.unreadableCount, 1);
  await addExpense(store);
  assert.equal(store.snapshot.expenses.length, 8, 'Seven readable plus the new one');
  await expenseService(store).save(draft('3', sample.groceries, { id: sample.e[1].id }), Fx.today);
  assert.equal((await LedgerStore.open(backend)).unreadableCount, 0);
});

test('a layout from a newer version of the app is not touched', async () => {
  const { backend } = await plainStore();
  backend.rawPutMeta(META_KEYS.format, { schema: 2 });
  await rejectsWithCode(LedgerStore.open(backend), 'newerVersion');
  backend.rawPutMeta(META_KEYS.format, { schema: 'one' });
  await rejectsWithCode(LedgerStore.open(backend), 'unrecognized');
  backend.rawPutMeta(META_KEYS.format, 'junk');
  await rejectsWithCode(LedgerStore.open(backend), 'unrecognized');
});

test('a storage that cannot be read is reported, not mistaken for an empty one', async () => {
  const backend = new MemoryBackend();
  backend.failLoad = true;
  await rejectsWithCode(LedgerStore.open(backend), 'unavailable');
});

// With a passcode: what is stored ----------------------------------------------------------------

test('with a passcode, nothing readable is stored', async () => {
  const { backend, store, sample } = await protectedStore();
  assert.equal(store.isProtected, true);
  assert.equal(store.state, 'ready');
  const text = backend.dump();
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} must not appear in storage`);
  assert.ok(!text.includes(PASSCODE), 'The passcode is never stored');
  for (const name of ROW_STORES) {
    for (const row of backend.rawRows(name)) {
      assert.deepEqual(Object.keys(row).sort(), ['id', 'sealed'], `${name} rows hold only an id and sealed bytes`);
      assert.ok(row.sealed instanceof Uint8Array);
    }
  }
  assert.equal(backend.rawRows('expenses').length, sample.e.length);
  const keyring = backend.rawMeta(META_KEYS.keyring);
  assert.equal(keyring.mode, 'passcode');
  assert.equal(keyring.kdf.iterations, 100_000);
});

test('protected data opens again only with the passcode', async () => {
  const { backend, sample } = await protectedStore();
  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.state, 'locked');
  assert.equal(reopened.isProtected, true);
  assert.equal(reopened.snapshot.expenses.length, 0, 'Nothing is visible while locked');

  await rejectsWithCode(reopened.unlock('482916'), 'wrongPasscode');
  await rejectsWithCode(reopened.unlock(''), 'wrongPasscode');
  assert.equal(reopened.state, 'locked');
  assert.equal(reopened.snapshot.expenses.length, 0);

  await reopened.unlock(PASSCODE);
  assert.equal(reopened.state, 'ready');
  assert.deepEqual(canonical(reopened.snapshot), canonical(sample.snapshot));
  assert.equal(reopened.unreadableCount, 0);
});

test('while locked, nothing can be read or saved', async () => {
  const { backend, store } = await protectedStore();
  store.lock();
  assert.equal(store.state, 'locked');
  assert.equal(store.snapshot.expenses.length, 0);
  assert.equal(store.snapshot.categories.length, 0);
  assert.equal(store.firedAlertKeys.size, 0);
  const before = backend.commitCount;
  const changes = new LedgerChangeSet();
  changes.settings = normalizeSettings({ ...defaultSettings(), currencyCode: 'USD' });
  await rejectsWithCode(store.commit(changes), 'locked');
  await rejectsWithCode(store.replaceAll(new SampleLedger().snapshot), 'locked');
  await rejectsWithCode(store.saveFiredAlertKeys(['x']), 'locked');
  await rejectsWithCode(store.enableProtection(NEXT, FAST), 'locked');
  await rejectsWithCode(store.disableProtection(PASSCODE), 'locked');
  await rejectsWithCode(store.changePasscode(PASSCODE, NEXT, FAST), 'locked');
  assert.equal(backend.commitCount, before);
});

test('locking forgets the data, and unlocking brings it back', async () => {
  const { store, sample } = await protectedStore();
  const reasons = [];
  store.subscribe((_, reason) => reasons.push(reason));
  store.lock();
  store.lock();
  assert.equal(store.state, 'locked');
  assert.deepEqual(reasons, ['state'], 'Locking twice is told once');
  await store.unlock(PASSCODE);
  assert.deepEqual(canonical(store.snapshot), canonical(sample.snapshot));
  assert.deepEqual(reasons, ['state', 'state']);
});

test('locking does nothing when there is no passcode', async () => {
  const { store, sample } = await plainStore();
  store.lock();
  assert.equal(store.state, 'ready');
  assert.equal(store.snapshot.expenses.length, sample.e.length);
});

test('a save that was queued before the lock is refused instead of being written', async () => {
  const { backend, store } = await protectedStore();
  const before = backend.commitCount;
  const pending = addExpense(store);
  store.lock();
  await rejectsWithCode(pending, 'locked');
  assert.equal(backend.commitCount, before);
});

test('saving with a passcode seals every record, and reopening shows the same data', async () => {
  const { backend, store } = await protectedStore();
  const saved = await addExpense(store, '12.34');
  const row = backend.rawRow('expenses', saved.id);
  assert.ok(row.sealed instanceof Uint8Array);
  assert.ok(!backend.dump().includes('minorUnits'));
  const reopened = await otherWindow(backend, PASSCODE);
  assert.equal(reopened.snapshot.expense(saved.id).amount.minorUnits, 1234);
  assert.deepEqual(canonical(reopened.snapshot), canonical(store.snapshot));
});

test('every sealed row is different each time it is saved', async () => {
  const { backend, store, sample } = await protectedStore();
  const before = backend.rawRow('expenses', sample.e[0].id).sealed;
  await expenseService(store).save(draft('50', sample.groceries, { id: sample.e[0].id, merchant: 'Spinneys' }), Fx.today);
  const after = backend.rawRow('expenses', sample.e[0].id).sealed;
  assert.notDeepEqual(Array.from(before), Array.from(after));
});

test('a first ledger that starts protected is never stored in the clear', async () => {
  const { backend } = await protectedStore();
  assert.equal(backend.commitCount, 1);
  for (const secret of SECRETS) assert.ok(!backend.dump().includes(secret));
});

test('a first ledger refuses a weak passcode and stores nothing', async () => {
  const { backend, store } = await emptyStore();
  for (const [passcode, problem] of [['123456', 'sequence'], ['111111', 'repeated'], ['4829', 'tooShort'], ['', 'empty']]) {
    await assert.rejects(store.initializeNew(new SampleLedger().snapshot, { passcode, ...FAST }), (error) => {
      assert.equal(error.code, 'weakPasscode');
      assert.equal(error.details.problem, problem);
      return true;
    });
  }
  assert.equal(backend.commitCount, 0);
  assert.equal(store.state, 'empty');
});

// With a passcode: checking it -------------------------------------------------------------------

test('a passcode can be checked without opening anything', async () => {
  const { backend } = await protectedStore();
  const store = await LedgerStore.open(backend);
  assert.equal(await store.verifyPasscode(PASSCODE), true);
  assert.equal(await store.verifyPasscode('000000'), false);
  assert.equal(store.state, 'locked', 'Checking does not unlock');
  const key = await store.verifyKey(PASSCODE);
  assert.equal(store.state, 'locked');
  assert.equal(key.dek.extractable, false);
  await store.unlockWithKey(key);
  assert.equal(store.state, 'ready');
  await store.unlockWithKey(key);
  assert.equal(store.state, 'ready', 'Opening an open store does nothing');
});

test('checking a passcode when none is set says so', async () => {
  const { store } = await plainStore();
  await rejectsWithCode(store.verifyKey(PASSCODE), 'notProtected');
  await rejectsWithCode(store.verifyPasscode(PASSCODE), 'notProtected');
});

test('a key from before the passcode was changed elsewhere does not open the data', async () => {
  const { backend, store: first } = await protectedStore();
  const locked = await LedgerStore.open(backend);
  const stale = await locked.verifyKey(PASSCODE);
  await first.changePasscode(PASSCODE, NEXT, FAST);
  await rejectsWithCode(locked.unlockWithKey(stale), 'conflict');
  assert.equal(locked.state, 'locked');
  await rejectsWithCode(locked.unlock(PASSCODE), 'wrongPasscode', 'The old passcode is no longer right');
  await locked.unlock(NEXT);
  assert.equal(locked.unreadableCount, 0);
});

test('a damaged keyring is reported as damaged and the data is left alone', async () => {
  const { backend } = await protectedStore();
  const rowsBefore = JSON.stringify(backend.rawRows('expenses').map((r) => Array.from(r.sealed)));
  for (const junk of [{ mode: 'passcode' }, 'text', { mode: 'passcode', version: 1, kdf: { name: 'MD5', iterations: 5, salt: '' }, wrapped: '' }]) {
    backend.rawPutMeta(META_KEYS.keyring, junk);
    const store = await LedgerStore.open(backend);
    assert.equal(store.state, 'locked', 'A keyring that exists means the data is protected, even if damaged');
    await rejectsWithCode(store.unlock(PASSCODE), 'damaged');
    await rejectsWithCode(store.verifyPasscode(PASSCODE), 'damaged');
    assert.equal(store.state, 'locked');
  }
  assert.equal(JSON.stringify(backend.rawRows('expenses').map((r) => Array.from(r.sealed))), rowsBefore);
});

// With a passcode: someone changed the storage ---------------------------------------------------

test('a changed sealed record is left out and counted; the rest opens', async () => {
  const { backend, sample } = await protectedStore();
  const victim = backend.rawRow('expenses', sample.e[0].id);
  victim.sealed[20] ^= 1;
  backend.rawPut('expenses', victim);
  const store = await otherWindow(backend, PASSCODE);
  assert.equal(store.snapshot.expenses.length, 7);
  assert.equal(store.snapshot.expense(sample.e[0].id), null);
  assert.deepEqual(store.unreadableByStore, { expenses: 1 });
  assert.equal(store.unreadableCount, 1);
});

test('records swapped between places are noticed', async () => {
  const { backend, sample } = await protectedStore();
  const a = backend.rawRow('expenses', sample.e[0].id);
  const b = backend.rawRow('expenses', sample.e[1].id);
  backend.rawPut('expenses', { id: a.id, sealed: b.sealed });
  backend.rawPut('expenses', { id: b.id, sealed: a.sealed });
  const category = backend.rawRows('categories')[0];
  backend.rawPut('expenses', { id: sample.e[2].id, sealed: category.sealed });
  const store = await otherWindow(backend, PASSCODE);
  assert.equal(store.snapshot.expenses.length, 5, 'Three records were in the wrong place');
  assert.deepEqual(store.unreadableByStore, { expenses: 3 });
});

test('a readable record planted in a protected store is not trusted', async () => {
  const { backend, sample } = await protectedStore();
  const planted = { ...toWire.expense(sample.e[0]), id: Fx.uuid(777), merchant: 'Planted' };
  backend.rawPut('expenses', { id: Fx.uuid(777), plain: planted });
  const store = await otherWindow(backend, PASSCODE);
  assert.equal(store.snapshot.expenses.length, 8);
  assert.equal(store.snapshot.expense(Fx.uuid(777)), null);
  assert.equal(store.unreadableCount, 1);
});

test('a sealed record copied from another ledger does not open', async () => {
  const mine = await protectedStore();
  const theirs = await protectedStore(); // different random key, same passcode
  const foreign = theirs.backend.rawRow('expenses', theirs.sample.e[0].id);
  mine.backend.rawPut('expenses', { id: mine.sample.e[0].id, sealed: foreign.sealed });
  const store = await otherWindow(mine.backend, PASSCODE);
  assert.equal(store.unreadableCount, 1);
});

test('known limitation: a deleted record, or an older copy of a record, cannot be told from the real thing', async () => {
  const { backend, store, sample } = await protectedStore();
  const old = backend.rawRow('expenses', sample.e[0].id);
  await expenseService(store).save(draft('77', sample.groceries, { id: sample.e[0].id }), Fx.today);

  // Someone with access to the storage puts the older version of the record back...
  backend.rawPut('expenses', old);
  const rolledBack = await otherWindow(backend, PASSCODE);
  assert.equal(rolledBack.unreadableCount, 0, 'No alarm: it is a genuine sealed record');
  assert.equal(rolledBack.snapshot.expense(sample.e[0].id).amount.minorUnits, 5000, 'The older amount is back');

  // ...or removes a record altogether.
  backend.rawDelete('expenses', sample.e[1].id);
  const shorter = await otherWindow(backend, PASSCODE);
  assert.equal(shorter.unreadableCount, 0, 'No alarm: a missing record leaves no trace');
  assert.equal(shorter.snapshot.expenses.length, 7);
});

test('protection changes are refused while a record cannot be read, so nothing unreadable is lost or sealed', async () => {
  const plain = await plainStore();
  plain.backend.rawPut('expenses', { id: plain.sample.e[0].id, plain: { broken: true } });
  const store = await otherWindow(plain.backend);
  assert.equal(store.unreadableCount, 1);
  const before = plain.backend.commitCount;
  await rejectsWithCode(store.enableProtection(PASSCODE, FAST), 'unreadableRecords');
  assert.equal(plain.backend.commitCount, before);
  assert.equal(store.isProtected, false);

  const sealed = await protectedStore();
  const row = sealed.backend.rawRow('expenses', sealed.sample.e[0].id);
  row.sealed[30] ^= 1;
  sealed.backend.rawPut('expenses', row);
  const opened = await otherWindow(sealed.backend, PASSCODE);
  await rejectsWithCode(opened.changePasscode(PASSCODE, NEXT, FAST), 'unreadableRecords');
  await rejectsWithCode(opened.disableProtection(PASSCODE), 'unreadableRecords');
  assert.equal(sealed.backend.rawMeta(META_KEYS.keyring).kdf.iterations, 100_000, 'The keyring was not replaced');
  assert.deepEqual(Array.from(sealed.backend.rawRow('expenses', sealed.sample.e[0].id).sealed), Array.from(row.sealed), 'The unreadable record is untouched');
});

// Turning the passcode on, off and changing it ---------------------------------------------------

test('setting a passcode seals everything in one step, and nothing readable is left behind', async () => {
  const { backend, store, sample } = await plainStore();
  await store.saveFiredAlertKeys(['alert-key-one']);
  assert.ok(backend.dump().includes('Spinneys'));
  const before = backend.commitCount;
  await store.enableProtection(PASSCODE, FAST);
  assert.equal(backend.commitCount, before + 1, 'One all-or-nothing write');
  assert.equal(store.isProtected, true);
  assert.equal(store.state, 'ready');
  for (const secret of [...SECRETS, 'alert-key-one']) assert.ok(!backend.dump().includes(secret), `${secret} was left behind`);
  assert.deepEqual(canonical(store.snapshot), canonical(sample.snapshot));

  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.state, 'locked');
  await reopened.unlock(PASSCODE);
  assert.deepEqual(canonical(reopened.snapshot), canonical(sample.snapshot));
  assert.deepEqual([...reopened.firedAlertKeys], ['alert-key-one']);
  await addExpense(reopened);
  assert.ok(backend.rawRows('expenses').every((row) => row.sealed instanceof Uint8Array), 'New saves are sealed');
});

test('setting a passcode refuses weak ones and a second one, and a failure leaves the plain data as it was', async () => {
  const { backend, store, sample } = await plainStore();
  await rejectsWithCode(store.enableProtection('123456', FAST), 'weakPasscode');
  await rejectsWithCode(store.disableProtection(PASSCODE), 'notProtected');
  await rejectsWithCode(store.changePasscode(PASSCODE, NEXT, FAST), 'notProtected');

  backend.failNext = 'full';
  await rejectsWithCode(store.enableProtection(PASSCODE, FAST), 'full');
  assert.equal(store.isProtected, false);
  assert.equal(backend.rawMeta(META_KEYS.keyring), null);
  assert.ok(backend.rawRows('expenses').every((row) => row.plain), 'The data is still plain, and complete');
  assert.equal(backend.rawRows('expenses').length, sample.e.length);
  await store.enableProtection(PASSCODE, FAST);
  assert.equal(store.isProtected, true);
  await rejectsWithCode(store.enableProtection(NEXT, FAST), 'alreadyProtected');
});

test('removing the passcode needs it, then stores everything as plain JSON again', async () => {
  const { backend, store, sample } = await protectedStore();
  const before = backend.commitCount;
  await rejectsWithCode(store.disableProtection('000000'), 'wrongPasscode');
  assert.equal(backend.commitCount, before);
  assert.equal(store.isProtected, true);
  assert.ok(!backend.dump().includes('Spinneys'));

  backend.failNext = 'failed';
  await rejectsWithCode(store.disableProtection(PASSCODE), 'failed');
  assert.equal(store.isProtected, true, 'A failed change changes nothing');
  assert.ok(!backend.dump().includes('Spinneys'));

  await store.disableProtection(PASSCODE);
  assert.equal(store.isProtected, false);
  assert.equal(backend.rawMeta(META_KEYS.keyring), null);
  assert.ok(backend.dump().includes('Spinneys'));
  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.state, 'ready', 'No passcode: it opens straight away');
  assert.deepEqual(canonical(reopened.snapshot), canonical(sample.snapshot));
});

test('changing the passcode needs the old one and makes a new data key', async () => {
  const { backend, store, sample } = await protectedStore();
  const oldKey = await store.verifyKey(PASSCODE);
  const oldKeyring = backend.rawMeta(META_KEYS.keyring);
  const oldRow = backend.rawRow('expenses', sample.e[0].id);

  const before = backend.commitCount;
  await rejectsWithCode(store.changePasscode('000000', NEXT, FAST), 'wrongPasscode');
  await rejectsWithCode(store.changePasscode(PASSCODE, '111111', FAST), 'weakPasscode');
  assert.equal(backend.commitCount, before, 'Refused changes write nothing');

  await store.changePasscode(PASSCODE, NEXT, FAST);
  assert.equal(backend.commitCount, before + 1, 'One all-or-nothing write');
  assert.notDeepEqual(backend.rawMeta(META_KEYS.keyring), oldKeyring);

  // Every record was re-sealed under a NEW key: the old key opens none of them.
  for (const row of backend.rawRows('expenses')) {
    await rejectsWithCode(openRecord(oldKey.dek, 'expenses', row.id, row.sealed), 'cannotOpen');
  }

  const reopened = await LedgerStore.open(backend);
  await rejectsWithCode(reopened.unlock(PASSCODE), 'wrongPasscode');
  await reopened.unlock(NEXT);
  assert.deepEqual(canonical(reopened.snapshot), canonical(sample.snapshot));
  assert.equal(reopened.unreadableCount, 0);

  // Saves after the change work with the new passcode.
  await addExpense(reopened);
  assert.equal((await otherWindow(backend, NEXT)).snapshot.expenses.length, 9);
  assert.ok(oldRow.sealed.length > 0);
});

test('known limitation: a copy of the storage made before a passcode change still opens with the OLD passcode', async () => {
  const { backend, store, sample } = await protectedStore();
  const copy = copyOf(backend);
  await store.changePasscode(PASSCODE, NEXT, FAST);
  const old = await LedgerStore.open(copy);
  await old.unlock(PASSCODE);
  assert.equal(old.snapshot.expenses.length, sample.e.length, 'Changing the passcode cannot reach copies that already exist');
});

test('a failed passcode change leaves the old passcode working', async () => {
  const { backend, store, sample } = await protectedStore();
  backend.failNext = 'full';
  await rejectsWithCode(store.changePasscode(PASSCODE, NEXT, FAST), 'full');
  assert.equal(await store.verifyPasscode(PASSCODE), true);
  assert.equal(await store.verifyPasscode(NEXT), false);
  const reopened = await otherWindow(backend, PASSCODE);
  assert.deepEqual(canonical(reopened.snapshot), canonical(sample.snapshot));
  await addExpense(store);
  assert.equal((await otherWindow(backend, PASSCODE)).snapshot.expenses.length, 9);
});

test('turning the passcode on and off again round trips the data exactly', async () => {
  const { backend, store, sample } = await plainStore();
  await store.enableProtection(PASSCODE, FAST);
  await store.changePasscode(PASSCODE, NEXT, FAST);
  await store.disableProtection(NEXT);
  await store.enableProtection(PASSCODE, FAST);
  const reopened = await otherWindow(backend, PASSCODE);
  assert.deepEqual(canonical(reopened.snapshot), canonical(sample.snapshot));
});

test('restoring a backup keeps the passcode and the protection', async () => {
  const { backend, store } = await protectedStore();
  const keyring = backend.rawMeta(META_KEYS.keyring);
  await store.replaceAll(Fx.catalog());
  assert.deepEqual(backend.rawMeta(META_KEYS.keyring), keyring, 'The passcode was not touched');
  assert.ok(backend.rawRows('categories').every((row) => row.sealed), 'The restored data is sealed too');
  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.state, 'locked');
  await reopened.unlock(PASSCODE);
  assert.equal(reopened.snapshot.expenses.length, 0);
});

test('the remembered alerts are sealed too', async () => {
  const { backend, store } = await protectedStore();
  await store.saveFiredAlertKeys(['budget-secret-key-123']);
  assert.ok(!backend.dump().includes('budget-secret-key-123'));
  const reopened = await otherWindow(backend, PASSCODE);
  assert.deepEqual([...reopened.firedAlertKeys], ['budget-secret-key-123']);
});

// Erasing everything -----------------------------------------------------------------------------

test('erasing everything works even while locked, and leaves nothing behind', async () => {
  const { backend, store } = await protectedStore();
  await store.saveFiredAlertKeys(['k']);
  await backend.putMeta(META_KEYS.lock, { timeout: 60 });
  await backend.putMeta(META_KEYS.attempts, { failedAttempts: 6, lockedUntil: 5 });
  store.lock();
  await store.eraseEverything();
  assert.equal(store.state, 'empty');
  assert.equal(store.isProtected, false);
  assert.equal(store.snapshot.expenses.length, 0);
  const loaded = await backend.load();
  assert.equal(loaded.version, null);
  assert.deepEqual(loaded.meta, {});
  for (const name of ROW_STORES) assert.deepEqual(loaded.rows[name], []);
  assert.equal(backend.dump().includes('Spinneys'), false);

  const reopened = await LedgerStore.open(backend);
  assert.equal(reopened.state, 'empty');
});

test('after erasing, a brand new ledger can be started, with or without a passcode', async () => {
  const { backend, store } = await protectedStore();
  await store.eraseEverything();
  await store.initializeNew(Fx.catalog());
  assert.equal(store.state, 'ready');
  assert.equal(store.isProtected, false, 'The old passcode is gone');
  assert.equal(store.snapshot.expenses.length, 0);
  assert.equal((await LedgerStore.open(backend)).state, 'ready');
  await store.eraseEverything();
  await store.initializeNew(Fx.catalog(), { passcode: NEXT, ...FAST });
  assert.equal((await LedgerStore.open(backend)).state, 'locked');
});

test('a failed erase changes nothing', async () => {
  const { backend, store } = await plainStore();
  backend.failNext = 'failed';
  await rejectsWithCode(store.eraseEverything(), 'failed');
  assert.equal(store.state, 'ready');
  assert.equal(store.snapshot.expenses.length, 8);
  assert.equal(backend.rawRows('expenses').length, 8);
});

// Two windows ------------------------------------------------------------------------------------

test('a window that is behind is refused instead of overwriting the newer data', async () => {
  const { backend, store: a } = await plainStore();
  const b = await otherWindow(backend);
  await addExpense(a, '1');
  const before = backend.commitCount;
  await rejectsWithCode(addExpense(b, '2'), 'conflict');
  assert.equal(b.isStale, true);
  assert.equal(b.snapshot.expenses.length, 8, 'It still shows what it had');
  await rejectsWithCode(addExpense(b, '3'), 'conflict');
  await rejectsWithCode(b.saveFiredAlertKeys(['x']), 'conflict');
  assert.equal(backend.commitCount, before, 'Nothing more was written');

  await b.reload();
  assert.equal(b.isStale, false);
  assert.equal(b.snapshot.expenses.length, 9, 'Reloading shows the other window\'s expense');
  await addExpense(b, '4');
  assert.equal(backend.rawRows('expenses').length, 10);
  const afterwards = await otherWindow(backend);
  assert.equal(afterwards.snapshot.expenses.length, 10, 'Nothing was lost');
});

test('two windows saving at the same moment: one wins, the other is told', async () => {
  const { backend, store: a } = await plainStore();
  const b = await otherWindow(backend);
  const outcomes = await Promise.allSettled([addExpense(a, '1'), addExpense(b, '2')]);
  const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'conflict');
  assert.equal(backend.rawRows('expenses').length, 9);
});

test('a window that still has the old key cannot write records the new passcode would not open', async () => {
  const { backend, store: a } = await protectedStore();
  const b = await otherWindow(backend, PASSCODE);
  await a.changePasscode(PASSCODE, NEXT, FAST);
  const before = backend.commitCount;
  await rejectsWithCode(addExpense(b), 'conflict');
  assert.equal(backend.commitCount, before, 'Nothing was written with the old key');

  await b.reload();
  assert.equal(b.state, 'locked', 'The protection changed, so the old key is dropped');
  assert.equal(b.snapshot.expenses.length, 0);
  await rejectsWithCode(b.unlock(PASSCODE), 'wrongPasscode');
  await b.unlock(NEXT);
  assert.equal(b.unreadableCount, 0, 'Every record opens with the new key');
  await addExpense(b);
  assert.equal((await otherWindow(backend, NEXT)).unreadableCount, 0);
});

test('a window that is open when the passcode is set elsewhere locks when it reloads', async () => {
  const { backend, store: a } = await plainStore();
  const b = await otherWindow(backend);
  await a.enableProtection(PASSCODE, FAST);
  await rejectsWithCode(addExpense(b), 'conflict');
  assert.ok(backend.rawRows('expenses').every((row) => row.sealed), 'The plain window wrote nothing');
  await b.reload();
  assert.equal(b.state, 'locked');
  assert.equal(b.snapshot.expenses.length, 0);
  await b.unlock(PASSCODE);
  assert.equal(b.snapshot.expenses.length, 8);
});

test('a window that is open when the passcode is removed elsewhere reloads into the plain data', async () => {
  const { backend, store: a } = await protectedStore();
  const b = await otherWindow(backend, PASSCODE);
  await a.disableProtection(PASSCODE);
  await rejectsWithCode(addExpense(b), 'conflict');
  await b.reload();
  assert.equal(b.state, 'ready');
  assert.equal(b.isProtected, false);
  assert.equal(b.snapshot.expenses.length, 8);
  await addExpense(b);
  assert.ok(backend.rawRows('expenses').every((row) => row.plain));
});

test('a window that is open when everything is erased elsewhere finds an empty app', async () => {
  const { backend, store: a } = await plainStore();
  const b = await otherWindow(backend);
  await a.eraseEverything();
  await rejectsWithCode(addExpense(b), 'conflict');
  await b.reload();
  assert.equal(b.state, 'empty');
  assert.equal(b.snapshot.expenses.length, 0);
});

test('reloading when nothing changed keeps the key and the data', async () => {
  const { store, sample } = await protectedStore();
  await store.reload();
  assert.equal(store.state, 'ready');
  assert.deepEqual(canonical(store.snapshot), canonical(sample.snapshot));
});

// Size -------------------------------------------------------------------------------------------

test('a large ledger saves and opens quickly, with and without a passcode', async () => {
  const COUNT = 5000;
  const base = Fx.catalog();
  const category = Fx.category('Groceries', base);
  const list = Array.from({ length: COUNT }, (_, i) => Fx.expense(String((i % 500) + 1), Fx.today.addingDays(-(i % 400)), category, {
    id: Fx.uuid(100000 + i), merchant: `Shop ${i % 37}`, createdAt: Fx.now + i,
  }));
  const big = Fx.adding(list, base);

  for (const withPasscode of [false, true]) {
    const { backend, store } = await emptyStore();
    let started = performance.now();
    await store.initializeNew(big, withPasscode ? { passcode: PASSCODE, ...FAST } : {});
    const writeMs = performance.now() - started;

    started = performance.now();
    const reopened = await LedgerStore.open(backend);
    if (withPasscode) await reopened.unlock(PASSCODE);
    const openMs = performance.now() - started;

    assert.equal(reopened.snapshot.expenses.length, COUNT);
    assert.equal(reopened.unreadableCount, 0);
    assert.deepEqual(canonical(reopened.snapshot), canonical(big));
    console.log(`  ${COUNT} expenses ${withPasscode ? 'with' : 'without'} a passcode: first write ${writeMs.toFixed(0)} ms, open ${openMs.toFixed(0)} ms`);
    assert.ok(writeMs < 8000, `writing took ${writeMs} ms`);
    assert.ok(openMs < 8000, `opening took ${openMs} ms`);

    started = performance.now();
    await addExpense(reopened);
    assert.ok(performance.now() - started < 1000, 'One more expense stays quick however large the ledger is');
  }
});
