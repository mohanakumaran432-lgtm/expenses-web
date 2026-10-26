// The key handling behind the passcode.
//
// How the data is protected, in plain words:
// - The data is locked with one random 256-bit key (the "data key"). It is made once and never typed by anyone.
// - The passcode does not lock the data directly. It is stretched (PBKDF2-HMAC-SHA-256, 600,000 rounds, random salt)
//   into a second key, and THAT key locks the data key. The stored "keyring" holds only the salt, the settings and the
//   locked data key. A wrong passcode cannot unlock it; any changed byte makes opening fail.
// - Every stored record is sealed separately with AES-256-GCM, tied to its own place (store name and id), so a record
//   cannot be swapped with another one or copied elsewhere without being noticed.
// - Changing the passcode makes a NEW data key and re-seals everything, so an old copy of the keyring plus the old
//   passcode never opens data saved afterwards.
//
// All of it uses only the browser's own WebCrypto. Nothing here knows about IndexedDB or the screen.

import { AppError, characterCount } from './util.js';
import { base64ToBytes, bytesToBase64, randomBytes, utf8Decode, utf8Encode } from './encoding.js';
import {
  MAX_ACCEPTED_ITERATIONS, MIN_ACCEPTED_ITERATIONS, PBKDF2_ITERATIONS, SALT_BYTES, deriveKey, importDataKey, open, seal, wipe,
} from './crypto.js';

export const KEYRING_VERSION = 1;
export const KDF_NAME = 'PBKDF2-HMAC-SHA256';
const DATA_KEY_BYTES = 32;

export const VAULT_MESSAGES = Object.freeze({
  wrongPasscode: 'That passcode is not right.',
  damaged: 'The protection information for this data is damaged, so it cannot be opened. Restore from a backup file.',
  unreadableRecord: 'A saved record could not be opened.',
});

function vaultError(code, message) {
  return new AppError('vault', code, message || VAULT_MESSAGES[code]);
}

// What the encryption is bound to ----------------------------------------------------------------------

function keyringAAD(kdf) {
  return utf8Encode(`keyring|v${KEYRING_VERSION}|${kdf.name}|${kdf.iterations}`);
}

function recordAAD(storeName, id) {
  return utf8Encode(`record|v${KEYRING_VERSION}|${storeName}|${id}`);
}

// The keyring ------------------------------------------------------------------------------------------

/**
 * Reads a stored keyring strictly. Throws AppError('vault', 'damaged') for anything that is not exactly what
 * createKeyring writes. Returns { kdf, salt, wrapped } with the bytes decoded.
 */
export function parseKeyring(raw) {
  const kdf = raw && raw.kdf;
  if (!raw || typeof raw !== 'object' || raw.mode !== 'passcode' || raw.version !== KEYRING_VERSION
    || !kdf || typeof kdf !== 'object' || kdf.name !== KDF_NAME
    || !Number.isSafeInteger(kdf.iterations) || kdf.iterations < MIN_ACCEPTED_ITERATIONS || kdf.iterations > MAX_ACCEPTED_ITERATIONS) {
    throw vaultError('damaged');
  }
  const salt = base64ToBytes(kdf.salt);
  const wrapped = base64ToBytes(raw.wrapped);
  if (salt === null || salt.length < 8 || wrapped === null || wrapped.length < 12 + DATA_KEY_BYTES + 16) throw vaultError('damaged');
  return { kdf: { name: kdf.name, iterations: kdf.iterations, salt: kdf.salt }, salt, wrapped };
}

/**
 * Makes a new data key and locks it with the passcode.
 * Returns { keyring, dek }: `keyring` is what gets stored; `dek` is the key to use right now (it cannot be read back out).
 */
