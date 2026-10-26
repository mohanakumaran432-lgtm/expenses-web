import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, utf8Encode, bytesToBase64, base64ToBytes, stableStringify } from '../docs/js/core/encoding.js';

// The backup checksum is only trustworthy if SHA-256 is right, so it is checked against published test vectors and
// against digests produced independently with Python's hashlib. (The app uses the browser's own implementation.)

const pattern = (count) => Uint8Array.from({ length: count }, (_, i) => (i * 7 + 3) % 251);

test('published vectors', async () => {
  assert.equal(await sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex(utf8Encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('one million letter a', async () => {
  const data = new Uint8Array(1_000_000).fill(0x61);
  assert.equal(await sha256Hex(data), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('lengths around the block and padding boundaries', async () => {
  const expected = {
    1: '084fed08b978af4d7d196a7446a86b58009e636b611db16211b65a9aadff29c5',
    55: '1deace58c745f3ecadde68a5923f494c3703fa73f0306483ccb898a5826e8d70',
    56: '06dbe23685750e4d3881ded95047abaf93fa8f9c5d3501dc57c717a72ff1398e',
    57: '011f4bced20a249afb834d24b3e4eca31ad5ea2bdd1d8a1a564c2d2410398e69',
    63: '47fb38b12335c9298d09280515c0666489a189d1554bb0ac1a0740806ce9d8b6',
    64: 'dfa798724b1a8014994f363e5da7474ed26ce3757fb29e07aa47ad5a9352d37b',
    65: 'dd2eab5a5507d7717c63ce953d9ac61752c21e664425ad1227054722a0d97f69',
    119: 'c6e0f435df5d7d265baacca31e0602c00aa22fa6d3819aed664649294c743756',
    120: '17eb8960823a644bde3065620bb9d45931fe8993fd8eb692a17aff0fd725db6a',
    128: '3a9c1e22e20578eebe442238f431befd688bd56698eb7c77d95d3f97d8f58207',
    1000: 'a9425c416f534025a4e2422bd14adba4ec3d4a68d10c3329be8df612964d2b6e',
  };
  for (const [count, digest] of Object.entries(expected)) {
    assert.equal(await sha256Hex(pattern(Number(count))), digest, `length ${count}`);
  }
});

test('output shape', async () => {
  const hex = await sha256Hex(pattern(10));
  assert.equal(hex.length, 64);
  assert.equal(hex, hex.toLowerCase());
});

test('any single changed byte changes the digest', async () => {
  const original = pattern(500);
  const reference = await sha256Hex(original);
  const digests = new Set();
  for (const position of [0, 1, 63, 64, 250, 499]) {
    const copy = original.slice();
    copy[position] ^= 0x01;
    const digest = await sha256Hex(copy);
    assert.notEqual(digest, reference, `Changing byte ${position} must change the digest`);
    digests.add(digest);
  }
  assert.equal(digests.size, 6);
});

test('base64 round trip is strict', () => {
  const bytes = pattern(1000);
  const text = bytesToBase64(bytes);
  assert.deepEqual(base64ToBytes(text), bytes);
  assert.equal(base64ToBytes(`${text}!`), null);
  assert.equal(base64ToBytes('abc'), null, 'Length must be a multiple of four');
  assert.equal(base64ToBytes('ab=c'), null, 'Padding only at the end');
  assert.deepEqual(base64ToBytes(''), new Uint8Array());
});

test('stable JSON sorts keys at every level', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } }), '{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}');
});
