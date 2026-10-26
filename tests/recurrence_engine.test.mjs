import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx } from './support.mjs';
import {
  MAX_OCCURRENCES_PER_SCAN, dayOfOccurrence, dueDays, pendingOccurrences, remindersDue, upcomingDays,
} from '../docs/js/core/recurrence.js';
import { makeExpense, makeLogEntry, makeTemplate, occurrenceKey } from '../docs/js/core/models.js';

// Pure date arithmetic for repeating expenses. Expected dates were worked out independently (with Python's
// calendar module), not copied from the code under test.

const anyCategory = Fx.uuid(1);
const day = (y, m, d) => Fx.day(y, m, d);

const make = (frequency, { every = 1, from, until = null, active = true } = {}) => Fx.template({
  categoryID: anyCategory, frequency, every, from, until, active,
});
const due = (template, from, through) => dueDays(template, from, through).map((d) => d.toString());
const upcoming = (template, today, count) => upcomingDays(template, today, count).map((d) => d.toString());

// Sequences --------------------------------------------------------------------------------------

test('a monthly bill on the 31st clamps to month end without drifting', () => {
  const template = make('monthly', { from: day(2026, 1, 31) });
  assert.deepEqual(due(template, day(2026, 1, 1), day(2026, 5, 31)),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

test('a leap-day yearly bill falls on February 28 in ordinary years', () => {
  const template = make('yearly', { from: day(2024, 2, 29) });
  assert.deepEqual(due(template, day(2024, 1, 1), day(2029, 12, 31)),
    ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29', '2029-02-28']);
});

test('every two years from a leap day', () => {
  const template = make('yearly', { every: 2, from: day(2024, 2, 29) });
  assert.deepEqual(due(template, day(2024, 1, 1), day(2029, 12, 31)), ['2024-02-29', '2026-02-28', '2028-02-29']);
});

test('every three days', () => {
  const template = make('daily', { every: 3, from: day(2026, 10, 1) });
  assert.deepEqual(due(template, day(2026, 10, 1), day(2026, 10, 20)),
    ['2026-10-01', '2026-10-04', '2026-10-07', '2026-10-10', '2026-10-13', '2026-10-16', '2026-10-19']);
});

test('every two weeks', () => {
  const template = make('weekly', { every: 2, from: day(2026, 10, 1) });
  assert.deepEqual(due(template, day(2026, 10, 1), day(2026, 10, 20)), ['2026-10-01', '2026-10-15']);
  assert.deepEqual(due(template, day(2026, 10, 1), day(2026, 10, 29)), ['2026-10-01', '2026-10-15', '2026-10-29']);
});

test('every two months', () => {
  const template = make('monthly', { every: 2, from: day(2026, 1, 15) });
  assert.deepEqual(due(template, day(2026, 1, 1), day(2026, 12, 31)),
    ['2026-01-15', '2026-03-15', '2026-05-15', '2026-07-15', '2026-09-15', '2026-11-15']);
});

test('a daily sequence crosses the year boundary', () => {
  const template = make('daily', { from: day(2026, 12, 30) });
  assert.deepEqual(due(template, day(2026, 12, 30), day(2027, 1, 2)), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('an interval below one is treated as one', () => {
  const template = make('daily', { every: 0, from: day(2026, 10, 1) });
  assert.deepEqual(due(template, day(2026, 10, 1), day(2026, 10, 3)), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('occurrence number math', () => {
  const template = make('monthly', { from: day(2026, 1, 31) });
  assert.equal(dayOfOccurrence(0, template).toString(), '2026-01-31');
  assert.equal(dayOfOccurrence(1, template).toString(), '2026-02-28');
  assert.equal(dayOfOccurrence(2, template).toString(), '2026-03-31');
});

// Windows and limits -----------------------------------------------------------------------------

test('the end day is included', () => {
  const included = make('monthly', { from: day(2026, 1, 31), until: day(2026, 3, 31) });
  assert.deepEqual(due(included, day(2026, 1, 1), day(2026, 12, 31)), ['2026-01-31', '2026-02-28', '2026-03-31']);
  const excluded = make('monthly', { from: day(2026, 1, 31), until: day(2026, 3, 30) });
  assert.deepEqual(due(excluded, day(2026, 1, 1), day(2026, 12, 31)), ['2026-01-31', '2026-02-28']);
});

test('nothing is due before the start day', () => {
  const template = make('monthly', { from: day(2026, 1, 31) });
  assert.deepEqual(due(template, day(2025, 1, 1), day(2026, 1, 30)), []);
  assert.deepEqual(due(template, day(2026, 1, 31), day(2026, 1, 31)), ['2026-01-31']);
});

test('a window in the middle of the series', () => {
  const template = make('monthly', { from: day(2026, 1, 31) });
  assert.deepEqual(due(template, day(2026, 3, 1), day(2026, 5, 31)), ['2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(due(template, day(2026, 3, 1), day(2026, 3, 30)), []);
});

test('searching far from the start still finds the right days', () => {
  const weekly = make('weekly', { every: 3, from: day(2020, 1, 1) });
  assert.deepEqual(due(weekly, day(2026, 10, 1), day(2026, 11, 10)), ['2026-10-14', '2026-11-04']);
  const monthly = make('monthly', { from: day(2020, 1, 31) });
  assert.deepEqual(due(monthly, day(2026, 10, 1), day(2026, 12, 31)), ['2026-10-31', '2026-11-30', '2026-12-31']);
});

test('a single scan is capped', () => {
  const template = make('daily', { from: day(2000, 1, 1) });
  assert.equal(dueDays(template, day(2000, 1, 1), day(2100, 12, 31)).length, MAX_OCCURRENCES_PER_SCAN);
});

// Upcoming ---------------------------------------------------------------------------------------

test('upcoming days are strictly after today', () => {
  const template = make('monthly', { from: day(2026, 10, 20) });
  assert.deepEqual(upcoming(template, Fx.today, 2), ['2026-11-20', '2026-12-20']);
});

test('upcoming days far from the start', () => {
  const template = make('monthly', { from: day(2020, 1, 31) });
  assert.deepEqual(upcoming(template, Fx.today, 3), ['2026-10-31', '2026-11-30', '2026-12-31']);
});

test('upcoming days stop at the end day', () => {
  const template = make('weekly', { from: day(2026, 10, 1), until: day(2026, 11, 1) });
  assert.deepEqual(upcoming(template, Fx.today, 5), ['2026-10-22', '2026-10-29']);
});

test('stopped templates and zero counts have no upcoming days', () => {
  const stopped = make('monthly', { from: day(2026, 1, 1), active: false });
  assert.deepEqual(upcoming(stopped, Fx.today, 3), []);
  const running = make('monthly', { from: day(2026, 1, 1) });
  assert.deepEqual(upcoming(running, Fx.today, 0), []);
});

test('upcoming before the start day begins at the start day', () => {
  const template = make('monthly', { from: day(2027, 3, 5) });
  assert.deepEqual(upcoming(template, Fx.today, 2), ['2027-03-05', '2027-04-05']);
});

// Pending ----------------------------------------------------------------------------------------

function snapshotWith(templates) {
  const result = Fx.catalog();
  result.templates = templates;
  return result;
}

const pendingDays = (snapshot, today = Fx.today) => pendingOccurrences(snapshot, today).map((p) => p.dueDay.toString());

test('every unhandled due day is pending, oldest first', () => {
  const template = make('monthly', { from: day(2026, 8, 20) });
  assert.deepEqual(pendingDays(snapshotWith([template])), ['2026-08-20', '2026-09-20', '2026-10-20']);
});

test('days in the future are not pending', () => {
  const template = make('monthly', { from: day(2026, 10, 21) });
  assert.deepEqual(pendingDays(snapshotWith([template])), []);
  assert.deepEqual(pendingDays(snapshotWith([template]), day(2026, 10, 21)), ['2026-10-21']);
});

test('logged or recorded occurrences are not pending', () => {
  const template = make('monthly', { from: day(2026, 8, 20) });
  const ledger = snapshotWith([template]);
  const category = Fx.category('Rent & Housing', ledger);

  // August was skipped (only the log knows), September was recorded (only the expense knows).
  ledger.recurrenceLog = [makeLogEntry({
    id: Fx.uuid(8001), templateID: template.id, dueDay: day(2026, 8, 20), outcome: 'skipped', expenseID: null, decidedAt: Fx.now,
  })];
  const recorded = makeExpense({
    ...Fx.expense('3000', day(2026, 9, 20), category),
    recurringTemplateID: template.id,
    occurrenceKey: occurrenceKey(template.id, day(2026, 9, 20)),
  });
  ledger.expenses = [recorded];

  assert.deepEqual(pendingDays(ledger), ['2026-10-20']);
});

test('stopped templates are never pending', () => {
  const template = make('monthly', { from: day(2026, 8, 20), active: false });
  assert.deepEqual(pendingDays(snapshotWith([template])), []);
});

test('two templates due on the same day are ordered by their id', () => {
  const first = Fx.template({ id: 5002, categoryID: anyCategory, from: day(2026, 10, 20) });
  const second = Fx.template({ id: 5001, categoryID: anyCategory, from: day(2026, 10, 20) });
  const pending = pendingOccurrences(snapshotWith([first, second]), Fx.today);
  assert.deepEqual(pending.map((p) => p.templateID), [Fx.uuid(5001), Fx.uuid(5002)]);
});

test('occurrence keys are stable and unique', () => {
  const template = make('daily', { from: day(2026, 10, 1) });
  const keys = pendingOccurrences(snapshotWith([template]), Fx.today).map((p) => p.key);
  assert.equal(keys.length, 20);
  assert.equal(new Set(keys).size, 20);
  assert.equal(keys[0], '00000000-0000-0000-0000-000000005001#2026-10-01');
});

// Reminders shown on Home ------------------------------------------------------------------------

const withReminder = (template, { on = true, daysBefore = 1 } = {}) => makeTemplate({ ...template, reminderEnabled: on, reminderDaysBefore: daysBefore });
const ledger = (templates, recurrenceLog = []) => ({ templates, recurrenceLog, expenses: [] });
const remindedKeys = (snapshot, today) => remindersDue(snapshot, today).map((r) => `${r.template.id}@${r.dueDay.toString()}+${r.daysAway}`);

test('a reminder appears from the chosen number of days before the date', () => {
  const rent = withReminder(Fx.template({ id: 1, categoryID: anyCategory, from: day(2026, 1, 1) }), { daysBefore: 2 });
  const snapshot = ledger([rent]);
  assert.deepEqual(remindedKeys(snapshot, day(2026, 10, 28)), [], 'Four days ahead is too early');
  assert.deepEqual(remindedKeys(snapshot, day(2026, 10, 30)), [`${rent.id}@2026-11-01+2`]);
  assert.deepEqual(remindedKeys(snapshot, day(2026, 10, 31)), [`${rent.id}@2026-11-01+1`]);
});

test('a date due today is not a reminder (it is recorded or waiting instead)', () => {
  const rent = withReminder(Fx.template({ id: 1, categoryID: anyCategory, from: day(2026, 1, 1) }), { daysBefore: 7 });
  assert.deepEqual(remindedKeys(ledger([rent]), day(2026, 11, 1)), [], 'The next date after the 1st is a month away');
});

test('a reminder window of zero still reminds one day ahead', () => {
  const rent = withReminder(Fx.template({ id: 1, categoryID: anyCategory, from: day(2026, 1, 1) }), { daysBefore: 0 });
  assert.equal(remindersDue(ledger([rent]), day(2026, 10, 31)).length, 1);
});

test('reminders that are off, or belong to a paused schedule, are not shown', () => {
  const off = withReminder(Fx.template({ id: 1, categoryID: anyCategory, from: day(2026, 1, 1) }), { on: false });
  const paused = withReminder(Fx.template({ id: 2, categoryID: anyCategory, from: day(2026, 1, 1), active: false }));
  assert.deepEqual(remindedKeys(ledger([off, paused]), day(2026, 10, 31)), []);
});

test('a date that is already decided is not reminded about', () => {
  const rent = withReminder(Fx.template({ id: 1, categoryID: anyCategory, from: day(2026, 1, 1) }));
  const entry = makeLogEntry({ id: Fx.uuid(9), templateID: rent.id, dueDay: day(2026, 11, 1), outcome: 'skipped', expenseID: null, decidedAt: Fx.now });
  assert.deepEqual(remindedKeys(ledger([rent], [entry]), day(2026, 10, 31)), []);
});

test('reminders are listed soonest first and stop after the schedule ends', () => {
  const later = withReminder(Fx.template({ id: 1, title: 'Later', categoryID: anyCategory, from: day(2026, 1, 3) }), { daysBefore: 7 });
  const sooner = withReminder(Fx.template({ id: 2, title: 'Sooner', categoryID: anyCategory, from: day(2026, 1, 1) }), { daysBefore: 7 });
  const ended = withReminder(Fx.template({ id: 3, categoryID: anyCategory, from: day(2026, 1, 2), until: day(2026, 10, 2) }), { daysBefore: 7 });
  assert.deepEqual(remindersDue(ledger([later, sooner, ended]), day(2026, 10, 30)).map((r) => r.template.title), ['Sooner', 'Later']);
});
