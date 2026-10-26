// The printable report: the same figures as the screen, already turned into text. Mirrors the iPhone app's
// ReportDocumentTests. Currency strings are compared through the same formatter the builder uses, never typed by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger } from './support.mjs';
import { compareRanges } from '../docs/js/core/comparison.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { PeriodResolver } from '../docs/js/core/periods.js';
import { MAX_SLICES, buildReportDocument, signed, signedPercent } from '../docs/js/core/report_document.js';
import { money as makeMoney } from '../docs/js/core/money.js';
import { LedgerDirectory } from '../docs/js/core/snapshot.js';

const sample = new SampleLedger();
const formatter = Fx.formatter();
const money = formatter.money;

const october = DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 31));
const september = DayRange.between(Fx.day(2026, 9, 1), Fx.day(2026, 9, 30));
const EN_DASH = '–';
const ARROW = '›';

// Helpers ----------------------------------------------------------------------------------------

function makeDoc(snapshot = sample.snapshot, { range = SampleLedger.fullRange, comparison = null, title } = {}) {
  const report = Fx.report(snapshot, range);
  const directory = new LedgerDirectory(snapshot);
  const options = { report, comparison, directory, formatter, generatedAt: Fx.now, timeZone: Fx.dubai };
  if (title !== undefined) options.title = title;
  return buildReportDocument(options);
}

function compare(current, previous, aligned = false) {
  return compareRanges({
    expenses: sample.snapshot.expenses,
    directory: sample.directory,
    currencyCode: 'AED',
    current,
    previous,
    today: Fx.today,
    firstWeekday: sample.snapshot.settings.firstWeekday,
    alignToElapsed: aligned,
  });
}

function table(title, doc) {
  const found = doc.tables.find((t) => t.title === title);
  assert.ok(found, `No table titled ${title}`);
  return found;
}

const metric = (title, doc) => (doc.summary.find((m) => m.title === title) || { value: '' }).value;

/** Text of an amount given in whole currency units, such as "92.50". */
const text = (amount) => money.string(Fx.money(amount));

const sum = (values) => values.reduce((total, value) => total + value, 0);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.0001, `${message || ''} expected ${expected}, got ${actual}`);

/** A ledger with `count` named merchants (M01, M02, ... paid 1, 2, ... AED) and, optionally, 500 AED with no merchant. */
function merchantLedger(count, withUnnamedSpending) {
  const base = Fx.catalog();
  const groceries = Fx.category('Groceries', base);
  const list = [];
  for (let index = 1; index <= count; index += 1) {
    const name = index < 10 ? `M0${index}` : `M${index}`;
    list.push(Fx.expense(String(index), Fx.day(2026, 10, 5), groceries, { merchant: name, createdAt: Fx.now + index * 1000 }));
  }
  if (withUnnamedSpending) list.push(Fx.expense('500', Fx.day(2026, 10, 6), groceries, { createdAt: Fx.now + 100_000 }));
  return Fx.adding(list, base);
}

// Header and summary -----------------------------------------------------------------------------

test('the header text comes from the report', () => {
  const doc = makeDoc();
  assert.equal(doc.title, 'Spending report');
  assert.equal(doc.rangeText, `2026-09-01 ${EN_DASH} 2026-10-31`);
  assert.equal(doc.currencyCode, 'AED');
  assert.ok(doc.generatedText.startsWith('Generated '), doc.generatedText);
  assert.ok(doc.generatedText.includes('2026'), doc.generatedText);
  assert.equal(makeDoc(sample.snapshot, { title: 'October for the family' }).title, 'October for the family');
});

