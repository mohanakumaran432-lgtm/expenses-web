// A small runner and a few finders shared by the interactive browser tests. A step that fails is reported and the run goes on
// (after putting the app back on its Settings page), so one broken flow does not hide the rest.

import { shot, inApp } from './harness.mjs';

export const TOP = '.tabview:not([hidden]) > .page:last-child';

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeRunner(page, label) {
  const results = [];
  const settle = (ms = 250) => page.waitForTimeout(ms);

  async function recover() {
    try {
      await inApp(page, (app) => { app.ui.closeAll(); app.shell.popToRoot(); app.shell.selectTab('settings'); });
    } catch { /* the page may be mid-navigation */ }
    await settle(200);
  }

  async function step(title, fn) {
    try {
      await fn();
      results.push({ title, ok: true });
      console.log(`  ok    ${title}`);
    } catch (error) {
      const line = String((error && error.message) || error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
      results.push({ title, ok: false, error: line });
      console.log(`  FAIL  ${title}\n        ${line}`);
      try { await shot(page, `fail-${label}-${slug(title)}`); } catch { /* ignore */ }
      await recover();
    }
  }

  function summary() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${label}: ${results.length - failed.length} of ${results.length} steps passed`);
    for (const r of failed) console.log(`  - ${r.title}: ${r.error}`);
    return failed.length;
  }

  return { step, summary, settle, recover, results };
}

/** Finders that read like the screen. */
export function finders(page) {
  const settle = (ms = 250) => page.waitForTimeout(ms);
  const exact = (text) => new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`);
  const api = {
    settle,
    exact,
    tab: (name) => page.locator('.tabbar .tab', { hasText: name }).click(),
    /** A row on the page that is on top. */
    row: (name) => page.locator(`${TOP} .row`, { hasText: name }).first(),
    /** A row inside the sheet that is on top. */
    sheetRow: (name) => page.locator('.layer').last().locator('.row', { hasText: name }).first(),
    /** A button on the page that is on top. */
    button: (name) => page.locator(`${TOP} button`).filter({ hasText: exact(name) }).first(),
    sheetButton: (name) => page.locator('.layer').last().locator('button').filter({ hasText: exact(name) }).first(),
    navButton: (name) => page.locator(`${TOP} .navbar button`).filter({ hasText: exact(name) }).first(),
    /** Cancel / Save style buttons in the bar of the sheet on top. */
    sheetAction: (name) => page.locator('.layer').last().locator('.navbar button').filter({ hasText: exact(name) }).first(),
    dialog: () => page.locator('.dialog').last(),
    dialogButton: (name) => page.locator('.dialog button').filter({ hasText: exact(name) }).last(),
    dialogInput: () => page.locator('.dialog input').last(),
    actionItem: (name) => page.locator('.action-sheet button').filter({ hasText: exact(name) }).first(),
    toast: (text) => page.locator('.toast', { hasText: text }).first(),
    async back() {
      await page.locator(`${TOP} .navbar .nav-btn`).first().click();
      await settle(300);
    },
    async waitDialog(title) {
      await page.locator('.dialog .dialog-title', { hasText: title }).first().waitFor({ timeout: 4000 });
    },
    async waitToast(text) {
      await page.locator('.toast', { hasText: text }).first().waitFor({ timeout: 5000 });
    },
    async noLayers() {
      await page.waitForFunction(() => document.querySelectorAll('.layer').length === 0, null, { timeout: 5000 });
    },
    async pageTitle() {
      return page.locator(`${TOP} .navbar-title`).first().innerText();
    },
  };
  return api;
}

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

export function expectEqual(actual, wanted, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) throw new Error(`${message}: expected ${b} but found ${a}`);
}
