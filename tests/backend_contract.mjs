// The rules every storage backend must follow. The same list runs against the in-memory backend (in Node) and against the
// real IndexedDB backend (in a browser), so the tests that use the in-memory one say something true about the real one.
//
// Each case is { name, run(env, t) }.
//   env.backend    a fresh, empty backend
//   env.second()   another connection to the SAME storage (a second window of the app)
//   t              ok(value, message), equal(a, b, message), deepEqual(a, b, message), rejectsCode(promise, code, message)

import { META_KEYS, ROW_STORES } from '../docs/js/data/stores.js';

const row = (id, extra = {}) => ({ id, plain: { name: id, ...extra } });
const put = (store, aRow) => ({ op: 'put', store, row: aRow });
const del = (store, id) => ({ op: 'delete', store, id });
const clear = (store) => ({ op: 'clear', store });
const ids = (loaded, store) => loaded.rows[store].map((r) => r.id).sort();

export const BACKEND_CONTRACT = [
  {
    name: 'a new storage is empty',
    async run({ backend }, t) {
      const loaded = await backend.load();
      t.equal(loaded.version, null, 'no version yet');
      t.deepEqual(loaded.meta, {});
      for (const name of ROW_STORES) t.deepEqual(loaded.rows[name], [], `${name} starts empty`);
      const light = await backend.load({ rows: false });
      t.equal(light.version, null);
      t.deepEqual(light.rows, {}, 'rows are left out when not asked for');
    },
  },
  {
    name: 'a write stores its rows and values, and gives a version',
    async run({ backend }, t) {
      const version = await backend.commit({
        expectVersion: null,
        ops: [put('expenses', row('E1', { merchant: 'Café ☕' })), put('tags', row('T1'))],
        meta: { format: { schema: 1 } },
      });
      t.equal(typeof version, 'string');
      t.ok(version.length >= 16, 'a long random version');
      const loaded = await backend.load();
      t.equal(loaded.version, version);
      t.deepEqual(loaded.rows.expenses, [row('E1', { merchant: 'Café ☕' })]);
      t.deepEqual(loaded.rows.tags, [row('T1')]);
      t.deepEqual(loaded.meta, { format: { schema: 1 } });
      const light = await backend.load({ rows: false });
      t.equal(light.version, version);
      t.deepEqual(light.meta, { format: { schema: 1 } });
    },
  },
  {
    name: 'every write gives a different version, even one with nothing in it',
    async run({ backend }, t) {
      const a = await backend.commit({ expectVersion: null, ops: [put('tags', row('A'))] });
      const b = await backend.commit({ expectVersion: a, ops: [put('tags', row('B'))] });
      const c = await backend.commit({ expectVersion: b });
      t.ok(a !== b && b !== c && a !== c);
      t.equal((await backend.load()).version, c);
    },
  },
  {
    name: 'a write that expects the wrong version is refused and changes nothing',
    async run({ backend }, t) {
      const version = await backend.commit({ expectVersion: null, ops: [put('tags', row('A'))], meta: { format: { schema: 1 } } });
      await t.rejectsCode(
        backend.commit({ expectVersion: 'not the version', ops: [put('tags', row('B')), del('tags', 'A')], meta: { keyring: { x: 1 } } }),
        'conflict',
      );
      await t.rejectsCode(backend.commit({ expectVersion: null, ops: [put('tags', row('C'))] }), 'conflict', 'null is wrong once data exists');
      const loaded = await backend.load();
      t.deepEqual(ids(loaded, 'tags'), ['A']);
      t.deepEqual(loaded.meta, { format: { schema: 1 } });
      t.equal(loaded.version, version);
    },
  },
  {
    name: 'a first write that expects an existing version is refused',
    async run({ backend }, t) {
      await t.rejectsCode(backend.commit({ expectVersion: 'abc', ops: [put('tags', row('A'))] }), 'conflict');
      t.deepEqual(ids(await backend.load(), 'tags'), []);
    },
  },
  {
    name: 'two writers that expect the same version: exactly one wins',
    async run({ backend, second }, t) {
      const first = await backend.commit({ expectVersion: null, ops: [put('tags', row('A'))] });
      const other = await second();
      const results = await Promise.allSettled([
        backend.commit({ expectVersion: first, ops: [put('tags', row('B'))] }),
        other.commit({ expectVersion: first, ops: [put('tags', row('C'))] }),
      ]);
      t.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'one write succeeded');
      const loser = results.find((r) => r.status === 'rejected');
      t.equal(loser.reason.code, 'conflict', 'the other was told so');
      const stored = ids(await backend.load(), 'tags');
      t.equal(stored.length, 2);
      t.equal(stored[0], 'A');
      t.ok(stored[1] === 'B' || stored[1] === 'C', 'only the winner is stored');
    },
  },
  {
    name: 'a problem in the middle of a write undoes the whole write',
    async run({ backend }, t) {
      const version = await backend.commit({ expectVersion: null, ops: [put('tags', row('A'))], meta: { format: { schema: 1 } } });
      await t.rejectsCode(
        backend.commit({
          expectVersion: version,
          ops: [put('tags', row('B')), del('tags', 'A'), put('nonsense', row('X'))],
          meta: { keyring: { x: 1 } },
        }),
        'failed',
      );
      const loaded = await backend.load();
      t.deepEqual(ids(loaded, 'tags'), ['A'], 'the earlier steps were undone');
      t.deepEqual(loaded.meta, { format: { schema: 1 } });
      t.equal(loaded.version, version);
      // ...and the storage still works afterwards.
      await backend.commit({ expectVersion: version, ops: [put('tags', row('B'))] });
      t.deepEqual(ids(await backend.load(), 'tags'), ['A', 'B']);
    },
  },
  {
    name: 'a row without an id is refused as a whole',
    async run({ backend }, t) {
      const version = await backend.commit({ expectVersion: null, ops: [put('tags', row('A'))] });
      await t.rejectsCode(backend.commit({ expectVersion: version, ops: [put('tags', row('B')), put('tags', { plain: { name: 'no id' } })] }), 'failed');
      t.deepEqual(ids(await backend.load(), 'tags'), ['A']);
    },
  },
  {
    name: 'the version name is reserved',
    async run({ backend }, t) {
      await t.rejectsCode(backend.commit({ expectVersion: null, ops: [], meta: { version: 'mine' } }), 'failed');
      await t.rejectsCode(backend.putMeta('version', 'mine'), 'failed');
      await t.rejectsCode(backend.deleteMeta('version'), 'failed');
      t.equal((await backend.load()).version, null);
    },
  },
  {
    name: 'steps run in the order given',
    async run({ backend }, t) {
      let version = await backend.commit({ expectVersion: null, ops: [put('tags', row('A')), put('tags', row('B'))] });
      version = await backend.commit({ expectVersion: version, ops: [put('tags', row('C')), del('tags', 'C')] });
      t.deepEqual(ids(await backend.load(), 'tags'), ['A', 'B'], 'put then delete: gone');
      version = await backend.commit({ expectVersion: version, ops: [del('tags', 'A'), put('tags', row('A', { again: true }))] });
      const loaded = await backend.load();
      t.deepEqual(ids(loaded, 'tags'), ['A', 'B'], 'delete then put: present');
      t.deepEqual(loaded.rows.tags.find((r) => r.id === 'A').plain, { name: 'A', again: true });
      version = await backend.commit({ expectVersion: version, ops: [clear('tags'), put('tags', row('Z'))] });
      t.deepEqual(ids(await backend.load(), 'tags'), ['Z'], 'clear then put: only the new row');
      await backend.commit({ expectVersion: version, ops: [del('tags', 'missing')] });
    },
  },
  {
    name: 'putting a row with an existing id replaces it',
    async run({ backend }, t) {
      const version = await backend.commit({ expectVersion: null, ops: [put('budgets', row('B1', { value: 1 }))] });
      await backend.commit({ expectVersion: version, ops: [put('budgets', row('B1', { value: 2 }))] });
      const loaded = await backend.load();
      t.equal(loaded.rows.budgets.length, 1);
      t.equal(loaded.rows.budgets[0].plain.value, 2);
    },
  },
  {
    name: 'small values can be written with a record write, and removed by writing null',
    async run({ backend }, t) {
      let version = await backend.commit({ expectVersion: null, meta: { keyring: { a: 1 }, format: { schema: 1 } } });
      t.deepEqual((await backend.load()).meta, { keyring: { a: 1 }, format: { schema: 1 } });
      version = await backend.commit({ expectVersion: version, meta: { keyring: null } });
      t.deepEqual((await backend.load()).meta, { format: { schema: 1 } });
      await backend.commit({ expectVersion: version, meta: { missing: null } });
    },
  },
  {
    name: 'small values written on their own do not touch the version or the records',
    async run({ backend }, t) {
      const version = await backend.commit({ expectVersion: null, ops: [put('tags', row('A'))] });
      t.equal(await backend.getMeta('lock'), null, 'a missing value is null');
      await backend.putMeta('lock', { timeout: 60 });
      await backend.putMeta('attempts', { failedAttempts: 2, lockedUntil: 0 });
      t.deepEqual(await backend.getMeta('lock'), { timeout: 60 });
      const loaded = await backend.load();
      t.equal(loaded.version, version, 'the version did not change');
      t.deepEqual(loaded.meta, { lock: { timeout: 60 }, attempts: { failedAttempts: 2, lockedUntil: 0 } });
      // So a record write that expects that version still works.
      await backend.commit({ expectVersion: version, ops: [put('tags', row('B'))] });
      await backend.deleteMeta('lock');
      t.equal(await backend.getMeta('lock'), null);
      t.deepEqual(Object.keys((await backend.load()).meta), ['attempts']);
    },
  },
  {
    name: 'what is stored is a copy: changing an object after saving or loading it changes nothing',
    async run({ backend }, t) {
      const mine = row('E1', { nested: { list: [1, 2, 3] } });
      const version = await backend.commit({ expectVersion: null, ops: [put('expenses', mine)], meta: { format: { schema: 1 } } });
      mine.plain.nested.list.push(4);
      mine.plain.name = 'changed';
      const loaded = await backend.load();
      t.deepEqual(loaded.rows.expenses[0].plain, { name: 'E1', nested: { list: [1, 2, 3] } });
      loaded.rows.expenses[0].plain.nested.list.length = 0;
      loaded.meta.format.schema = 99;
      const again = await backend.load();
      t.deepEqual(again.rows.expenses[0].plain.nested.list, [1, 2, 3]);
      t.deepEqual(again.meta, { format: { schema: 1 } });
      t.equal(again.version, version);
    },
  },
  {
    name: 'bytes come back exactly as they went in',
    async run({ backend }, t) {
      const bytes = new Uint8Array(1000);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
      await backend.commit({ expectVersion: null, ops: [put('expenses', { id: 'E1', sealed: bytes })] });
      const stored = (await backend.load()).rows.expenses[0];
      t.ok(stored.sealed instanceof Uint8Array, 'still bytes');
      t.equal(stored.sealed.length, 1000);
      t.deepEqual(Array.from(stored.sealed), Array.from(bytes));
    },
  },
  {
    name: 'text of every kind round trips',
    async run({ backend }, t) {
      const awkward = { text: 'سوبرماركت — 日本語 — 😀 — "quoted" — \\ — \n\t — \u0000 — é', empty: '', zero: 0, flag: false, nothing: null, list: [] };
      await backend.commit({ expectVersion: null, ops: [put('settings', { id: 'settings', plain: awkward })] });
      t.deepEqual((await backend.load()).rows.settings[0].plain, awkward);
    },
  },
  {
    name: 'a large write is stored whole',
    async run({ backend }, t) {
      const ops = [];
      for (let i = 0; i < 5000; i += 1) ops.push(put('expenses', row(`E${String(i).padStart(5, '0')}`, { amount: i })));
      await backend.commit({ expectVersion: null, ops });
      const loaded = await backend.load();
      t.equal(loaded.rows.expenses.length, 5000);
      t.equal(loaded.rows.expenses.reduce((sum, r) => sum + r.plain.amount, 0), (4999 * 5000) / 2);
    },
  },
  {
    name: 'a second connection sees what the first one wrote',
    async run({ backend, second }, t) {
      const version = await backend.commit({ expectVersion: null, ops: [put('tags', row('A'))], meta: { format: { schema: 1 } } });
      const other = await second();
      const loaded = await other.load();
      t.equal(loaded.version, version);
      t.deepEqual(ids(loaded, 'tags'), ['A']);
      await other.putMeta('lock', { timeout: 300 });
      t.deepEqual(await backend.getMeta('lock'), { timeout: 300 });
    },
  },
  {
    name: 'erasing removes everything, including the version',
    async run({ backend }, t) {
      const version = await backend.commit({
        expectVersion: null,
        ops: [put('expenses', row('E1')), put('settings', row('settings'))],
        meta: { format: { schema: 1 }, keyring: { a: 1 } },
      });
      await backend.putMeta('lock', { timeout: 60 });
      await backend.putMeta('attempts', { failedAttempts: 3, lockedUntil: 1 });
      await backend.eraseAll();
      const loaded = await backend.load();
      t.equal(loaded.version, null);
      t.deepEqual(loaded.meta, {});
      for (const name of ROW_STORES) t.deepEqual(loaded.rows[name], [], name);
      await t.rejectsCode(backend.commit({ expectVersion: version, ops: [put('tags', row('A'))] }), 'conflict', 'the old version is gone');
      await backend.commit({ expectVersion: null, ops: [put('tags', row('A'))] });
      t.deepEqual(ids(await backend.load(), 'tags'), ['A'], 'it can be used again');
    },
  },
  {
    name: 'every record store exists and keeps its rows apart',
    async run({ backend }, t) {
      const ops = ROW_STORES.map((name) => put(name, row('same-id', { store: name })));
      await backend.commit({ expectVersion: null, ops });
      const loaded = await backend.load();
      for (const name of ROW_STORES) {
        t.equal(loaded.rows[name].length, 1, name);
        t.equal(loaded.rows[name][0].plain.store, name);
      }
      t.equal(Object.keys(loaded.rows).length, ROW_STORES.length);
      t.ok(!(META_KEYS.version in loaded.meta));
    },
  },
];