test('the summary lists the headline figures', () => {
  const doc = makeDoc();
  assert.deepEqual(doc.summary.map((m) => m.title), [
    'Total spending', 'Transactions', 'Average per day', 'Highest expense', 'Lowest expense', 'Highest category', 'Lowest category',
  ]);
  assert.equal(metric('Total spending', doc), text('453.50'));
  assert.equal(metric('Transactions', doc), '8');
  // 45,350 fils over the 50 days from September 1 to October 20 = 907 fils.
  assert.equal(metric('Average per day', doc), text('9.07'));
  assert.equal(metric('Highest expense', doc), `${text('200')} ${EN_DASH} ADNOC (Fuel)`);
  assert.equal(metric('Lowest expense', doc), `${text('8')} ${EN_DASH} Transport`);
  assert.equal(metric('Highest category', doc), `Fuel ${EN_DASH} ${text('200')}`);
  assert.equal(metric('Lowest category', doc), `Coffee & Snacks ${EN_DASH} ${text('18')}`);
});

test('the notes state the currency, rounding and average rules', () => {
  const doc = makeDoc();
  assert.equal(doc.notes.length, 2);
  assert.equal(doc.notes[0], 'All amounts are in AED. Percentages are rounded to one decimal place.');
  assert.ok(doc.notes[1].includes('already happened'), doc.notes[1]);
});

test('other-currency expenses are left out and the report says so', () => {
  const usd = Fx.expense('10', Fx.day(2026, 10, 20), sample.groceries, { currency: 'USD', createdAt: Fx.now + 50_000 });
  const ledger = Fx.adding([usd], sample.snapshot);
  const one = makeDoc(ledger);
  assert.equal(metric('Transactions', one), '8', 'The dollars are not counted');
  assert.equal(metric('Total spending', one), text('453.50'));
  assert.equal(one.notes.at(-1), '1 transaction in another currency is not included. No currency conversion is done.');

  const second = Fx.expense('5', Fx.day(2026, 10, 19), sample.groceries, { currency: 'USD', createdAt: Fx.now + 51_000 });
  const two = makeDoc(Fx.adding([second], ledger));
  assert.equal(two.notes.at(-1), '2 transactions in other currencies are not included. No currency conversion is done.');
});

// Category chart and table -----------------------------------------------------------------------

test('the category table and its footer reconcile with the report', () => {
  const doc = makeDoc();
  const categories = table('Spending by category', doc);
  assert.deepEqual(categories.headers, ['Category', 'Transactions', 'Amount', 'Share']);
  assert.deepEqual(categories.rows.map((r) => r[0]), ['Fuel', 'Entertainment', 'Groceries', 'Transport', 'Coffee & Snacks']);
  assert.deepEqual(categories.rows.map((r) => r[1]), ['1', '1', '3', '2', '1']);
  assert.deepEqual(categories.rows.map((r) => r[2]), ['200', '120', '92.50', '23', '18'].map(text));
  // 20,000 / 45,350 = 44.1%, 12,000 = 26.5%, 9,250 = 20.4%, 2,300 = 5.1%, 1,800 = 4.0%
  assert.deepEqual(categories.rows.map((r) => r[3]), ['44.1%', '26.5%', '20.4%', '5.1%', '4.0%']);
  assert.deepEqual(categories.footer, ['Total', '8', text('453.50'), '100%']);
});

test('chart slices carry exact figures, not just colors', () => {
  const doc = makeDoc();
  assert.deepEqual(doc.categorySlices.map((s) => s.label), ['Fuel', 'Entertainment', 'Groceries', 'Transport', 'Coffee & Snacks']);
  const expectedValues = [200, 120, 92.5, 23, 18];
  assert.equal(doc.categorySlices.length, expectedValues.length);
  doc.categorySlices.forEach((slice, index) => {
    near(slice.value, expectedValues[index], slice.label);
    assert.ok(slice.colorHex.startsWith('#'), slice.colorHex);
    assert.ok(slice.detail.endsWith('%)'), `Every slice also states its percentage: ${slice.detail}`);
  });
  assert.equal(doc.categorySlices[0].detail, `${text('200')} (44.1%)`);
  assert.equal(doc.categorySlices[4].detail, `${text('18')} (4.0%)`);
});

