// Adding and editing a repeating expense (a schedule).
//
// A schedule is only a recipe. It adds nothing to any total until one of its dates becomes a real expense, either
// automatically or when the person confirms it. Changing a schedule never changes expenses it already recorded.
//
// Two ways in:
//  - from Settings (`fromExpense` false): the whole schedule is edited and saved here.
//  - from the Add / Edit expense form (`fromExpense` true): only the repeat rules are chosen. The expense being entered is
//    the first one, its amount, category and so on are the schedule's, and the form saves the schedule with the expense.

import { h, plural, uid } from '../dom.js';
import { keypadYieldsToKeyboard } from '../typing.js';
import { badge, group, inputRow, row, segmented, sheetContent, toggleRow } from '../components.js';
import { amountPad } from './amount_pad.js';
import { chooseFromList, dateInput } from './pickers.js';
import { FREQUENCIES, FREQUENCY_TITLES, FREQUENCY_UNITS, RECURRENCE_MODES, RECURRENCE_MODE_TITLES } from '../../core/models.js';
import { dueDays, upcomingDays } from '../../core/recurrence.js';
import { EARLIEST_DAY } from '../../core/validation.js';
import { newId } from '../../core/util.js';

const NAME_LIMIT = 60;
const REMINDER_CHOICES = Object.freeze([
  { value: 1, label: '1 day before' },
  { value: 2, label: '2 days before' },
  { value: 3, label: '3 days before' },
  { value: 7, label: '1 week before' },
]);
const MODE_NOTES = Object.freeze({
  autoRecord: 'Added to your expenses on its date, when you open the app. Good for things that never change.',
  askToConfirm: 'Waits on Home until you confirm or skip it, and you can change the amount first. Good for bills that vary.',
});

/** "Every month", "Every 2 weeks", "Every day, until 31 Dec 2026". */
export function describeSchedule(app, template) {
  const unit = FREQUENCY_UNITS[template.frequency];
  const every = template.interval === 1 ? `Every ${unit}` : `Every ${template.interval} ${unit}s`;
  return template.endDay ? `${every}, until ${app.formatter.day(template.endDay)}` : every;
}

/** The next few dates of a schedule, as one sentence. `after` is the last day that does not count. */
export function nextDatesText(app, template, after, count = 3) {
  const days = upcomingDays({ ...template, isActive: true }, after, count);
  if (days.length === 0) return template.endDay ? 'No more dates before it ends.' : '';
  return days.map((day) => app.formatter.day(day)).join(', ');
}

function parseTags(text) {
  return text.split(',').map((piece) => piece.trim()).filter(Boolean);
}

/**
 * Opens the editor.
 *
 * Resolves, in `fromExpense` mode, with the chosen schedule (not yet saved), `null` when "Don't repeat" was chosen, or
 * undefined when closed without choosing. Otherwise it resolves with the saved schedule, 'deleted', or undefined.
 *
 * @param template    an existing schedule to change (or, in `fromExpense` mode, the one chosen earlier in the form)
 * @param prefill     starting values from the expense being entered (see recurringPrefill)
 */
export function editRecurring(app, { template = null, prefill = null, fromExpense = false } = {}) {
  const { closed } = app.ui.present((_, __, handle) => buildEditor(app, handle, { template, prefill, fromExpense }));
  return closed;
}

