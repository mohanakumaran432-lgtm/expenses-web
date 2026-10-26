// Taps through the Settings lists the way a person would: categories (add, style, subcategories, merge, archive, delete, reorder),
// payment methods, tags, currency and display choices, notification switches. Run: SHOTS_DIR=... node tests/e2e/flows_lists.mjs [light|dark]
import { launch, openApp, shot, startFresh, seed, inApp, leakedText } from './harness.mjs';
import { TOP, expect, expectEqual, finders, makeRunner } from './steps.mjs';

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const { page, url, problems, close } = await launch({ colorScheme: scheme });
const { step, summary, settle } = makeRunner(page, `lists-${scheme}`);
const f = finders(page);
const leaks = [];
const snap = async (name) => { await shot(page, `${name}-${scheme}`); for (const text of await leakedText(page)) leaks.push(`${name}: ${text}`); };
const state = (fn, arg) => inApp(page, fn, arg);
let failures = 0;

try {
  await openApp(page, url);
  await startFresh(page, { passcode: null });
  await seed(page, url, {});
  await f.tab('Settings');
  await settle(300);

  console.log(`\nLists (${scheme})`);

  // ------------------------------------------------------------------ categories
  await step('Categories opens from Settings', async () => {
    await f.row('Categories').click();
    await settle(350);
    expectEqual(await f.pageTitle(), 'Categories', 'page title');
  });

  await step('A new category gets a name, an icon and a colour of the person\'s own', async () => {
    await page.getByRole('button', { name: 'Add a category' }).click();
    await settle(350);
    await snap('80-category-new-empty');
    expect(await f.sheetAction('Save').isDisabled(), 'Save waits for a name');
    await page.getByLabel('Category name').fill('Pets');
    await page.locator('.icon-choice[data-name="pawprint"]').scrollIntoViewIfNeeded();
    await page.locator('.icon-choice[data-name="pawprint"]').click();
    await page.locator('.color-choice[data-hex]').nth(4).click();
    await page.locator('input[type=color]').fill('#12ab34');
    await settle(200);
    await snap('81-category-new-filled');
    const preview = await page.locator('.style-preview-name').last().innerText();
    expectEqual(preview, 'Pets', 'the preview shows the name');
    await f.sheetAction('Save').click();
    await f.waitToast('Category added');
    await f.noLayers();
    const made = await state((app) => {
      const c = app.snapshot.categories.find((x) => x.name === 'Pets');
      return c && { icon: c.iconSymbol, color: c.colorHex, archived: c.isArchived };
    });
    expectEqual(made, { icon: 'pawprint', color: '#12AB34', archived: false }, 'the stored category');
  });

  await step('Closing a changed form asks before throwing it away', async () => {
    await page.getByRole('button', { name: 'Add a category' }).click();
    await settle(300);
    await page.getByLabel('Category name').fill('Scratch');
    await f.sheetAction('Cancel').click();
    await f.waitDialog('Discard your changes?');
    await f.dialogButton('Keep editing').click();
    expect(await page.getByLabel('Category name').inputValue() === 'Scratch', 'the text is still there after Keep editing');
    await f.sheetAction('Cancel').click();
    await f.waitDialog('Discard your changes?');
    await f.dialogButton('Discard').click();
    await f.noLayers();
    const exists = await state((app) => app.snapshot.categories.some((c) => c.name === 'Scratch'));
    expect(!exists, 'nothing was saved');
  });

  await step('A category with the same name is refused with a clear message', async () => {
    await page.getByRole('button', { name: 'Add a category' }).click();
    await settle(300);
    await page.getByLabel('Category name').fill('pets');
    await f.sheetAction('Save').click();
    await page.locator('.dialog').first().waitFor({ timeout: 4000 });
    const text = await f.dialog().innerText();
    expect(/already|same name|exists/i.test(text), `a message about the name being taken (got: ${text.replace(/\s+/g, ' ')})`);
    await snap('82-category-duplicate');
    await f.dialogButton('OK').click();
    await f.sheetAction('Cancel').click();
    await f.waitDialog('Discard your changes?');
    await f.dialogButton('Discard').click();
    await f.noLayers();
  });

  await step('Subcategories can be added, renamed, merged and archived', async () => {
    await f.row('Pets').click();
    await settle(400);
    await f.row('Add a subcategory').click();
    await f.waitDialog('New subcategory');
    await f.dialogInput().fill('Vet');
    await f.dialogButton('Add').click();
    await f.waitToast('Subcategory added');
    await f.row('Add a subcategory').click();
    await f.waitDialog('New subcategory');
    await f.dialogInput().fill('Food');
    await f.dialogButton('Add').click();
    await f.waitToast('Subcategory added');
    await settle(300);
    await snap('83-category-subcategories');
    await f.row('Vet').click();
    await f.actionItem('Rename').click();
    await f.waitDialog('Rename subcategory');
    await f.dialogInput().fill('Vet visits');
    await f.dialogButton('Rename').click();
    await settle(400);
    let names = await state((app) => {
      const c = app.snapshot.categories.find((x) => x.name === 'Pets');
      return app.snapshot.subcategoriesOf(c.id).map((s) => s.name);
    });
    expectEqual(names, ['Vet visits', 'Food'], 'subcategories after the rename');
    await f.row('Food').click();
    await f.actionItem('Merge into another subcategory…').click();
    await settle(300);
    await f.sheetRow('Vet visits').click();
    await f.waitDialog('Merge into Vet visits?');
    await f.dialogButton('Merge').click();
    await f.waitToast('Merged into Vet visits');
    names = await state((app) => {
      const c = app.snapshot.categories.find((x) => x.name === 'Pets');
      return app.snapshot.subcategoriesOf(c.id).map((s) => s.name);
    });
    expectEqual(names, ['Vet visits'], 'active subcategories after the merge');
    const archived = await state((app) => app.snapshot.subcategories.filter((s) => s.name === 'Food').map((s) => ({ archived: s.isArchived, merged: Boolean(s.mergedIntoID) })));
    expectEqual(archived, [{ archived: true, merged: true }], 'the merged subcategory is kept on record');
    await snap('84-category-after-merge');
  });

  await step('A category with expenses is merged into another and its history moves', async () => {
    await page.evaluate(() => {}); // keep the page awake
    await state(async (app) => {
      const { makeDraft } = await import('/js/core/models.js');
      const { parseMoney } = await import('/js/core/money.js');
      const category = app.snapshot.categories.find((x) => x.name === 'Pets');
      const sub = app.snapshot.subcategoriesOf(category.id)[0];
      const today = app.today();
      for (const [text, back] of [['120.50', 1], ['75.00', 3]]) {
        const draft = makeDraft({
          amount: parseMoney(text, app.currency).money, day: today.addingDays(-back), timeZoneID: app.timeZone(), categoryID: category.id, subcategoryID: sub.id,
          merchant: 'Pet Zone', notes: '', tags: [], hasExplicitTime: false, hour: 12, minute: 0,
        });
        await app.services.expenses.save(draft, today);
      }
    });
    await settle(300);
    await f.row('Merge into another category…').click();
    await settle(400);
    await snap('85-category-merge-chooser');
    await f.sheetRow('Personal Care').click();
    await f.waitDialog('Merge into Personal Care?');
    const message = await f.dialog().innerText();
    expect(/2 expenses/.test(message) && /subcategor/.test(message), `the warning counts what moves (got: ${message.replace(/\s+/g, ' ')})`);
    await f.dialogButton('Merge').click();
    await f.waitToast('Merged into Personal Care');
    await settle(500);
    const result = await state((app) => {
      const pets = app.snapshot.categories.find((x) => x.name === 'Pets');
      const care = app.snapshot.categories.find((x) => x.name === 'Personal Care');
      const moved = app.snapshot.expenses.filter((e) => e.merchant === 'Pet Zone');
      return {
        petsArchived: pets.isArchived, petsMergedIntoCare: pets.mergedIntoID === care.id,
        allMovedToCare: moved.length === 2 && moved.every((e) => e.categoryID === care.id),
        stillHaveSub: moved.every((e) => Boolean(e.subcategoryID)),
      };
    });
    expectEqual(result, { petsArchived: true, petsMergedIntoCare: true, allMovedToCare: true, stillHaveSub: true }, 'after the merge');
    expectEqual(await f.pageTitle(), 'Categories', 'back on the list after merging');
    await snap('86-categories-after-merge');
  });

  await step('An unused category can be deleted, a used one cannot', async () => {
    await page.getByRole('button', { name: 'Add a category' }).click();
    await settle(300);
    await page.getByLabel('Category name').fill('Temporary');
    await f.sheetAction('Save').click();
    await f.waitToast('Category added');
    await f.noLayers();
    await f.row('Temporary').click();
    await settle(400);
    await f.button('Delete this category').click();
    await f.waitDialog('Delete this category?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Category deleted');
    await settle(400);
    expectEqual(await f.pageTitle(), 'Categories', 'back on the list');
    await f.row('Groceries').click();
    await settle(400);
    expect(await page.locator(`.tabview:not([hidden]) > .page:last-child button`, { hasText: 'Delete this category' }).count() === 0, 'no delete button for a category in use');
    await f.back();
  });

  await step('A category is archived and restored; archived ones leave the Add list', async () => {
    await f.row('Entertainment').click();
    await settle(400);
    await f.row('Archive this category').click();
    await f.waitDialog('Archive this category?');
    await f.dialogButton('Archive').click();
    await f.waitToast('Category archived');
    await settle(300);
    let active = await state((app) => app.snapshot.activeCategories.some((c) => c.name === 'Entertainment'));
    expect(!active, 'it is no longer offered');
    await snap('87-category-archived');
    await f.row('Restore this category').click();
    await f.waitToast('Category restored');
    active = await state((app) => app.snapshot.activeCategories.some((c) => c.name === 'Entertainment'));
    expect(active, 'it is offered again');
    await f.back();
  });

  await step('Categories are reordered by dragging a handle', async () => {
    await f.navButton('Reorder').click();
    await settle(300);
    await snap('88-categories-reorder');
    const before = await state((app) => app.snapshot.activeCategories.map((c) => c.name));
    const handles = page.locator(`.tabview:not([hidden]) > .page:last-child .drag-handle`);
    const first = await handles.nth(0).boundingBox();
    const second = await handles.nth(1).boundingBox();
    const rowHeight = second.y - first.y;
    const x = first.x + first.width / 2;
    const y = first.y + first.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + rowHeight * 0.8, { steps: 6 });
    await page.mouse.move(x, y + rowHeight * 2.3, { steps: 10 });
    await settle(150);
    await snap('89-categories-dragging');
    await page.mouse.up();
    await settle(500);
    const after = await state((app) => app.snapshot.activeCategories.map((c) => c.name));
    expectEqual(after.slice(0, 3), [before[1], before[2], before[0]], 'the first category was dropped after the third');
    expect(after.length === before.length, 'no category was lost');
  });

  await step('The arrow keys reorder a focused handle too', async () => {
    const before = await state((app) => app.snapshot.activeCategories.map((c) => c.name));
    const handle = page.locator(`.tabview:not([hidden]) > .page:last-child .drag-handle`).nth(2);
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await settle(500);
    const after = await state((app) => app.snapshot.activeCategories.map((c) => c.name));
    expectEqual(after.slice(0, 3), [before[0], before[2], before[1]], 'the third moved up one place');
    await f.navButton('Done').click();
    await settle(300);
    expect(await page.locator(`.tabview:not([hidden]) > .page:last-child .drag-handle`).count() === 0, 'handles are gone after Done');
    await f.back();
  });

  // ------------------------------------------------------------------ payment methods
  await step('Payment methods: add, rename, archive, restore and delete', async () => {
    await f.row('Payment methods').click();
    await settle(350);
    expectEqual(await f.pageTitle(), 'Payment methods', 'page title');
    await snap('90-methods');
    await page.getByRole('button', { name: 'Add a payment method' }).click();
    await settle(300);
    await page.getByLabel('Payment method name').fill('Amex');
    await page.locator('.icon-choice[data-name="star"]').click();
    await f.sheetAction('Save').click();
    await f.waitToast('Payment method added');
    await f.noLayers();
    await f.row('Amex').click();
    await settle(300);
    await page.getByLabel('Payment method name').fill('Amex Gold');
    await f.sheetAction('Save').click();
    await f.waitToast('Payment method updated');
    await f.noLayers();
    await f.row('Amex Gold').click();
    await settle(300);
    await f.sheetRow('Archive').click();
    await f.noLayers();
    await settle(300);
    let archived = await state((app) => app.snapshot.paymentMethods.filter((m) => m.name === 'Amex Gold').map((m) => m.isArchived));
    expectEqual(archived, [true], 'archived');
    await snap('91-methods-archived');
    await f.row('Amex Gold').click();
    await settle(300);
    await f.sheetRow('Restore').click();
    await f.noLayers();
    archived = await state((app) => app.snapshot.paymentMethods.filter((m) => m.name === 'Amex Gold').map((m) => m.isArchived));
    expectEqual(archived, [false], 'restored');
    await f.row('Amex Gold').click();
    await settle(300);
    await f.sheetButton('Delete payment method').click();
    await f.waitDialog('Delete this payment method?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Payment method deleted');
    const gone = await state((app) => !app.snapshot.paymentMethods.some((m) => m.name === 'Amex Gold'));
    expect(gone, 'deleted for good because nothing used it');
  });

  await step('A payment method in use cannot be deleted, only archived', async () => {
    await f.row('Debit Card').click();
    await settle(300);
    expect(await page.locator('.layer').last().locator('button', { hasText: 'Delete payment method' }).count() === 0, 'no delete button');
    const note = await page.locator('.layer').last().innerText();
    expect(/cannot be deleted/.test(note), 'the sheet says why');
    await f.sheetAction('Cancel').click();
    await f.noLayers();
  });

  await step('Payment methods are reordered with the keyboard and a default is chosen', async () => {
    await f.navButton('Reorder').click();
    await settle(250);
    const before = await state((app) => app.snapshot.activePaymentMethods.map((m) => m.name));
    const handle = page.locator(`.tabview:not([hidden]) > .page:last-child .drag-handle`).nth(3);
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await settle(500);
    const after = await state((app) => app.snapshot.activePaymentMethods.map((m) => m.name));
    expectEqual(after.slice(0, 3), [before[0], before[3], before[1]], 'the fourth moved up two places');
    await f.navButton('Done').click();
    await settle(250);
    await f.row('Default for new expenses').click();
    await settle(300);
    await f.sheetRow('Cash').click();
    await f.noLayers();
    const chosen = await state((app) => {
      const m = app.snapshot.paymentMethods.find((x) => x.id === app.settings.defaultPaymentMethodID);
      return m && m.name;
    });
    expectEqual(chosen, 'Cash', 'the default payment method');
    await snap('92-methods-default');
    await f.row('Default for new expenses').click();
    await settle(300);
    await f.sheetRow('Last one used').click();
    await f.noLayers();
    await f.back();
  });

  // ------------------------------------------------------------------ tags
  await step('Tags can be renamed and deleted, and expenses follow', async () => {
    await f.row('Tags').click();
    await settle(350);
    const counts = await state((app) => ({
      work: app.snapshot.expenses.filter((e) => e.tags.includes('work')).length,
      treat: app.snapshot.expenses.filter((e) => e.tags.includes('treat')).length,
    }));
    expect(counts.work > 0 && counts.treat > 0, 'the sample data has these tags');
    await f.row('work').click();
    await f.actionItem('Rename').click();
    await f.waitDialog('Rename tag');
    await f.dialogInput().fill('office');
    await f.dialogButton('Rename').click();
    await f.waitToast('Tag renamed');
    let now = await state((app) => ({
      work: app.snapshot.expenses.filter((e) => e.tags.includes('work')).length,
      office: app.snapshot.expenses.filter((e) => e.tags.includes('office')).length,
    }));
    expectEqual(now, { work: 0, office: counts.work }, 'expenses carry the new tag name');
    await snap('93-tags-renamed');
    await f.row('treat').click();
    await f.actionItem('Delete tag').click();
    await f.waitDialog('Delete this tag?');
    await f.dialogButton('Delete').click();
    await f.waitToast('Tag deleted');
    now = await state((app) => ({
      treat: app.snapshot.expenses.filter((e) => e.tags.includes('treat')).length,
      total: app.snapshot.expenses.length,
    }));
    expect(now.treat === 0 && now.total > 100, 'the tag is gone from every expense and no expense was deleted');
    await f.back();
  });

  // ------------------------------------------------------------------ choices on the Settings page
  await step('Week start, appearance and formats are saved', async () => {
    await f.row('The week starts on').click();
    await settle(250);
    await f.actionItem('Saturday').click();
    await settle(300);
    expectEqual(await state((app) => app.settings.firstWeekday), 7, 'week start');
    await f.row('The week starts on').click();
    await settle(250);
    await f.actionItem('Monday').click();
    await settle(300);
    expectEqual(await state((app) => app.settings.firstWeekday), 2, 'week start again');

    await f.row('Appearance').click();
    await settle(250);
    await f.actionItem('Dark').click();
    await settle(400);
    expectEqual(await state(() => document.documentElement.dataset.theme || null), 'dark', 'the page follows the Dark choice');
    await snap('94-appearance-dark');
    await f.row('Appearance').click();
    await settle(250);
    await f.actionItem(scheme === 'dark' ? 'Dark' : 'Light').click();
    await settle(300);
    await f.row('Appearance').click();
    await settle(250);
    await f.actionItem('System').click();
    await settle(300);

    await f.row('Formats').click();
    await settle(300);
    await f.row('Day / month / year').click();
    await settle(300);
    await f.row('Apostrophe and point').click();
    await settle(300);
    const picked = await state((app) => ({ date: app.settings.dateFormat, number: app.settings.numberFormat }));
    expectEqual(picked, { date: 'dayMonthYear', number: 'apostropheDot' }, 'formats');
    await snap('95-formats-changed');
    const defaults = page.locator('.tabview:not([hidden]) > .page:last-child .row', { hasText: 'System default' });
    await defaults.nth(2).click();
    await defaults.nth(1).click();
    await defaults.nth(0).click();
    await settle(300);
    const reset = await state((app) => ({ date: app.settings.dateFormat, number: app.settings.numberFormat, time: app.settings.timeFormat }));
    expectEqual(reset, { date: 'system', number: 'system', time: 'system' }, 'formats back to the system default');
    await f.back();
  });

  await step('Changing the currency explains that nothing is converted', async () => {
    await f.row('Currency').click();
    await settle(350);
    await page.getByPlaceholder('Search currencies').fill('USD');
    await settle(200);
    await f.sheetRow('USD').click();
    await f.waitDialog('Use USD from now on?');
    const message = await f.dialog().innerText();
    expect(/Nothing is converted/.test(message) && /no exchange rates/i.test(message), `the message says no conversion (got: ${message.replace(/\s+/g, ' ')})`);
    await snap('96-currency-confirm');
    await f.dialogButton('Use USD').click();
    await settle(500);
    expectEqual(await state((app) => app.currency), 'USD', 'currency');
    const unchanged = await state((app) => app.snapshot.expenses.every((e) => e.amount.currencyCode === 'AED'));
    expect(unchanged, 'every saved expense is still in AED');
    await f.tab('Home');
    await settle(500);
    const homeText = await page.locator(TOP).innerText();
    expect(/in another currency/.test(homeText), `Home says that expenses in another currency are not included (got: ${homeText.slice(0, 200).replace(/\s+/g, ' ')})`);
    await snap('96b-home-other-currency');
    await f.tab('Settings');
    await settle(300);
    await f.row('Currency').click();
    await settle(350);
    await page.getByPlaceholder('Search currencies').fill('AED');
    await f.sheetRow('AED').click();
    // Nothing is stored in USD, so there is nothing to explain and no question is asked on the way back.
    await settle(500);
    expect(await page.locator('.dialog').count() === 0, 'no question when nothing is stored in the currency being left');
    expectEqual(await state((app) => app.currency), 'AED', 'currency back');
  });

  await step('Notification switches save, and the amounts switch is separate', async () => {
    await f.row('Notifications').click();
    await settle(350);
    await page.getByRole('switch', { name: /Budget alerts/ }).check({ force: true });
    await page.getByRole('switch', { name: /Repeating expense reminders/ }).check({ force: true });
    await settle(300);
    let now = await state((app) => ({ budget: app.settings.budgetAlertsEnabled, recurring: app.settings.recurringRemindersEnabled, amounts: app.settings.notificationsShowAmounts }));
    expectEqual(now, { budget: true, recurring: true, amounts: false }, 'switches (amounts stay off)');
    await page.getByRole('switch', { name: /Show amounts in alerts/ }).check({ force: true });
    await settle(300);
    await snap('97-notifications-on');
    now = await state((app) => ({ amounts: app.settings.notificationsShowAmounts }));
    expectEqual(now, { amounts: true }, 'amounts switch');
    await page.getByRole('switch', { name: /Show amounts in alerts/ }).uncheck({ force: true });
    await page.getByRole('switch', { name: /Budget alerts/ }).uncheck({ force: true });
    await page.getByRole('switch', { name: /Repeating expense reminders/ }).uncheck({ force: true });
    await settle(300);
    await f.back();
  });

  await step('The Settings page shows what was chosen', async () => {
    await snap('98-settings-after');
    const text = await page.locator('.tabview:not([hidden]) > .page:last-child').innerText();
    expect(/Currency\s+AED/.test(text), 'currency value shown');
    expect(/Monday/.test(text), 'week start value shown');
  });
} finally {
  console.log('\nproblems:', problems);
  console.log('leaked text:', leaks);
  failures = summary();
  await close();
}
process.exit(failures > 0 || problems.length > 0 || leaks.length > 0 ? 1 : 0);