test('more than eight categories are grouped as "Other categories" in the chart only', () => {
  const base = Fx.catalog();
  const names = base.categories.map((c) => c.name).slice(0, 10);
  const list = names.map((name, index) => Fx.expense(
    String(100 - index * 10), Fx.day(2026, 10, 5), Fx.category(name, base), { createdAt: Fx.now + index * 1000 },
  ));
  const doc = makeDoc(Fx.adding(list, base), { range: october });

  assert.equal(doc.categorySlices.length, MAX_SLICES + 1);
  assert.deepEqual(doc.categorySlices.slice(0, 8).map((s) => s.label), names.slice(0, 8));
  const other = doc.categorySlices.at(-1);
  assert.equal(other.label, 'Other categories (2)');
  near(other.value, 30, 'The two smallest are 20 + 10');
  // 3,000 / 55,000 = 5.4545...% which shows as 5.5%
  assert.equal(other.detail, `${text('30')} (5.5%)`);
  near(sum(doc.categorySlices.map((s) => s.value)), 550, 'The chart still adds up to the total');

  const categories = table('Spending by category', doc);
  assert.equal(categories.rows.length, 10, 'The table is never shortened');
  assert.equal(categories.footer[2], text('550'));
  assert.ok(!doc.tables.some((t) => t.title === 'Spending by subcategory'), 'No subcategory was used');
});

test('the subcategory table appears when subcategories are used', () => {
  const subs = table('Spending by subcategory', makeDoc());
  assert.deepEqual(subs.headers, [`Category ${ARROW} Subcategory`, 'Transactions', 'Amount']);
  assert.equal(subs.rows.length, 6);
  assert.deepEqual(subs.rows.map((r) => r[0]), [
    `Fuel ${ARROW} No subcategory`, `Entertainment ${ARROW} No subcategory`, `Groceries ${ARROW} Milk`,
    `Groceries ${ARROW} No subcategory`, `Transport ${ARROW} No subcategory`, `Coffee & Snacks ${ARROW} No subcategory`,
  ]);
  assert.deepEqual(subs.rows[2], [`Groceries ${ARROW} Milk`, '1', text('50')]);
  assert.deepEqual(subs.rows[3], [`Groceries ${ARROW} No subcategory`, '2', text('42.50')]);
});

// Trend ------------------------------------------------------------------------------------------

test('the weekly trend marks partial weeks and keeps empty ones', () => {
  const doc = makeDoc();
  assert.equal(doc.trendTitle, 'Weekly spending');
  const weeks = table('Weekly totals', doc);
  assert.deepEqual(weeks.headers, ['Period', 'Transactions', 'Amount']);
  assert.equal(weeks.rows.length, 8, 'Weeks with no spending stay in the table');
  assert.equal(weeks.rows[0][0], `2026-09-01 ${EN_DASH} 2026-09-06 (partial)`);
  assert.equal(weeks.rows[1][0], `2026-09-07 ${EN_DASH} 2026-09-13`);
  assert.equal(weeks.rows[7][0], `2026-10-19 ${EN_DASH} 2026-10-20 (partial)`);
  assert.deepEqual(weeks.rows.map((r) => r[1]), ['0', '0', '1', '0', '2', '0', '0', '5']);
  assert.deepEqual(weeks.rows.map((r) => r[2]), ['0', '0', '200', '0', '45', '0', '0', '208.50'].map(text));
  assert.deepEqual(weeks.footer, ['Total', '8', text('453.50')]);

  assert.equal(doc.trendPoints.length, 8);
  assert.deepEqual(doc.trendPoints.map((p) => p.label), weeks.rows.map((r) => r[0]));
  near(sum(doc.trendPoints.map((p) => p.value)), 453.5);
});

test('the daily trend chart shows every day but the table only days with spending', () => {
  const doc = makeDoc(sample.snapshot, { range: october });
  assert.equal(doc.trendTitle, 'Daily spending');
  assert.equal(doc.trendPoints.length, 20, 'October 1 to 20: the days that have happened');
  const days = table('Daily totals', doc);
  assert.deepEqual(days.rows.map((r) => r[0]), ['2026-10-01', '2026-10-19', '2026-10-20']);
  assert.deepEqual(days.rows.map((r) => r[1]), ['1', '2', '3']);
  assert.deepEqual(days.rows.map((r) => r[2]), ['30', '138', '70.50'].map(text));
  assert.deepEqual(days.footer, ['Total', '6', text('238.50')]);
});

