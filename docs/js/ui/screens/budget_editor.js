// Adding and editing a budget: how much, what it covers, how often it repeats, and when to warn.
// A budget never changes or deletes any expense. It only measures them.

import { h } from '../dom.js';
import { keypadYieldsToKeyboard } from '../typing.js';
import { badge, chip, group, inputRow, row, segmented, sheetContent, toggleRow } from '../components.js';
import { amountPad } from './amount_pad.js';
import { chooseFromList, dateInput } from './pickers.js';
import { BUDGET_PERIODS, BUDGET_PERIOD_TITLES } from '../../core/models.js';
import { PeriodResolver } from '../../core/periods.js';
import { newId } from '../../core/util.js';

const LEVEL_PRESETS = Object.freeze([50, 75, 80, 90, 100]);
const MAX_LEVEL = 1000;

/** The name a budget gets when none is typed: the category it covers, or "All spending". */
export function defaultBudgetName(app, categoryID) {
  const category = categoryID ? app.snapshot.category(categoryID) : null;
  return category ? category.name : 'All spending';
}

/**
 * Opens the form. Resolves with the saved budget, 'deleted', or undefined when it was closed without saving.
 * @param budget   an existing budget to edit, or null for a new one
 * @param prefill  starting values for a new budget: { categoryID, periodKind }
 */
export function editBudget(app, { budget = null, prefill = null } = {}) {
  const { closed } = app.ui.present((_, __, handle) => buildEditor(app, handle, { budget, prefill }));
  return closed;
}

