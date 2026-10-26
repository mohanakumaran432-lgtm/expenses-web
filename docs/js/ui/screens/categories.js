// Managing categories: the list, one category in detail (with its subcategories), the editor, and safe merging.
// Nothing here ever deletes spending history. A category that expenses use can be archived or merged, never deleted.

import { fill, h, plural } from '../dom.js';
import { icon } from '../icons.js';
import { badge, button, group, iconButton, navButton, emptyState, notice, page, row, sheetContent } from '../components.js';
import { saturatingAdd } from '../../core/util.js';
import { money } from '../../core/money.js';
import { chooseFromList } from './pickers.js';
import { colorGrid, iconGrid, isHexColor } from './style_pickers.js';
import { dragHandle, orderSaver, rememberHandleFocus, reorderable } from './reorder.js';
import { openDrilldown } from './drilldown.js';
import { editBudget } from './budget_editor.js';

const NAME_LIMIT = 40;

/** Count and total (in the app's currency) of the expenses in each category. */
function totalsByCategory(app) {
  const map = new Map();
  const code = app.currency;
  for (const expense of app.snapshot.expenses) {
    let entry = map.get(expense.categoryID);
    if (!entry) {
      entry = { count: 0, minor: 0 };
      map.set(expense.categoryID, entry);
    }
    entry.count += 1;
    if (expense.amount.currencyCode === code) entry.minor = saturatingAdd(entry.minor, expense.amount.minorUnits);
  }
  return map;
}

function figureOf(map, id) {
  return map.get(id) || { count: 0, minor: 0 };
}

// ---------------------------------------------------------------- the list

export function openCategories(app) {
  app.shell.push(createCategories);
}

export function createCategories(app) {
  let reordering = false;
  let stopReorder = null;
  const editToggle = navButton('Reorder', () => { reordering = !reordering; refresh(); });
  const screen = page(app, {
    title: 'Categories',
    back: true,
    backLabel: 'Settings',
    trailing: [editToggle, iconButton('plus', 'Add a category', () => editCategory(app))],
  });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);
  const saveOrder = orderSaver((ids) => app.perform('category-order', () => app.services.categories.reorderCategories(ids), { title: 'Could not change the order' }), { onIdle: () => refresh() });

  function refresh() {
    if (saveOrder.busy) return; // the list on screen already shows the newest order
    if (stopReorder) stopReorder();
    stopReorder = null;
    const restoreFocus = rememberHandleFocus(holder);
    const f = app.formatter;
    const snapshot = app.snapshot;
    const totals = totalsByCategory(app);
    const active = snapshot.categories.filter((c) => !c.isArchived);
    const archived = snapshot.categories.filter((c) => c.isArchived);
    editToggle.firstChild.textContent = reordering ? 'Done' : 'Reorder';
    editToggle.setAttribute('aria-label', reordering ? 'Done reordering' : 'Reorder categories');
    editToggle.hidden = active.length < 2;
    const sections = [];

    const activeRows = active.map((category) => {
      const figure = figureOf(totals, category.id);
      const line = row({
        badge: badge(category),
        title: category.name,
        sub: plural(figure.count, 'transaction'),
        amount: figure.count > 0 ? f.money.string(money(figure.minor, app.currency)) : null,
        chevron: !reordering,
        trailing: reordering ? dragHandle(category.name) : null,
        ariaLabel: reordering ? null : `${category.name}, ${plural(figure.count, 'transaction')}${figure.minor > 0 ? `, ${f.money.string(money(figure.minor, app.currency))}` : ''}. Open.`,
        onClick: reordering ? null : () => openCategoryPage(app, category.id),
      });
      line.dataset.id = category.id;
      return line;
    });
    const activeGroup = group(activeRows, {
      title: 'In use',
      footer: reordering
        ? 'Drag the handles to change the order. This is the order shown when you add an expense.'
        : 'This is the order shown when you add an expense. Totals are all time, in your currency.',
    });
    sections.push(activeGroup);
    if (reordering) {
      stopReorder = reorderable(activeGroup.querySelector('.group'), { onChange: (ids) => saveOrder.submit(ids) });
    }

    if (archived.length > 0 && !reordering) {
      sections.push(group(archived.map((category) => {
        const target = category.mergedIntoID ? snapshot.category(category.mergedIntoID) : null;
        const figure = figureOf(totals, category.id);
        return row({
          badge: badge(category),
          title: category.name,
          sub: target ? `Merged into ${target.name}` : `Archived · ${plural(figure.count, 'transaction')}`,
          chevron: true,
          onClick: () => openCategoryPage(app, category.id),
        });
      }), { title: 'Archived and merged', footer: 'Archived categories are hidden when adding expenses. Their expenses stay in your history and reports.' }));
    }
    fill(holder, ...sections);
    restoreFocus();
  }

  return { el: screen.el, refresh, destroy() { if (stopReorder) stopReorder(); } };
}