// Payment methods --------------------------------------------------------------------------------

test('the payment methods table and chart', () => {
  const doc = makeDoc();
  const methods = table('Payment methods', doc);
  assert.deepEqual(methods.rows.map((r) => r[0]), ['Credit Card', 'Not specified', 'Cash', 'Debit Card']);
  assert.deepEqual(methods.rows.map((r) => r[1]), ['2', '1', '3', '2']);
  assert.deepEqual(methods.rows.map((r) => r[2]), ['218', '120', '88', '27.50'].map(text));
  assert.deepEqual(methods.rows.map((r) => r[3]), ['48.1%', '26.5%', '19.4%', '6.1%']);
  assert.deepEqual(doc.paymentSlices.map((s) => s.label), methods.rows.map((r) => r[0]));
  assert.deepEqual(doc.paymentSlices.map((s) => s.colorHex), ['#007AFF', '#34C759', '#FF9500', '#AF52DE']);
  const expected = [['218', '48.1%'], ['120', '26.5%'], ['88', '19.4%'], ['27.50', '6.1%']].map(([amount, share]) => `${text(amount)} (${share})`);
  assert.deepEqual(doc.paymentSlices.map((s) => s.detail), expected);
});

// Merchants and biggest expenses -----------------------------------------------------------------

test('top merchants lists unnamed spending last', () => {
  const merchants = table('Top merchants', makeDoc());
  assert.deepEqual(merchants.headers, ['Merchant', 'Transactions', 'Amount', 'Share']);
  assert.deepEqual(merchants.rows.map((r) => r[0]), ['ADNOC', 'Reel Cinemas', 'Spinneys', 'Café Nero', 'RTA', 'Carrefour', 'No merchant']);
  assert.deepEqual(merchants.rows.map((r) => r[1]), ['1', '1', '2', '1', '1', '1', '1']);
  assert.equal(merchants.rows[2][2], text('80'), 'Both Spinneys visits are added together');
});

test('unnamed spending never takes a rank, even when it is the largest', () => {
  const merchants = table('Top merchants', makeDoc(merchantLedger(3, true), { range: october }));
  // 500 AED has no merchant, which is more than any named one, yet it is listed after them.
  assert.deepEqual(merchants.rows.map((r) => r[0]), ['M03', 'M02', 'M01', 'No merchant']);
  assert.equal(merchants.rows.at(-1)[2], text('500'));
});

test('only the ten biggest named merchants are listed', () => {
  const withUnnamed = table('Top merchants', makeDoc(merchantLedger(12, true), { range: october }));
  assert.equal(withUnnamed.rows.length, 11, 'Ten named merchants plus the unnamed spending');
  assert.equal(withUnnamed.rows[0][0], 'M12');
  assert.equal(withUnnamed.rows[9][0], 'M03');
  assert.equal(withUnnamed.rows.at(-1)[0], 'No merchant');
  assert.ok(!withUnnamed.rows.some((r) => r[0] === 'M02' || r[0] === 'M01'));

  const namedOnly = table('Top merchants', makeDoc(merchantLedger(12, false), { range: october }));
  assert.equal(namedOnly.rows.length, 10);
  assert.equal(namedOnly.rows.at(-1)[0], 'M03');
  assert.ok(!namedOnly.rows.some((r) => r[0] === 'No merchant'));
});

test('top expenses are the biggest single expenses with their description', () => {
  const top = table('Top expenses', makeDoc());
  assert.deepEqual(top.headers, ['Date', 'Description', 'Amount']);
  assert.equal(top.rows.length, 8);
  assert.deepEqual(top.rows[0], ['2026-09-15', 'ADNOC (Fuel)', text('200')]);
  assert.deepEqual(top.rows[1], ['2026-10-19', 'Reel Cinemas (Entertainment)', text('120')]);
  assert.deepEqual(top.rows[2], ['2026-10-20', 'Spinneys (Groceries)', text('50')]);
  assert.deepEqual(top.rows[5], ['2026-09-30', 'RTA (Transport)', text('15')]);
  assert.deepEqual(top.rows[7], ['2026-10-20', 'Transport', text('8')], 'With no merchant, the category describes it');

  const busy = table('Top expenses', makeDoc(merchantLedger(12, true), { range: october }));
  assert.equal(busy.rows.length, 10, 'At most ten rows');
  assert.equal(busy.rows[0][2], text('500'));
});

