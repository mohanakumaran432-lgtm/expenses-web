// Typing an amount: the big number on screen and the on-screen number keypad.
// Amounts are typed as digits and kept exact (core/amount_input.js), so there is no floating point and no way to enter more
// decimals than the currency has.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { AmountInput } from '../../core/amount_input.js';

/**
 * @returns { display, keypad, input, attachKeys(target), set(money), destroy() }
 *   display   the big number (put it where the amount belongs)
 *   keypad    the 3 x 4 grid of keys (put it at the bottom)
 *   input     the AmountInput; read `input.money` for the exact amount
 *   attachKeys(target) lets a hardware keyboard type the amount too while `target` (the sheet) is the one on top; returns a function that stops it
 */
export function amountPad({ app, currencyCode, initial = null, onChange = () => {} }) {
  const input = initial && initial.minorUnits > 0 ? AmountInput.prefilled(currencyCode, initial) : new AmountInput(currencyCode);
  const money = app.formatter.money;
  const textEl = h('span', { class: 'amount-text num' });
  const display = h('div', { class: 'amount-display', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'amount-cur', 'aria-hidden': 'true' }, currencyCode), textEl);

  function draw() {
    const empty = input.isEmpty;
    textEl.textContent = empty ? '0' : input.displayText(money.groupingSeparator, money.decimalSeparator);
    textEl.classList.toggle('no-value', empty);
    display.setAttribute('aria-label', empty ? `${currencyCode}, no amount yet` : `${currencyCode} ${textEl.textContent}`);
  }

  function reject() {
    display.classList.remove('nope');
    // Restart the little shake: the browser must see the class removed before it is added again.
    void display.offsetWidth;
    display.classList.add('nope');
  }

  function apply(change) {
    const accepted = change();
    if (accepted === false) reject();
    draw();
    onChange();
  }

  const digit = (value) => apply(() => input.appendDigit(value));
  const point = () => apply(() => input.appendPoint());
  const back = () => apply(() => { input.deleteLast(); return true; });
  const wipe = () => apply(() => { input.clear(); return true; });

  function key(label, handler, extra = {}) {
    return h('button', { type: 'button', class: ['key', extra.fn ? 'fn' : ''], 'aria-label': extra.ariaLabel || null, disabled: Boolean(extra.disabled), onClick: handler }, label);
  }

  const canPoint = input.allowedFractionDigits > 0;
  const backKey = h('button', { type: 'button', class: 'key fn', 'aria-label': 'Delete the last digit' }, icon('backspace'));
  let holdTimer = null;
  let held = false;
  backKey.addEventListener('pointerdown', () => {
    held = false;
    holdTimer = setTimeout(() => { held = true; wipe(); }, 550);
  });
  const stopHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  backKey.addEventListener('pointerup', stopHold);
  backKey.addEventListener('pointerleave', stopHold);
  backKey.addEventListener('pointercancel', stopHold);
  backKey.addEventListener('click', () => { if (!held) back(); held = false; });

  const keypad = h('div', { class: 'keypad', role: 'group', 'aria-label': 'Amount keypad' },
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => key(String(n), () => digit(n))),
    canPoint ? key(money.decimalSeparator, point, { fn: true, ariaLabel: 'Decimal point' }) : h('span', { class: 'key-gap', 'aria-hidden': 'true' }),
    key('0', () => digit(0)),
    backKey);

  function attachKeys(target) {
    const onKey = (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      // Only the sheet on top listens: while something is open above it (or it is closed), it is out of reach (`inert`) or gone.
      if (!target.isConnected || target.closest('[inert]')) return;
      const t = event.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (/^[0-9]$/.test(event.key)) digit(Number(event.key));
      else if ((event.key === '.' || event.key === ',') && canPoint) point();
      else if (event.key === 'Backspace') back();
      else return;
      event.preventDefault();
    };
    // On the whole page, not on the sheet: a sheet is opened with the focus on its frame, which is outside `target`, so keys
    // pressed before anything inside was touched would never reach a listener on `target` (an iPhone does not focus a tapped button).
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }

  draw();
  return {
    display,
    keypad,
    input,
    attachKeys,
    set(amount) {
      input.clear();
      if (amount && amount.minorUnits > 0) Object.assign(input, AmountInput.prefilled(currencyCode, amount));
      draw();
      onChange();
    },
    destroy: stopHold,
  };
}
