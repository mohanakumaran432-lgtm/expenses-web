// The state behind the on-screen numeric keypad.
//
// It works on typed digits only, so the result is an exact amount with no floating point. It enforces the
// currency's decimal places (2 for AED, 0 for JPY, 3 for KWD) while typing, so an invalid amount cannot even be entered.

import { digitsForCode } from './currency.js';
import { money, plainString } from './money.js';

export const MAX_WHOLE_DIGITS = 10;

export class AmountInput {
  constructor(currencyCode) {
    this.currencyCode = String(currencyCode).toUpperCase();
    this.whole = '';
    this.fraction = '';
    this.hasPoint = false;
  }

  /** Starts from an existing amount (used when editing an expense). */
  static prefilled(currencyCode, amount) {
    const input = new AmountInput(currencyCode);
    const parts = plainString(amount).split('.');
    input.whole = parts[0] === '' ? '0' : parts[0];
    if (parts.length > 1) {
      input.fraction = parts[1];
      input.hasPoint = true;
    }
    return input;
  }

  get allowedFractionDigits() {
    return digitsForCode(this.currencyCode);
  }

  get isEmpty() {
    return this.whole === '' && this.fraction === '' && !this.hasPoint;
  }

  /** Appends one digit. Returns false when the digit is not accepted (too many decimals, too long). */
  appendDigit(digit) {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) return false;
    const character = String(digit);
    if (this.hasPoint) {
      if (this.fraction.length >= this.allowedFractionDigits) return false;
      this.fraction += character;
      return true;
    }
    if (this.whole === '0') {
      if (digit === 0) return false;
      this.whole = character;
      return true;
    }
    if (this.whole.length >= MAX_WHOLE_DIGITS) return false;
    this.whole += character;
    return true;
  }

  /** Appends the decimal point. Not accepted for currencies without decimals or when one is already there. */
  appendPoint() {
    if (this.allowedFractionDigits === 0 || this.hasPoint) return false;
    this.hasPoint = true;
    if (this.whole === '') this.whole = '0';
    return true;
  }

  deleteLast() {
    if (this.hasPoint) {
      if (this.fraction === '') {
        this.hasPoint = false;
        if (this.whole === '0') this.whole = '';
      } else {
        this.fraction = this.fraction.slice(0, -1);
      }
      return;
    }
    if (this.whole !== '') this.whole = this.whole.slice(0, -1);
  }

  clear() {
    this.whole = '';
    this.fraction = '';
    this.hasPoint = false;
  }

  /** The exact amount typed so far (zero when nothing is typed). */
  get money() {
    const wholeText = this.whole === '' ? '0' : this.whole;
    const fractionText = this.fraction.padEnd(this.allowedFractionDigits, '0');
    return money(Number(wholeText + fractionText), this.currencyCode);
  }

  get isZero() {
    return this.money.minorUnits === 0;
  }

  /** Text exactly as typed, with thousands grouping, for the big number on screen. Example: "1,234.5". */
  displayText(groupingSeparator = ',', decimalSeparator = '.') {
    const wholeText = this.whole === '' ? '0' : this.whole;
    let grouped = '';
    let counter = 0;
    for (let i = wholeText.length - 1; i >= 0; i -= 1) {
      if (counter > 0 && counter % 3 === 0) grouped = groupingSeparator + grouped;
      grouped = wholeText[i] + grouped;
      counter += 1;
    }
    return this.hasPoint ? grouped + decimalSeparator + this.fraction : grouped;
  }
}