// Comparison -------------------------------------------------------------------------------------

test('the comparison section shows signed differences and category movers', () => {
  const doc = makeDoc(sample.snapshot, { comparison: compare(october, september) });
  const section = doc.comparison;
  assert.ok(section);
  assert.equal(section.title, 'Period comparison');
  assert.deepEqual(section.metrics.map((m) => m.title), [
    `This period (2026-10-01 ${EN_DASH} 2026-10-31)`, `Earlier period (2026-09-01 ${EN_DASH} 2026-09-30)`,
    'Difference', 'Change', 'Average per day',
  ]);
  assert.equal(section.metrics[0].value, text('238.50'));
  assert.equal(section.metrics[1].value, text('215'));
  assert.equal(section.metrics[2].value, `+${text('23.50')}`);
  // 2,350 / 21,500 = 10.93...% shows as 10.9%
  assert.equal(section.metrics[3].value, '+10.9%');
  // October 1-20: 23,850 / 20 = 1,193 fils;  September: 21,500 / 30 = 717 fils;  difference 476 fils
  assert.equal(section.metrics[4].value, `${text('11.93')} vs ${text('7.17')} (+${text('4.76')})`);
  assert.equal(section.note, 'The periods have different lengths (31 and 30 days); compare the daily averages.');

  assert.equal(section.table.title, 'Category changes');
  assert.deepEqual(section.table.headers, ['Category', 'This period', 'Earlier', 'Change']);
  assert.deepEqual(section.table.rows.map((r) => r[0]), ['Fuel', 'Entertainment', 'Groceries', 'Coffee & Snacks', 'Transport']);
  const fuel = section.table.rows[0];
  assert.equal(fuel[1], text('0'));
  assert.equal(fuel[2], text('200'));
  assert.ok(fuel[3].endsWith(' (none this period)'), fuel[3]);
  assert.ok(!fuel[3].startsWith('+'));
  assert.equal(section.table.rows[1][3], `+${text('120')} (new)`);
  const transport = section.table.rows[4];
  assert.equal(transport[1], text('8'));
  assert.equal(transport[2], text('15'));
  assert.equal(transport[3], money.string(makeMoney(-700, 'AED')), 'A plain decrease: no sign added, no label');
});

test('a comparison with nothing before explains why there is no percentage', () => {
  const january = DayRange.between(Fx.day(2026, 1, 1), Fx.day(2026, 1, 31));
  const section = makeDoc(sample.snapshot, { comparison: compare(october, january) }).comparison;
  assert.ok(!section.metrics.some((m) => m.title === 'Change'), 'No invented percentage');
  assert.equal(section.note, 'There was no spending in the earlier period, so a percentage change cannot be calculated.');
  assert.equal(section.table.rows.length, 4);
  assert.ok(section.table.rows.every((r) => r[3].endsWith(' (new)')));
});

test('an aligned comparison says the earlier period was cut short', () => {
  const ranges = new PeriodResolver(2).comparisonRanges('thisMonthVsLastMonth', Fx.today);
  const section = makeDoc(sample.snapshot, { comparison: compare(ranges.current, ranges.previous, true) }).comparison;
  assert.equal(section.metrics[1].title, `Earlier period (2026-09-01 ${EN_DASH} 2026-09-20)`);
  assert.equal(section.metrics[1].value, text('200'));
  assert.equal(section.metrics[3].value, '+19.3%');
  assert.equal(section.note, 'The earlier period was cut to the same number of days so the comparison is like for like.');
});

test('no comparison means no comparison section', () => {
  assert.equal(makeDoc().comparison, null);
});

