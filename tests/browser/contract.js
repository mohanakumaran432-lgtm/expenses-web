// Runs the shared storage rules (tests/backend_contract.mjs) against the REAL IndexedDB of whatever browser opens this
// page, plus a few checks that only make sense in a browser. Results go to window.__contractResults for the runner.

import { BACKEND_CONTRACT } from '../backend_contract.mjs';
import { IndexedDbBackend } from '../../docs/js/data/backend_indexeddb.js';
import { LedgerStore } from '../../docs/js/data/ledger_store.js';
import { addExpense, sampleLedger } from './helpers.js';

function same(a, b) {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((value, index) => value === b[index]);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => same(value, b[index]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]));
  }
  return false;
}

const show = (value) => {
  try {
    return JSON.stringify(value, (key, item) => (item instanceof Uint8Array ? `bytes(${item.length})` : item));
  } catch {
    return String(value);
  }
};

const t = {
  ok(value, message) {
    if (!value) throw new Error(message || 'expected a truthy value');
  },
  equal(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message || 'equal'}: ${show(actual)} !== ${show(expected)}`);
  },
  deepEqual(actual, expected, message) {
    if (!same(actual, expected)) throw new Error(`${message || 'deepEqual'}: ${show(actual)} does not match ${show(expected)}`);
  },
  async rejectsCode(promise, code, message) {
    try {
      await promise;
    } catch (error) {
      if (error && error.code === code) return;
      throw new Error(`${message || 'rejectsCode'}: expected code ${code}, got ${error && error.code}: ${error && error.message}`);
    }
    throw new Error(`${message || 'rejectsCode'}: expected a rejection with code ${code}, but it succeeded`);
  },
};

let counter = 0;
const freshName = () => `contract-${Date.now()}-${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}`;

async function inFreshDatabase(run) {
  const name = freshName();
  const opened = [];
  const open = async () => {
    const backend = await IndexedDbBackend.open({ name });
    opened.push(backend);
    return backend;
  };
  try {
    const backend = await open();
    await run({ backend, second: open, name, open }, t);
  } finally {
    for (const backend of opened) backend.close();
    await IndexedDbBackend.destroy(name);
  }
}

// Checks that only a real browser can answer ---------------------------------------------------------

const BROWSER_ONLY = [
  {
    name: 'data written is still there after the connection is closed and opened again',
    async run({ backend, open }) {
      const version = await backend.commit({ expectVersion: null, ops: [{ op: 'put', store: 'tags', row: { id: 'A', plain: { n: 1 } } }], meta: { format: { schema: 1 } } });
      backend.close();
      const again = await open();
      const loaded = await again.load();
      t.equal(loaded.version, version);
      t.deepEqual(loaded.rows.tags, [{ id: 'A', plain: { n: 1 } }]);
    },
  },
  {
    name: 'a window keeps working after another window deleted the database (it reconnects)',
    async run({ backend, name }) {
      await backend.commit({ expectVersion: null, ops: [{ op: 'put', store: 'tags', row: { id: 'A', plain: {} } }] });
      await IndexedDbBackend.destroy(name); // our connection is asked to close, and lets go
      const loaded = await backend.load();
      t.equal(loaded.version, null, 'The deleted database is gone');
      t.deepEqual(loaded.rows.tags, []);
      await backend.commit({ expectVersion: null, ops: [{ op: 'put', store: 'tags', row: { id: 'B', plain: {} } }] });
      t.equal((await backend.load()).rows.tags.length, 1);
    },
  },
  {
    name: 'many writes in a row from two connections never lose or duplicate a record',
    async run({ backend, second }) {
      const other = await second();
      const wins = { a: 0, b: 0 };
      let version = null;
      for (let i = 0; i < 30; i += 1) {
        const mine = i % 2 === 0 ? backend : other;
        const theirs = i % 2 === 0 ? other : backend;
        const row = { id: `R${String(i).padStart(2, '0')}`, plain: { i } };
        const results = await Promise.allSettled([
          mine.commit({ expectVersion: version, ops: [{ op: 'put', store: 'tags', row }] }),
          theirs.commit({ expectVersion: version, ops: [{ op: 'put', store: 'tags', row: { id: `X${String(i).padStart(2, '0')}`, plain: { i } } }] }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        t.equal(fulfilled.length, 1, `round ${i}: exactly one write wins`);
        version = fulfilled[0].value;
        if (results[0].status === 'fulfilled') wins.a += 1; else wins.b += 1;
      }
      const loaded = await backend.load();
      t.equal(loaded.rows.tags.length, 30, 'One record per round');
      t.equal(loaded.version, version);
    },
  },
  {
    name: 'the real ledger store works on IndexedDB: protected data, reopening, tampering, two windows',
    async run({ backend, open }) {
      const sample = sampleLedger();
      const count = sample.expenses.length;
      const store = await LedgerStore.open(backend);
      await store.initializeNew(sample, { passcode: '482915', iterations: 100000 });
      await addExpense(store, '12.34');

      const text = JSON.stringify(await backend.load(), (key, value) => (value instanceof Uint8Array ? Array.from(value, (b) => String.fromCharCode(b)).join('') : value));
      for (const secret of ['Spinneys', 'Groceries', 'minorUnits', 'merchant', 'Reel Cinemas']) t.ok(!text.includes(secret), `${secret} must not be stored readable`);

      const reopened = await LedgerStore.open(await open());
      t.equal(reopened.state, 'locked');
      await t.rejectsCode(reopened.unlock('000000'), 'wrongPasscode');
      await reopened.unlock('482915');
      t.equal(reopened.snapshot.expenses.length, count + 1);

      // A second window that is behind is refused, and catches up when it reloads.
      await addExpense(reopened, '1');
      await t.rejectsCode(addExpense(store, '2'), 'conflict');
      await store.reload();
      t.equal(store.state, 'ready');
      t.equal(store.snapshot.expenses.length, count + 2);

      // Someone changes one sealed record directly in the storage.
      const loaded = await backend.load();
      const victim = loaded.rows.expenses[0];
      victim.sealed[20] ^= 1;
      await backend.commit({ expectVersion: loaded.version, ops: [{ op: 'put', store: 'expenses', row: victim }] });
      const tampered = await LedgerStore.open(await open());
      await tampered.unlock('482915');
      t.equal(tampered.unreadableCount, 1, 'The changed record is noticed');
      t.equal(tampered.snapshot.expenses.length, count + 1);
    },
  },
];

// Running ---------------------------------------------------------------------------------------------

async function main() {
  const results = [];
  for (const { name, run } of BACKEND_CONTRACT) {
    const started = performance.now();
    try {
      await inFreshDatabase(run);
      results.push({ name, ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      results.push({ name, ok: false, error: String(error && error.stack ? error.stack : error) });
    }
  }
  for (const { name, run } of BROWSER_ONLY) {
    const started = performance.now();
    try {
      await inFreshDatabase(run);
      results.push({ name: `browser only: ${name}`, ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      results.push({ name: `browser only: ${name}`, ok: false, error: String(error && error.stack ? error.stack : error) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  document.getElementById('out').textContent = [
    `${results.length - failed.length} of ${results.length} checks passed in ${navigator.userAgent}`,
    ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error}`}`),
  ].join('\n');
  window.__contractResults = { done: true, userAgent: navigator.userAgent, results };
}

main().catch((error) => {
  window.__contractResults = { done: true, fatal: String(error && error.stack ? error.stack : error), results: [] };
});
