// Repeating expenses: the list, one schedule in detail, and confirming or skipping the dates that are waiting.
//
// A repeating expense is only a recipe. Totals change only when one of its dates becomes a real expense: automatically
// on its date (when the app is opened), or when the person taps Confirm. Skipping a date is final; it is never offered again.

import { fill, h, plural } from '../dom.js';
import { badge, button, emptyState, group, iconButton, moneyBig, page, row, sheetContent } from '../components.js';
import { amountPad } from './amount_pad.js';
import { describeSchedule, editRecurring } from './recurring_editor.js';
import { openDrilldown } from './drilldown.js';
import { categoryBadge } from './rows.js';
import { RECURRENCE_MODE_TITLES } from '../../core/models.js';
import { upcomingDays } from '../../core/recurrence.js';

export function openRecurring(app) {
  app.shell.push(createRecurring);
}

/** Adds a repeating expense (the full form). */
export function addRecurring(app) {
  return editRecurring(app, {});
}

function templateBadge(app, template) {
  return categoryBadge(app, template.categoryID);
}

function nextDayOf(template, today) {
  return upcomingDays(template, today, 1)[0] || null;
}

// ---------------------------------------------------------------- waiting for confirmation

/** "today", "yesterday" or "12 Oct 2026": a day for the middle of a sentence. */
function dayInSentence(f, day, today) {
  const text = f.relativeDay(day, today);
  return text === 'Today' || text === 'Yesterday' ? text.toLowerCase() : text;
}

/** One waiting date as a row. Tapping it opens the confirm sheet. */
function waitingRow(app, occurrence, today) {
  const template = app.snapshot.templates.find((t) => t.id === occurrence.templateID);
  if (!template) return null;
  const f = app.formatter;
  const due = dayInSentence(f, occurrence.dueDay, today);
  return row({
    badge: templateBadge(app, template),
    title: template.title,
    sub: `Due ${due}`,
    amount: f.money.string(template.amount),
    amountSub: 'Waiting',
    onClick: () => confirmOccurrence(app, occurrence),
    ariaLabel: `${template.title}, due ${due}, ${f.money.string(template.amount)}. Confirm or skip.`,
  });
}

/** Opens the sheet listing everything waiting for a decision (the "Review" button on Home). */
export function reviewWaiting(app) {
  const { closed } = app.ui.present((_, __, handle) => {
    const sheet = sheetContent({ title: 'Waiting for you', cancelLabel: 'Close', onCancel: () => handle.close(undefined) });
    const holder = h('div', { class: 'stack-l' });
    sheet.body.append(holder);
    function refresh() {
      const waiting = app.waitingOccurrences();
      if (waiting.length === 0) {
        handle.close(undefined);
        return;
      }
      const today = app.today();
      fill(holder, group(waiting.map((occurrence) => waitingRow(app, occurrence, today)), {
        footer: 'Tap one to add it to your expenses (you can change the amount first) or to skip it.',
      }));
    }
    refresh();
    return { el: sheet.el, label: 'Waiting for you', refresh };
  });
  return closed;
}

/** Confirms or skips one waiting date. Resolves 'added', 'skipped', or undefined when closed without deciding. */
export function confirmOccurrence(app, occurrence) {
  const template = app.snapshot.templates.find((t) => t.id === occurrence.templateID);
  if (!template) return Promise.resolve(undefined);
  const { closed } = app.ui.present((_, __, handle) => {
    const f = app.formatter;
    const today = app.today();
    let valid = false;
    const pad = amountPad({ app, currencyCode: template.amount.currencyCode, initial: template.amount, onChange: () => refresh() });
    const sheet = sheetContent({
      title: 'Confirm expense',
      onCancel: () => handle.close(undefined),
      actionLabel: 'Add',
      onAction: () => add(),
      actionDisabled: true,
      footer: pad.keypad,
    });
    const hint = h('p', { class: 'form-hint', role: 'status' });

    function refresh() {
      valid = pad.input.money.minorUnits > 0;
      hint.textContent = valid ? '' : 'Enter an amount.';
      sheet.setActionDisabled(!valid);
    }

    async function add() {
      if (!valid) return;
      const result = await app.perform('recurring-confirm', () => app.services.recurrence.confirm(occurrence, pad.input.money, today), { title: 'Could not add it' });
      if (!result.ok) return;
      handle.close('added');
      app.ui.toast('Expense added');
    }

    async function skip() {
      const yes = await app.ui.confirm({
        title: 'Skip this one?',
        message: `Nothing is added for ${f.day(occurrence.dueDay)}, and it will not be offered again. The next date is not affected.`,
        confirmLabel: 'Skip',
        destructive: true,
      });
      if (!yes) return;
      const result = await app.perform('recurring-confirm', () => app.services.recurrence.skip(occurrence, today), { title: 'Could not skip it' });
      if (!result.ok) return;
      handle.close('skipped');
      app.ui.toast('Skipped');
    }

    sheet.body.append(h('div', { class: 'stack-l' },
      h('div', { class: 'amount-block' },
        h('p', { class: 't-strong t-center' }, template.title),
        h('p', { class: 't-sub t-center' }, `Due ${f.day(occurrence.dueDay)}`),
        pad.display,
        hint),
      button('Skip this one', { variant: 'secondary', block: true, onClick: skip }),
      h('p', { class: 't-foot footnote' }, 'The amount is the usual one. Change it if this time was different. It is added as an expense dated on its due date.')));
    refresh();
    const detachKeys = pad.attachKeys(sheet.el);
    return {
      el: sheet.el,
      label: 'Confirm expense',
      destroy() {
        detachKeys();
        pad.destroy();
      },
    };
  });
  return closed;
}