function buildEditor(app, handle, { budget, prefill }) {
  const editing = budget !== null;
  const currency = editing ? budget.amount.currencyCode : app.currency;
  const today = app.today();
  const f = app.formatter;

  const state = {
    id: editing ? budget.id : newId(),
    name: editing ? budget.name : '',
    categoryID: editing ? budget.categoryID : (prefill && prefill.categoryID) || null,
    periodKind: editing ? budget.periodKind : (prefill && prefill.periodKind) || 'monthly',
    customStart: editing && budget.customStart ? budget.customStart : today.startOfMonth,
    customEnd: editing && budget.customEnd ? budget.customEnd : today.endOfMonth,
    levels: editing ? [...budget.alertThresholds] : [80, 100],
    alerts: editing ? budget.notificationsEnabled : false,
    isActive: editing ? budget.isActive : true,
  };

  let valid = false;
  const pad = amountPad({ app, currencyCode: currency, initial: editing ? budget.amount : null, onChange: () => refresh() });

  const signature = () => JSON.stringify([
    pad.input.money.minorUnits, state.name, state.categoryID, state.periodKind,
    state.periodKind === 'custom' ? [state.customStart && state.customStart.raw, state.customEnd && state.customEnd.raw] : null,
    [...state.levels].sort((a, b) => a - b), state.alerts, state.isActive,
  ]);
  const startSignature = signature();
  const isDirty = () => signature() !== startSignature;

  const sheet = sheetContent({
    title: editing ? 'Edit budget' : 'New budget',
    onCancel: () => requestClose(),
    actionLabel: 'Save',
    onAction: () => save(),
    actionDisabled: true,
    footer: pad.keypad,
  });
  const hint = h('p', { class: 'form-hint', role: 'status' });

  // ------------------------------------------------------------ what it covers

  const scopeRow = row({ title: 'Covers', value: '', chevron: true, onClick: () => chooseScope() });
  const scopeValueEl = scopeRow.querySelector('.row-value');

  async function chooseScope() {
    const active = app.snapshot.activeCategories.slice();
    if (state.categoryID && !active.some((c) => c.id === state.categoryID)) {
      const current = app.snapshot.category(state.categoryID);
      if (current) active.push(current);
    }
    const picked = await chooseFromList(app, {
      title: 'This budget covers',
      value: state.categoryID || '',
      searchable: active.length > 8,
      footer: 'A budget for one category counts only that category. A budget for all spending counts every expense.',
      options: [
        { value: '', label: 'All spending', sub: 'Every category' },
        ...active.map((c) => ({ value: c.id, label: c.isArchived ? `${c.name} (archived)` : c.name, badge: badge(c) })),
      ],
    });
    if (picked === undefined) return;
    state.categoryID = picked === '' ? null : picked;
    nameInput.placeholder = defaultBudgetName(app, state.categoryID);
    drawScope();
    refresh();
  }

  function drawScope() {
    scopeValueEl.textContent = state.categoryID ? (app.snapshot.category(state.categoryID) || { name: 'Unknown category' }).name : 'All spending';
  }

  // ------------------------------------------------------------ how often

  const periodControl = segmented({
    label: 'How often the budget repeats',
    options: BUDGET_PERIODS.map((kind) => ({ value: kind, label: kind === 'custom' ? 'Custom' : BUDGET_PERIOD_TITLES[kind] })),
    value: state.periodKind,
    onChange: (kind) => { state.periodKind = kind; drawPeriod(); refresh(); },
  });
  const periodNote = h('p', { class: 't-foot footnote' });
  const fromInput = dateInput(state.customStart, { label: 'From' });
  const toInput = dateInput(state.customEnd, { label: 'To' });
  const customBlock = h('div', { class: 'group', hidden: true },
    inputRow({ label: 'From', input: fromInput }),
    inputRow({ label: 'To', input: toInput }));
  fromInput.addEventListener('change', () => { state.customStart = fromInput.day(); refresh(); });
  toInput.addEventListener('change', () => { state.customEnd = toInput.day(); refresh(); });

  function drawPeriod() {
    customBlock.hidden = state.periodKind !== 'custom';
    const resolver = new PeriodResolver(app.settings.firstWeekday);
    if (state.periodKind === 'weekly') {
      const week = today.startOfWeek(app.settings.firstWeekday);
      periodNote.textContent = `Starts again every ${f.weekdayLong(week)}. This week: ${f.range(resolver.range('thisWeek', today))}. The first day of the week is set in Settings.`;
    } else if (state.periodKind === 'monthly') {
      periodNote.textContent = `Starts again on the 1st of every month. This month: ${f.monthYear(today)}.`;
    } else {
      periodNote.textContent = 'One fixed period that does not repeat. Both days are included.';
    }
  }

  // ------------------------------------------------------------ name

  const nameInput = h('input', {
    class: 'input', type: 'text', value: state.name, placeholder: defaultBudgetName(app, state.categoryID), autocomplete: 'off', autocorrect: 'off', maxlength: 60, 'aria-label': 'Budget name',
  });
  nameInput.addEventListener('input', () => { state.name = nameInput.value; refresh(); });

  // ------------------------------------------------------------ warning levels and alerts

  const levelRow = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Warning levels' });
  function drawLevels() {
    const shown = Array.from(new Set([...LEVEL_PRESETS, ...state.levels])).sort((a, b) => a - b);
    levelRow.replaceChildren(
      ...shown.map((level) => chip(`${level}%`, { pressed: state.levels.includes(level), onClick: () => toggleLevel(level) })),
      chip('Other…', { onClick: () => addOtherLevel() }));
  }
  function toggleLevel(level) {
    if (state.levels.includes(level)) {
      if (state.levels.length === 1) {
        app.ui.toast('Keep at least one warning level.');
        return;
      }
      state.levels = state.levels.filter((x) => x !== level);
    } else {
      state.levels = [...state.levels, level];
    }
    drawLevels();
    refresh();
  }
  async function addOtherLevel() {
    const typed = await app.ui.prompt({
      title: 'Other warning level',
      message: `Enter a whole percentage of the budget, from 1 to ${MAX_LEVEL}. For example 95.`,
      inputMode: 'numeric',
      confirmLabel: 'Add',
      label: 'Percentage',
      maxLength: 4,
    });
    if (typed === null) return;
    const level = Number(typed.trim().replace(/%$/, ''));
    if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
      await app.ui.alert({ title: 'Not a valid level', message: `Enter a whole number from 1 to ${MAX_LEVEL}.` });
      return;
    }
    if (!state.levels.includes(level)) state.levels = [...state.levels, level];
    drawLevels();
    refresh();
  }

  const alertsToggle = toggleRow({
    title: 'Alert me inside the app',
    sub: 'Shows a message on Home when a level is reached.',
    checked: state.alerts,
    onChange: (checked) => { state.alerts = checked; drawAlertNote(); refresh(); },
  });
  const alertNote = h('p', { class: 't-foot footnote' });
  function drawAlertNote() {
    const lines = ['Alerts only appear while the app is open. This app has no server, so it cannot wake your iPhone to tell you.'];
    if (state.alerts && !app.settings.budgetAlertsEnabled) lines.push('Budget alerts are switched off in Settings, so none will show until you switch them on there.');
    alertNote.textContent = lines.join(' ');
  }

  const activeToggle = editing
    ? toggleRow({
      title: 'Active', sub: 'A paused budget is not measured and gives no alerts.', checked: state.isActive,
      onChange: (checked) => { state.isActive = checked; refresh(); },
    })
    : null;

  // ------------------------------------------------------------ saving and leaving

  function toDraft() {
    const typed = state.name.trim();
    return {
      id: state.id,
      name: typed === '' ? defaultBudgetName(app, state.categoryID) : typed,
      categoryID: state.categoryID,
      periodKind: state.periodKind,
      customStart: state.periodKind === 'custom' ? state.customStart : null,
      customEnd: state.periodKind === 'custom' ? state.customEnd : null,
      amount: pad.input.money,
      alertThresholds: [...state.levels].sort((a, b) => a - b),
      notificationsEnabled: state.alerts,
      isActive: state.isActive,
    };
  }

  function refresh() {
    let message = '';
    let bad = false;
    if (!(pad.input.money.minorUnits > 0)) {
      message = 'Enter how much you can spend.';
    } else if (state.periodKind === 'custom') {
      if (!state.customStart || !state.customEnd) {
        message = 'Choose both dates.';
        bad = true;
      } else if (state.customEnd.raw < state.customStart.raw) {
        message = 'The end date cannot be before the start date.';
        bad = true;
      }
    }
    hint.textContent = message;
    hint.classList.toggle('bad', bad);
    valid = message === '';
    sheet.setActionDisabled(!valid);
  }

  async function save() {
    if (!valid) return;
    const draft = toDraft();
    const result = await app.perform('budget-write', () => app.services.budgets.save(draft), { title: 'Could not save the budget' });
    if (!result.ok) return;
    handle.close(result.value);
    app.ui.toast(editing ? 'Budget updated' : 'Budget added');
  }

  async function remove() {
    const yes = await app.ui.confirm({
      title: 'Delete this budget?',
      message: 'Your expenses are not affected. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!yes) return;
    const result = await app.perform('budget-write', () => app.services.budgets.delete(state.id), { title: 'Could not delete the budget' });
    if (!result.ok) return;
    handle.close('deleted');
    app.ui.toast('Budget deleted');
  }

  function requestClose() {
    if (!isDirty()) {
      handle.close(undefined);
      return;
    }
    app.ui.confirm({ title: 'Discard this budget?', message: 'What you entered has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', destructive: true })
      .then((yes) => { if (yes) handle.close(undefined); });
  }

  // ------------------------------------------------------------ put it together

  sheet.body.append(
    h('div', { class: 'amount-block' }, h('p', { class: 't-sub t-center' }, 'Budget amount'), pad.display, hint),
    h('div', { class: 'stack' }, group([scopeRow])),
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Repeats'), periodControl, customBlock, periodNote),
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Name (optional)'), nameInput),
    h('section', { class: 'section' },
      h('h2', { class: 'section-title' }, 'Warning levels'),
      levelRow,
      h('p', { class: 't-foot footnote' }, 'The budget is shown as close to its limit once spending reaches the lowest level below 100%. With alerts on, you are told as each level is reached.')),
    h('section', { class: 'section' }, h('div', { class: 'group' }, alertsToggle), alertNote),
    ...(activeToggle ? [h('section', { class: 'section' }, h('div', { class: 'group' }, activeToggle))] : []),
    ...(editing ? [h('button', { type: 'button', class: 'btn danger block', onClick: () => remove() }, 'Delete budget')] : []));

  drawScope();
  drawPeriod();
  drawLevels();
  drawAlertNote();
  refresh();

  keypadYieldsToKeyboard(sheet.el);
  const detachKeys = pad.attachKeys(sheet.el);

  return {
    el: sheet.el,
    label: editing ? 'Edit budget' : 'New budget',
    dismissible: () => {
      if (!isDirty()) return true;
      requestClose();
      return false;
    },
    destroy() {
      detachKeys();
      pad.destroy();
    },
  };
}
