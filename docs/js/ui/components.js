// The building blocks screens are made of: pages, sheets, list rows, buttons, fields, chips, notices.
// Nothing here knows about expenses; it only knows how things should look and behave on an iPhone.

import { digitsOf } from '../core/money.js';
import { activate, h, perFrame, uid } from './dom.js';
import { glyphFor, icon } from './icons.js';

// ---------------------------------------------------------------- pages and sheets

/**
 * A full page with a navigation bar. `body` is whatever goes inside the padded column.
 * Returns { el, scroll, body, setTitle, setTrailing, setFab }.
 */
export function page(app, {
  title, large = false, back = false, backLabel = 'Back', leading = null, trailing = null, className = '', withFab = false, onBack = null,
}) {
  const leadingEl = h('div', { class: 'navbar-leading' });
  const trailingEl = h('div', { class: 'navbar-trailing' });
  const titleEl = h('div', { class: 'navbar-title', role: large ? null : 'heading', 'aria-level': large ? null : '1', 'aria-hidden': large ? 'true' : null }, title);
  const largeEl = large ? h('h1', { class: 'large-title' }, title) : null;
  const bodyEl = h('div', { class: ['page-body', withFab ? 'with-fab' : ''] });
  const navbar = h('header', { class: 'navbar' }, h('div', { class: 'navbar-row' }, leadingEl, titleEl, trailingEl));
  const scroll = h('div', { class: 'page-scroll' }, navbar, largeEl, bodyEl);
  const el = h('section', { class: ['page', large ? 'has-large' : '', className], 'aria-label': title }, scroll);

  if (back) {
    leadingEl.appendChild(h('button', { type: 'button', class: 'nav-btn', onClick: () => (onBack ? onBack() : app.shell.pop()), 'aria-label': `Back to ${backLabel}` },
      icon('chevronLeft', { className: 'back-chevron' }), h('span', null, backLabel)));
  }
  if (leading) leadingEl.append(...[].concat(leading));
  if (trailing) trailingEl.append(...[].concat(trailing));

  if (large) {
    scroll.addEventListener('scroll', perFrame(() => {
      el.classList.toggle('compact', scroll.scrollTop > 34);
    }), { passive: true });
  } else {
    navbar.classList.add('solid');
  }

  return {
    el,
    scroll,
    body: bodyEl,
    setTitle(text) {
      titleEl.textContent = text;
      if (largeEl) largeEl.textContent = text;
      el.setAttribute('aria-label', text);
    },
    setTrailing(...nodes) {
      trailingEl.replaceChildren(...nodes.flat().filter(Boolean));
    },
    setLeading(...nodes) {
      leadingEl.replaceChildren(...nodes.flat().filter(Boolean));
    },
  };
}

/**
 * The inside of a sheet: a bar with Cancel / title / action, a scrolling body, and an optional footer.
 * Returns { el, body, footer, setAction }.
 */
export function sheetContent({
  title, cancelLabel = 'Cancel', onCancel, actionLabel = null, onAction = null, actionDisabled = false, footer = null, scroll = true,
}) {
  const action = actionLabel
    ? h('button', { type: 'button', class: 'nav-btn strong', disabled: actionDisabled, onClick: () => onAction && onAction() }, actionLabel)
    : null;
  const bar = h('header', { class: 'navbar solid' }, h('div', { class: 'navbar-row' },
    h('div', { class: 'navbar-leading' }, cancelLabel ? h('button', { type: 'button', class: 'nav-btn', onClick: () => onCancel && onCancel() }, cancelLabel) : null),
    h('div', { class: 'navbar-title', role: 'heading', 'aria-level': '1' }, title),
    h('div', { class: 'navbar-trailing' }, action)));
  const body = h('div', { class: 'page-body', style: { paddingTop: '1rem' } });
  const scroller = h('div', { class: scroll ? 'sheet-scroll' : 'sheet-fixed' }, body);
  const footerEl = footer ? h('div', { class: 'sheet-footer' }, footer) : null;
  const el = h('div', { class: 'sheet-content' }, bar, scroller, footerEl);
  return {
    el,
    body,
    scroller,
    footer: footerEl,
    setAction(label, disabled) {
      if (!action) return;
      action.textContent = label;
      action.disabled = Boolean(disabled);
    },
    setActionDisabled(disabled) {
      if (action) action.disabled = Boolean(disabled);
    },
  };
}

// ---------------------------------------------------------------- buttons

export function button(label, { variant = '', onClick = null, block = false, disabled = false, small = false, glyph = null, type = 'button', ariaLabel = null } = {}) {
  return h('button', {
    type,
    class: ['btn', variant, block ? 'block' : '', small ? 'small' : ''],
    disabled,
    onClick,
    'aria-label': ariaLabel,
  }, glyph ? icon(glyph, { size: '1.2rem' }) : null, label);
}

