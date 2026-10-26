// Payment methods and tags: add, rename, reorder, archive, delete what nothing uses. History is never lost.

import { fill, h, plural } from '../dom.js';
import { badge, button, emptyState, group, iconButton, navButton, page, row, sheetContent } from '../components.js';
import { chooseFromList } from './pickers.js';
import { iconGrid } from './style_pickers.js';
import { dragHandle, orderSaver, rememberHandleFocus, reorderable } from './reorder.js';
import { openDrilldown } from './drilldown.js';

const NAME_LIMIT = 40;
const METHOD_ICONS = Object.freeze([
  'banknote', 'creditcard', 'iphone', 'arrow.left.arrow.right', 'building.columns', 'gift', 'star', 'heart', 'laptopcomputer',
  'bag', 'briefcase', 'phone', 'tag',
]);

function methodBadge(method, size = '') {
  return badge({ iconSymbol: method.iconSymbol, colorHex: '#546E7A' }, size);
}

// ---------------------------------------------------------------- payment methods

export function openPaymentMethods(app) {
  app.shell.push(createPaymentMethods);
}

export function createPaymentMethods(app) {
  let reordering = false;
  let stopReorder = null;
  const editToggle = navButton('Reorder', () => { reordering = !reordering; refresh(); });
  const screen = page(app, {
    title: 'Payment methods',
    back: true,
    backLabel: 'Settings',
    trailing: [editToggle, iconButton('plus', 'Add a payment method', () => editPaymentMethod(app))],
  });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);
  const saveOrder = orderSaver((ids) => app.perform('method-order', () => app.services.methods.reorder(ids), { title: 'Could not change the order' }), { onIdle: () => refresh() });

  function usage(id) {
    return app.services.methods.usageCount(id);
  }

  function refresh() {
    if (saveOrder.busy) return; // the list on screen already shows the newest order
    if (stopReorder) stopReorder();
    stopReorder = null;
    const restoreFocus = rememberHandleFocus(holder);
    const snapshot = app.snapshot;
    const active = snapshot.paymentMethods.filter((m) => !m.isArchived);
    const archived = snapshot.paymentMethods.filter((m) => m.isArchived);
    editToggle.firstChild.textContent = reordering ? 'Done' : 'Reorder';
    editToggle.setAttribute('aria-label', reordering ? 'Done reordering' : 'Reorder payment methods');
    editToggle.hidden = active.length < 2;
    const sections = [];

    const defaultMethod = snapshot.settings.defaultPaymentMethodID ? snapshot.paymentMethod(snapshot.settings.defaultPaymentMethodID) : null;
    if (!reordering) {
      sections.push(group([row({
        title: 'Default for new expenses',
        value: defaultMethod && !defaultMethod.isArchived ? defaultMethod.name : 'Last one used',
        chevron: true,
        onClick: async () => {
          const picked = await chooseFromList(app, {
            title: 'Default payment method',
            value: defaultMethod ? defaultMethod.id : '',
            options: [
              { value: '', label: 'Last one used', sub: 'Start with the payment method you picked most recently' },
              ...active.map((m) => ({ value: m.id, label: m.name, badge: methodBadge(m) })),
            ],
          });
          if (picked === undefined) return;
          await app.perform('settings-write', () => app.updateSettings({ defaultPaymentMethodID: picked === '' ? null : picked }), { title: 'Could not save' });
        },
      })]));
    }

    const rows = active.map((method) => {
      const count = usage(method.id);
      const line = row({
        badge: methodBadge(method),
        title: method.name,
        sub: count === 0 ? 'Not used yet' : plural(count, 'use'),
        chevron: !reordering,
        trailing: reordering ? dragHandle(method.name) : null,
        onClick: reordering ? null : () => editPaymentMethod(app, { method }),
        ariaLabel: reordering ? null : `${method.name}, ${count === 0 ? 'not used yet' : plural(count, 'use')}. Edit.`,
      });
      line.dataset.id = method.id;
      return line;
    });
    const activeGroup = group(rows, {
      title: 'In use',
      footer: reordering ? 'Drag the handles to change the order shown when you add an expense.' : 'This is the order shown when you add an expense.',
    });
    sections.push(activeGroup);
    if (reordering) {
      stopReorder = reorderable(activeGroup.querySelector('.group'), { onChange: (ids) => saveOrder.submit(ids) });
    }
    if (archived.length > 0 && !reordering) {
      sections.push(group(archived.map((method) => row({
        badge: methodBadge(method), title: method.name, sub: 'Archived', chevron: true, onClick: () => editPaymentMethod(app, { method }),
      })), { title: 'Archived', footer: 'Archived methods are hidden when adding expenses. Expenses that used them keep their history.' }));
    }
    fill(holder, ...sections);
    restoreFocus();
  }

  return { el: screen.el, refresh, destroy() { if (stopReorder) stopReorder(); } };
}

