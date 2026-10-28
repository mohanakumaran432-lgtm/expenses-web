import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addMonths, currentMonth, formatAed, isValidDay, monthRange, parseAmount, todayDubai, toFils } from './format.ts'
import { csvCell, toCsv } from './csv.ts'
import { byCategory, byMonth, totals } from './summary.ts'

test('parseAmount accepts valid money and rejects the rest', () => {
  assert.equal(parseAmount('12'), 12)
  assert.equal(parseAmount(' 1,234.50 '), 1234.5)
  for (const bad of ['', '0', '0.00', '-5', '1.234', 'abc', '1e3', '12345678901', '.5']) assert.equal(parseAmount(bad), null, bad)
})

test('fils conversion avoids floating-point drift', () => {
  assert.equal(toFils(0.1 + 0.2), 30)
  assert.equal(toFils(19.99), 1999)
  assert.match(formatAed(123450), /AED/)
})

test('Dubai date is used, not the device date', () => {
  // 21:00 UTC on 28 Oct is already 01:00 on 29 Oct in Dubai (UTC+4)
  assert.equal(todayDubai(new Date('2026-10-28T21:00:00Z')), '2026-10-29')
  assert.equal(todayDubai(new Date('2026-10-28T19:59:00Z')), '2026-10-28')
  assert.equal(currentMonth(new Date('2026-10-31T20:30:00Z')), '2026-11')
})

test('month arithmetic and ranges', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12')
  assert.equal(addMonths('2026-12', 1), '2027-01')
  assert.equal(addMonths('2026-10', -5), '2026-05')
  assert.deepEqual(monthRange('2026-12'), { from: '2026-12-01', toExclusive: '2027-01-01' })
  assert.ok(isValidDay('2026-02-28'))
  assert.ok(!isValidDay('2026-13-01') && !isValidDay('28/02/2026'))
})

test('CSV cells are quoted and formula-safe', () => {
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`)
  for (const evil of ['+1', '-1', '@SUM(1)', '\tx', '\rx']) assert.ok(csvCell(evil).replace(/^"/, '').startsWith("'"), evil)
  assert.equal(csvCell(-5), '-5', 'numbers are not altered')
  assert.equal(toCsv([['a', 1]]), '﻿a,1\r\n')
})

test('summaries add up in fils', () => {
  const rows = [
    { kind: 'income' as const, amount: 1000, occurred_on: '2026-10-01', category_id: 'sal' },
    { kind: 'expense' as const, amount: 0.1, occurred_on: '2026-10-02', category_id: 'food' },
    { kind: 'expense' as const, amount: 0.2, occurred_on: '2026-10-03', category_id: 'food' },
    { kind: 'expense' as const, amount: 50, occurred_on: '2026-09-30', category_id: 'rent' },
  ]
  assert.deepEqual(totals(rows), { income: 100000, expense: 5030, balance: 94970 })
  assert.deepEqual(byCategory(rows, 'expense'), [
    { categoryId: 'rent', fils: 5000 },
    { categoryId: 'food', fils: 30 },
  ])
  assert.deepEqual(byMonth(rows, ['2026-10', '2026-09']).map((m) => m.balance), [99970, -5000])
})
