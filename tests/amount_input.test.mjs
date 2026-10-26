import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx } from './support.mjs';
import { AmountInput, MAX_WHOLE_DIGITS } from '../docs/js/core/amount_input.js';

function type(text, input) {
  for (const character of text) {
    if (character === '.') input.appendPoint();
    else if (/[0-9]/.test(character)) input.appendDigit(Number(character));
  }
}

test('typing builds the exact amount', () => {
  const input = new AmountInput('AED');
  type('12.5', input);
  assert.equal(input.money.minorUnits, 1250);
  assert.equal(input.displayText(), '12.5');
});

test('empty input is zero', () => {
  const input = new AmountInput('AED');
  assert.ok(input.isEmpty);
  assert.ok(input.isZero);
  assert.equal(input.displayText(), '0');
});

test('a second point is ignored', () => {
  const input = new AmountInput('AED');
  type('1', input);
  assert.ok(input.appendPoint());
  assert.ok(!input.appendPoint());
  type('5', input);
  assert.equal(input.money.minorUnits, 150);
});

test('a third decimal digit is rejected for two-decimal currencies', () => {
  const input = new AmountInput('AED');
  type('1.25', input);
  assert.ok(!input.appendDigit(9));
  assert.equal(input.money.minorUnits, 125);
});

test('yen has no decimal point', () => {
  const input = new AmountInput('JPY');
  type('1500', input);
  assert.ok(!input.appendPoint());
  assert.equal(input.money.minorUnits, 1500);
});

test('dinar allows three decimals', () => {
  const input = new AmountInput('KWD');
  type('1.234', input);
  assert.ok(!input.appendDigit(5));
  assert.equal(input.money.minorUnits, 1234);
});

test('leading zeros are collapsed', () => {
  const input = new AmountInput('AED');
  type('005', input);
  assert.equal(input.displayText(), '5');
  assert.equal(input.money.minorUnits, 500);
});

test('point first gives "0."', () => {
  const input = new AmountInput('AED');
  input.appendPoint();
  assert.equal(input.displayText(), '0.');
  type('5', input);
  assert.equal(input.displayText(), '0.5');
  assert.equal(input.money.minorUnits, 50);
});

test('delete walks backwards and never crashes', () => {
  const input = new AmountInput('AED');
  type('12.5', input);
  input.deleteLast();
  assert.equal(input.displayText(), '12.');
  input.deleteLast();
  assert.equal(input.displayText(), '12');
  input.deleteLast();
  assert.equal(input.displayText(), '1');
  input.deleteLast();
  assert.ok(input.isEmpty);
  input.deleteLast();
  input.deleteLast();
  assert.ok(input.isEmpty);
});

test('length limit', () => {
  const input = new AmountInput('AED');
  for (let i = 0; i < MAX_WHOLE_DIGITS; i += 1) assert.ok(input.appendDigit(9));
  assert.ok(!input.appendDigit(9));
  assert.equal(input.money.minorUnits, 999_999_999_900);
});

test('the longest amount of any currency is still a valid expense amount', () => {
  const dinar = new AmountInput('KWD');
  for (let i = 0; i < MAX_WHOLE_DIGITS; i += 1) dinar.appendDigit(9);
  dinar.appendPoint();
  for (let i = 0; i < 3; i += 1) dinar.appendDigit(9);
  assert.equal(dinar.money.minorUnits, 9_999_999_999_999);
  assert.ok(Number.isSafeInteger(dinar.money.minorUnits));
  assert.ok(dinar.money.minorUnits <= 10_000_000_000_000);
});

test('grouping and separators are display only', () => {
  const input = new AmountInput('AED');
  type('1234567.5', input);
  assert.equal(input.displayText(), '1,234,567.5');
  assert.equal(input.displayText('.', ','), '1.234.567,5');
  assert.equal(input.money.minorUnits, 123_456_750);
});

test('editing starts from the existing amount', () => {
  const input = AmountInput.prefilled('AED', Fx.money('12.50'));
  assert.equal(input.money.minorUnits, 1250);
  assert.equal(input.displayText(), '12.50');
  input.deleteLast();
  assert.equal(input.displayText(), '12.5');
  type('7', input);
  assert.equal(input.money.minorUnits, 1257);
});

test('clear starts over', () => {
  const input = new AmountInput('AED');
  type('99.99', input);
  input.clear();
  assert.ok(input.isEmpty);
  assert.equal(input.money.minorUnits, 0);
});

test('only digits zero to nine are accepted', () => {
  const input = new AmountInput('AED');
  assert.ok(!input.appendDigit(10));
  assert.ok(!input.appendDigit(-1));
  assert.ok(input.isEmpty);
});