// ---------------------------------------------------------------- the editor

/** Adds or changes a category's name, icon and colour. Resolves with the saved category, or undefined when cancelled. */
export function editCategory(app, { category = null } = {}) {
  const { closed } = app.ui.present((_, __, handle) => {
    const editing = category !== null;
    const state = {
      name: editing ? category.name : '',
      icon: editing ? category.iconSymbol : 'tag',
      color: editing ? category.colorHex : '#546E7A',
    };
    const startSignature = JSON.stringify(state);
    const isDirty = () => JSON.stringify(state) !== startSignature;

    const sheet = sheetContent({
      title: editing ? 'Edit category' : 'New category',
      onCancel: () => requestClose(),
      actionLabel: 'Save',
      onAction: () => save(),
      actionDisabled: state.name.trim() === '',
    });
    const preview = h('div', { class: 'style-preview' });
    const nameInput = h('input', {
      class: 'input', type: 'text', value: state.name, placeholder: 'For example Pets', maxlength: NAME_LIMIT, autocomplete: 'off', autocorrect: 'off', 'aria-label': 'Category name', 'data-autofocus': editing ? null : '',
    });
    const icons = iconGrid({ value: state.icon, onChange: (name) => { state.icon = name; drawPreview(); } });
    const colors = colorGrid({ value: state.color, onChange: (hex) => { state.color = hex; drawPreview(); } });

    function drawPreview() {
      fill(preview,
        badge({ iconSymbol: state.icon, colorHex: isHexColor(state.color) ? state.color : '#8E8E93' }, 'lg'),
        h('span', { class: 'style-preview-name' }, state.name.trim() === '' ? 'Category name' : state.name.trim()));
      sheet.setActionDisabled(state.name.trim() === '');
    }
    nameInput.addEventListener('input', () => { state.name = nameInput.value; drawPreview(); });

    async function save() {
      if (state.name.trim() === '') return;
      const result = await app.perform('category-write', async () => {
        if (editing) {
          await app.services.categories.updateCategory(category.id, state.name, state.icon, state.color);
          return app.snapshot.category(category.id);
        }
        return app.services.categories.addCategory(state.name, state.icon, state.color);
      }, { title: 'Could not save the category' });
      if (!result.ok) return;
      handle.close(result.value);
      app.ui.toast(editing ? 'Category updated' : 'Category added');
    }

    function requestClose() {
      if (!isDirty()) {
        handle.close(undefined);
        return;
      }
      app.ui.confirm({ title: 'Discard your changes?', message: 'What you entered has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', destructive: true })
        .then((yes) => { if (yes) handle.close(undefined); });
    }

    sheet.body.append(
      h('div', { class: 'stack-l' },
        preview,
        h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Name'), nameInput),
        h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Icon'), icons),
        h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Colour'), colors,
          h('p', { class: 't-foot footnote' }, 'The colour is used on charts and badges. Charts also show names, amounts and percentages, so no one has to tell colours apart.'))));
    drawPreview();
    return {
      el: sheet.el,
      label: editing ? 'Edit category' : 'New category',
      dismissible: () => {
        if (!isDirty()) return true;
        requestClose();
        return false;
      },
    };
  });
  return closed;
}

// ---------------------------------------------------------------- one category

export function openCategoryPage(app, categoryID) {
  app.shell.push(createCategoryPage, { categoryID });
}

function expensesOf(app, categoryID) {
  return app.snapshot.expenses.filter((e) => e.categoryID === categoryID);
}