// ---------------------------------------------------------------- the list

export function createRecurring(app) {
  const screen = page(app, {
    title: 'Repeating expenses',
    back: true,
    backLabel: 'Settings',
    trailing: iconButton('plus', 'Add a repeating expense', () => addRecurring(app)),
  });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  function refresh() {
    const snapshot = app.snapshot;
    const f = app.formatter;
    const today = app.today();
    const templates = snapshot.templates.slice();
    if (templates.length === 0) {
      fill(holder, emptyState({
        mark: '🔁',
        title: 'Nothing repeats yet',
        message: 'Add what you pay again and again, such as rent, a subscription or school fees. The app can add it for you on each date, or ask you each time.',
        action: button('Add a repeating expense', { glyph: 'plus', onClick: () => addRecurring(app) }),
      }));
      return;
    }

    const sections = [];
    const waiting = app.waitingOccurrences();
    if (waiting.length > 0) {
      sections.push(group(waiting.map((occurrence) => waitingRow(app, occurrence, today)), {
        title: 'Waiting for you',
        footer: 'Tap one to add it to your expenses (you can change the amount first) or to skip it.',
      }));
    }

    const lineFor = (template) => {
      const next = template.isActive ? nextDayOf(template, today) : null;
      return row({
        badge: templateBadge(app, template),
        title: template.title,
        sub: `${f.money.string(template.amount)} · ${describeSchedule(app, template)}`,
        value: !template.isActive ? 'Paused' : (next ? `Next ${f.dayMonthShort(next)}` : 'Ended'),
        chevron: true,
        onClick: () => app.shell.push(createRecurringDetail, { id: template.id }),
        ariaLabel: `${template.title}, ${f.money.string(template.amount)}, ${describeSchedule(app, template)}. Open.`,
      });
    };
    const farFuture = Number.MAX_SAFE_INTEGER;
    const byNext = (a, b) => {
      const nextA = nextDayOf(a, today);
      const nextB = nextDayOf(b, today);
      return (nextA ? nextA.raw : farFuture) - (nextB ? nextB.raw : farFuture) || a.title.localeCompare(b.title);
    };
    const active = templates.filter((t) => t.isActive).sort(byNext);
    const paused = templates.filter((t) => !t.isActive).sort((a, b) => a.title.localeCompare(b.title));
    if (active.length > 0) sections.push(group(active.map(lineFor), { title: 'Repeating' }));
    if (paused.length > 0) {
      sections.push(group(paused.map(lineFor), {
        title: 'Paused',
        footer: 'A paused one adds nothing. When you resume it, dates that passed meanwhile are not added.',
      }));
    }
    sections.push(h('p', { class: 't-foot footnote' }, 'Dates are added when you open the app, not at the exact moment they fall due. A bill due on the 1st that you open the app on the 3rd is added on the 3rd, dated the 1st.'));
    fill(holder, ...sections);
  }

  return { el: screen.el, refresh };
}

// ---------------------------------------------------------------- one schedule

