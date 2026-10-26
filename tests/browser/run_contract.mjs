// Runs the storage checks in a real browser (Chromium through Playwright) and prints the result.
//
//     node tests/browser/run_contract.mjs
//
// Needs Playwright (not part of the app, and not needed to use it). Exit code 0 = every check passed.
// This tests Chromium only. Safari/WebKit is a different engine and is NOT covered by this run.

import { createRequire } from 'node:module';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const { server, url } = await startServer({ port: 0, withTests: true });
let exitCode = 1;
try {
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  }
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console error: ${message.text()}`); });
  await page.goto(`${url}/__repo__/tests/browser/contract.html`);
  await page.waitForFunction(() => window.__contractResults && window.__contractResults.done, null, { timeout: 120_000 });
  const outcome = await page.evaluate(() => window.__contractResults);
  await browser.close();

  if (outcome.fatal) {
    console.log(`The page could not run the checks:\n${outcome.fatal}`);
  } else {
    const failed = outcome.results.filter((r) => !r.ok);
    console.log(`${outcome.userAgent}\n`);
    for (const r of outcome.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? ` (${r.ms} ms)` : `\n      ${r.error}`}`);
    console.log(`\n${outcome.results.length - failed.length} of ${outcome.results.length} checks passed.`);
    if (problems.length) console.log(`\nBrowser reported:\n  ${problems.join('\n  ')}`);
    exitCode = failed.length === 0 && problems.length === 0 ? 0 : 1;
  }
} finally {
  server.close();
}
process.exit(exitCode);
