// Small helpers shared by the whole core. Nothing here touches the page, the network or storage,
// so every file in js/core runs unchanged in Node (for the tests) and in the browser.

/** A new random id. Upper-case on purpose: the iPhone app writes ids this way, so backups look identical. */
export function newId() {
  return globalThis.crypto.randomUUID().toUpperCase();
}

export function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

/** One error type for everything the person can cause. `kind` says where it came from, `code` says what went wrong. */
export class AppError extends Error {
  constructor(kind, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

/** Largest whole number JavaScript can add without losing the last digit. */
export const MAX_EXACT = Number.MAX_SAFE_INTEGER;

/**
 * Adds two whole numbers and stops at the largest exact value instead of silently losing digits.
 * The app limits a single expense to 10^13 minor units, so reaching this limit would need hundreds of
 * maximum-size expenses; it is a guard, not something a person will meet.
 */
export function saturatingAdd(a, b) {
  const sum = a + b;
  if (sum > MAX_EXACT) return MAX_EXACT;
  if (sum < -MAX_EXACT) return -MAX_EXACT;
  return sum;
}

/** n / d for BigInts, rounded half away from zero (0.5 becomes 1, -0.5 becomes -1). d must not be zero. */
export function divideRoundHalfAwayFromZero(n, d) {
  if (d === 0n) throw new RangeError('Division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let quotient = n / d;
  const remainder = n % d;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twice >= d) quotient += n < 0n ? -1n : 1n;
  return quotient;
}

/** A BigInt that is known to fit, back to a Number (clamped to the exact range). */
export function bigToExactNumber(value) {
  const limit = BigInt(MAX_EXACT);
  if (value > limit) return MAX_EXACT;
  if (value < -limit) return -MAX_EXACT;
  return Number(value);
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;
let segmenter = null;

/** The characters a person would count: "é", an emoji with a skin tone, or a flag each count as one. */
export function characters(text) {
  if (ASCII_ONLY.test(text)) {
    // "\r\n" is one character for people (and for Swift); everything else in ASCII is one unit each.
    return text.includes('\r\n') ? text.split(/(\r\n|[\s\S])/).filter(Boolean) : Array.from(text);
  }
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    if (!segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (piece) => piece.segment);
  }
  return Array.from(text);
}

export function characterCount(text) {
  if (ASCII_ONLY.test(text) && !text.includes('\r\n')) return text.length;
  return characters(text).length;
}

export function prefixCharacters(text, count) {
  if (ASCII_ONLY.test(text) && !text.includes('\r\n')) return text.slice(0, count);
  return characters(text).slice(0, count).join('');
}

/** Plain-object copy that drops keys whose value is null or undefined (what the iPhone app's JSON does for empty optionals). */
export function withoutEmpty(object) {
  const result = {};
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result;
}

/** A frozen shallow copy. Records are never edited in place; changing one means making a new one. */
export function freeze(object) {
  return Object.freeze(object);
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Orders two pieces of text the same way on every device: by Unicode code point after canonical normalization
 * (the same rule Swift's "<" on String follows). Used for tie-breaks in sorted lists, so output never depends on locale.
 */
export function compareText(a, b) {
  if (a === b) return 0;
  const x = ASCII_ONLY.test(a) && ASCII_ONLY.test(b) ? a : a.normalize('NFC');
  const y = ASCII_ONLY.test(a) && ASCII_ONLY.test(b) ? b : b.normalize('NFC');
  if (x === y) return 0;
  const left = Array.from(x);
  const right = Array.from(y);
  const shortest = Math.min(left.length, right.length);
  for (let i = 0; i < shortest; i += 1) {
    const p = left[i].codePointAt(0);
    const q = right[i].codePointAt(0);
    if (p !== q) return p < q ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}