export function navButton(label, onClick, { strong = false, disabled = false, glyph = null, ariaLabel = null } = {}) {
  return h('button', { type: 'button', class: ['nav-btn', strong ? 'strong' : ''], disabled, onClick, 'aria-label': ariaLabel || (label === '' ? null : label) },
    glyph ? icon(glyph) : null, label ? h('span', null, label) : null);
}

export function iconButton(glyph, label, onClick, { disabled = false } = {}) {
  return h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, onClick, disabled }, icon(glyph));
}

// ---------------------------------------------------------------- badges for categories and payment methods

export function badge(item, size = '') {
  const el = h('span', { class: ['badge', size], 'aria-hidden': 'true', style: { '--c': item.colorHex || '#8E8E93' } }, glyphFor(item.iconSymbol));
  return el;
}

export function swatch(color) {
  return h('span', { class: 'swatch', 'aria-hidden': 'true', style: { '--c': color } });
}

// ---------------------------------------------------------------- lists

/** A titled group of rows with an optional footnote. */
export function group(rows, { title = null, footer = null, className = '', titleAction = null } = {}) {
  const items = [].concat(rows).filter(Boolean);
  return h('section', { class: ['section', className] },
    title || titleAction ? h('div', { class: 'section-head' }, title ? h('h2', { class: 'section-title' }, title) : h('span'), titleAction) : null,
    h('div', { class: 'group' }, items),
    footer ? h('p', { class: 't-foot footnote' }, footer) : null);
}

export function row({
  title, sub = null, value = null, badge: badgeEl = null, chevron = false, onClick = null, destructive = false, trailing = null,
  check = false, amount = null, amountSub = null, selectable = null, ariaLabel = null, disabled = false, subClass = '', titleClass = '',
}) {
  const kids = [];
  if (selectable !== null) kids.push(h('span', { class: ['row-select', selectable ? 'on' : ''], 'aria-hidden': 'true' }, selectable ? icon('check') : null));
  if (badgeEl) kids.push(badgeEl);
  kids.push(h('div', { class: 'row-main' },
    h('div', { class: ['row-title', titleClass] }, title),
    sub ? h('div', { class: ['row-sub', subClass] }, sub) : null));
  if (amount !== null) {
    kids.push(h('div', { class: 'row-amount num' }, amount, amountSub ? h('span', { class: 'sub' }, amountSub) : null));
  }
  if (value !== null) kids.push(h('div', { class: 'row-value' }, value));
  if (trailing) kids.push(trailing);
  if (check) kids.push(icon('check', { className: 'row-check' }));
  if (chevron) kids.push(icon('chevronRight', { className: 'row-chevron' }));
  const clickable = typeof onClick === 'function';
  return h(clickable ? 'button' : 'div', {
    class: ['row', badgeEl || selectable !== null ? 'with-badge' : '', destructive ? 'destructive' : '', disabled ? 'disabled' : ''],
    type: clickable ? 'button' : null,
    disabled: clickable ? disabled : null,
    onClick: clickable ? onClick : null,
    'aria-label': ariaLabel,
  }, kids);
}

/** A row with an on/off switch. `onChange(checked)` runs when it is flipped. */
export function toggleRow({ title, sub = null, checked = false, onChange, disabled = false }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, disabled, 'aria-checked': checked ? 'true' : 'false' });
  input.addEventListener('change', () => {
    input.setAttribute('aria-checked', input.checked ? 'true' : 'false');
    onChange(input.checked, input);
  });
  const el = h('label', { class: ['row', 'pressable', disabled ? 'disabled' : ''] },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, title), sub ? h('div', { class: 'row-sub' }, sub) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'track' })));
  el.input = input;
  return el;
}

/** A row with a label and a text box. */
export function inputRow({ label, input }) {
  const id = uid('in');
  input.id = id;
  input.classList.add('bare');
  return h('div', { class: 'input-row' }, h('label', { for: id }, label), input);
}

// ---------------------------------------------------------------- controls

/** Choose one of a few options. `onChange(value)` runs when a different one is chosen. */
export function segmented({ options, value, onChange, label = null }) {
  const el = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
  const buttons = options.map((option) => h('button', {
    type: 'button', class: 'seg', 'aria-pressed': option.value === value ? 'true' : 'false', dataset: { value: option.value },
    onClick: () => {
      if (option.value === el.value) return;
      el.set(option.value);
      onChange(option.value);
    },
  }, option.label));
  el.value = value;
  el.set = (next) => {
    el.value = next;
    for (const b of buttons) b.setAttribute('aria-pressed', b.dataset.value === String(next) ? 'true' : 'false');
  };
  el.append(...buttons);
  return el;
}

export function chip(label, { pressed = null, onClick = null, removable = false, className = '', ariaLabel = null } = {}) {
  const el = h('button', {
    type: 'button',
    class: ['chip', className],
    'aria-pressed': pressed === null ? null : (pressed ? 'true' : 'false'),
    'aria-label': ariaLabel || (removable ? `Remove ${label}` : null),
    onClick,
  }, label, removable ? icon('x', { className: 'x' }) : null);
  return el;
}