export function createRecurringDetail(app, params) {
  const screen = page(app, { title: 'Repeating expense', back: true, backLabel: 'Repeating' });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  function refresh() {
    const snapshot = app.snapshot;
    const template = snapshot.templates.find((t) => t.id === params.id);
    if (!template) {
      fill(holder, emptyState({ mark: '🔁', title: 'Gone', message: 'This repeating expense no longer exists.' }));
      return;
    }
    screen.setTitle(template.title);
    const f = app.formatter;
    const today = app.today();
    const category = snapshot.category(template.categoryID);
    const sub = template.subcategoryID ? snapshot.subcategory(template.subcategoryID) : null;
    const method = template.paymentMethodID ? snapshot.paymentMethod(template.paymentMethodID) : null;
    const recorded = snapshot.expenses.filter((e) => e.recurringTemplateID === template.id);
    const skipped = snapshot.recurrenceLog.filter((entry) => entry.templateID === template.id && entry.outcome === 'skipped').length;
    const coming = template.isActive ? upcomingDays(template, today, 5) : [];

    const details = [
      row({ badge: category ? badge(category) : null, title: 'Category', value: category ? category.name : 'Unknown' }),
      sub ? row({ title: 'Subcategory', value: sub.name }) : null,
      method ? row({ title: 'Payment method', value: method.name }) : null,
      template.merchant !== '' ? row({ title: 'Merchant', value: template.merchant }) : null,
      template.tags.length > 0 ? row({ title: 'Tags', value: template.tags.join(', ') }) : null,
      template.notes !== '' ? row({ title: 'Notes', value: template.notes }) : null,
    ];
    const reminderWords = template.reminderEnabled
      ? `${template.reminderDaysBefore <= 1 ? '1 day' : `${template.reminderDaysBefore} days`} before`
      : 'Off';

    fill(holder,
      h('section', { class: 'detail-head' },
        moneyBig(f, template.amount, { size: 'medium' }),
        h('p', { class: 't-sub t-center' }, describeSchedule(app, template)),
        !template.isActive ? h('p', { class: 't-center' }, h('span', { class: 'pill' }, 'Paused')) : null),
      group(details, { title: 'What it is' }),
      group([
        row({ title: 'Starts', value: f.day(template.startDay) }),
        row({ title: 'Ends', value: template.endDay ? f.day(template.endDay) : 'Never' }),
        row({ title: 'On each date', value: RECURRENCE_MODE_TITLES[template.mode] }),
        row({ title: 'Reminder', value: reminderWords }),
      ], { title: 'Schedule' }),
      group(coming.length > 0
        ? coming.map((day) => row({ title: f.day(day), sub: f.weekdayLong(day) }))
        : [row({ title: template.isActive ? 'No more dates' : 'Paused', sub: template.isActive ? 'It has reached its last date.' : 'Resume it to see the next dates.' })],
      { title: 'Coming up' }),
      group([
        row({
          title: 'Added so far', value: String(recorded.length), chevron: recorded.length > 0, disabled: recorded.length === 0,
          onClick: recorded.length === 0 ? null : () => openDrilldown(app, {
            title: template.title, subtitle: 'Added from this schedule', backLabel: 'Back',
            select: (a) => a.snapshot.expenses.filter((e) => e.recurringTemplateID === template.id),
          }),
        }),
        row({ title: 'Skipped', value: String(skipped) }),
      ], { title: 'History' }),
      h('div', { class: 'stack' },
        button('Edit', {
          block: true,
          glyph: 'edit',
          onClick: async () => {
            // The form can delete the schedule too; this page is about it, so it leaves with it.
            const result = await editRecurring(app, { template });
            if (result === 'deleted') app.shell.pop();
          },
        }),
        button(template.isActive ? 'Pause' : 'Resume', {
          variant: 'secondary', block: true, glyph: template.isActive ? 'pause' : 'play',
          onClick: async () => {
            const result = await app.perform('recurring-write', () => app.services.recurrence.setActive(!template.isActive, template.id, app.today()), { title: 'Could not change it' });
            if (result.ok) app.ui.toast(template.isActive ? 'Paused' : 'Resumed');
          },
        }),
        button('Delete', { variant: 'danger', block: true, glyph: 'trash', onClick: () => remove(template) })),
      template.isActive ? null : h('p', { class: 't-foot footnote' }, 'Resuming does not add the dates that passed while it was paused.'));
  }

  async function remove(template) {
    const added = app.snapshot.expenses.filter((e) => e.recurringTemplateID === template.id).length;
    const yes = await app.ui.confirm({
      title: 'Delete this repeating expense?',
      message: added > 0
        ? `No more expenses will be added from it. The ${plural(added, 'expense')} it already added stay. This cannot be undone.`
        : 'No more expenses will be added from it. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!yes) return;
    const result = await app.perform('recurring-write', () => app.services.recurrence.deleteTemplate(template.id), { title: 'Could not delete' });
    if (!result.ok) return;
    app.shell.pop();
    app.ui.toast('Repeating expense deleted');
  }

  return { el: screen.el, refresh };
}

