import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { CalendarContext } from '../docs/js/core/calendar.js';
import {
  CSV_COLUMNS, csvRow, makeCSV, neutralizeFormula, parseCSV,
} from '../docs/js/core/csv.js';
import { makeCategory, makeExpense } from '../docs/js/core/models.js';
import { parseMoney, plainString } from '../docs/js/core/money.js';
import { ExpenseSearchIndex, makeFilter, makeSort, runQuery, totalOf } from '../docs/js/core/query.js';
import { LedgerDirectory } from '../docs/js/core/snapshot.js';

const sample = new SampleLedger();
const day = (y, m, d) => Fx.day(y, m, d);
const later = (seconds) => Fx.now + seconds * 1000;
const rows = (expenses, directory = sample.directory) => parseCSV(makeCSV(expenses, directory));
const tweak = (expense, changes) => makeExpense({ ...expense, ...changes });

// File shape -------------------------------------------------------------------------------------

test('header and file envelope', () => {
  const text = makeCSV([], sample.directory);
  assert.equal(text, '﻿Date,Time,Amount,Currency,Category,Subcategory,Payment Method,Merchant,Notes,Tags,Recurring,ID\r\n');
  assert.equal(CSV_COLUMNS.length, 12);
  const bytes = new TextEncoder().encode(text);
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xEF, 0xBB, 0xBF], 'UTF-8 byte order mark, so Arabic text opens correctly');
});

test('lines end with CRLF only', () => {
  const text = makeCSV(sample.snapshot.expenses, sample.directory);
  assert.ok(text.endsWith('\r\n'));
  const withoutBreaks = text.replaceAll('\r\n', '');
  assert.ok(!withoutBreaks.includes('\n'));
  assert.ok(!withoutBreaks.includes('\r'));
  assert.equal(text.split('\r\n').length, 10, 'Nine lines plus the empty piece after the last break');
});

// Content ----------------------------------------------------------------------------------------

test('the sample ledger exports oldest first with every column', () => {
  const table = rows(sample.snapshot.expenses);
  assert.equal(table.length, 9);
  assert.deepEqual(table[0], [...CSV_COLUMNS]);
  assert.ok(table.slice(1).every((row) => row.length === 12));
  assert.deepEqual(table.slice(1).map((row) => row[2]), ['200.00', '15.00', '30.00', '18.00', '120.00', '50.00', '12.50', '8.00']);
  assert.deepEqual(table[6], ['2026-10-20', '', '50.00', 'AED', 'Groceries', 'Milk', 'Cash', 'Spinneys', '', 'family', 'No', sample.e[0].id]);
  assert.equal(table[4][7], 'Café Nero', 'Accented text is kept as typed');
  assert.equal(table[4][9], 'Work');
  assert.equal(table[5][6], '', 'No payment method is an empty field');
  assert.equal(table[8][7], '', 'No merchant is an empty field');
});

test('exported amounts add up to the report total', () => {
  const body = rows(sample.snapshot.expenses).slice(1);
  let total = 0;
  for (const row of body) {
    const parsed = parseMoney(row[2], row[3]);
    assert.ok(parsed.ok, `Not an amount: ${row[2]}`);
    total += parsed.money.minorUnits;
  }
  const report = Fx.report(sample.snapshot, SampleLedger.fullRange);
  assert.equal(total, report.total.minorUnits);
  assert.equal(total, SampleLedger.grandTotalMinor);
  assert.equal(body.length, report.count);
});

test('amounts use the decimals of their currency', () => {
  const d = day(2026, 10, 20);
  const yen = Fx.expense('1500', d, sample.groceries, { currency: 'JPY', createdAt: later(1) });
  const dinar = Fx.expense('12.345', d, sample.groceries, { currency: 'KWD', createdAt: later(2) });
  const dirham = Fx.expense('7', d, sample.groceries, { createdAt: later(3) });
  const table = rows([dirham, dinar, yen]).slice(1);
  assert.deepEqual(table.map((row) => row[2]), ['1500', '12.345', '7.00']);
  assert.deepEqual(table.map((row) => row[3]), ['JPY', 'KWD', 'AED']);
});

