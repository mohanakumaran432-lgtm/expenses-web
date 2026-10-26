import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fx } from './support.mjs';
import { CalendarContext } from '../docs/js/core/calendar.js';
import { isCurrencyCode } from '../docs/js/core/currency.js';
import { DayRange } from '../docs/js/core/dayrange.js';
import { DisplayFormatter } from '../docs/js/core/format.js';
import { defaultSettings, normalizeSettings, settingsToWire } from '../docs/js/core/models.js';
import { makeExpense } from '../docs/js/core/models.js';

const decode = (json) => normalizeSettings(JSON.parse(json));

function formatter({ date = 'yearMonthDay', time = 'twentyFourHour' } = {}) {
  const settings = normalizeSettings({ ...defaultSettings(), numberFormat: 'commaDot', dateFormat: date, timeFormat: time });
  return new DisplayFormatter(settings, 'en-US');
}

// Defaults ---------------------------------------------------------------------------------------

test('defaults are the most private choices', () => {
  const settings = defaultSettings();
  assert.equal(settings.currencyCode, 'AED');
  assert.equal(settings.firstWeekday, 2);
  assert.equal(settings.defaultReportPeriod, 'thisMonth');
  assert.equal(settings.notificationsShowAmounts, false, 'No amounts on the lock screen unless asked for');
  assert.equal(settings.budgetAlertsEnabled, false, 'Notifications are opt-in');
  assert.equal(settings.recurringRemindersEnabled, false, 'Notifications are opt-in');
  assert.equal(settings.hideContentInAppSwitcher, true, 'The app switcher hides the content by default');
  assert.equal(settings.hasCompletedOnboarding, false);
});

// Reading ----------------------------------------------------------------------------------------

test('a round trip keeps every choice', () => {
  const settings = normalizeSettings({
    currencyCode: 'KWD', numberFormat: 'dotComma', dateFormat: 'dayMonthYear', timeFormat: 'twelveHour', firstWeekday: 7,
    defaultReportPeriod: 'last30Days', appearance: 'dark', defaultPaymentMethodID: Fx.uuid(77), budgetAlertsEnabled: true,
    recurringRemindersEnabled: true, notificationsShowAmounts: true, hideContentInAppSwitcher: false,
    excludeFromDeviceBackup: true, hasCompletedOnboarding: true,
  });
  assert.equal(settings.currencyCode, 'KWD');
  assert.equal(settings.firstWeekday, 7);
  assert.equal(settings.defaultPaymentMethodID, Fx.uuid(77));
  const again = normalizeSettings(JSON.parse(JSON.stringify(settingsToWire(settings))));
  assert.deepEqual(again, settings);

  const noMethod = normalizeSettings({ ...settings, defaultPaymentMethodID: null });
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(settingsToWire(noMethod)))), noMethod);
});

test('an empty or partial blob fills in the defaults', () => {
  assert.deepEqual(decode('{}'), defaultSettings());
  const partial = decode('{"currencyCode":"USD","firstWeekday":1,"notificationsShowAmounts":true}');
  assert.deepEqual(partial, { ...defaultSettings(), currencyCode: 'USD', firstWeekday: 1, notificationsShowAmounts: true });
  assert.deepEqual(normalizeSettings(null), defaultSettings());
  assert.deepEqual(normalizeSettings('text'), defaultSettings());
});

test('values from a newer version never make loading fail', () => {
  const json = '{"numberFormat":"fancy","dateFormat":"future","timeFormat":7,"appearance":null,'
    + '"defaultReportPeriod":"lastDecade","defaultPaymentMethodID":"not-a-uuid","hasCompletedOnboarding":true,'
    + '"someNewSetting":{"a":1}}';
  assert.deepEqual(decode(json), { ...defaultSettings(), hasCompletedOnboarding: true },
    'Unknown choices fall back to defaults; what is understood is kept');
});

test('nonsense weekdays and currency codes fall back to defaults', () => {
  assert.equal(decode('{"firstWeekday":12}').firstWeekday, 2);
  assert.equal(decode('{"firstWeekday":0}').firstWeekday, 2);
  assert.equal(decode('{"firstWeekday":-3}').firstWeekday, 2);
  assert.equal(decode('{"firstWeekday":7}').firstWeekday, 7);
  assert.equal(decode('{"firstWeekday":2.5}').firstWeekday, 2);
  assert.equal(decode('{"firstWeekday":"3"}').firstWeekday, 2);
  assert.equal(decode('{"currencyCode":"dirham"}').currencyCode, 'AED');
  assert.equal(decode('{"currencyCode":""}').currencyCode, 'AED');
  assert.equal(decode('{"currencyCode":"usd"}').currencyCode, 'USD', 'Lower case is tidied, not rejected');
  assert.equal(isCurrencyCode('JPY'), true);
  assert.equal(isCurrencyCode('JP'), false);
  assert.equal(isCurrencyCode('J1Y'), false);
});

