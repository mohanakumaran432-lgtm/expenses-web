// The in-memory backend against the shared rules every backend must follow, plus its own test helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeAssertions, rejectsWithCode } from './support.mjs';
import { BACKEND_CONTRACT } from './backend_contract.mjs';
import { MemoryBackend } from '../docs/js/data/backend_memory.js';

for (const { name, run } of BACKEND_CONTRACT) {
  test(`memory backend: ${name}`, async () => {
    const backend = new MemoryBackend();
    await run({ backend, second: async () => backend }, nodeAssertions);
  });
}

// Behaviour of the test helpers themselves (the ledger-store tests rely on them) -------------------------------

const row = (id) => ({ id, plain: { name: id } });

test('memory backend: the next write can be made to fail, and the one after works', async () => {
  const backend = new MemoryBackend();
  const version = await backend.commit({ expectVersion: null, ops: [{ op: 'put', store: 'tags', row: row('A') }] });
  for (const code of ['failed', 'full', 'unavailable']) {
    backend.failNext = code;
    await rejectsWithCode(backend.commit({ expectVersion: version, ops: [{ op: 'put', store: 'tags', row: row('B') }] }), code);
    assert.equal((await backend.load()).rows.tags.length, 1, 'nothing changed');
  }
  assert.equal(backend.commitCount, 1);
  await backend.commit({ expectVersion: version, ops: [{ op: 'put', store: 'tags', row: row('B') }] });
  assert.equal(backend.commitCount, 2);
});

test('memory backend: reads and small writes can be made to fail', async () => {
  const backend = new MemoryBackend();
  backend.failLoad = true;
  await rejectsWithCode(backend.load(), 'unavailable');
  await rejectsWithCode(backend.getMeta('lock'), 'unavailable');
  backend.failLoad = false;
  backend.failMeta = true;
  await rejectsWithCode(backend.putMeta('lock', {}), 'failed');
  await rejectsWithCode(backend.deleteMeta('lock'), 'failed');
  backend.failMeta = false;
  await backend.putMeta('lock', { timeout: 0 });
  assert.deepEqual(await backend.getMeta('lock'), { timeout: 0 });
});

test('memory backend: dump shows plain text, and bytes as characters, so a leak can be searched for', async () => {
  const backend = new MemoryBackend();
  const bytes = Uint8Array.from(Array.from('Spinneys', (c) => c.charCodeAt(0)));
  await backend.commit({
    expectVersion: null,
    ops: [{ op: 'put', store: 'tags', row: { id: 'A', plain: { name: 'Carrefour' } } }, { op: 'put', store: 'tags', row: { id: 'B', sealed: bytes } }],
  });
  const text = backend.dump();
  assert.ok(text.includes('Carrefour'));
  assert.ok(text.includes('Spinneys'));
});

test('memory backend: the raw helpers change storage without the version changing', async () => {
  const backend = new MemoryBackend();
  const version = await backend.commit({ expectVersion: null, ops: [{ op: 'put', store: 'tags', row: row('A') }] });
  backend.rawPut('tags', { id: 'A', plain: { name: 'edited' } });
  backend.rawDelete('tags', 'Z');
  backend.rawPutMeta('lock', { timeout: 900 });
  assert.equal(backend.rawRow('tags', 'A').plain.name, 'edited');
  assert.equal(backend.rawRow('tags', 'Z'), null);
  assert.equal(backend.rawRows('tags').length, 1);
  assert.deepEqual(backend.rawMeta('lock'), { timeout: 900 });
  assert.equal((await backend.load()).version, version);
});
