// Adding and editing an expense. One sheet for both. Typing an amount and tapping a category is all that is needed;
// everything else is optional.

import { h, uid } from '../dom.js';
import { keypadYieldsToKeyboard } from '../typing.js';
import { icon } from '../icons.js';
import { badge, chip, sheetContent } from '../components.js';
import { amountPad } from './amount_pad.js';
import { editDraft, expenseProblemMessage } from '../../core/expense_service.js';
import { makeDraft } from '../../core/models.js';
import { MAX_TAGS_PER_EXPENSE, tag as normalizeTag } from '../../core/text.js';
import { LocalDate } from '../../core/localdate.js';
import { EARLIEST_DAY, MAX_DAYS_IN_FUTURE } from '../../core/validation.js';
import { zero } from '../../core/money.js';
import { recurringPrefill } from '../../core/recurrence_service.js';

/**
 * Opens the form. Resolves with the saved expense, 'deleted', or undefined when it was closed without saving.
 * @param expense  an existing expense to edit, or null for a new one
 * @param prefill  starting values for a new expense (a copy of another expense, for instance): a partial draft without an id
 */
export function openExpenseForm(app, { expense = null, prefill = null } = {}) {
  const { closed } = app.ui.present((_, __, handle) => buildForm(app, handle, { expense, prefill }));
  return closed;
}

