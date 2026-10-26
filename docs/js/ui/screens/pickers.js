// Small pickers used from many screens: a currency, a list of choices, and a range of days.

import { fill, h } from '../dom.js';
import { ALL_CURRENCIES } from '../../core/currency.js';
import { LocalDate } from '../../core/localdate.js';
import { DayRange } from '../../core/dayrange.js';
import { PERIOD_KINDS, PERIOD_TITLES, PeriodResolver } from '../../core/periods.js';
import { sheetContent, row, searchField, group, linkButton } from '../components.js';

/** A date box. Reads and writes LocalDate (never a JavaScript Date, so the time zone can never shift the day). */
export function dateInput(day, { min = null, max = null, label = 'Date' } = {}) {
  const input = h('input', { class: 'input', type: 'date', value: day ? day.toString() : '', min: min ? min.toString() : null, max: max ? max.toString() : null, 'aria-label': label, required: true });
  input.day = () => LocalDate.fromISO(input.value);
  return input;
}

/** Asks for a currency. Resolves with the code, or undefined when cancelled. */
export function chooseCurrency(app, current, { footer = null } = {}) {
  const { closed } = app.ui.present((_, __, handle) => {
    let query = '';
    const list = h('div', { class: 'group' });
    const sheet = sheetContent({ title: 'Currency', onCancel: () => handle.close(undefined) });
    const search = searchField({ placeholder: 'Search currencies', onInput: (text) => { query = text.trim().toLowerCase(); draw(); } });
    sheet.body.append(search, list, h('p', { class: 't-foot footnote' }, footer || 'Choosing a currency does not convert any amounts. Expenses already saved keep the currency they were saved in.'));
    function draw() {
      const matches = ALL_CURRENCIES.filter((c) => query === '' || c.code.toLowerCase().includes(query) || c.name.toLowerCase().includes(query));
      list.replaceChildren(...(matches.length === 0
        ? [h('div', { class: 'row' }, h('div', { class: 'row-sub' }, 'No currency matches.'))]
        : matches.map((c) => row({
          title: c.code, sub: c.name, check: c.code === current, ariaLabel: `${c.code}, ${c.name}`, onClick: () => handle.close(c.code),
        }))));
    }
    draw();
    return { el: sheet.el, label: 'Currency' };
  });
  return closed;
}

/**
 * A list of choices in a sheet (for lists too long for the quick action list).
 * options: [{ value, label, sub?, badge? }]. Resolves with the chosen value, or undefined.
 */
export function chooseFromList(app, { title, options, value = null, footer = null, searchable = false }) {
  const { closed } = app.ui.present((_, __, handle) => {
    const sheet = sheetContent({ title, onCancel: () => handle.close(undefined) });
    let query = '';
    const holder = h('div', { class: 'stack' });
    if (searchable) sheet.body.append(searchField({ placeholder: 'Search', onInput: (text) => { query = text.trim().toLowerCase(); draw(); } }));
    sheet.body.append(holder);
    function draw() {
      const shown = options.filter((o) => query === '' || `${o.label} ${o.sub || ''}`.toLowerCase().includes(query));
      holder.replaceChildren(group(shown.map((o) => row({
        title: o.label, sub: o.sub || null, badge: o.badge || null, check: o.value === value, onClick: () => handle.close(o.value),
      })), { footer }));
    }
    draw();
    return { el: sheet.el, label: title };
  });
  return closed;
}

/**
 * Two days, "From" and "To", both included. Resolves { start, end } (LocalDate) or undefined when cancelled.
 * `today` is only used for the starting suggestion.
 */
export function chooseDateRange(app, { title = 'Choose dates', start = null, end = null, confirmLabel = 'Done' }) {
  const today = app.today();
  const { closed } = app.ui.present((_, __, handle) => {
    const from = dateInput(start || today.startOfMonth, { label: 'From' });
    const to = dateInput(end || today, { label: 'To' });
    const error = h('p', { class: 'field-error', role: 'alert' });
    const sheet = sheetContent({
      title,
      onCancel: () => handle.close(undefined),
      actionLabel: confirmLabel,
      onAction: () => {
        const a = from.day();
        const b = to.day();
        if (!a || !b) {
          error.textContent = 'Choose both dates.';
          return;
        }
        if (b.raw < a.raw) {
          error.textContent = 'The end date cannot be before the start date.';
          return;
        }
        handle.close({ start: a, end: b });
      },
    });
    from.id = 'range-from';
    to.id = 'range-to';
    from.classList.add('bare');
    to.classList.add('bare');
    sheet.body.append(
      h('div', { class: 'group' },
        h('div', { class: 'input-row' }, h('label', { for: 'range-from' }, 'From'), from),
        h('div', { class: 'input-row' }, h('label', { for: 'range-to' }, 'To'), to)),
      error,
      h('p', { class: 't-foot footnote' }, 'Both days are included, from the start of the first day to the end of the last.'));
    return { el: sheet.el, label: title };
  }, {}, { compact: true });
  return closed;
}