test('the signed helpers add a plus only to increases', () => {
  const up = makeMoney(500, 'AED');
  const down = makeMoney(-500, 'AED');
  const none = makeMoney(0, 'AED');
  assert.equal(signed(up, money), `+${money.string(up)}`);
  assert.equal(signed(down, money), money.string(down));
  assert.equal(signed(none, money), money.string(none));

  assert.equal(signedPercent(10.9, money), '+10.9%');
  assert.equal(signedPercent(-9.9, money), money.percentString(-9.9));
  assert.ok(!signedPercent(-9.9, money).startsWith('+'));
  assert.equal(signedPercent(0, money), money.percentString(0));
});

// Empty and future periods -----------------------------------------------------------------------

test('an empty period produces a valid document without tables', () => {
  const january = DayRange.between(Fx.day(2026, 1, 1), Fx.day(2026, 1, 31));
  const doc = makeDoc(sample.snapshot, { range: january });
  assert.deepEqual(doc.summary.map((m) => m.title), ['Total spending', 'Transactions', 'Average per day']);
  assert.equal(metric('Total spending', doc), text('0'));
  assert.equal(metric('Transactions', doc), '0');
  assert.equal(metric('Average per day', doc), text('0'));
  assert.deepEqual(doc.tables, []);
  assert.deepEqual(doc.categorySlices, []);
  assert.deepEqual(doc.paymentSlices, []);
  assert.equal(doc.trendPoints.length, 31, 'A flat line for the 31 days shows that nothing was spent');
  assert.ok(doc.trendPoints.every((p) => p.value === 0));
  assert.equal(doc.notes.length, 2);
});

test('a period that has not started has no average', () => {
  const november = DayRange.between(Fx.day(2026, 11, 1), Fx.day(2026, 11, 30));
  const doc = makeDoc(sample.snapshot, { range: november });
  assert.deepEqual(doc.summary.map((m) => m.title), ['Total spending', 'Transactions']);
  assert.deepEqual(doc.trendPoints, []);
  assert.deepEqual(doc.tables, []);
});

// Structure and reconciliation -------------------------------------------------------------------

test('every row has as many cells as its headers', () => {
  const documents = [
    makeDoc(),
    makeDoc(sample.snapshot, { range: october }),
    makeDoc(merchantLedger(12, true), { range: october }),
    makeDoc(sample.snapshot, { comparison: compare(october, september) }),
  ];
  for (const doc of documents) {
    const tables = [...doc.tables];
    if (doc.comparison) tables.push(doc.comparison.table);
    assert.ok(tables.length > 0);
    for (const t of tables) {
      for (const row of t.rows) assert.equal(row.length, t.headers.length, `${t.title}: ${row}`);
      if (t.footer) assert.equal(t.footer.length, t.headers.length, `${t.title} footer`);
    }
  }
});

test('every section adds up to the same total', () => {
  const doc = makeDoc();
  near(sum(doc.categorySlices.map((s) => s.value)), 453.5);
  near(sum(doc.paymentSlices.map((s) => s.value)), 453.5);
  near(sum(doc.trendPoints.map((p) => p.value)), 453.5);
  for (const title of ['Spending by category', 'Spending by subcategory', 'Weekly totals', 'Payment methods', 'Top merchants']) {
    const counts = table(title, doc).rows.map((r) => Number.parseInt(r[1], 10)).filter(Number.isFinite);
    assert.equal(sum(counts), 8, title);
  }
});

test('a report with Arabic and accented names keeps them exactly', () => {
  const base = Fx.catalog();
  const groceries = Fx.category('Groceries', base);
  const list = [
    Fx.expense('10', Fx.day(2026, 10, 5), groceries, { merchant: 'سوبرماركت', createdAt: Fx.now }),
    Fx.expense('20', Fx.day(2026, 10, 6), groceries, { merchant: 'Café Crème', createdAt: Fx.now + 1000 }),
  ];
  const doc = makeDoc(Fx.adding(list, base), { range: october });
  const merchants = table('Top merchants', doc);
  assert.deepEqual(merchants.rows.map((r) => r[0]), ['Café Crème', 'سوبرماركت']);
  assert.equal(metric('Highest expense', doc), `${text('20')} ${EN_DASH} Café Crème (Groceries)`);
});