export function createCategoryPage(app, params) {
  const { categoryID } = params;
  let reorderingSubs = false;
  let stopReorder = null;
  const editButton = navButton('Edit', async () => {
    const category = app.snapshot.category(categoryID);
    if (category) await editCategory(app, { category });
  }, { strong: true });
  const screen = page(app, { title: 'Category', back: true, backLabel: 'Categories', trailing: editButton });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);
  const saveOrder = orderSaver((ids) => app.perform('subcategory-order', () => app.services.categories.reorderSubcategories(categoryID, ids), { title: 'Could not change the order' }), { onIdle: () => refresh() });

  function refresh() {
    if (saveOrder.busy) return; // the list on screen already shows the newest order
    if (stopReorder) stopReorder();
    stopReorder = null;
    const restoreFocus = rememberHandleFocus(holder);
    const f = app.formatter;
    const snapshot = app.snapshot;
    const category = snapshot.category(categoryID);
    if (!category) {
      editButton.hidden = true;
      fill(holder, emptyState({ mark: '🏷️', title: 'This category is gone', message: 'It was deleted. Go back to see your categories.' }));
      return;
    }
    screen.setTitle(category.name);
    const mergedInto = category.mergedIntoID ? snapshot.category(category.mergedIntoID) : null;
    editButton.hidden = Boolean(mergedInto);
    const totals = totalsByCategory(app);
    const figure = figureOf(totals, categoryID);
    const total = money(figure.minor, app.currency);
    const thisMonth = (() => {
      const today = app.today();
      let minor = 0;
      for (const e of expensesOf(app, categoryID)) {
        if (e.amount.currencyCode === app.currency && e.localDay.year === today.year && e.localDay.month === today.month) minor = saturatingAdd(minor, e.amount.minorUnits);
      }
      return money(minor, app.currency);
    })();
    const usage = app.services.categories.usageOfCategory(categoryID);
    const subs = snapshot.subcategoriesOf(categoryID, true);
    const activeSubs = subs.filter((s) => !s.isArchived);
    const archivedSubs = subs.filter((s) => s.isArchived);
    const sections = [];

    sections.push(h('div', { class: 'style-preview' },
      badge(category, 'lg'),
      h('div', { class: 'grow' },
        h('div', { class: 'style-preview-name' }, category.name),
        h('div', { class: 't-sub' }, mergedInto ? `Merged into ${mergedInto.name}` : category.isArchived ? 'Archived: hidden when adding expenses' : 'In use'))));

    sections.push(group([
      row({ title: 'Transactions', value: String(figure.count) }),
      row({ title: 'Total spent', sub: 'All time', value: f.money.string(total) }),
      row({ title: 'This month', value: f.money.string(thisMonth) }),
      row({
        title: 'View transactions', chevron: figure.count > 0, disabled: figure.count === 0,
        onClick: figure.count > 0 ? () => openDrilldown(app, {
          title: category.name, subtitle: 'All time', backLabel: 'Category', select: (a) => expensesOf(a, categoryID),
        }) : null,
      }),
    ]));

    // ---- subcategories
    const subRows = activeSubs.map((sub) => {
      const count = snapshot.expenses.filter((e) => e.subcategoryID === sub.id).length;
      const line = row({
        title: sub.name,
        sub: plural(count, 'transaction'),
        chevron: !reorderingSubs,
        trailing: reorderingSubs ? dragHandle(sub.name) : null,
        onClick: reorderingSubs ? null : () => subcategoryActions(app, sub),
        ariaLabel: reorderingSubs ? null : `${sub.name}, ${plural(count, 'transaction')}. Options.`,
      });
      line.dataset.id = sub.id;
      return line;
    });
    if (!reorderingSubs && !mergedInto) {
      subRows.push(row({ title: h('span', { class: 't-accent' }, 'Add a subcategory'), onClick: () => addSubcategory(app, categoryID) }));
    }
    const subGroup = group(subRows, {
      title: 'Subcategories',
      titleAction: activeSubs.length > 1 ? h('button', { type: 'button', class: 'section-link', onClick: () => { reorderingSubs = !reorderingSubs; refresh(); } }, reorderingSubs ? 'Done' : 'Reorder') : null,
      footer: activeSubs.length === 0 ? 'Subcategories are optional. Use them to split a category, for example Fuel into Petrol and Car wash.' : null,
    });
    sections.push(subGroup);
    if (reorderingSubs) {
      stopReorder = reorderable(subGroup.querySelector('.group'), { onChange: (ids) => saveOrder.submit(ids) });
    }
    if (archivedSubs.length > 0 && !reorderingSubs) {
      sections.push(group(archivedSubs.map((sub) => {
        const target = sub.mergedIntoID ? snapshot.subcategory(sub.mergedIntoID) : null;
        return row({
          title: sub.name, sub: target ? `Merged into ${target.name}` : 'Archived', chevron: true,
          onClick: () => subcategoryActions(app, sub),
        });
      }), { title: 'Archived subcategories' }));
    }

    // ---- what can be done with the whole category
    if (!mergedInto) {
      const actions = [];
      if (!category.isArchived) {
        actions.push(row({
          title: 'Set a budget for this category', chevron: true,
          onClick: () => editBudget(app, { prefill: { categoryID } }),
        }));
        actions.push(row({
          title: 'Merge into another category…', sub: 'Moves everything across, then archives this one', chevron: true,
          onClick: async () => { if (await mergeCategoryFlow(app, category)) app.shell.pop(); },
        }));
      }
      actions.push(row({
        title: category.isArchived ? 'Restore this category' : 'Archive this category',
        sub: category.isArchived ? 'Show it again when adding expenses' : 'Hide it when adding expenses. Nothing is deleted.',
        onClick: async () => {
          if (!category.isArchived) {
            const yes = await app.ui.confirm({
              title: 'Archive this category?',
              message: `${category.name} will no longer be offered when you add an expense. Its ${plural(usage.expenseCount, 'expense')} stay in your history and reports.`,
              confirmLabel: 'Archive',
            });
            if (!yes) return;
          }
          const result = await app.perform('category-write', () => app.services.categories.setCategoryArchived(!category.isArchived, categoryID), { title: 'Could not change the category' });
          if (result.ok) app.ui.toast(category.isArchived ? 'Category restored' : 'Category archived');
        },
      }));
      sections.push(group(actions));
    }
    if (usage.isUnused && !snapshot.categories.some((c) => c.mergedIntoID === categoryID)) {
      sections.push(button('Delete this category', {
        variant: 'danger', block: true,
        onClick: async () => {
          const yes = await app.ui.confirm({
            title: 'Delete this category?',
            message: 'Nothing uses it, so no expenses are affected. This cannot be undone.',
            confirmLabel: 'Delete', destructive: true,
          });
          if (!yes) return;
          const result = await app.perform('category-write', () => app.services.categories.deleteUnusedCategory(categoryID), { title: 'Could not delete the category' });
          if (result.ok) {
            app.ui.toast('Category deleted');
            app.shell.pop();
          }
        },
      }));
    } else if (!mergedInto) {
      sections.push(h('p', { class: 't-foot footnote' },
        'A category that expenses, budgets or repeating expenses use cannot be deleted, so your history stays complete. Archive it to hide it, or merge it into another category.'));
    }
    fill(holder, ...sections);
    restoreFocus();
  }

  return { el: screen.el, refresh, destroy() { if (stopReorder) stopReorder(); } };
}