test('explicit times are written as 24-hour time in their own zone', () => {
  const morning = tweak(Fx.expense('5', day(2026, 10, 20), sample.coffee, { createdAt: later(1) }), {
    hasExplicitTime: true, occurredAt: new CalendarContext(Fx.dubai).instant(day(2026, 10, 20), 9, 5),
  });
  const night = tweak(Fx.expense('6', day(2026, 10, 21), sample.coffee, { zone: Fx.newYork, createdAt: later(2) }), {
    hasExplicitTime: true, occurredAt: new CalendarContext(Fx.newYork).instant(day(2026, 10, 21), 23, 30),
  });
  const noTime = Fx.expense('7', day(2026, 10, 22), sample.coffee, { createdAt: later(3) });

  const table = rows([noTime, night, morning]);
  assert.deepEqual(table[1].slice(0, 2), ['2026-10-20', '09:05']);
  assert.deepEqual(table[2].slice(0, 2), ['2026-10-21', '23:30'], 'The day stays the day it was recorded on');
  assert.deepEqual(table[3].slice(0, 2), ['2026-10-22', '']);
});

test('recurring column', () => {
  const repeating = tweak(Fx.expense('5', day(2026, 10, 20), sample.coffee, { createdAt: later(1) }), { recurringTemplateID: Fx.uuid(5001) });
  const plain = Fx.expense('6', day(2026, 10, 21), sample.coffee, { createdAt: later(2) });
  const table = rows([repeating, plain]);
  assert.equal(table[1][10], 'Yes');
  assert.equal(table[2][10], 'No');
});

test('names fall back to what was saved with the expense', () => {
  const orphan = tweak(Fx.expense('5', day(2026, 10, 20), sample.coffee), {
    categoryID: Fx.uuid(9999), categoryNameSnapshot: 'Old category',
    subcategoryID: Fx.uuid(9998), subcategoryNameSnapshot: 'Old sub',
    paymentMethodID: Fx.uuid(9997), paymentMethodNameSnapshot: 'Old card',
  });
  assert.deepEqual(rows([orphan])[1].slice(4, 7), ['Old category', 'Old sub', 'Old card']);
});

test('exporting a filtered list gives exactly those rows', () => {
  const filter = makeFilter({ categoryIDs: new Set([sample.groceries.id]) });
  const directory = sample.directory;
  const index = new ExpenseSearchIndex(sample.snapshot.expenses, directory);
  const shown = runQuery(sample.snapshot.expenses, filter, makeSort(), directory, index);
  const body = rows(shown).slice(1);
  assert.equal(body.length, 3);
  assert.deepEqual(new Set(body.map((row) => row[4])), new Set(['Groceries']));
  assert.deepEqual(body.map((row) => row[2]), ['30.00', '50.00', '12.50']);
  assert.equal(totalOf(shown, 'AED').minorUnits, 9_250, 'Matches 30.00 + 50.00 + 12.50');
});

// Escaping ---------------------------------------------------------------------------------------

test('tricky text survives a round trip', () => {
  const tricky = tweak(Fx.expense('10', day(2026, 10, 20), sample.groceries, { createdAt: later(1) }), {
    merchant: 'He said "hi", twice', notes: 'line one\nline two\r\nline three', tags: ['a', 'b c'],
  });
  const arabic = tweak(Fx.expense('11', day(2026, 10, 21), sample.groceries, { createdAt: later(2) }), {
    merchant: 'مطعم الشام', notes: 'قهوة ☕',
  });
  const padded = tweak(Fx.expense('12', day(2026, 10, 22), sample.groceries, { createdAt: later(3) }), { merchant: '  padded  ' });

  const list = [tricky, arabic, padded];
  const text = makeCSV(list, sample.directory);
  assert.ok(text.includes('"He said ""hi"", twice"'), 'Quotes are doubled inside a quoted field');

  const table = parseCSV(text);
  assert.equal(table.length, 4);
  list.forEach((expense, offset) => {
    assert.deepEqual(table[offset + 1], csvRow(expense, sample.directory));
  });
  assert.equal(table[1][7], 'He said "hi", twice');
  assert.equal(table[1][8], 'line one\nline two\r\nline three');
  assert.equal(table[1][9], 'a; b c');
  assert.equal(table[2][7], arabic.merchant);
  assert.equal(table[2][8], arabic.notes);
  assert.equal(table[3][7], '  padded  ');
});