/** Adds or changes a payment method. Resolves with the saved method, or undefined when cancelled. */
export function editPaymentMethod(app, { method = null } = {}) {
  const { closed } = app.ui.present((_, __, handle) => {
    const editing = method !== null;
    const state = { name: editing ? method.name : '', icon: editing ? method.iconSymbol : 'creditcard' };
    const startSignature = JSON.stringify(state);
    const isDirty = () => JSON.stringify(state) !== startSignature;
    const uses = editing ? app.services.methods.usageCount(method.id) : 0;

    const sheet = sheetContent({
      title: editing ? 'Edit payment method' : 'New payment method',
      onCancel: () => requestClose(),
      actionLabel: 'Save',
      onAction: () => save(),
      actionDisabled: state.name.trim() === '',
    });
    const preview = h('div', { class: 'style-preview' });
    const nameInput = h('input', {
      class: 'input', type: 'text', value: state.name, placeholder: 'For example Corporate card', maxlength: NAME_LIMIT, autocomplete: 'off', autocorrect: 'off', 'aria-label': 'Payment method name', 'data-autofocus': editing ? null : '',
    });
    const names = METHOD_ICONS.includes(state.icon) ? METHOD_ICONS : [state.icon, ...METHOD_ICONS];
    const icons = iconGrid({ value: state.icon, choices: names, onChange: (name) => { state.icon = name; drawPreview(); } });

    function drawPreview() {
      fill(preview,
        badge({ iconSymbol: state.icon, colorHex: '#546E7A' }, 'lg'),
        h('span', { class: 'style-preview-name' }, state.name.trim() === '' ? 'Payment method' : state.name.trim()));
      sheet.setActionDisabled(state.name.trim() === '');
    }
    nameInput.addEventListener('input', () => { state.name = nameInput.value; drawPreview(); });

    async function save() {
      if (state.name.trim() === '') return;
      const result = await app.perform('method-write', async () => {
        if (editing) {
          await app.services.methods.update(method.id, state.name, state.icon);
          return app.snapshot.paymentMethod(method.id);
        }
        return app.services.methods.add(state.name, state.icon);
      }, { title: 'Could not save' });
      if (!result.ok) return;
      handle.close(result.value);
      app.ui.toast(editing ? 'Payment method updated' : 'Payment method added');
    }

    function requestClose() {
      if (!isDirty()) {
        handle.close(undefined);
        return;
      }
      app.ui.confirm({ title: 'Discard your changes?', message: 'What you entered has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', destructive: true })
        .then((yes) => { if (yes) handle.close(undefined); });
    }

    const extras = [];
    if (editing) {
      extras.push(group([row({
        title: method.isArchived ? 'Restore' : 'Archive',
        sub: method.isArchived ? 'Offer it again when adding expenses' : 'Hide it when adding expenses. Nothing is deleted.',
        onClick: async () => {
          const result = await app.perform('method-write', () => app.services.methods.setArchived(!method.isArchived, method.id), { title: 'Could not change it' });
          if (result.ok) handle.close(app.snapshot.paymentMethod(method.id));
        },
      })]));
      if (uses > 0) {
        extras.push(group([row({
          title: 'View expenses', value: plural(uses, 'use'), chevron: true,
          onClick: () => {
            handle.close(undefined);
            openDrilldown(app, {
              title: method.name, subtitle: 'All time', backLabel: 'Payment methods',
              select: (a) => a.snapshot.expenses.filter((e) => e.paymentMethodID === method.id),
            });
          },
        })]));
        extras.push(h('p', { class: 't-foot footnote' }, 'A payment method that expenses use cannot be deleted, so your history stays complete. Archive it to hide it.'));
      } else {
        extras.push(button('Delete payment method', {
          variant: 'danger', block: true,
          onClick: async () => {
            const yes = await app.ui.confirm({ title: 'Delete this payment method?', message: 'Nothing uses it. This cannot be undone.', confirmLabel: 'Delete', destructive: true });
            if (!yes) return;
            const result = await app.perform('method-write', () => app.services.methods.deleteUnused(method.id), { title: 'Could not delete' });
            if (result.ok) {
              handle.close('deleted');
              app.ui.toast('Payment method deleted');
            }
          },
        }));
      }
    }

    sheet.body.append(h('div', { class: 'stack-l' },
      preview,
      h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Name'), nameInput),
      h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Icon'), icons),
      ...extras));
    drawPreview();
    return {
      el: sheet.el,
      label: editing ? 'Edit payment method' : 'New payment method',
      dismissible: () => {
        if (!isDirty()) return true;
        requestClose();
        return false;
      },
    };
  });
  return closed;
}

