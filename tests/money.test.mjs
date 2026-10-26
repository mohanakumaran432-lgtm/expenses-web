import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx } from './support.mjs';
import { DEFAULT_CURRENCY_CODE, digitsForCode, isKnownCurrency } from '../docs/js/core/currency.js';
import { MoneyFormatter } from '../docs/js/core/format.js';
import {
  MAX_EXACT, add, compareMoney, dividedBy, money, parseMoney, percentChange, percentShare, plainString, subtract, sum,
} from '../docs/js/core/money.js';

const parseError = (text, code = 'AED') => {
  const result = parseMoney(text, code);
  return result.ok ? null : result;
};

// Parsing ----------------------------------------------------------------------------------------

test('parses whole and decimal amounts', () => {
  assert.equal(Fx.money('12.5').minorUnits, 1250);
  assert.equal(Fx.money('12,50').minorUnits, 1250);
  assert.equal(Fx.money('0.05').minorUnits, 5);
  assert.equal(Fx.money('.5').minorUnits, 50);
  assert.equal(Fx.money('  7 ').minorUnits, 700);
  assert.equal(Fx.money('0007').minorUnits, 700);
});

test('rejects invalid input', () => {
  assert.equal(parseError('').error, 'empty');
  assert.equal(parseError('   ').error, 'empty');
  assert.equal(parseError('abc').error, 'invalidCharacters');
  assert.equal(parseError('1.2.3').error, 'invalidCharacters');
  assert.equal(parseError('1,2,3').error, 'invalidCharacters');
  assert.equal(parseError('-5').error, 'invalidCharacters');
  assert.equal(parseError('5 000').error, 'invalidCharacters');
  assert.equal(parseError('1e5').error, 'invalidCharacters');
  assert.equal(parseError('.').error, 'invalidCharacters');
  assert.equal(parseError('١٢').error, 'invalidCharacters', 'Arabic-Indic digits are not accepted');
});

test('too many decimals is rejected, not rounded', () => {
  assert.deepEqual(parseError('1.234'), { ok: false, error: 'tooManyDecimals', allowed: 2 });
  assert.deepEqual(parseError('12.5', 'JPY'), { ok: false, error: 'tooManyDecimals', allowed: 0 });
  assert.deepEqual(parseError('1.2345', 'KWD'), { ok: false, error: 'tooManyDecimals', allowed: 3 });
});

test('currency minor units', () => {
  assert.equal(Fx.money('1500', 'JPY').minorUnits, 1500);
  assert.equal(Fx.money('1.5', 'KWD').minorUnits, 1500);
  assert.equal(Fx.money('1.234', 'KWD').minorUnits, 1234);
  assert.equal(digitsForCode('AED'), 2);
  assert.equal(digitsForCode('JPY'), 0);
  assert.equal(digitsForCode('KWD'), 3);
  assert.equal(digitsForCode('BHD'), 3);
  assert.equal(digitsForCode('XYZ'), 2, 'Unknown codes use two decimals');
  assert.equal(DEFAULT_CURRENCY_CODE, 'AED');
  assert.ok(isKnownCurrency('USD'));
});

test('a huge number is "too large", not a crash', () => {
  assert.equal(parseError('99999999999999999999').error, 'tooLarge');
});

// Exactness --------------------------------------------------------------------------------------

test('decimal fractions add exactly', () => {
  assert.deepEqual(add(Fx.money('0.10'), Fx.money('0.20')), Fx.money('0.30'));
});

test('a thousand cents sum to ten exactly', () => {
  const pennies = Array.from({ length: 1000 }, () => Fx.money('0.01'));
  assert.deepEqual(sum(pennies, 'AED'), Fx.money('10'));
  assert.equal(plainString(sum(pennies, 'AED')), '10.00');
});

test('plainString is locale independent and padded', () => {
  assert.equal(plainString(money(5, 'AED')), '0.05');
  assert.equal(plainString(money(1250, 'AED')), '12.50');
  assert.equal(plainString(money(1500, 'JPY')), '1500');
  assert.equal(plainString(money(1500, 'KWD')), '1.500');
  assert.equal(plainString(money(-5, 'AED')), '-0.05');
  assert.equal(plainString(money(0, 'AED')), '0.00');
});