test('settings are frozen and a bad flag type falls back', () => {
  const settings = decode('{"budgetAlertsEnabled":"yes","hideContentInAppSwitcher":0}');
  assert.equal(settings.budgetAlertsEnabled, false);
  assert.equal(settings.hideContentInAppSwitcher, true);
  assert.throws(() => { 'use strict'; settings.currencyCode = 'USD'; }, TypeError);
});

// Week start -------------------------------------------------------------------------------------

test('the week starts on the chosen day', () => {
  const tuesday = Fx.day(2026, 10, 20);
  assert.ok(tuesday.startOfWeek(2).equals(Fx.day(2026, 10, 19)), 'Monday');
  assert.ok(tuesday.startOfWeek(1).equals(Fx.day(2026, 10, 18)), 'Sunday');
  assert.ok(tuesday.startOfWeek(7).equals(Fx.day(2026, 10, 17)), 'Saturday');
  assert.ok(tuesday.startOfWeek(3).equals(tuesday), 'A day that starts the week is its own start');
});

test('an impossible week start is clamped so a week never starts in the future', () => {
  const tuesday = Fx.day(2026, 10, 20);
  assert.ok(tuesday.startOfWeek(0).equals(Fx.day(2026, 10, 18)));
  assert.ok(tuesday.startOfWeek(-5).equals(Fx.day(2026, 10, 18)));
  assert.ok(tuesday.startOfWeek(9).equals(Fx.day(2026, 10, 17)));
  for (let firstWeekday = -3; firstWeekday <= 12; firstWeekday += 1) {
    assert.ok(tuesday.startOfWeek(firstWeekday).raw <= tuesday.raw, `first weekday ${firstWeekday}`);
  }
});

// Date and time styles ---------------------------------------------------------------------------

test('date styles', () => {
  const day = Fx.day(2026, 10, 20);
  assert.equal(formatter({ date: 'dayMonthYear' }).day(day), '20/10/2026');
  assert.equal(formatter({ date: 'monthDayYear' }).day(day), '10/20/2026');
  assert.equal(formatter({ date: 'yearMonthDay' }).day(day), '2026-10-20');
  const early = Fx.day(2026, 3, 5);
  assert.equal(formatter({ date: 'dayMonthYear' }).day(early), '05/03/2026');
  assert.equal(formatter({ date: 'monthDayYear' }).day(early), '03/05/2026');
  assert.equal(formatter({ date: 'yearMonthDay' }).day(Fx.day(2028, 2, 29)), '2028-02-29', 'A leap day prints correctly');
});

test('ranges and day headers', () => {
  const f = formatter();
  assert.equal(f.range(DayRange.single(Fx.day(2026, 10, 20))), '2026-10-20');
  assert.equal(f.range(DayRange.between(Fx.day(2026, 10, 1), Fx.day(2026, 10, 20))), '2026-10-01 – 2026-10-20');
  assert.equal(f.dayHeader(Fx.today, Fx.today), 'Today');
  assert.equal(f.dayHeader(Fx.day(2026, 10, 19), Fx.today), 'Yesterday');
  const older = f.dayHeader(Fx.day(2026, 10, 18), Fx.today);
  assert.ok(older.startsWith('Sun'), older);
  assert.ok(older.endsWith(', 2026-10-18'), older);
  assert.equal(f.relativeDay(Fx.today, Fx.today), 'Today');
  assert.equal(f.relativeDay(Fx.day(2026, 10, 19), Fx.today), 'Yesterday');
  assert.equal(f.relativeDay(Fx.day(2026, 10, 18), Fx.today), '2026-10-18', 'older days are written without the weekday');
});

test('time styles', () => {
  const twentyFour = formatter({ time: 'twentyFourHour' });
  assert.equal(twentyFour.time(16, 5), '16:05');
  assert.equal(twentyFour.time(0, 0), '00:00');
  assert.equal(twentyFour.time(23, 59), '23:59');
  const twelve = formatter({ time: 'twelveHour' });
  assert.equal(twelve.time(16, 5), '4:05 PM');
  assert.equal(twelve.time(0, 30), '12:30 AM');
  assert.equal(twelve.time(12, 0), '12:00 PM');
});

test('an expense shows its own wall clock time or nothing', () => {
  const f = formatter();
  const category = Fx.category('Groceries', Fx.catalog());
  const expense = Fx.expense('10', Fx.day(2026, 10, 21), category, { zone: Fx.newYork });
  assert.equal(f.timeOfExpense(expense), null, 'No time was entered');
  const timed = makeExpense({
    ...expense,
    hasExplicitTime: true,
    occurredAt: new CalendarContext(Fx.newYork).instant(Fx.day(2026, 10, 21), 23, 30),
  });
  assert.equal(f.timeOfExpense(timed), '23:30', 'The time as it was on the clock where the money was spent');
});

test('the generated timestamp mentions the year', () => {
  const text = formatter().timestamp(Fx.now, Fx.dubai);
  assert.ok(text.includes('2026'), text);
});
