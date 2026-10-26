// The key handling behind the passcode: the keyring, sealed records and the rules for choosing a passcode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectsWithCode, thrownCode } from './support.mjs';
import { base64ToBytes, bytesToBase64 } from '../docs/js/core/encoding.js';
import { PBKDF2_ITERATIONS } from '../docs/js/core/crypto.js';
import {
  KDF_NAME, KEYRING_VERSION, PASSCODE_PROBLEMS, STRENGTH_NOTES, checkNewPasscode, createKeyring, openKeyring, openRecord,
  parseKeyring, reprotect, sealRecord,
} from '../docs/js/core/vault.js';

// The real setting is 600,000 rounds; the tests use the smallest value the app accepts, to stay quick.
const FAST = { iterations: 100_000 };
const PASSCODE = '482915';

const sample = { id: 'A1', merchant: 'Café ☕ "Nero"', amount: { currencyCode: 'AED', minorUnits: 1250 } };

// The keyring ------------------------------------------------------------------------------------

test('the real number of rounds is the one the notes promise', () => {
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  assert.equal(KDF_NAME, 'PBKDF2-HMAC-SHA256');
});

test('a keyring opens with its passcode and the key it gives seals and opens records', async () => {
  const { keyring, dek } = await createKeyring(PASSCODE, FAST);
  const sealed = await sealRecord(dek, 'expenses', 'A1', sample);
  const again = await openKeyring(keyring, PASSCODE);
  assert.deepEqual(await openRecord(again, 'expenses', 'A1', sealed), sample);
});

test('a keyring keeps only what it must, in readable fields, and nothing secret', async () => {
  const { keyring } = await createKeyring(PASSCODE, FAST);
  assert.deepEqual(Object.keys(keyring).sort(), ['kdf', 'mode', 'version', 'wrapped']);
  assert.equal(keyring.mode, 'passcode');
  assert.equal(keyring.version, KEYRING_VERSION);
  assert.deepEqual(Object.keys(keyring.kdf).sort(), ['iterations', 'name', 'salt']);
  assert.equal(keyring.kdf.iterations, 100_000);
  assert.equal(base64ToBytes(keyring.kdf.salt).length, 16);
  // 12-byte nonce + 32-byte data key + 16-byte tag
  assert.equal(base64ToBytes(keyring.wrapped).length, 60);
  const text = JSON.stringify(keyring);
  assert.ok(!text.includes(PASSCODE));
  JSON.parse(text); // plain JSON, so it can be stored anywhere
});

test('a wrong passcode never opens the keyring', async () => {
  const { keyring } = await createKeyring(PASSCODE, FAST);
  for (const wrong of ['482916', '48291', '4829155', '', ' 482915', PASSCODE.split('').reverse().join('')]) {
    await rejectsWithCode(openKeyring(keyring, wrong), 'wrongPasscode');
  }
});

test('two keyrings for the same passcode are different', async () => {
  const a = await createKeyring(PASSCODE, FAST);
  const b = await createKeyring(PASSCODE, FAST);
  assert.notEqual(a.keyring.kdf.salt, b.keyring.kdf.salt);
  assert.notEqual(a.keyring.wrapped, b.keyring.wrapped);
  // ...and so are their data keys: a record sealed under one does not open under the other.
  const sealed = await sealRecord(a.dek, 'expenses', 'A1', sample);
  await rejectsWithCode(openRecord(b.dek, 'expenses', 'A1', sealed), 'cannotOpen');
});