test('the currency code is upper-cased', () => {
  assert.equal(money(1, 'aed').currencyCode, 'AED');
});

test('adding different currencies is refused', () => {
  assert.throws(() => add(Fx.money('1', 'AED'), Fx.money('1', 'USD')), /different currencies/);
  assert.throws(() => subtract(Fx.money('1', 'AED'), Fx.money('1', 'USD')), /different currencies/);
});

// Arithmetic limits ------------------------------------------------------------------------------

test('addition saturates instead of overflowing', () => {
  const big = money(MAX_EXACT, 'AED');
  assert.equal(add(big, money(1, 'AED')).minorUnits, MAX_EXACT);
  const small = money(-MAX_EXACT, 'AED');
  assert.equal(subtract(small, money(1, 'AED')).minorUnits, -MAX_EXACT);
});

test('subtraction and comparison', () => {
  assert.equal(subtract(Fx.money('10'), Fx.money('2.50')).minorUnits, 750);
  assert.equal(subtract(Fx.money('2'), Fx.money('10')).minorUnits, -800);
  assert.ok(compareMoney(Fx.money('5'), Fx.money('7')) < 0);
  assert.equal(compareMoney(Fx.money('7'), Fx.money('7')), 0);
});

// Division and rounding (derived values only) ----------------------------------------------------

test('an average rounds to the minor unit', () => {
  assert.equal(dividedBy(Fx.money('10'), 3).minorUnits, 333);
  assert.equal(dividedBy(Fx.money('10'), 8).minorUnits, 125);
  assert.equal(dividedBy(Fx.money('20'), 3).minorUnits, 667);
});

test('half a minor unit rounds away from zero', () => {
  // 0.05 / 2 = 0.025, which is half a fils: it rounds up to 0.03 the way people expect.
  assert.equal(dividedBy(Fx.money('0.05'), 2).minorUnits, 3);
});

test('dividing by zero or a negative count gives zero', () => {
  assert.equal(dividedBy(Fx.money('10'), 0).minorUnits, 0);
  assert.equal(dividedBy(Fx.money('10'), -2).minorUnits, 0);
});

// Display ----------------------------------------------------------------------------------------

test('the formatter uses the chosen separators', () => {
  const amount = money(123_456, 'AED');
  assert.equal(new MoneyFormatter('en-US', 'commaDot').string(amount, false), '1,234.56');
  assert.equal(new MoneyFormatter('en-US', 'dotComma').string(amount, false), '1.234,56');
  assert.equal(new MoneyFormatter('en-US', 'spaceComma').string(amount, false), '1 234,56');
  assert.equal(new MoneyFormatter('en-US', 'apostropheDot').string(amount, false), '1’234.56');
});

test('the formatter exposes the separators it uses', () => {
  const chosen = [
    ['commaDot', ',', '.'],
    ['dotComma', '.', ','],
    ['spaceComma', ' ', ','],
    ['apostropheDot', '’', '.'],
  ];
  for (const [style, grouping, decimal] of chosen) {
    const formatter = new MoneyFormatter('en-US', style);
    assert.equal(formatter.groupingSeparator, grouping);
    assert.equal(formatter.decimalSeparator, decimal);
  }
  const system = new MoneyFormatter('en-US', 'system');
  assert.equal(system.decimalSeparator, '.');
  assert.equal(system.groupingSeparator, ',');
});

test('the formatter honors currency decimals', () => {
  const formatter = new MoneyFormatter('en-US', 'commaDot');
  assert.equal(formatter.string(money(1500, 'JPY'), false), '1,500');
  assert.equal(formatter.string(money(1234, 'KWD'), false), '1.234');
  assert.equal(formatter.string(money(5, 'AED'), false), '0.05');
  assert.equal(formatter.string(money(-250, 'AED'), false), '-2.50');
});

