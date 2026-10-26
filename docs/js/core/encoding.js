// Bytes, text and hashes. Uses only what every modern browser (and Node) provides; nothing is downloaded.

import { AppError } from './util.js';

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/** The secure-crypto interface. It exists only on pages opened over https (or localhost), which is how the app is served. */
export function subtle() {
  const found = globalThis.crypto && globalThis.crypto.subtle;
  if (!found) {
    throw new AppError(
      'crypto',
      'unavailable',
      'This browser is not allowing the secure operations the app needs. Open the app from its https address in Safari.',
    );
  }
  return found;
}

export function randomBytes(count) {
  return globalThis.crypto.getRandomValues(new Uint8Array(count));
}

export function utf8Encode(text) {
  return encoder.encode(text);
}

/** Throws if the bytes are not valid UTF-8 (so a damaged file is reported, not silently repaired). */
export function utf8Decode(bytes) {
  return strictDecoder.decode(bytes);
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict decoder: returns null for anything that is not canonical standard base64. */
export function base64ToBytes(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) return null;
  let binary;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(bytes) {
  const digest = await subtle().digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

/** JSON with every object's keys in sorted order, so the same data always produces the same text. */
export function stableStringify(value, indent) {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = sortKeys(value[key]);
    return result;
  }
  return value;
}
