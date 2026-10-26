// How the browser database's failures are reported. (The real database is exercised in tests/browser/; these checks use
// stand-ins for the failures a real one is hard to make produce on purpose.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectsWithCode } from './support.mjs';
import { IndexedDbBackend, mapStorageError } from '../docs/js/data/backend_indexeddb.js';
import { AppError } from '../docs/js/core/util.js';
import { STORAGE_MESSAGES } from '../docs/js/data/stores.js';

test('running out of room is reported as "full", with advice that does not lose data', () => {
  const error = mapStorageError(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
  assert.equal(error.code, 'full');
  assert.equal(error.kind, 'storage');
  assert.equal(error.message, STORAGE_MESSAGES.full);
  assert.ok(error.message.includes('Nothing was changed'));
});

test('a browser that refuses storage is reported as unavailable', () => {
  for (const name of ['SecurityError', 'NotSupportedError']) {
    assert.equal(mapStorageError(new DOMException('no', name)).code, 'unavailable', name);
  }
});

test('anything else is a failed save that names only the kind of error, never its text', () => {
  const error = mapStorageError(new DOMException('contains Spinneys and 42.50', 'DataError'));
  assert.equal(error.code, 'failed');
  assert.deepEqual(error.details, { name: 'DataError' });
  assert.ok(!JSON.stringify(error.details).includes('Spinneys'));
  assert.ok(!error.message.includes('Spinneys'));
  assert.equal(mapStorageError(new Error('boom')).details.name, 'Error');
  assert.equal(mapStorageError('text').code, 'failed');
  assert.equal(mapStorageError(null).code, 'failed');
  assert.equal(mapStorageError(undefined).details.name, 'Error');
});

test('an error the app already made passes through unchanged', () => {
  const own = new AppError('storage', 'conflict', 'x');
  assert.equal(mapStorageError(own), own);
});

test('opening without any database support is reported as unavailable', async () => {
  await rejectsWithCode(IndexedDbBackend.open({ factory: undefined }), 'unavailable');
  await rejectsWithCode(IndexedDbBackend.open({ factory: null }), 'unavailable');
});

test('a database that throws while opening (private browsing, blocked storage) is reported as unavailable', async () => {
  const throwing = { open() { throw new DOMException('denied', 'SecurityError'); } };
  await rejectsWithCode(IndexedDbBackend.open({ factory: throwing }), 'unavailable');
});

test('a database that fails to open through its error event is reported, and can be tried again', async () => {
  let attempts = 0;
  const failing = {
    open() {
      attempts += 1;
      const request = {};
      queueMicrotask(() => {
        request.error = new DOMException('denied', 'SecurityError');
        request.onerror({ preventDefault() {} });
      });
      return request;
    },
  };
  await rejectsWithCode(IndexedDbBackend.open({ factory: failing }), 'unavailable');
  await rejectsWithCode(IndexedDbBackend.open({ factory: failing }), 'unavailable');
  assert.equal(attempts, 2, 'A failed attempt is not remembered');
});

test('the messages the person sees are plain and say whether anything changed', () => {
  for (const code of ['unavailable', 'full', 'conflict', 'failed', 'newerVersion', 'unrecognized', 'locked', 'empty', 'unreadableRecords']) {
    assert.ok(STORAGE_MESSAGES[code].length > 20, code);
    assert.ok(/[.]$/.test(STORAGE_MESSAGES[code]), `${code} ends like a sentence`);
  }
  assert.ok(STORAGE_MESSAGES.failed.includes('Nothing was changed'));
  assert.ok(STORAGE_MESSAGES.conflict.includes('not saved'));
});