test('the formatter shows the currency code somewhere', () => {
  const formatter = new MoneyFormatter('en-US', 'commaDot');
  const text = formatter.string(money(123_456, 'AED'));
  assert.ok(text.includes('AED'), text);
  assert.ok(text.includes('1,234.56'), text);
});

test('system formatting follows the locale', () => {
  const german = new MoneyFormatter('de-DE', 'system');
  assert.equal(german.decimalSeparator, ',');
  assert.equal(german.groupingSeparator, '.');
  assert.ok(german.string(money(123_456, 'EUR')).includes('1.234,56'));
});

test('compact amounts for chart axes', () => {
  const formatter = new MoneyFormatter('en-US', 'commaDot');
  assert.equal(formatter.compactString(money(0, 'AED')), '0');
  assert.equal(formatter.compactString(money(95_000, 'AED')), '950');
  assert.equal(formatter.compactString(money(250_000, 'AED')), '2.5K');
  assert.equal(formatter.compactString(money(1_500_000, 'AED')), '15K', 'a trailing .0 is dropped');
  assert.equal(formatter.compactString(money(99_994_000, 'AED')), '999.9K');
  assert.equal(formatter.compactString(money(99_995_000, 'AED')), '1M', 'rounding never writes 1000K');
  assert.equal(formatter.compactString(money(340_000_000, 'AED')), '3.4M');
  assert.equal(formatter.compactString(money(-250_000, 'AED')), '-2.5K');
  const german = new MoneyFormatter('de-DE', 'system');
  assert.equal(german.compactString(money(250_000, 'EUR')), '2,5K');
});

test('percent formatting', () => {
  const formatter = new MoneyFormatter('en-US', 'commaDot');
  assert.equal(formatter.percentString(12.5), '12.5%');
  assert.equal(formatter.percentString(100), '100.0%');
});

test('signed formatting writes the direction as text', () => {
  const formatter = new MoneyFormatter('en-US', 'commaDot');
  assert.equal(formatter.signedPercentString(12.5), '+12.5%');
  assert.equal(formatter.signedPercentString(-3), '−3.0%');
  assert.equal(formatter.signedPercentString(0), '0.0%');

  const up = formatter.signedString(money(12_000, 'AED'));
  assert.ok(up.startsWith('+'), up);
  assert.ok(up.includes('120.00'), up);

  const down = formatter.signedString(money(-3_000, 'AED'));
  assert.ok(down.startsWith('−'), down);
  assert.ok(down.includes('30.00'), down);
  assert.ok(!down.includes('-'), down);

  const none = formatter.signedString(money(0, 'AED'));
  assert.ok(!none.startsWith('+'), none);
  assert.ok(!none.startsWith('−'), none);
});

test('percent math', () => {
  const part = Fx.money('1');
  const total = Fx.money('3');
  assert.equal(percentShare(part, total), 33.3, '33.333... rounds to one decimal place');
  assert.equal(percentShare(part, Fx.money('0')), 0, 'No division by zero');
  assert.equal(percentChange(Fx.money('0'), Fx.money('5')), null, 'A change from zero has no percentage');
  assert.equal(percentChange(Fx.money('100'), Fx.money('150')), 50);
  assert.equal(percentChange(Fx.money('200'), Fx.money('150')), -25);
});

test('percent rounds half away from zero', () => {
  // 1/8 = 12.5% exactly; 1/16 = 6.25% -> 6.3 (half away from zero), 2/3 = 66.666... -> 66.7
  assert.equal(percentShare(Fx.money('1'), Fx.money('16')), 6.3);
  assert.equal(percentShare(Fx.money('2'), Fx.money('3')), 66.7);
  assert.equal(percentChange(Fx.money('16'), Fx.money('15')), -6.3);
});

test('exact digits survive amounts near the limit', () => {
  const nearLimit = Fx.money('99999999999.99'); // 9_999_999_999_999 minor units
  assert.equal(nearLimit.minorUnits, 9_999_999_999_999);
  assert.equal(plainString(nearLimit), '99999999999.99');
  const formatter = new MoneyFormatter('en-US', 'commaDot');
  assert.equal(formatter.string(nearLimit, false), '99,999,999,999.99');
});