// ---------------------------------------------------------------- merging

/** Asks where to merge a category and does it. Resolves with the target category, or null when cancelled or not possible. */
export async function mergeCategoryFlow(app, source) {
  const targets = app.snapshot.activeCategories.filter((c) => c.id !== source.id);
  if (targets.length === 0) {
    await app.ui.alert({ title: 'Nothing to merge into', message: 'You need another category in use to merge this one into.' });
    return null;
  }
  const targetID = await chooseFromList(app, {
    title: `Merge ${source.name} into`,
    searchable: targets.length > 8,
    options: targets.map((c) => ({ value: c.id, label: c.name, badge: badge(c) })),
    footer: 'Expenses, subcategories, budgets and repeating expenses move to the category you choose.',
  });
  if (!targetID) return null;
  const target = app.snapshot.category(targetID);
  const usage = app.services.categories.usageOfCategory(source.id);
  const parts = [plural(usage.expenseCount, 'expense')];
  if (usage.subcategoryCount > 0) parts.push(plural(usage.subcategoryCount, 'subcategory', 'subcategories'));
  if (usage.budgetCount > 0) parts.push(plural(usage.budgetCount, 'budget'));
  if (usage.templateCount > 0) parts.push(plural(usage.templateCount, 'repeating expense'));
  const yes = await app.ui.confirm({
    title: `Merge into ${target.name}?`,
    message: `${parts.join(', ')} will move to ${target.name}. ${source.name} will be archived and kept on record as merged. Nothing is deleted. A merge cannot be undone.`,
    confirmLabel: 'Merge',
    destructive: true,
  });
  if (!yes) return null;
  const result = await app.perform('category-merge', () => app.services.categories.mergeCategory(source.id, targetID), { busy: 'Merging…', title: 'Could not merge' });
  if (!result.ok) return null;
  app.ui.toast(`Merged into ${target.name}`);
  return target;
}