test('formula starters are neutralised', () => {
  assert.equal(neutralizeFormula('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(neutralizeFormula('+1+1'), "'+1+1");
  assert.equal(neutralizeFormula('-2+3'), "'-2+3");
  assert.equal(neutralizeFormula('@cmd'), "'@cmd");
  assert.equal(neutralizeFormula('\tcmd'), "'\tcmd");
  assert.equal(neutralizeFormula('\rcmd'), "'\rcmd");
  assert.equal(neutralizeFormula('Coffee = good'), 'Coffee = good', 'Only the first character matters');
  assert.equal(neutralizeFormula('a-b'), 'a-b');
  assert.equal(neutralizeFormula(''), '');
});

test('every text column is protected but amounts are not', () => {
  const snapshot = sample.snapshot.clone();
  snapshot.categories = snapshot.categories.map((c) => (c.id === sample.groceries.id ? makeCategory({ ...c, name: '=1+1' }) : c));
  snapshot.invalidate();
  const risky = tweak(Fx.expense('12.50', day(2026, 10, 20), sample.groceries, { createdAt: later(1) }), {
    merchant: '=HYPERLINK("http://example.com","click")', notes: "+cmd|' /C calc'!A0", tags: ['@sum', '-x'],
  });

  const row = rows([risky], new LedgerDirectory(snapshot))[1];
  assert.equal(row[2], '12.50', 'Amounts are plain numbers and never get a prefix');
  assert.equal(row[4], "'=1+1");
  assert.equal(row[7], `'=HYPERLINK("http://example.com","click")`);
  assert.equal(row[8], "'+cmd|' /C calc'!A0");
  assert.equal(row[9], "'@sum; -x");
  for (const field of row) {
    assert.ok(!['=', '+', '-', '@', '\t', '\r'].includes(field[0]), `Field starts like a formula: ${field}`);
  }
});

// Many rows --------------------------------------------------------------------------------------

test('five thousand rows reconcile and round trip', () => {
  const list = [];
  let expectedTotal = 0;
  for (let i = 0; i < 5_000; i += 1) {
    const amount = `${(i % 300) + 1}.${i % 2 === 0 ? '00' : '75'}`;
    const merchant = i % 7 === 0 ? `Shop, "No. ${i}"` : `Shop ${i % 13}`;
    const item = Fx.expense(amount, day(2025, 1, 1).addingDays(i % 400), sample.groceries, { merchant, createdAt: later(i) });
    expectedTotal += item.amount.minorUnits;
    list.push(item);
  }
  const table = rows(list);
  assert.equal(table.length, 5_001);

  const byID = new Map(list.map((item) => [item.id, item]));
  let parsedTotal = 0;
  let mismatches = 0;
  for (const row of table.slice(1)) {
    const original = byID.get(row[11]);
    if (!original) { mismatches += 1; continue; }
    if (row[7] !== original.merchant || row[2] !== plainString(original.amount)) mismatches += 1;
    const parsed = parseMoney(row[2], row[3]);
    if (parsed.ok) parsedTotal += parsed.money.minorUnits;
  }
  assert.equal(mismatches, 0);
  assert.equal(parsedTotal, expectedTotal);
  assert.equal(new Set(table.slice(1).map((row) => row[11])).size, 5_000, 'Every row keeps its own ID');
});

// The reader used by the tests -------------------------------------------------------------------

test('the parser handles quotes, commas and line breaks', () => {
  assert.deepEqual(parseCSV('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCSV('"a,b","c""d"\r\n'), [['a,b', 'c"d']]);
  assert.deepEqual(parseCSV('x,"multi\r\nline"\r\n'), [['x', 'multi\r\nline']]);
  assert.deepEqual(parseCSV('a,b'), [['a', 'b']], 'A missing final line break is tolerated');
  assert.deepEqual(parseCSV(',\r\n'), [['', '']]);
  assert.deepEqual(parseCSV('"",x\n'), [['', 'x']]);
  assert.deepEqual(parseCSV('﻿h\r\n'), [['h']], 'The byte order mark is not part of the first field');
  assert.deepEqual(parseCSV(''), []);
});