function buildEditor(app, handle, { template, prefill, fromExpense }) {
  const editing = template !== null;
  const stored = editing && !fromExpense; // a schedule that exists in the app's data
  const today = app.today();
  const f = app.formatter;
  const fromForm = fromExpense && prefill ? prefill : null; // the expense as it is in the form right now
  const seed = fromForm || (editing ? template : (prefill || {}));
  const currency = editing ? template.amount.currencyCode : (prefill && prefill.currencyCode) || app.currency;
  const fixedAmount = fromExpense ? ((fromForm && fromForm.amount) || (editing ? template.amount : null)) : null;

  const state = {
    id: editing ? template.id : newId(),
    title: editing ? template.title : (seed.title || ''),
    categoryID: seed.categoryID || null,
    subcategoryID: seed.subcategoryID || null,
    paymentMethodID: seed.paymentMethodID || null,
    merchant: seed.merchant || '',
    notes: seed.notes || '',
    tags: (seed.tags || []).join(', '),
    frequency: editing ? template.frequency : 'monthly',
    intervalText: String(editing ? template.interval : 1),
    startDay: fromForm ? fromForm.startDay : (editing ? template.startDay : (seed.startDay || today)),
    endDay: editing && template.endDay ? template.endDay : null,
    hasEnd: editing && Boolean(template.endDay),
    mode: editing ? template.mode : 'askToConfirm',
    reminder: editing ? template.reminderEnabled : false,
    reminderDays: editing ? (template.reminderDaysBefore || 1) : 1,
    past: 'skipThem',
  };

  let valid = false;
  const pad = fromExpense ? null : amountPad({ app, currencyCode: currency, initial: editing ? template.amount : null, onChange: () => refresh() });
  const amountNow = () => (pad ? pad.input.money : fixedAmount);

  const interval = () => {
    const value = Number(state.intervalText);
    return Number.isInteger(value) && state.intervalText.trim() !== '' ? value : NaN;
  };

  const signature = () => JSON.stringify([
    amountNow() && amountNow().minorUnits, state.title, state.categoryID, state.subcategoryID, state.paymentMethodID, state.merchant, state.notes, state.tags,
    state.frequency, state.intervalText, state.startDay && state.startDay.raw, state.hasEnd && state.endDay && state.endDay.raw, state.mode, state.reminder, state.reminderDays, state.past,
  ]);
  const startSignature = signature();
  const isDirty = () => signature() !== startSignature;

  const sheet = sheetContent({
    title: stored ? 'Edit repeating expense' : (fromExpense ? 'Repeat this expense' : 'New repeating expense'),
    onCancel: () => requestClose(),
    actionLabel: fromExpense ? 'Done' : 'Save',
    onAction: () => save(),
    actionDisabled: true,
    footer: pad ? pad.keypad : null,
  });
  const hint = h('p', { class: 'form-hint', role: 'status' });

  // ------------------------------------------------------------ name and what it is

  const titleInput = h('input', {
    class: 'input', type: 'text', value: state.title, placeholder: 'For example Rent', autocomplete: 'off', autocorrect: 'off', maxlength: NAME_LIMIT, 'aria-label': 'Name',
  });
  titleInput.addEventListener('input', () => { state.title = titleInput.value; refresh(); });

  const categoryRow = row({ title: 'Category', value: '', chevron: true, onClick: () => chooseCategory() });
  const subcategoryRow = row({ title: 'Subcategory', value: '', chevron: true, onClick: () => chooseSubcategory() });
  const methodRow = row({ title: 'Payment method', value: '', chevron: true, onClick: () => chooseMethod() });
  const valueOf = (rowEl) => rowEl.querySelector('.row-value');

  async function chooseCategory() {
    const options = app.snapshot.activeCategories.map((category) => ({ value: category.id, label: category.name, badge: badge(category) }));
    const picked = await chooseFromList(app, { title: 'Category', value: state.categoryID, options, searchable: options.length > 8 });
    if (picked === undefined) return;
    if (picked !== state.categoryID) state.subcategoryID = null;
    state.categoryID = picked;
    drawWhat();
    refresh();
  }

  async function chooseSubcategory() {
    const subs = state.categoryID ? app.snapshot.subcategoriesOf(state.categoryID) : [];
    const picked = await chooseFromList(app, {
      title: 'Subcategory',
      value: state.subcategoryID || '',
      options: [{ value: '', label: 'None' }, ...subs.map((sub) => ({ value: sub.id, label: sub.name }))],
    });
    if (picked === undefined) return;
    state.subcategoryID = picked === '' ? null : picked;
    drawWhat();
    refresh();
  }

  async function chooseMethod() {
    const methods = app.snapshot.activePaymentMethods;
    const picked = await chooseFromList(app, {
      title: 'Payment method',
      value: state.paymentMethodID || '',
      options: [{ value: '', label: 'None' }, ...methods.map((method) => ({ value: method.id, label: method.name }))],
    });
    if (picked === undefined) return;
    state.paymentMethodID = picked === '' ? null : picked;
    drawWhat();
    refresh();
  }

  function drawWhat() {
    const category = state.categoryID ? app.snapshot.category(state.categoryID) : null;
    valueOf(categoryRow).textContent = category ? category.name : 'Choose';
    const subs = state.categoryID ? app.snapshot.subcategoriesOf(state.categoryID) : [];
    subcategoryRow.hidden = subs.length === 0;
    const sub = state.subcategoryID ? app.snapshot.subcategory(state.subcategoryID) : null;
    valueOf(subcategoryRow).textContent = sub ? sub.name : 'None';
    const method = state.paymentMethodID ? app.snapshot.paymentMethod(state.paymentMethodID) : null;
    valueOf(methodRow).textContent = method ? method.name : 'None';
  }

  const merchantInput = h('input', {
    class: 'input', type: 'text', value: state.merchant, placeholder: 'Merchant (optional)', autocomplete: 'off', autocorrect: 'off', maxlength: 120, 'aria-label': 'Merchant',
  });
  merchantInput.addEventListener('input', () => { state.merchant = merchantInput.value; refresh(); });
  const tagsInput = h('input', {
    class: 'input', type: 'text', value: state.tags, placeholder: 'Tags, separated by commas (optional)', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', 'aria-label': 'Tags',
  });
  tagsInput.addEventListener('input', () => { state.tags = tagsInput.value; refresh(); });
  const notesInput = h('textarea', { class: 'input', placeholder: 'Notes (optional)', maxlength: 2000, rows: 2, 'aria-label': 'Notes' }, state.notes);
  notesInput.addEventListener('input', () => { state.notes = notesInput.value; refresh(); });

  // ------------------------------------------------------------ how often

  const frequencyControl = segmented({
    label: 'How often it repeats',
    options: FREQUENCIES.map((value) => ({ value, label: FREQUENCY_TITLES[value] })),
    value: state.frequency,
    onChange: (value) => { state.frequency = value; drawRepeat(); refresh(); },
  });
  const intervalInput = h('input', {
    type: 'text', inputmode: 'numeric', pattern: '[0-9]*', value: state.intervalText, autocomplete: 'off', maxlength: 3, 'aria-label': 'Repeat every how many',
  });
  const unitEl = h('span', { class: 'input-unit' });
  const everyID = uid('every');
  const intervalRow = h('div', { class: 'group' }, h('div', { class: 'input-row' }, h('label', { for: everyID }, 'Every'), unitEl));
  intervalInput.id = everyID;
  intervalInput.classList.add('bare');
  intervalRow.firstChild.insertBefore(intervalInput, unitEl);
  intervalInput.addEventListener('input', () => { state.intervalText = intervalInput.value.replace(/[^0-9]/g, ''); drawRepeat(); refresh(); });
  const scheduleNote = h('p', { class: 't-foot footnote', 'aria-live': 'polite' });

  function drawRepeat() {
    const n = interval();
    const unit = FREQUENCY_UNITS[state.frequency];
    unitEl.textContent = n === 1 ? unit : `${unit}s`;
  }

  // ------------------------------------------------------------ dates

  const startInput = dateInput(state.startDay, { label: 'Starts', min: EARLIEST_DAY });
  startInput.addEventListener('change', () => { state.startDay = startInput.day(); drawEarlier(); refresh(); });
  const endInput = dateInput(state.endDay || state.startDay.addingMonths(12), { label: 'Ends', min: EARLIEST_DAY });
  endInput.addEventListener('change', () => { state.endDay = endInput.day(); refresh(); });
  const startBlock = fromExpense
    ? h('p', { class: 't-foot footnote' }, `Starts on ${f.day(state.startDay)}. The expense you are entering is the first one; the schedule adds the next ones.`)
    : h('div', { class: 'group' }, inputRow({ label: 'Starts', input: startInput }));
  const endToggle = toggleRow({
    title: 'Stop on a date', sub: 'Otherwise it repeats until you stop it.', checked: state.hasEnd,
    onChange: (checked) => {
      state.hasEnd = checked;
      if (checked && !state.endDay) state.endDay = endInput.day() || state.startDay.addingMonths(12);
      drawEnd();
      refresh();
    },
  });
  const endBlock = h('div', { class: 'group', hidden: true }, inputRow({ label: 'Last date', input: endInput }));
  function drawEnd() {
    endBlock.hidden = !state.hasEnd;
  }

  // Earlier dates: only for a new schedule that starts in the past.
  const earlierSection = h('section', { class: 'section', hidden: true });
  const earlierControl = segmented({
    label: 'Dates that have already passed',
    options: [{ value: 'skipThem', label: 'Skip them' }, { value: 'recordThem', label: 'Add them' }],
    value: state.past,
    onChange: (value) => { state.past = value; drawEarlier(); refresh(); },
  });
  const earlierNote = h('p', { class: 't-foot footnote', 'aria-live': 'polite' });
  earlierSection.append(h('h2', { class: 'section-title' }, 'Dates already passed'), earlierControl, earlierNote);
  function drawEarlier() {
    const show = !editing && !fromExpense && Boolean(state.startDay) && state.startDay.raw < today.raw;
    earlierSection.hidden = !show;
    if (!show) return;
    const n = interval();
    if (!Number.isInteger(n) || n < 1) return;
    const draft = { ...toDraft(), isActive: true };
    const count = dueDays(draft, state.startDay, today.addingDays(-1)).length;
    if (count === 0) {
      earlierSection.hidden = true;
      return;
    }
    earlierNote.textContent = state.past === 'skipThem'
      ? `${plural(count, 'earlier date')} will not be added. The schedule starts from today.`
      : `${plural(count, 'earlier date')} will be ${state.mode === 'autoRecord' ? 'added to your expenses right away' : 'offered for you to confirm'}.`;
  }

  // ------------------------------------------------------------ what happens on a date

  const modeControl = segmented({
    label: 'What happens on each date',
    options: RECURRENCE_MODES.map((value) => ({ value, label: value === 'autoRecord' ? 'Add it' : 'Ask me' })),
    value: state.mode,
    onChange: (value) => { state.mode = value; drawMode(); drawEarlier(); refresh(); },
  });
  const modeNote = h('p', { class: 't-foot footnote' });
  function drawMode() {
    modeNote.textContent = `${RECURRENCE_MODE_TITLES[state.mode]}. ${MODE_NOTES[state.mode]}`;
  }

  // ------------------------------------------------------------ reminder

  const reminderToggle = toggleRow({
    title: 'Remind me on Home', sub: 'A message appears on Home a few days before it is due.', checked: state.reminder,
    onChange: (checked) => { state.reminder = checked; drawReminder(); refresh(); },
  });
  const reminderRow = row({
    title: 'Remind me', value: '', chevron: true,
    onClick: async () => {
      const picked = await app.ui.actions({
        title: 'Remind me',
        options: REMINDER_CHOICES.map((choice) => ({ label: choice.label, value: choice.value, checked: choice.value === state.reminderDays })),
      });
      if (picked === undefined) return;
      state.reminderDays = picked;
      drawReminder();
      refresh();
    },
  });
  const reminderGroup = h('div', { class: 'group', hidden: true }, reminderRow);
  const reminderNote = h('p', { class: 't-foot footnote' });
  function drawReminder() {
    reminderGroup.hidden = !state.reminder;
    const choice = REMINDER_CHOICES.find((c) => c.value === state.reminderDays) || REMINDER_CHOICES[0];
    valueOf(reminderRow).textContent = choice.label;
    const lines = ['Reminders only appear while the app is open. This app has no server, so it cannot wake your iPhone to tell you.'];
    if (state.reminder && !app.settings.recurringRemindersEnabled) lines.push('Repeating expense reminders are switched off in Settings under Notifications, so none will show until you switch them on there.');
    reminderNote.textContent = lines.join(' ');
  }

  // ------------------------------------------------------------ saving and leaving

  function toDraft() {
    return {
      id: state.id,
      title: state.title.trim(),
      amount: amountNow(),
      categoryID: state.categoryID,
      subcategoryID: state.subcategoryID,
      paymentMethodID: state.paymentMethodID,
      merchant: state.merchant,
      notes: state.notes,
      tags: parseTags(state.tags),
      frequency: state.frequency,
      interval: interval(),
      startDay: state.startDay,
      endDay: state.hasEnd ? state.endDay : null,
      mode: state.mode,
      reminderEnabled: state.reminder,
      reminderDaysBefore: state.reminderDays,
      reminderHour: editing ? template.reminderHour : 9,
      reminderMinute: editing ? template.reminderMinute : 0,
      isActive: editing ? template.isActive : true,
      timeZoneID: editing ? template.timeZoneID : app.timeZone(),
    };
  }

  function problem() {
    if (state.title.trim() === '') return { text: 'Give it a name.', bad: false };
    const amount = amountNow();
    if (!amount || !(amount.minorUnits > 0)) {
      return { text: fromExpense ? 'Enter the amount in the expense first, then choose how it repeats.' : 'Enter an amount.', bad: false };
    }
    if (!state.categoryID) return { text: 'Choose a category.', bad: false };
    const n = interval();
    if (!Number.isInteger(n) || n < 1 || n > 365) return { text: 'Repeat every a whole number from 1 to 365.', bad: true };
    if (!state.startDay) return { text: 'Choose a start date.', bad: true };
    if (state.hasEnd && (!state.endDay || state.endDay.raw < state.startDay.raw)) return { text: 'The last date cannot be before the start date.', bad: true };
    return null;
  }

  function refresh() {
    const found = problem();
    hint.textContent = found ? found.text : '';
    hint.classList.toggle('bad', Boolean(found && found.bad));
    valid = found === null;
    sheet.setActionDisabled(!valid);
    // What the schedule will do, in words.
    const n = interval();
    if (Number.isInteger(n) && n >= 1 && n <= 365 && state.startDay) {
      const draft = toDraft();
      const after = fromExpense ? state.startDay : (state.startDay.raw >= today.raw ? state.startDay.addingDays(-1) : today.addingDays(editing ? 0 : -1));
      const dates = nextDatesText(app, draft, after);
      scheduleNote.textContent = dates === '' ? '' : `${fromExpense ? 'After this one' : 'Next'}: ${dates}.`;
    } else {
      scheduleNote.textContent = '';
    }
    drawEarlier();
  }

  async function save() {
    if (!valid) return;
    const draft = toDraft();
    if (fromExpense) {
      handle.close(draft);
      return;
    }
    const result = await app.perform('recurring-write', () => app.services.recurrence.saveTemplate(draft, {
      pastOccurrences: editing ? 'skipThem' : state.past, startDayAlreadyEntered: false, today,
    }), { title: 'Could not save' });
    if (!result.ok) return;
    handle.close(result.value);
    app.ui.toast(editing ? 'Repeating expense updated' : 'Repeating expense added');
    app.afterOpen(); // records what is due now, so nothing waits for the next time the app is opened
  }

  async function remove() {
    const yes = await app.ui.confirm({
      title: 'Delete this repeating expense?',
      message: 'No more expenses will be added from it. Expenses it already recorded stay. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!yes) return;
    const result = await app.perform('recurring-write', () => app.services.recurrence.deleteTemplate(state.id), { title: 'Could not delete' });
    if (!result.ok) return;
    handle.close('deleted');
    app.ui.toast('Repeating expense deleted');
  }

  function requestClose() {
    if (!isDirty()) {
      handle.close(undefined);
      return;
    }
    app.ui.confirm({ title: 'Discard your changes?', message: 'What you entered has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', destructive: true })
      .then((yes) => { if (yes) handle.close(undefined); });
  }

  // ------------------------------------------------------------ put it together

  const fromExpenseSummary = fromExpense && fixedAmount
    ? group([
      row({ title: 'Amount', value: f.money.string(fixedAmount) }),
      row({ title: 'Category', value: (state.categoryID && app.snapshot.category(state.categoryID) ? app.snapshot.category(state.categoryID).name : 'Not chosen yet') }),
    ], { footer: 'These come from the expense you are entering. If you change them there, the schedule follows.' })
    : null;

  sheet.body.append(h('div', { class: 'stack-l' },
    pad ? h('div', { class: 'amount-block' }, h('p', { class: 't-sub t-center' }, 'Amount each time'), pad.display, hint) : hint,
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Name'), titleInput),
    fromExpenseSummary,
    fromExpense ? null : group([categoryRow, subcategoryRow, methodRow], { title: 'What it is' }),
    fromExpense ? null : h('section', { class: 'section' }, h('div', { class: 'stack-s' }, merchantInput, tagsInput, notesInput)),
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Repeats'), frequencyControl, intervalRow, scheduleNote,
      stored ? h('p', { class: 't-foot footnote' }, 'Changing the dates never adds expenses for days that have already passed.') : null),
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Dates'), startBlock, group([endToggle]), endBlock),
    earlierSection,
    h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'On each date'), modeControl, modeNote),
    h('section', { class: 'section' }, group([reminderToggle]), reminderGroup, reminderNote),
    stored ? h('button', { type: 'button', class: 'btn danger block', onClick: () => remove() }, 'Delete repeating expense') : null,
    fromExpense && editing ? h('button', { type: 'button', class: 'btn secondary block', onClick: () => handle.close(null) }, 'Do not repeat this expense') : null));

  drawWhat();
  drawRepeat();
  drawEnd();
  drawMode();
  drawReminder();
  refresh();

  keypadYieldsToKeyboard(sheet.el);
  const detachKeys = pad ? pad.attachKeys(sheet.el) : () => {};

  return {
    el: sheet.el,
    label: stored ? 'Edit repeating expense' : 'Repeat this expense',
    dismissible: () => {
      if (!isDirty()) return true;
      requestClose();
      return false;
    },
    destroy() {
      detachKeys();
      if (pad) pad.destroy();
    },
  };
}