test('a changed or damaged keyring is refused', async () => {
  const { keyring } = await createKeyring(PASSCODE, FAST);
  const clone = () => JSON.parse(JSON.stringify(keyring));

  // Changed bytes in the locked data key: it cannot be opened, so it looks like a wrong passcode.
  const flipped = base64ToBytes(keyring.wrapped);
  flipped[20] ^= 1;
  await rejectsWithCode(openKeyring({ ...clone(), wrapped: bytesToBase64(flipped) }, PASSCODE), 'wrongPasscode');

  // Changed settings are tied to the locked key, so they stop it from opening (or are refused as not valid).
  const slower = clone();
  slower.kdf.iterations = 100_001;
  await rejectsWithCode(openKeyring(slower, PASSCODE), 'wrongPasscode');
  const otherSalt = clone();
  otherSalt.kdf.salt = bytesToBase64(new Uint8Array(16));
  await rejectsWithCode(openKeyring(otherSalt, PASSCODE), 'wrongPasscode');

  const damaged = [
    null, undefined, 'text', 42, {}, { mode: 'none' },
    { ...clone(), mode: 'none' },
    { ...clone(), version: 2 },
    { ...clone(), kdf: null },
    { ...clone(), kdf: { ...keyring.kdf, name: 'MD5' } },
    { ...clone(), kdf: { ...keyring.kdf, iterations: 1 } },
    { ...clone(), kdf: { ...keyring.kdf, iterations: 99_999 } },
    { ...clone(), kdf: { ...keyring.kdf, iterations: 100_000_000 } },
    { ...clone(), kdf: { ...keyring.kdf, iterations: 'many' } },
    { ...clone(), kdf: { ...keyring.kdf, salt: '' } },
    { ...clone(), kdf: { ...keyring.kdf, salt: '***' } },
    { ...clone(), wrapped: '' },
    { ...clone(), wrapped: 'AAAA' },
    { ...clone(), wrapped: 12345 },
  ];
  for (const bad of damaged) {
    assert.equal(thrownCode(() => parseKeyring(bad)), 'damaged', JSON.stringify(bad));
    await rejectsWithCode(openKeyring(bad, PASSCODE), 'damaged');
  }
});

test('the data key cannot be read back out of the key object', async () => {
  const { dek } = await createKeyring(PASSCODE, FAST);
  assert.equal(dek.extractable, false);
  assert.deepEqual([...dek.usages].sort(), ['decrypt', 'encrypt']);
  assert.equal(dek.algorithm.name, 'AES-GCM');
  assert.equal(dek.algorithm.length, 256);
  await assert.rejects(globalThis.crypto.subtle.exportKey('raw', dek));
  const reopened = await openKeyring((await createKeyring(PASSCODE, FAST)).keyring, PASSCODE);
  assert.equal(reopened.extractable, false);
});

test('a passcode with unusual characters works, and an equivalent spelling opens it too', async () => {
  const typed = 'Pässwörd ☕ 密码 123';
  const { keyring, dek } = await createKeyring(typed, FAST);
  const sealed = await sealRecord(dek, 'tags', 'T1', { name: 'x' });
  const decomposed = typed.normalize('NFD');
  assert.notEqual(decomposed, typed);
  const opened = await openKeyring(keyring, decomposed);
  assert.deepEqual(await openRecord(opened, 'tags', 'T1', sealed), { name: 'x' });
});

// Changing the passcode --------------------------------------------------------------------------

test('changing the passcode needs the old one and makes a new data key', async () => {
  const first = await createKeyring(PASSCODE, FAST);
  const sealedBefore = await sealRecord(first.dek, 'expenses', 'A1', sample);

  await rejectsWithCode(reprotect(first.keyring, 'wrong one', 'newer passcode 77', FAST), 'wrongPasscode');

  const next = await reprotect(first.keyring, PASSCODE, 'newer passcode 77', FAST);
  assert.notEqual(next.keyring.wrapped, first.keyring.wrapped);
  assert.notEqual(next.keyring.kdf.salt, first.keyring.kdf.salt);

  // The new keyring opens only with the new passcode.
  await rejectsWithCode(openKeyring(next.keyring, PASSCODE), 'wrongPasscode');
  const reopened = await openKeyring(next.keyring, 'newer passcode 77');
  const sealedAfter = await sealRecord(next.dek, 'expenses', 'A1', sample);
  assert.deepEqual(await openRecord(reopened, 'expenses', 'A1', sealedAfter), sample);

  // The old data key is gone: old records do not open with the new key, and new records not with the old passcode's key.
  await rejectsWithCode(openRecord(reopened, 'expenses', 'A1', sealedBefore), 'cannotOpen');
  const oldKey = await openKeyring(first.keyring, PASSCODE);
  await rejectsWithCode(openRecord(oldKey, 'expenses', 'A1', sealedAfter), 'cannotOpen');
});

// Records ----------------------------------------------------------------------------------------

test('a sealed record reveals nothing and is different every time', async () => {
  const { dek } = await createKeyring(PASSCODE, FAST);
  const a = await sealRecord(dek, 'expenses', 'A1', sample);
  const b = await sealRecord(dek, 'expenses', 'A1', sample);
  assert.notDeepEqual(Array.from(a), Array.from(b), 'A new random nonce each time');
  const asText = Array.from(a, (byte) => String.fromCharCode(byte)).join('');
  for (const secret of ['Nero', 'minorUnits', 'AED', '1250']) assert.ok(!asText.includes(secret), secret);
  const textBytes = new TextEncoder().encode(JSON.stringify(sample)).length;
  assert.equal(a.length, 12 + textBytes + 16, 'nonce + the text as bytes + tag');
});