export function field({ label, control, hint = null, error = null }) {
  const id = control.id || uid('fld');
  control.id = id;
  return h('div', { class: 'field' },
    label ? h('label', { for: id }, label) : null,
    control,
    hint ? h('p', { class: 't-hint', style: { padding: '0 0.25rem' } }, hint) : null,
    error ? h('p', { class: 'field-error', role: 'alert' }, error) : null);
}

export function textInput({ value = '', placeholder = '', type = 'text', inputMode = null, maxLength = null, autocomplete = 'off', onInput = null, ariaLabel = null, autocapitalize = 'sentences' } = {}) {
  const input = h('input', {
    class: 'input', type, value, placeholder, inputmode: inputMode, maxlength: maxLength, autocomplete, autocorrect: 'off', spellcheck: 'false',
    autocapitalize, 'aria-label': ariaLabel,
  });
  if (onInput) input.addEventListener('input', () => onInput(input.value, input));
  return input;
}

export function searchField({ value = '', placeholder = 'Search', onInput, onClear = null }) {
  const input = h('input', { class: 'input', type: 'search', value, placeholder, autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', autocapitalize: 'none', enterkeyhint: 'search', 'aria-label': placeholder });
  const clearButton = h('button', { type: 'button', class: 'clear', 'aria-label': 'Clear search', hidden: value === '', onClick: () => {
    input.value = '';
    clearButton.hidden = true;
    onInput('');
    if (onClear) onClear();
    input.focus();
  } }, icon('x'));
  input.addEventListener('input', () => {
    clearButton.hidden = input.value === '';
    onInput(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  const el = h('div', { class: 'search', role: 'search' }, icon('search'), input, clearButton);
  el.input = input;
  return el;
}

// ---------------------------------------------------------------- feedback

export function emptyState({ mark = '🗒️', title, message = null, action = null }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-mark', 'aria-hidden': 'true' }, mark),
    h('h2', { class: 'empty-title' }, title),
    message ? h('p', null, message) : null,
    action);
}

export function notice({ kind = '', title = null, body, actions = [], onDismiss = null, glyph = null }) {
  return h('div', { class: ['notice', kind], role: kind === 'bad' ? 'alert' : 'status' },
    glyph ? icon(glyph, { size: '1.3rem' }) : null,
    h('div', { class: 'notice-body' },
      title ? h('div', { class: 'notice-title' }, title) : null,
      body ? h('div', null, body) : null,
      actions),
    onDismiss ? h('button', { type: 'button', class: 'dismiss', 'aria-label': 'Dismiss', onClick: onDismiss }, icon('x')) : null);
}

export function linkButton(label, onClick) {
  return h('button', { type: 'button', class: 'link', onClick }, label);
}

export function progress(percent, { kind = '' } = {}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const colour = kind === 'exceeded' ? 'var(--bad)' : kind === 'approaching' ? 'var(--warn)' : 'var(--accent)';
  return h('div', { class: ['progress', clamped === 0 ? 'zero' : ''], role: 'presentation', 'aria-hidden': 'true' },
    h('span', { style: { '--p': clamped, '--bar': colour } }));
}

// ---------------------------------------------------------------- money in big type

/** Splits a formatted amount into the whole part and the fraction, using the person's separators. */
export function splitMoney(formatter, m) {
  const decimals = digitsOf(m);
  const text = formatter.money.numberText(Math.abs(m.minorUnits), decimals);
  const sign = m.minorUnits < 0 ? '−' : '';
  if (decimals === 0) return { sign, whole: text, fraction: '' };
  const cut = text.lastIndexOf(formatter.money.decimalSeparator);
  return { sign, whole: text.slice(0, cut), fraction: text.slice(cut) };
}

/** The amount in large display type: "AED  4,820 .50". `plusSign` writes "+" before a positive amount (for differences). */
export function moneyBig(formatter, m, { size = '', showCurrency = true, plusSign = false } = {}) {
  const parts = splitMoney(formatter, m);
  const sign = plusSign && m.minorUnits > 0 ? '+' : parts.sign;
  const long = size === '' && parts.whole.length > 9;
  const spoken = plusSign ? formatter.money.signedString(m) : formatter.money.string(m, showCurrency);
  return h('div', { class: ['money-big', size, long ? 'long' : ''] },
    h('span', { class: 'sr-only' }, spoken),
    showCurrency ? h('span', { class: 'cur', 'aria-hidden': 'true' }, m.currencyCode) : null,
    h('span', { class: 'whole', 'aria-hidden': 'true' }, sign + parts.whole),
    parts.fraction ? h('span', { class: 'frac', 'aria-hidden': 'true' }, parts.fraction) : null);
}

export { activate };
