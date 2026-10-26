// Shared helpers for the tests ("Fx" = fixtures). Tests never use the real clock or the phone's time zone, so they
// give the same answer on every machine and on every day. They mirror the iPhone app's test fixtures.

import assert from 'node:assert/strict';
import { CalendarContext } from '../docs/js/core/calendar.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { DisplayFormatter } from '../docs/js/core/format.js';
import { LocalDate } from '../docs/js/core/localdate.js';
import { defaultSettings, makeExpense, makeTemplate, normalizeSettings } from '../docs/js/core/models.js';
import { parseMoney, zero } from '../docs/js/core/money.js';
import { generateReport } from '../docs/js/core/reports.js';
import { LedgerDirectory, MemoryStore, initialSnapshot } from '../docs/js/core/snapshot.js';

export const Fx = {
  dubai: 'Asia/Dubai',
  utc: 'UTC',
  newYork: 'America/New_York',

  /** 2026-10-20 12:00:00 UTC (in milliseconds), which is 16:00 on 2026-10-20 in Dubai. */
  now: 1_792_497_600_000,
  today: new LocalDate(2026, 10, 20),

  day(year, month, day) {
    return new LocalDate(year, month, day);
  },

  money(text, currency = 'AED') {
    const parsed = parseMoney(text, currency);
    if (!parsed.ok) {
      assert.fail(`Test data error: ${text} is not a valid amount (${parsed.error})`);
      return zero(currency);
    }
    return parsed.money;
  },

  /** Predictable ids make failures easier to read: 00000000-0000-0000-0000-000000000007. */
  uuid(number) {
    return `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
  },

  /** A fresh ledger with the 23 default categories and 5 payment methods. */
  catalog(firstWeekday = 2) {
    let counter = 0;
    return initialSnapshot(Fx.now, firstWeekday, () => {
      counter += 1;
      return Fx.uuid(counter);
    });
  },

  category(name, snapshot) {
    const found = snapshot.categories.find((c) => c.name === name);
    if (!found) throw new Error(`The default catalog has no category named ${name}`);
    return found;
  },

  method(name, snapshot) {
    const found = snapshot.paymentMethods.find((p) => p.name === name);
    if (!found) throw new Error(`The default catalog has no payment method named ${name}`);
    return found;
  },

  /** An expense built directly (for engine tests that do not go through the service). */
  expense(amount, localDay, category, {
    subcategory = null, method = null, merchant = '', currency = 'AED', tags = [], zone = 'Asia/Dubai',
    createdAt = Fx.now, id = null,
  } = {}) {
    const context = new CalendarContext(zone);
    return makeExpense({
      id: id || globalThis.crypto.randomUUID().toUpperCase(),
      amount: Fx.money(amount, currency),
      occurredAt: context.instant(localDay, 12, 0),
      timeZoneID: zone,
      hasExplicitTime: false,
      localDay,
      categoryID: category.id,
      subcategoryID: subcategory ? subcategory.id : null,
      paymentMethodID: method ? method.id : null,
      categoryNameSnapshot: category.name,
      subcategoryNameSnapshot: subcategory ? subcategory.name : null,
      paymentMethodNameSnapshot: method ? method.name : null,
      merchant,
      notes: '',
      tags,
      recurringTemplateID: null,
      occurrenceKey: null,
      createdAt,
      modifiedAt: createdAt,
    });
  },

  adding(expenses, snapshot) {
    const result = snapshot.clone();
    result.expenses.push(...expenses);
    result.normalizeOrder();
    return result;
  },

  store(snapshot) {
    return new MemoryStore(snapshot.clone());
  },

  /** Formatting with fixed separators, so expected strings do not depend on the machine's region settings. */
  formatter(numberFormat = 'commaDot') {
    const settings = normalizeSettings({
      ...defaultSettings(), numberFormat, dateFormat: 'yearMonthDay', timeFormat: 'twentyFourHour',
    });
    return new DisplayFormatter(settings, 'en-US');
  },

  report(snapshot, range, today = Fx.today, code = 'AED') {
    return generateReport({
      expenses: snapshot.expenses,
      directory: new LedgerDirectory(snapshot),
      currencyCode: code,
      range,
      today,
      firstWeekday: snapshot.settings.firstWeekday,
    });
  },

  /** A recurring template with sensible defaults. A test only names the fields it cares about. */
  template({
    id = 5001, title = 'Rent', amount = '3000', categoryID, frequency = 'monthly', every = 1, from, until = null,
    mode = 'autoRecord', active = true,
  }) {
    return makeTemplate({
      id: Fx.uuid(id),
      title,
      amount: Fx.money(amount),
      categoryID,
      subcategoryID: null,
      paymentMethodID: null,
      merchant: '',
      notes: '',
      tags: [],
      frequency,
      interval: every,
      startDay: from,
      endDay: until,
      mode,
      reminderEnabled: false,
      reminderDaysBefore: 1,
      reminderHour: 9,
      reminderMinute: 0,
      isActive: active,
      timeZoneID: Fx.dubai,
      createdAt: Fx.now,
      modifiedAt: Fx.now,
    });
  },
};

/**
 * One small, hand-checkable ledger shared by the query, report, CSV and backup tests.
 *
 * | #  | Day        | Category         | Amount    | Merchant      | Method      | Tags    | Subcategory |
 * |----|------------|------------------|-----------|---------------|-------------|---------|-------------|
 * | 1  | 2026-10-20 | Groceries        |    50.00  | Spinneys      | Cash        | family  | Milk        |
 * | 2  | 2026-10-20 | Groceries        |    12.50  | Carrefour     | Debit Card  |         |             |
 * | 3  | 2026-10-20 | Transport        |     8.00  |               | Cash        |         |             |
 * | 4  | 2026-10-19 | Coffee & Snacks  |    18.00  | Café Nero     | Credit Card | Work    |             |
 * | 5  | 2026-10-19 | Entertainment    |   120.00  | Reel Cinemas  |             |         |             |
 * | 6  | 2026-10-01 | Groceries        |    30.00  | Spinneys      | Cash        |         |             |
 * | 7  | 2026-09-30 | Transport        |    15.00  | RTA           | Debit Card  |         |             |
 * | 8  | 2026-09-15 | Fuel             |   200.00  | ADNOC         | Credit Card |         |             |
 *
 * The grand total is 453.50 AED (45,350 fils). Each expense is created one second after the previous one,
 * so "newest first" ordering is fully determined.
 */
export class SampleLedger {
  static grandTotalMinor = 45_350;

  constructor() {
    const base = Fx.catalog();
    const groceries = Fx.category('Groceries', base);
    const transport = Fx.category('Transport', base);
    const coffee = Fx.category('Coffee & Snacks', base);
    const entertainment = Fx.category('Entertainment', base);
    const fuel = Fx.category('Fuel', base);
    const cash = Fx.method('Cash', base);
    const debit = Fx.method('Debit Card', base);
    const credit = Fx.method('Credit Card', base);
    const milk = Object.freeze({
      id: Fx.uuid(900), categoryID: groceries.id, name: 'Milk', sortOrder: 0, isArchived: false, mergedIntoID: null,
      createdAt: Fx.now, modifiedAt: Fx.now,
    });
    base.subcategories = [milk];
    base.invalidate();

    const made = (index, amount, day, category, options = {}) => Fx.expense(amount, day, category, {
      ...options, createdAt: Fx.now + index * 1000,
    });

    const list = [
      made(0, '50', Fx.day(2026, 10, 20), groceries, { subcategory: milk, method: cash, merchant: 'Spinneys', tags: ['family'] }),
      made(1, '12.50', Fx.day(2026, 10, 20), groceries, { method: debit, merchant: 'Carrefour' }),
      made(2, '8', Fx.day(2026, 10, 20), transport, { method: cash }),
      made(3, '18', Fx.day(2026, 10, 19), coffee, { method: credit, merchant: 'Café Nero', tags: ['Work'] }),
      made(4, '120', Fx.day(2026, 10, 19), entertainment, { merchant: 'Reel Cinemas' }),
      made(5, '30', Fx.day(2026, 10, 1), groceries, { method: cash, merchant: 'Spinneys' }),
      made(6, '15', Fx.day(2026, 9, 30), transport, { method: debit, merchant: 'RTA' }),
      made(7, '200', Fx.day(2026, 9, 15), fuel, { method: credit, merchant: 'ADNOC' }),
    ];

    this.snapshot = Fx.adding(list, base);
    Object.assign(this, { groceries, transport, coffee, entertainment, fuel, cash, debit, credit, milk });
    /** e[0] is expense #1, e[7] is expense #8. */
    this.e = list;
  }

  get directory() {
    return new LedgerDirectory(this.snapshot);
  }

  /** September 1 to October 31, 2026: holds every sample expense. */
  static fullRange = DayRange.between(Fx.day(2026, 9, 1), Fx.day(2026, 10, 31));
}

/** assert.rejects with a check on the error's code. */
export async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected error code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

/** Runs a synchronous function and returns the AppError code it throws (or null if it does not throw). */
export function thrownCode(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

/** The small assertion set the shared backend rules use (the same names work in a browser page, see tests/browser). */
export const nodeAssertions = {
  ok: (value, message) => assert.ok(value, message),
  equal: (actual, expected, message) => assert.equal(actual, expected, message),
  deepEqual: (actual, expected, message) => assert.deepEqual(actual, expected, message),
  rejectsCode: (promise, code) => rejectsWithCode(promise, code),
};