test('a sealed record only opens in its own place', async () => {
  const { dek } = await createKeyring(PASSCODE, FAST);
  const sealed = await sealRecord(dek, 'expenses', 'A1', sample);
  assert.deepEqual(await openRecord(dek, 'expenses', 'A1', sealed), sample);
  await rejectsWithCode(openRecord(dek, 'expenses', 'A2', sealed), 'cannotOpen');
  await rejectsWithCode(openRecord(dek, 'budgets', 'A1', sealed), 'cannotOpen');
});

test('a changed, cut or empty sealed record is refused', async () => {
  const { dek } = await createKeyring(PASSCODE, FAST);
  const sealed = await sealRecord(dek, 'expenses', 'A1', sample);
  for (const position of [0, 5, 12, 20, sealed.length - 1]) {
    const changed = Uint8Array.from(sealed);
    changed[position] ^= 1;
    await rejectsWithCode(openRecord(dek, 'expenses', 'A1', changed), 'cannotOpen');
  }
  await rejectsWithCode(openRecord(dek, 'expenses', 'A1', sealed.slice(0, -1)), 'cannotOpen');
  await rejectsWithCode(openRecord(dek, 'expenses', 'A1', new Uint8Array(0)), 'cannotOpen');
  await rejectsWithCode(openRecord(dek, 'expenses', 'A1', new Uint8Array(20)), 'cannotOpen');
  await rejectsWithCode(openRecord(dek, 'expenses', 'A1', 'not bytes'), 'cannotOpen');
});

test('large and awkward records round trip', async () => {
  const { dek } = await createKeyring(PASSCODE, FAST);
  const big = { notes: 'x'.repeat(100_000), text: 'سوبرماركت\n\t"quoted" \u0000 ☕ 😀', list: Array.from({ length: 500 }, (_, i) => i) };
  assert.deepEqual(await openRecord(dek, 'expenses', 'big', await sealRecord(dek, 'expenses', 'big', big)), big);
});

// Choosing a passcode ----------------------------------------------------------------------------

test('passcodes that are too short, repeated, a run or very common are refused', () => {
  const problem = (text) => {
    const result = checkNewPasscode(text);
    return result.ok ? null : result.problem;
  };
  assert.equal(problem(''), 'empty');
  assert.equal(problem('   '), 'empty');
  assert.equal(problem(undefined), 'empty');
  assert.equal(problem(123456), 'empty');
  assert.equal(problem('12345'), 'tooShort');
  assert.equal(problem('4829'), 'tooShort');
  assert.equal(problem('abc12'), 'tooShort');
  assert.equal(problem('abcdefg'), 'tooShort');
  assert.equal(problem('111111'), 'repeated');
  assert.equal(problem('aaaaaaaa'), 'repeated');
  assert.equal(problem('123456'), 'sequence');
  assert.equal(problem('654321'), 'sequence');
  assert.equal(problem('45678901'), 'sequence');
  assert.equal(problem('112233'), 'common');
  assert.equal(problem('696969'), 'common');
  assert.equal(problem('482916'), null);
  assert.equal(problem('abcd efgh'), null);
  for (const key of Object.keys(PASSCODE_PROBLEMS)) assert.ok(PASSCODE_PROBLEMS[key].length > 10);
});

test('the strength of a passcode is described honestly', () => {
  const strength = (text) => checkNewPasscode(text).strength;
  assert.equal(strength('482915'), 'basic');
  assert.equal(strength('4829153'), 'basic');
  assert.equal(strength('48291537'), 'fair');
  assert.equal(strength('4829153704'), 'good');
  assert.equal(strength('abcdefgh'), 'fair');
  assert.equal(strength('Sunny day 9'), 'good');
  assert.equal(strength('correct horse battery'), 'strong');
  assert.equal(checkNewPasscode('482915').kind, 'digits');
  assert.equal(checkNewPasscode('abcd efgh').kind, 'text');
  for (const key of ['basic', 'fair', 'good', 'strong']) assert.ok(STRENGTH_NOTES[key]);
  assert.ok(STRENGTH_NOTES.basic.includes('every combination'), 'The weak case says why it is weak');
});

test('a passcode is used exactly as typed, including spaces', () => {
  assert.equal(checkNewPasscode('  correct horse  ').ok, true);
});