// ---------------------------------------------------------------- tags

export function openTags(app) {
  app.shell.push(createTags);
}

export function createTags(app) {
  const screen = page(app, { title: 'Tags', back: true, backLabel: 'Settings' });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  function refresh() {
    const tags = app.snapshot.tags;
    if (tags.length === 0) {
      fill(holder, emptyState({
        mark: '🏷️',
        title: 'No tags yet',
        message: 'Tags are short labels you can add to an expense, such as work or trip. Add them when you add an expense, and they appear here.',
      }));
      return;
    }
    fill(holder, group(tags.map((tag) => {
      const count = app.services.tags.usageCount(tag.name);
      return row({
        title: tag.name,
        sub: count === 0 ? 'Not on any expense' : plural(count, 'expense'),
        chevron: true,
        onClick: () => tagActions(app, tag, count),
      });
    }), { footer: 'Renaming or deleting a tag changes it on every expense that has it. The expenses themselves are never deleted.' }));
  }

  return { el: screen.el, refresh };
}

async function tagActions(app, tag, count) {
  const options = [];
  if (count > 0) options.push({ label: 'View expenses', value: 'view' });
  options.push({ label: 'Rename', value: 'rename' }, { label: 'Delete tag', value: 'delete', destructive: true });
  const choice = await app.ui.actions({ title: tag.name, options });
  if (choice === 'view') {
    openDrilldown(app, {
      title: tag.name, subtitle: 'Tag', backLabel: 'Tags',
      select: (a) => a.snapshot.expenses.filter((e) => e.tags.some((t) => t.toLowerCase() === tag.name.toLowerCase())),
    });
  } else if (choice === 'rename') {
    const name = await app.ui.prompt({
      title: 'Rename tag',
      message: count > 0 ? `This changes the tag on ${plural(count, 'expense')}. If another tag already has the new name, the two become one.` : null,
      value: tag.name,
      confirmLabel: 'Rename',
      label: 'Tag name',
      maxLength: NAME_LIMIT,
    });
    if (name === null) return;
    const result = await app.perform('tag-write', () => app.services.tags.rename(tag.name, name), { busy: count > 20 ? 'Renaming…' : null, title: 'Could not rename the tag' });
    if (result.ok) app.ui.toast('Tag renamed');
  } else if (choice === 'delete') {
    const yes = await app.ui.confirm({
      title: 'Delete this tag?',
      message: count > 0 ? `It will be taken off ${plural(count, 'expense')}. The expenses stay.` : 'It is not on any expense.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!yes) return;
    const result = await app.perform('tag-write', () => app.services.tags.delete(tag.name), { busy: count > 20 ? 'Deleting…' : null, title: 'Could not delete the tag' });
    if (result.ok) app.ui.toast('Tag deleted');
  }
}

