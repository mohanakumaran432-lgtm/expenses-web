// Shared set-up for the browser tests: a local server, Chromium at iPhone 17 Pro Max size (440 x 956 points), a fixed clock,
// and a few helpers. These tests run in Chromium. Safari/WebKit is a different engine and is NOT covered by them.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHOTS = process.env.SHOTS_DIR || path.join(HERE, '..', '..', '..', 'shots');
/** 2026-10-20 12:00 in Dubai (08:00 UTC): the same "today" the unit tests use. */
export const FIXED_NOW = new Date('2026-10-20T08:00:00Z');

export async function launch({ timezoneId = 'Asia/Dubai', locale = 'en-GB', colorScheme = 'light', serviceWorkers = 'block', viewport = { width: 440, height: 956 }, now = FIXED_NOW, docsRoot = undefined } = {}) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server, url } = await startServer({ port: 0, withTests: true, docsRoot });
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  }
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId, locale, colorScheme, serviceWorkers, reducedMotion: 'reduce',
  });
  const problems = [];
  const page = await context.newPage();
  if (now) await page.clock.setFixedTime(now);
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' || /Content Security Policy|Refused to/i.test(text)) problems.push(`console ${message.type()}: ${text}`);
  });
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()}`));
  const close = async () => {
    await context.close();
    await browser.close();
    server.close();
  };
  return { page, context, browser, url, problems, close };
}

export async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/**
 * Makes Chromium treat taps the way iPhone Safari does for focus: tapping a button or blank space does NOT take the focus away
 * from a text box (so the keyboard stays up); only tapping another text box, a label or a menu does. Chromium moves the focus
 * on every mouse press, which would hide what the app does when the focus stays put. Call before opening the app.
 */
export async function behaveLikeSafariFocus(context) {
  await context.addInitScript(() => {
    const MOVES_FOCUS = 'input, textarea, select, label, [contenteditable=""], [contenteditable="true"]';
    document.addEventListener('mousedown', (event) => {
      if (event.target && event.target.closest && !event.target.closest(MOVES_FOCUS)) event.preventDefault();
    }, true);
  });
}

/** Opens the app and waits for the first screen. */
export async function openApp(page, url, search = '?nosw=1') {
  await page.goto(`${url}/${search}`);
  await page.waitForSelector('#boot', { state: 'detached', timeout: 15_000 });
}

/** Finishes the welcome flow without a passcode (fast), or with one. */
export async function startFresh(page, { passcode = null, currency = null } = {}) {
  await page.getByRole('button', { name: 'Set up' }).click();
  if (currency) {
    await page.getByRole('button', { name: /^Currency/ }).click();
    await page.getByRole('button', { name: new RegExp(`^${currency},`) }).click();
  }
  if (passcode === null) {
    await page.getByRole('switch', { name: /Protect with a passcode/ }).uncheck({ force: true });
  } else {
    const fields = page.locator('.page input[type=password], .page input[type=text]');
    await fields.nth(0).fill(passcode);
    await fields.nth(1).fill(passcode);
  }
  await page.getByRole('button', { name: 'Start tracking' }).click();
  await page.waitForSelector('.tabbar', { timeout: 20_000 });
}

/** Runs code inside the page, with the live app object. */
export function inApp(page, fn, arg) {
  return page.evaluate(({ source, arg: a }) => {
    const run = new Function('app', 'arg', `return (${source})(app, arg);`);
    return run(window.__expensesApp, a);
  }, { source: fn.toString(), arg });
}

/** Loads sample spending (about ten weeks of it) through the app's real services. */
export async function seed(page, url, options = {}) {
  await page.evaluate(async ({ base, options: o }) => {
    const mod = await import(`${base}/__repo__/tests/e2e/seed.js`);
    await mod.seedLedger(window.__expensesApp, o);
  }, { base: url, options });
}

/** Adds a budget and a repeating expense (see seed.js). */
export async function seedExtras(page, url) {
  await page.evaluate(async ({ base }) => {
    const mod = await import(`${base}/__repo__/tests/e2e/seed.js`);
    await mod.seedBudgetAndRepeating(window.__expensesApp);
  }, { base: url });
}

/**
 * Fails when text that should never reach a person appears on screen: "null", "undefined", "NaN", "[object ...]" or a
 * raw template placeholder. Returns the offending snippets (empty when the screen is clean).
 */
export async function leakedText(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const found = [];
    for (const pattern of [/\bnull\b/i, /\bundefined\b/i, /\bNaN\b/, /\[object /i, /\$\{/, /Invalid Date/i]) {
      const match = pattern.exec(text);
      if (match) found.push(text.slice(Math.max(0, match.index - 30), match.index + 40).replace(/\s+/g, ' '));
    }
    return found;
  });
}

/** Scrolls the page that is on screen one screenful at a time, calling `snap(name)` for each stop (at most `max` stops). */
export async function scrollThrough(page, snap, prefix, { max = 8 } = {}) {
  const measure = () => page.evaluate(() => {
    const visible = [...document.querySelectorAll('.page-scroll')].filter((el) => el.offsetParent !== null).pop();
    return visible ? { top: visible.scrollTop, scrollHeight: visible.scrollHeight, clientHeight: visible.clientHeight } : null;
  });
  const first = await measure();
  if (!first) return 0;
  const step = Math.max(200, first.clientHeight - 140);
  let stops = 0;
  for (let y = step; y < first.scrollHeight - first.clientHeight + step && stops < max; y += step) {
    await page.evaluate((top) => {
      const visible = [...document.querySelectorAll('.page-scroll')].filter((el) => el.offsetParent !== null).pop();
      visible.scrollTop = top;
    }, y);
    await page.waitForTimeout(160);
    stops += 1;
    await snap(`${prefix}-s${stops}`);
  }
  await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.page-scroll')].filter((el) => el.offsetParent !== null).pop();
    if (visible) visible.scrollTop = 0;
  });
  return stops;
}