// ---------------------------------------------------------------- subcategories

async function addSubcategory(app, categoryID) {
  const name = await app.ui.prompt({ title: 'New subcategory', message: 'For example Petrol or Car wash.', confirmLabel: 'Add', label: 'Subcategory name', maxLength: NAME_LIMIT });
  if (name === null) return;
  const result = await app.perform('category-write', () => app.services.categories.addSubcategory(categoryID, name), { title: 'Could not add the subcategory' });
  if (result.ok) app.ui.toast('Subcategory added');
}

async function subcategoryActions(app, sub) {
  const snapshot = app.snapshot;
  const used = snapshot.expenses.some((e) => e.subcategoryID === sub.id)
    || snapshot.templates.some((t) => t.subcategoryID === sub.id)
    || snapshot.subcategories.some((s) => s.mergedIntoID === sub.id);
  const siblings = snapshot.subcategoriesOf(sub.categoryID).filter((s) => s.id !== sub.id);
  const options = [];
  if (snapshot.expenses.some((e) => e.subcategoryID === sub.id)) options.push({ label: 'View transactions', value: 'view' });
  if (!sub.mergedIntoID) {
    options.push({ label: 'Rename', value: 'rename' });
    if (!sub.isArchived && siblings.length > 0) options.push({ label: 'Merge into another subcategory…', value: 'merge' });
    options.push({ label: sub.isArchived ? 'Restore' : 'Archive', value: 'archive' });
  }
  if (!used) options.push({ label: 'Delete', value: 'delete', destructive: true });
  if (options.length === 0) return;
  const choice = await app.ui.actions({ title: sub.name, options });
  if (choice === undefined) return;
  const run = (key, task, title) => app.perform(key, task, { title });
  if (choice === 'view') {
    const category = snapshot.category(sub.categoryID);
    openDrilldown(app, {
      title: `${category ? category.name : 'Category'} › ${sub.name}`, subtitle: 'All time', backLabel: 'Category',
      select: (a) => a.snapshot.expenses.filter((e) => e.subcategoryID === sub.id),
    });
  } else if (choice === 'rename') {
    const name = await app.ui.prompt({ title: 'Rename subcategory', value: sub.name, confirmLabel: 'Rename', label: 'Subcategory name', maxLength: NAME_LIMIT });
    if (name !== null) await run('category-write', () => app.services.categories.renameSubcategory(sub.id, name), 'Could not rename');
  } else if (choice === 'archive') {
    await run('category-write', () => app.services.categories.setSubcategoryArchived(!sub.isArchived, sub.id), 'Could not change the subcategory');
  } else if (choice === 'delete') {
    const yes = await app.ui.confirm({ title: 'Delete this subcategory?', message: 'Nothing uses it. This cannot be undone.', confirmLabel: 'Delete', destructive: true });
    if (yes) await run('category-write', () => app.services.categories.deleteUnusedSubcategory(sub.id), 'Could not delete');
  } else if (choice === 'merge') {
    const targetID = await chooseFromList(app, {
      title: `Merge ${sub.name} into`,
      options: siblings.map((s) => ({ value: s.id, label: s.name })),
      footer: 'Its expenses move to the subcategory you choose, and this one is archived and kept on record as merged.',
    });
    if (!targetID) return;
    const target = snapshot.subcategory(targetID);
    const count = snapshot.expenses.filter((e) => e.subcategoryID === sub.id).length;
    const yes = await app.ui.confirm({
      title: `Merge into ${target.name}?`,
      message: `${plural(count, 'expense')} will move to ${target.name}. A merge cannot be undone.`,
      confirmLabel: 'Merge', destructive: true,
    });
    if (yes) {
      const result = await app.perform('category-merge', () => app.services.categories.mergeSubcategory(sub.id, targetID), { busy: 'Merging…', title: 'Could not merge' });
      if (result.ok) app.ui.toast(`Merged into ${target.name}`);
    }
  }
}
