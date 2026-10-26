// Cleans text that people type, so equal-looking values are stored equally.

import { characterCount, prefixCharacters } from './util.js';

export const MAX_NAME_LENGTH = 60;
export const MAX_MERCHANT_LENGTH = 120;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_EXPENSE = 20;

/** One line: surrounding spaces removed, any run of spaces, tabs or line breaks becomes one space. */
export function line(text) {
  return String(text).split(/\s+/u).filter((piece) => piece !== '').join(' ');
}

/** Free text: only the ends are trimmed, line breaks inside are kept. */
export function block(text) {
  return String(text).trim();
}

/** A tag without "#", commas or semicolons (those would break CSV lists), or null if nothing is left. */
export function tag(raw) {
  let text = String(raw).replaceAll(',', ' ').replaceAll(';', ' ');
  text = line(text);
  while (text.startsWith('#')) text = text.slice(1);
  text = line(text);
  if (text === '') return null;
  return prefixCharacters(text, MAX_TAG_LENGTH);
}

/** Normalizes each tag and removes duplicates ignoring case, keeping the first spelling and the order. */
export function tags(raw) {
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const cleaned = tag(item);
    if (cleaned === null) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

/** Key for comparing names ignoring case, accents and extra spaces ("Café " equals "cafe"). */
export function comparisonKey(text) {
  return line(text)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .normalize('NFC');
}

export { characterCount };