/**
 * Choose any number of things from a list (categories, payment methods, tags...).
 * options: [{ value, label, sub?, badge? }]. Resolves with a Set of the chosen values, or undefined when cancelled.
 */
export function chooseMany(app, { title, options, selected = new Set(), searchable = false, footer = null }) {
  const { closed } = app.ui.present((_, __, handle) => {
    const chosen = new Set(selected);
    const sheet = sheetContent({ title, onCancel: () => handle.close(undefined), actionLabel: 'Done', onAction: () => handle.close(chosen) });
    let query = '';
    const holder = h('div', { class: 'stack' });
    if (searchable) sheet.body.append(searchField({ placeholder: 'Search', onInput: (text) => { query = text.trim().toLowerCase(); draw(); } }));
    sheet.body.append(holder);
    function draw() {
      const shown = options.filter((o) => query === '' || `${o.label} ${o.sub || ''}`.toLowerCase().includes(query));
      fill(holder,
        group(shown.length === 0
          ? [h('div', { class: 'row' }, h('div', { class: 'row-sub' }, 'Nothing matches.'))]
          : shown.map((o) => row({
            title: o.label, sub: o.sub || null, badge: o.badge || null, check: chosen.has(o.value),
            ariaLabel: `${o.label}${o.sub ? `, ${o.sub}` : ''}`,
            onClick: () => {
              if (chosen.has(o.value)) chosen.delete(o.value);
              else chosen.add(o.value);
              draw();
            },
          })), { footer }),
        chosen.size > 0 ? h('div', { class: 'center' }, linkButton(`Clear ${chosen.size} selected`, () => { chosen.clear(); draw(); })) : null);
    }
    draw();
    return { el: sheet.el, label: title };
  });
  return closed;
}

/**
 * Choose a period: the ready-made ones (with the dates they mean today written under each) or a custom range.
 * Resolves { kind, start, end } (start and end only for 'custom'), { kind: 'any' } when allowAny and that was chosen, or undefined.
 */
export function choosePeriod(app, { title = 'Period', value = null, allowAny = false, anyLabel = 'Any date', kinds = PERIOD_KINDS } = {}) {
  const { closed } = app.ui.present((_, __, handle) => {
    const resolver = new PeriodResolver(app.settings.firstWeekday);
    const today = app.today();
    const f = app.formatter;
    const sheet = sheetContent({ title, onCancel: () => handle.close(undefined) });
    const rows = [];
    if (allowAny) rows.push(row({ title: anyLabel, check: !value || value.kind === 'any', onClick: () => handle.close({ kind: 'any', start: null, end: null }) }));
    for (const kind of kinds) {
      if (kind === 'custom') continue;
      rows.push(row({
        title: PERIOD_TITLES[kind], sub: f.range(resolver.range(kind, today)), check: Boolean(value) && value.kind === kind,
        onClick: () => handle.close({ kind, start: null, end: null }),
      }));
    }
    if (kinds.includes('custom')) {
      const hasCustom = Boolean(value) && value.kind === 'custom' && value.start && value.end;
      rows.push(row({
        title: 'Custom range', sub: hasCustom ? f.range(DayRange.between(value.start, value.end)) : 'Choose two dates', check: hasCustom, chevron: !hasCustom,
        onClick: async () => {
          const picked = await chooseDateRange(app, { title: 'Custom range', start: hasCustom ? value.start : null, end: hasCustom ? value.end : null, confirmLabel: 'Use' });
          if (picked) handle.close({ kind: 'custom', start: picked.start, end: picked.end });
        },
      }));
    }
    sheet.body.append(group(rows));
    return { el: sheet.el, label: title };
  });
  return closed;
}
