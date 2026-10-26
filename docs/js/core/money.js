// Exact money: a whole number of minor units plus the currency code.
//
// Why whole numbers: floating point cannot hold 0.10 exactly, so sums drift. Whole minor units (fils, cents, yen)
// add exactly, which is what lets the dashboard, the reports and the exports agree to the last digit.
// Floating point is used in exactly one place: `doubleValue`, to position things on a chart.

import { AppError, MAX_EXACT, bigToExactNumber, divideRoundHalfAwayFromZero, saturatingAdd } from './util.js';
import { digitsForCode } from './currency.js';

/** Largest single expense the app accepts: 10^13 minor units (100 billion AED). */
export const MAX_MINOR_UNITS = 10_000_000_000_000;

export function money(minorUnits, currencyCode) {
  return Object.freeze({ minorUnits, currencyCode: String(currencyCode).toUpperCase() });
}

export function zero(currencyCode) {
  return money(0, currencyCode);
}

export function digitsOf(m) {
  return digitsForCode(m.currencyCode);
}

export function isZero(m) {
  return m.minorUnits === 0;
}

export function isPositive(m) {
  return m.minorUnits > 0;
}

/** Floating-point value. ONLY for drawing chart positions, never for arithmetic or storage. */
export function doubleValue(m) {
  return m.minorUnits / 10 ** digitsOf(m);
}

/** Plain machine-readable text with a "." point and exactly the currency's number of decimals, e.g. "12.50". Never locale-dependent. */
export function plainString(m) {
  const digits = digitsOf(m);
  const sign = m.minorUnits < 0 ? '-' : '';
  const magnitude = Math.abs(m.minorUnits);
  if (digits === 0) return sign + String(magnitude);
  const divisor = 10 ** digits;
  const whole = Math.floor(magnitude / divisor);
  const fraction = String(magnitude - whole * divisor).padStart(digits, '0');
  return `${sign}${whole}.${fraction}`;
}

const DIGIT = /^[0-9]$/;

/**
 * Strict parser for amounts typed or pasted by a person. Accepts ASCII digits and at most one "." or ",".
 * Fails (instead of silently rounding) when there are more decimals than the currency allows.
 * Returns { ok: true, money } or { ok: false, error } with error one of
 * 'empty', 'invalidCharacters', 'tooManyDecimals', 'tooLarge'.
 */
export function parseMoney(text, currencyCode) {
  const trimmed = String(text).trim();
  if (trimmed === '') return { ok: false, error: 'empty' };
  const allowed = digitsForCode(String(currencyCode).toUpperCase());
  let whole = '';
  let fraction = '';
  let seenSeparator = false;
  for (const character of trimmed) {
    if (character === '.' || character === ',') {
      if (seenSeparator) return { ok: false, error: 'invalidCharacters' };
      seenSeparator = true;
    } else if (DIGIT.test(character)) {
      if (seenSeparator) fraction += character;
      else whole += character;
    } else {
      return { ok: false, error: 'invalidCharacters' };
    }
  }
  if (whole === '' && fraction === '') return { ok: false, error: 'invalidCharacters' };
  if (fraction.length > allowed) return { ok: false, error: 'tooManyDecimals', allowed };
  fraction = fraction.padEnd(allowed, '0');
  const combined = (whole === '' ? '0' : whole) + fraction;
  const value = Number(combined);
  if (!Number.isSafeInteger(value)) return { ok: false, error: 'tooLarge' };
  return { ok: true, money: money(value, currencyCode) };
}

function requireSameCurrency(a, b, action) {
  if (a.currencyCode !== b.currencyCode) {
    throw new AppError('money', 'currencyMismatch', `Cannot ${action} different currencies`);
  }
}

export function add(a, b) {
  requireSameCurrency(a, b, 'add');
  return money(saturatingAdd(a.minorUnits, b.minorUnits), a.currencyCode);
}

export function subtract(a, b) {
  requireSameCurrency(a, b, 'subtract');
  return money(saturatingAdd(a.minorUnits, -b.minorUnits), a.currencyCode);
}

/** Exact sum of a list. Every element must be in `currencyCode`. */
export function sum(values, currencyCode) {
  const code = String(currencyCode).toUpperCase();
  let total = 0;
  for (const value of values) {
    if (value.currencyCode !== code) throw new AppError('money', 'currencyMismatch', 'Cannot sum different currencies');
    total = saturatingAdd(total, value.minorUnits);
  }
  return money(total, code);
}

export function compareMoney(a, b) {
  if (a.currencyCode !== b.currencyCode) return a.currencyCode < b.currencyCode ? -1 : 1;
  return a.minorUnits === b.minorUnits ? 0 : a.minorUnits < b.minorUnits ? -1 : 1;
}

/** numerator / denominator (both whole numbers) rounded to the nearest minor unit, halves away from zero. */
export function roundedRatio(numerator, denominator, currencyCode) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d <= 0n) return zero(currencyCode);
  return money(bigToExactNumber(divideRoundHalfAwayFromZero(n, d)), currencyCode);
}

/** `m` divided by a count, rounded to the minor unit. Zero when the count is not positive. */
export function dividedBy(m, count) {
  if (!(count > 0)) return zero(m.currencyCode);
  return roundedRatio(m.minorUnits, count, m.currencyCode);
}

/**
 * Share of `part` in `total`, from 0 to 100, rounded to ONE decimal place (halves away from zero).
 * Computed with whole numbers only, so 1/3 is always 33.3. A zero total gives 0.
 */
export function percentShare(part, total) {
  if (total.minorUnits === 0) return 0;
  const tenths = divideRoundHalfAwayFromZero(BigInt(part.minorUnits) * 1000n, BigInt(total.minorUnits));
  return Number(tenths) / 10;
}

/** Percentage change from `oldValue` to `newValue`, or null when `oldValue` is zero (a change from nothing has no percentage). */
export function percentChange(oldValue, newValue) {
  if (oldValue.minorUnits === 0) return null;
  const difference = BigInt(newValue.minorUnits) - BigInt(oldValue.minorUnits);
  const tenths = divideRoundHalfAwayFromZero(difference * 1000n, BigInt(oldValue.minorUnits));
  return Number(tenths) / 10;
}

export { MAX_EXACT };
