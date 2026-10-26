// Passcode-based encryption, built only from the browser's own WebCrypto (no third-party code).
//
// - A passcode or password is stretched with PBKDF2-HMAC-SHA-256 (many iterations, random salt) into an AES-256 key.
// - Data is sealed with AES-256-GCM: it is both encrypted and tamper-evident. A wrong key, or any changed byte,
//   makes opening fail instead of returning garbage.
// - A sealed blob is stored as: 12 random bytes (the nonce) followed by the ciphertext and its 16-byte tag.
// - "Additional data" ties a blob to where it belongs (for example the record's key), so a blob copied to
//   another place stops opening.

import { AppError } from './util.js';
import { randomBytes, subtle, utf8Encode } from './encoding.js';

/** OWASP's 2023 minimum for PBKDF2-HMAC-SHA-256. Costs a fraction of a second on an iPhone, and slows down guessing. */
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_ACCEPTED_ITERATIONS = 100_000;
export const MAX_ACCEPTED_ITERATIONS = 10_000_000;
export const SALT_BYTES = 16;
const NONCE_BYTES = 12;

/** Stretches a passcode or password into an AES-GCM key that can never be read back out of the browser. */
export async function deriveKey(secret, salt, iterations = PBKDF2_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < MIN_ACCEPTED_ITERATIONS || iterations > MAX_ACCEPTED_ITERATIONS) {
    throw new AppError('crypto', 'badParameters', 'The protection settings of this data are not valid.');
  }
  const base = await subtle().importKey('raw', utf8Encode(secret.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A key from raw bytes (the random data key). Not extractable, so the app can use it but never reveal it. */
export function importDataKey(rawBytes) {
  return subtle().importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts and authenticates `plaintext`. Returns nonce || ciphertext || tag. */
export async function seal(key, plaintext, additionalData = new Uint8Array(0)) {
  const nonce = randomBytes(NONCE_BYTES);
  const encrypted = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, key, plaintext),
  );
  const out = new Uint8Array(nonce.length + encrypted.length);
  out.set(nonce, 0);
  out.set(encrypted, nonce.length);
  return out;
}

/** Opens a blob made by `seal`. Throws AppError('crypto', 'cannotOpen') for a wrong key or damaged data. */
export async function open(key, sealed, additionalData = new Uint8Array(0)) {
  if (!(sealed instanceof Uint8Array) || sealed.length < NONCE_BYTES + 16) {
    throw new AppError('crypto', 'cannotOpen', 'The protected data could not be opened.');
  }
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const body = sealed.subarray(NONCE_BYTES);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, key, body));
  } catch {
    throw new AppError('crypto', 'cannotOpen', 'The protected data could not be opened.');
  }
}

/** Overwrites bytes that held a secret. Best effort: JavaScript cannot guarantee that no other copy exists. */
export function wipe(bytes) {
  if (bytes && typeof bytes.fill === 'function') bytes.fill(0);
}