export async function createKeyring(passcode, { iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = randomBytes(SALT_BYTES);
  const raw = randomBytes(DATA_KEY_BYTES);
  try {
    const kek = await deriveKey(passcode, salt, iterations);
    const kdf = { name: KDF_NAME, iterations, salt: bytesToBase64(salt) };
    const wrapped = await seal(kek, raw, keyringAAD(kdf));
    const dek = await importDataKey(raw);
    return {
      keyring: { mode: 'passcode', version: KEYRING_VERSION, kdf, wrapped: bytesToBase64(wrapped) },
      dek,
    };
  } finally {
    wipe(raw);
  }
}

/** Unlocks the data key with the passcode. Throws AppError('vault', 'wrongPasscode') when the passcode is wrong. */
export async function openKeyring(keyring, passcode) {
  const { kdf, salt, wrapped } = parseKeyring(keyring);
  const kek = await deriveKey(passcode, salt, kdf.iterations);
  let raw;
  try {
    raw = await open(kek, wrapped, keyringAAD(kdf));
  } catch {
    throw vaultError('wrongPasscode');
  }
  try {
    if (raw.length !== DATA_KEY_BYTES) throw vaultError('damaged');
    return await importDataKey(raw);
  } finally {
    wipe(raw);
  }
}

/**
 * Checks the current passcode, then makes a brand-new keyring (new salt, NEW data key) for the next one.
 * The caller must re-seal every record with the returned `dek` before storing the keyring.
 */
export async function reprotect(keyring, currentPasscode, nextPasscode, options) {
  await openKeyring(keyring, currentPasscode); // throws wrongPasscode
  return createKeyring(nextPasscode, options);
}

// Records ----------------------------------------------------------------------------------------------

/** Seals one JSON-ready record. Returns bytes (nonce, ciphertext and tag together). */
export function sealRecord(dek, storeName, id, wire) {
  return seal(dek, utf8Encode(JSON.stringify(wire)), recordAAD(storeName, id));
}

/** Opens a sealed record. Throws AppError('crypto', 'cannotOpen') if it was changed or belongs elsewhere. */
export async function openRecord(dek, storeName, id, bytes) {
  const plain = await open(dek, bytes, recordAAD(storeName, id));
  try {
    return JSON.parse(utf8Decode(plain));
  } catch {
    throw vaultError('unreadableRecord');
  }
}

// Choosing a passcode ----------------------------------------------------------------------------------

export const MIN_PASSCODE_DIGITS = 6;
export const MIN_PASSPHRASE_CHARACTERS = 8;

const COMMON_DIGITS = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '654321', '123123', '112233', '121212', '696969', '159753',
  '789456', '102030', '010203', '202020', '101010', '123321', '111222', '121314', '147258', '741852', '246810', '135790',
  '987654', '123654', '1q2w3e', '000000', '520520', '555555', '666666', '777777', '888888', '999999', '222222', '333333',
  '444444', '111111',
]);

function isStraightRun(digits) {
  let up = true;
  let down = true;
  for (let i = 1; i < digits.length; i += 1) {
    const step = digits.charCodeAt(i) - digits.charCodeAt(i - 1);
    if (step !== 1 && !(digits[i - 1] === '9' && digits[i] === '0')) up = false;
    if (step !== -1 && !(digits[i - 1] === '0' && digits[i] === '9')) down = false;
  }
  return up || down;
}

export const PASSCODE_PROBLEMS = Object.freeze({
  empty: 'Enter a passcode.',
  tooShort: `Use at least ${MIN_PASSCODE_DIGITS} digits, or letters and numbers with at least ${MIN_PASSPHRASE_CHARACTERS} characters.`,
  repeated: 'Choose something less predictable than one repeated character.',
  sequence: 'Choose something less predictable than a run of numbers like 123456.',
  common: 'That passcode is one of the most commonly guessed. Choose another.',
});

export const STRENGTH_NOTES = Object.freeze({
  basic: 'Quick to type, but if someone copied your stored data they could try every combination on a fast computer. A longer passcode is stronger.',
  fair: 'Reasonable for everyday privacy. Longer, or with letters and numbers, is stronger.',
  good: 'A good passcode.',
  strong: 'A strong passcode.',
});

/**
 * Judges a passcode the person wants to set. Returns { ok: true, kind, strength } or { ok: false, problem } where
 * `problem` is a key of PASSCODE_PROBLEMS. The passcode is used exactly as typed (nothing is trimmed).
 */
export function checkNewPasscode(passcode) {
  if (typeof passcode !== 'string' || passcode.trim() === '') return { ok: false, problem: 'empty' };
  const digitsOnly = /^[0-9]+$/.test(passcode);
  const length = characterCount(passcode);
  if (digitsOnly) {
    if (length < MIN_PASSCODE_DIGITS) return { ok: false, problem: 'tooShort' };
    if (/^(\d)\1+$/.test(passcode)) return { ok: false, problem: 'repeated' };
    if (isStraightRun(passcode)) return { ok: false, problem: 'sequence' };
    if (COMMON_DIGITS.has(passcode)) return { ok: false, problem: 'common' };
    const strength = length >= 10 ? 'good' : length >= 8 ? 'fair' : 'basic';
    return { ok: true, kind: 'digits', strength };
  }
  if (length < MIN_PASSPHRASE_CHARACTERS) return { ok: false, problem: 'tooShort' };
  if (new Set(Array.from(passcode)).size === 1) return { ok: false, problem: 'repeated' };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(passcode)).length;
  let strength = 'fair';
  if (length >= 14) strength = 'strong';
  else if (length >= 10 && classes >= 2) strength = 'good';
  else if (length >= 12) strength = 'good';
  return { ok: true, kind: 'text', strength };
}