function timeText(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildForm(app, handle, { expense, prefill }) {
  const editing = expense !== null;
  const currency = editing ? expense.amount.currencyCode : app.currency;
  const zone = editing ? expense.timeZoneID : app.timeZone();
  const today = app.today();
  const services = app.services;

  const defaultMethod = (() => {
    const wanted = app.settings.defaultPaymentMethodID || services.expenses.recentPaymentMethodID();
    return wanted && app.snapshot.paymentMethod(wanted) && !app.snapshot.paymentMethod(wanted).isArchived ? wanted : null;
  })();
  const base = editing
    ? editDraft(expense)
    : makeDraft({ amount: zero(currency), day: today, timeZoneID: zone, paymentMethodID: defaultMethod, ...(prefill || {}) });

  const state = {
    id: base.id,
    day: base.day,
    hasTime: base.hasExplicitTime,
    hour: base.hour,
    minute: base.minute,
    categoryID: base.categoryID,
    subcategoryID: base.subcategoryID,
    paymentMethodID: base.paymentMethodID,
    merchant: base.merchant,
    notes: base.notes,
    tags: [...base.tags],
    recurringTemplateID: base.recurringTemplateID,
    occurrenceKey: base.occurrenceKey,
    repeat: null, // a schedule chosen in this form, saved together with the expense
  };

  let valid = false;
  let describeSchedule = null; // loaded the first time the schedule editor is opened
  const pad = amountPad({ app, currencyCode: currency, initial: base.amount, onChange: () => refresh() });

  function toDraft() {
    return makeDraft({
      id: state.id,
      amount: pad.input.money,
      day: state.day || today,
      hasExplicitTime: state.hasTime,
      hour: state.hour,
      minute: state.minute,
      timeZoneID: zone,
      categoryID: state.categoryID,
      subcategoryID: state.subcategoryID,
      paymentMethodID: state.paymentMethodID,
      merchant: state.merchant,
      notes: state.notes,
      tags: state.tags,
      recurringTemplateID: state.recurringTemplateID,
      occurrenceKey: state.occurrenceKey,
    });
  }

  const signature = () => JSON.stringify([
    pad.input.money.minorUnits, state.day && state.day.raw, state.hasTime, state.hour, state.minute, state.categoryID, state.subcategoryID,
    state.paymentMethodID, state.merchant, state.notes, state.tags, state.repeat !== null,
  ]);
  const startSignature = signature();
  const isDirty = () => signature() !== startSignature;

  // ------------------------------------------------------------ the sheet frame

  const sheet = sheetContent({
    title: editing ? 'Edit expense' : 'New expense',
    onCancel: () => requestClose(),
    actionLabel: 'Save',
    onAction: () => save(),
    actionDisabled: true,
    footer: pad.keypad,
  });
  const hint = h('p', { class: 'form-hint', role: 'status' });
  const notices = h('div', { class: 'stack-s' });

  // ------------------------------------------------------------ date and time

  const dayInput = h('input', {
    class: 'input bare', type: 'date', value: state.day.toString(), min: EARLIEST_DAY.toString(), max: today.addingDays(MAX_DAYS_IN_FUTURE).toString(),
    'aria-label': 'Date', required: true,
  });
  const todayChip = chip('Today', { onClick: () => setDay(today) });
  const yesterdayChip = chip('Yesterday', { onClick: () => setDay(today.addingDays(-1)) });
  function setDay(day) {
    state.day = day;
    if (day) dayInput.value = day.toString();
    refresh();
  }
  dayInput.addEventListener('change', () => setDay(LocalDate.fromISO(dayInput.value)));

  const timeInput = h('input', { class: 'input bare', type: 'time', value: timeText(state.hour, state.minute), 'aria-label': 'Time' });
  timeInput.addEventListener('change', () => {
    const match = /^(\d{1,2}):(\d{2})/.exec(timeInput.value);
    if (match) {
      state.hour = Number(match[1]);
      state.minute = Number(match[2]);
    }
    refresh();
  });
  const timeId = uid('time');
  const dateId = uid('date');
  const timeRow = h('div', { class: 'input-row', hidden: !state.hasTime }, h('label', { for: timeId }, 'Time'), timeInput);
  timeInput.id = timeId;
  const timeSwitch = h('input', { type: 'checkbox', role: 'switch', checked: state.hasTime, 'aria-checked': state.hasTime ? 'true' : 'false', 'aria-label': 'Add a time' });
  timeSwitch.addEventListener('change', () => {
    state.hasTime = timeSwitch.checked;
    timeSwitch.setAttribute('aria-checked', state.hasTime ? 'true' : 'false');
    timeRow.hidden = !state.hasTime;
    refresh();
  });

  dayInput.id = dateId;
  const dateBlock = h('div', { class: 'group' },
    h('div', { class: 'input-row' }, h('label', { for: dateId }, 'Date'), dayInput),
    h('label', { class: 'row pressable' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, 'Add a time')), h('span', { class: 'switch' }, timeSwitch, h('span', { class: 'track' }))),
    timeRow);
  const dateChips = h('div', { class: 'chip-row' }, todayChip, yesterdayChip);

  // ------------------------------------------------------------ category and subcategory

  const categoryButtons = new Map(); // category id -> buttons that show it (recent row + grid)
  const recentRow = h('div', { class: 'chip-scroll', role: 'group', 'aria-label': 'Recently used categories' });
  const grid = h('div', { class: 'tile-grid', role: 'group', 'aria-label': 'Categories' });
  const subSection = h('section', { class: 'section', hidden: true });
  const subRow = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Subcategories' });
  const recentLabel = h('h3', { class: 'section-title' }, 'Recent');

  function categoriesToShow() {
    const list = app.snapshot.activeCategories.slice();
    if (state.categoryID && !list.some((c) => c.id === state.categoryID)) {
      const current = app.snapshot.category(state.categoryID);
      if (current) list.push(current);
    }
    return list;
  }

  function remember(id, el) {
    if (!categoryButtons.has(id)) categoryButtons.set(id, []);
    categoryButtons.get(id).push(el);
  }

  function drawCategories() {
    categoryButtons.clear();
    const categories = categoriesToShow();
    grid.replaceChildren(...categories.map((category) => {
      const tile = h('button', { type: 'button', class: 'tile', 'aria-pressed': 'false', onClick: () => chooseCategory(category.id) },
        badge(category), h('span', null, category.isArchived ? `${category.name} (archived)` : category.name));
      remember(category.id, tile);
      return tile;
    }));
    const recent = services.expenses.recentCategoryIDs(6).map((id) => app.snapshot.category(id)).filter(Boolean);
    recentRow.replaceChildren(...recent.map((category) => {
      const button = h('button', { type: 'button', class: 'chip with-badge', 'aria-pressed': 'false', onClick: () => chooseCategory(category.id) },
        badge(category, 'sm'), h('span', null, category.name));
      remember(category.id, button);
      return button;
    }));
    recentLabel.hidden = recent.length === 0;
    recentRow.hidden = recent.length === 0;
    markCategory();
  }

  function markCategory() {
    for (const [id, buttons] of categoryButtons) {
      for (const button of buttons) button.setAttribute('aria-pressed', id === state.categoryID ? 'true' : 'false');
    }
  }

  function drawSubcategories() {
    const subs = state.categoryID ? app.snapshot.subcategoriesOf(state.categoryID) : [];
    const current = state.subcategoryID ? app.snapshot.subcategory(state.subcategoryID) : null;
    const list = current && current.isArchived && !subs.some((s) => s.id === current.id) ? [...subs, current] : subs;
    subSection.hidden = list.length === 0;
    subRow.replaceChildren(
      chip('None', { pressed: state.subcategoryID === null, onClick: () => { state.subcategoryID = null; drawSubcategories(); refresh(); } }),
      ...list.map((sub) => chip(sub.name, { pressed: state.subcategoryID === sub.id, onClick: () => { state.subcategoryID = sub.id; drawSubcategories(); refresh(); } })));
  }

  function chooseCategory(id) {
    if (state.categoryID !== id) state.subcategoryID = null;
    state.categoryID = id;
    markCategory();
    drawSubcategories();
    drawMerchantSuggestions();
    refresh();
  }

  // ------------------------------------------------------------ payment method

  const methodRow = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Payment method' });
  function drawMethods() {
    const active = app.snapshot.activePaymentMethods.slice();
    const current = state.paymentMethodID ? app.snapshot.paymentMethod(state.paymentMethodID) : null;
    if (current && !active.some((m) => m.id === current.id)) active.push(current);
    methodRow.replaceChildren(
      chip('None', { pressed: state.paymentMethodID === null, onClick: () => { state.paymentMethodID = null; drawMethods(); refresh(); } }),
      ...active.map((method) => chip(method.isArchived ? `${method.name} (archived)` : method.name, {
        pressed: state.paymentMethodID === method.id, onClick: () => { state.paymentMethodID = method.id; drawMethods(); refresh(); },
      })));
  }

  // ------------------------------------------------------------ merchant, notes, tags

  const merchantInput = h('input', {
    class: 'input', type: 'text', value: state.merchant, placeholder: 'For example Spinneys', autocomplete: 'off', autocorrect: 'off', maxlength: 120, 'aria-label': 'Merchant',
  });
  const merchantChips = h('div', { class: 'chip-row' });
  merchantInput.addEventListener('input', () => { state.merchant = merchantInput.value; drawMerchantSuggestions(); refresh(); });
  function drawMerchantSuggestions() {
    const seen = new Set();
    const picks = [];
    if (state.categoryID && merchantInput.value.trim() === '') {
      for (const e of app.snapshot.expenses) {
        if (e.categoryID !== state.categoryID || e.merchant === '' || seen.has(e.merchant.toLowerCase())) continue;
        seen.add(e.merchant.toLowerCase());
        picks.push(e.merchant);
        if (picks.length === 5) break;
      }
    }
    merchantChips.hidden = picks.length === 0;
    merchantChips.replaceChildren(...picks.map((name) => chip(name, { className: 'tag', onClick: () => {
      merchantInput.value = name;
      state.merchant = name;
      drawMerchantSuggestions();
      refresh();
    } })));
  }

  const notesInput = h('textarea', { class: 'input', placeholder: 'Anything worth remembering', maxlength: 2000, rows: 3, 'aria-label': 'Notes' }, state.notes);
  notesInput.addEventListener('input', () => { state.notes = notesInput.value; refresh(); });

  const tagsSelected = h('div', { class: 'chip-row' });
  const tagsSuggested = h('div', { class: 'chip-row' });
  const tagInput = h('input', { class: 'input', type: 'text', placeholder: 'Add a tag', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', maxlength: 40, 'aria-label': 'Add a tag', enterkeyhint: 'done' });
  const addTagButton = h('button', { type: 'button', class: 'btn small secondary', onClick: () => addTag(tagInput.value) }, 'Add');
  tagInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag(tagInput.value);
    }
  });
  function addTag(raw) {
    const cleaned = normalizeTag(raw);
    if (cleaned === null) return;
    if (state.tags.some((t) => t.toLowerCase() === cleaned.toLowerCase())) {
      tagInput.value = '';
      return;
    }
    if (state.tags.length >= MAX_TAGS_PER_EXPENSE) {
      app.ui.toast(`An expense can have up to ${MAX_TAGS_PER_EXPENSE} tags.`);
      return;
    }
    state.tags.push(cleaned);
    tagInput.value = '';
    drawTags();
    refresh();
  }
  function drawTags() {
    tagsSelected.hidden = state.tags.length === 0;
    tagsSelected.replaceChildren(...state.tags.map((t) => chip(t, { removable: true, pressed: true, className: 'tag', ariaLabel: `Remove tag ${t}`, onClick: () => {
      state.tags = state.tags.filter((x) => x !== t);
      drawTags();
      refresh();
    } })));
    const chosen = new Set(state.tags.map((t) => t.toLowerCase()));
    const suggestions = app.snapshot.tags.filter((t) => !chosen.has(t.name.toLowerCase())).slice(0, 12);
    tagsSuggested.hidden = suggestions.length === 0;
    tagsSuggested.replaceChildren(...suggestions.map((t) => chip(t.name, { className: 'tag', ariaLabel: `Add tag ${t.name}`, onClick: () => addTag(t.name) })));
  }

  // ------------------------------------------------------------ repeating

  const repeatValue = h('div', { class: 'row-value' });
  const repeatRow = h('button', { type: 'button', class: 'row', onClick: () => chooseRepeat() },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, 'Repeat'), h('div', { class: 'row-sub' }, 'Make this a repeating expense')),
    repeatValue, icon('chevronRight', { className: 'row-chevron' }));
  async function chooseRepeat() {
    const loaded = await import('./recurring_editor.js');
    const { editRecurring } = loaded;
    describeSchedule = loaded.describeSchedule;
    const prefilled = recurringPrefill(toDraft(), app.snapshot);
    const result = await editRecurring(app, { template: state.repeat, prefill: prefilled, fromExpense: true });
    if (result === undefined) return;
    state.repeat = result;
    drawRepeat();
    refresh();
  }
  function drawRepeat() {
    if (state.recurringTemplateID) {
      repeatRow.disabled = true;
      repeatValue.textContent = 'Already repeating';
    } else {
      repeatValue.textContent = state.repeat && describeSchedule ? describeSchedule(app, state.repeat) : 'Never';
    }
  }

  // ------------------------------------------------------------ saving and leaving

  /** What is missing or wrong, in words. Missing things are a gentle prompt; wrong things are shown as a problem. */
  function describeProblems(codes) {
    const needAmount = codes.includes('amountNotPositive');
    const needCategory = codes.includes('categoryRequired');
    let prompt = '';
    if (needAmount && needCategory) prompt = 'Enter an amount and choose a category.';
    else if (needAmount) prompt = 'Enter an amount.';
    else if (needCategory) prompt = 'Choose a category.';
    const errors = codes.filter((code) => code !== 'amountNotPositive' && code !== 'categoryRequired')
      .map((code) => (code === 'dateRequired' ? 'Choose a date.' : expenseProblemMessage(code)));
    return { prompt, errors };
  }

  function refresh() {
    const codes = state.day ? app.services.expenses.problems(toDraft(), today) : ['dateRequired'];
    const { prompt, errors } = describeProblems(codes);
    hint.textContent = [prompt, ...errors].filter(Boolean).join(' ');
    hint.classList.toggle('bad', errors.length > 0);
    valid = codes.length === 0;
    sheet.setActionDisabled(!valid);
    todayChip.setAttribute('aria-pressed', state.day && state.day.raw === today.raw ? 'true' : 'false');
    yesterdayChip.setAttribute('aria-pressed', state.day && state.day.raw === today.addingDays(-1).raw ? 'true' : 'false');
    const future = state.day && state.day.raw > today.raw && !codes.includes('dateTooFarInFuture');
    notices.replaceChildren(...(future ? [h('p', { class: 'form-note' }, 'This date is in the future. It counts towards that day, not today.')] : []));
  }

  async function save() {
    if (!valid) return;
    const draft = toDraft();
    // The schedule takes what the expense says at the moment of saving, so changes made after choosing "Repeat" are not lost.
    const repeat = state.repeat
      ? {
        ...state.repeat, amount: draft.amount, categoryID: draft.categoryID, subcategoryID: draft.subcategoryID,
        paymentMethodID: draft.paymentMethodID, merchant: draft.merchant, notes: draft.notes, tags: draft.tags, startDay: draft.day,
      }
      : null;
    const result = await app.perform('expense-write', async () => {
      const saved = await services.expenses.save(draft, today);
      let repeatError = null;
      if (repeat) {
        try {
          await services.recurrence.saveTemplate(repeat, { pastOccurrences: 'skipThem', startDayAlreadyEntered: true, today });
        } catch (error) {
          repeatError = error;
        }
      }
      return { saved, repeatError };
    }, { title: 'Could not save' });
    if (!result.ok) return;
    handle.close(result.value.saved);
    app.ui.toast(editing ? 'Expense updated' : 'Expense added');
    if (result.value.repeatError) {
      await app.ui.alert({ title: 'The schedule was not saved', message: `The expense was saved, but making it repeat did not work. ${app.errorMessage(result.value.repeatError)}` });
    }
  }

  async function remove() {
    const yes = await app.ui.confirm({ title: 'Delete this expense?', message: 'It will be removed from your records. This cannot be undone.', confirmLabel: 'Delete', destructive: true });
    if (!yes) return;
    const result = await app.perform('expense-write', () => services.expenses.delete(state.id), { title: 'Could not delete' });
    if (!result.ok) return;
    handle.close('deleted');
    app.ui.toast('Expense deleted');
  }

  function requestClose() {
    if (!isDirty()) {
      handle.close(undefined);
      return;
    }
    app.ui.confirm({ title: 'Discard this expense?', message: 'What you entered has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', destructive: true })
      .then((yes) => { if (yes) handle.close(undefined); });
  }

  // ------------------------------------------------------------ put it together

  const duplicateButton = editing
    ? h('button', { type: 'button', class: 'btn secondary block', onClick: async () => {
      if (isDirty()) {
        app.ui.toast('Save or discard your changes first.');
        return;
      }
      handle.close(undefined);
      await openExpenseForm(app, { prefill: { amount: expense.amount, categoryID: expense.categoryID, subcategoryID: expense.subcategoryID, paymentMethodID: expense.paymentMethodID, merchant: expense.merchant, notes: expense.notes, tags: [...expense.tags] } });
    } }, 'Duplicate')
    : null;
  const deleteButton = editing ? h('button', { type: 'button', class: 'btn danger block', onClick: () => remove() }, 'Delete expense') : null;

  sheet.body.append(
    h('div', { class: 'amount-block' }, pad.display, hint),
    h('section', { class: 'section' }, dateChips, dateBlock, notices),
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Category'), recentLabel, recentRow, grid),
    subSection,
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Payment method'), methodRow),
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Merchant'), merchantInput, merchantChips),
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Notes'), notesInput),
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Tags'), tagsSelected, h('div', { class: 'tag-entry' }, tagInput, addTagButton), tagsSuggested),
    h('section', { class: 'section' }, h('div', { class: 'group' }, repeatRow)),
    ...(editing ? [h('div', { class: 'stack' }, duplicateButton, deleteButton)] : []));
  subSection.append(h('h2', { class: 'section-title' }, 'Subcategory'), subRow);

  drawCategories();
  drawSubcategories();
  drawMethods();
  drawMerchantSuggestions();
  drawTags();
  drawRepeat();
  refresh();

  keypadYieldsToKeyboard(sheet.el);
  const detachKeys = pad.attachKeys(sheet.el);

  return {
    el: sheet.el,
    label: editing ? 'Edit expense' : 'New expense',
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
