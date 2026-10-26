// Measures the Add Expense sheet (used while tuning the layout; prints boxes, nothing is judged).
import { launch, openApp, shot, startFresh } from './harness.mjs';

const { page, url, problems, close } = await launch();
try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await page.getByRole('button', { name: 'Add expense' }).first().click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(500);
  const boxes = await page.evaluate(() => {
    const pick = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { selector, top: Math.round(r.top), height: Math.round(r.height), scrollTop: el.scrollTop ?? null };
    };
    return [
      '.sheet', '.sheet .navbar', '.sheet-scroll', '.sheet .page-body', '.amount-block', '.amount-display', '.amount-text', '.form-hint', '.chip', '.sheet-footer',
    ].map(pick);
  });
  console.table(boxes);
  const tree = await page.evaluate(() => {
    const body = document.querySelector('.sheet .page-body');
    return [...body.children].map((c) => `${c.tagName}.${c.className} h=${Math.round(c.getBoundingClientRect().height)} top=${Math.round(c.getBoundingClientRect().top)}`);
  });
  console.log(tree.join('\n'));
  await shot(page, '14-add-debug');
} finally {
  console.log('problems:', problems);
  await close();
}
