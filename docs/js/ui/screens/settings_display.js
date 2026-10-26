// Settings that change how things look and are counted: currency, week start, default period, appearance and formats.

import { fill, h, plural } from '../dom.js';
import { group, page, row } from '../components.js';
import { chooseCurrency, choosePeriod } from './pickers.js';
import { DisplayFormatter, MoneyFormatter } from '../../core/format.js';
import { money } from '../../core/money.js';
import {
  APPEARANCES, APPEARANCE_TITLES, DATE_FORMATS, NUMBER_FORMATS, TIME_FORMATS,
} from '../../core/models.js';
import { PERIOD_KINDS } from '../../core/periods.js';

const WEEK_ORDER = Object.freeze([2, 3, 4, 5, 6, 7, 1]);

const NUMBER_TITLES = Object.freeze({
  system: 'System default', commaDot: 'Comma and point', dotComma: 'Point and comma', spaceComma: 'Space and comma', apostropheDot: 'Apostrophe and point',
});
const DATE_TITLES = Object.freeze({
  system: 'System default', dayMonthYear: 'Day / month / year', monthDayYear: 'Month / day / year', yearMonthDay: 'Year-month-day',
});
const TIME_TITLES = Object.freeze({ system: 'System default', twelveHour: '12-hour', twentyFourHour: '24-hour' });

/** The name of a weekday number (1 is Sunday, 7 is Saturday), in the person's language. */
export function weekdayName(app, weekday) {
  return app.formatter.weekdayLong(app.today().startOfWeek(weekday));
}

// ---------------------------------------------------------------- choosers

export async function chooseWeekStart(app) {
  const picked = await app.ui.actions({
    title: 'The week starts on',
    options: WEEK_ORDER.map((day) => ({ label: weekdayName(app, day), value: day, checked: day === app.settings.firstWeekday })),
  });
  if (picked === undefined || picked === app.settings.firstWeekday) return;
  await app.perform('settings-write', () => app.updateSettings({ firstWeekday: picked }), { title: 'Could not save' });
}

export async function chooseDefaultPeriod(app) {
  const picked = await choosePeriod(app, {
    title: 'Default period',
    value: { kind: app.settings.defaultReportPeriod },
    kinds: PERIOD_KINDS.filter((kind) => kind !== 'custom'),
  });
  if (!picked || picked.kind === app.settings.defaultReportPeriod) return;
  await app.perform('settings-write', () => app.updateSettings({ defaultReportPeriod: picked.kind }), { title: 'Could not save' });
}

export async function chooseAppearance(app) {
  const picked = await app.ui.actions({
    title: 'Appearance',
    options: APPEARANCES.map((value) => ({ label: APPEARANCE_TITLES[value], value, checked: value === app.settings.appearance })),
  });
  if (picked === undefined || picked === app.settings.appearance) return;
  await app.perform('settings-write', () => app.updateSettings({ appearance: picked }), { title: 'Could not save' });
}

/** Changes the currency used for new expenses and totals. Nothing is converted: the person is told exactly what that means. */
export async function changeCurrency(app) {
  const old = app.currency;
  const picked = await chooseCurrency(app, old, {
    footer: 'Choosing a currency does not convert any amounts. Expenses already saved keep the currency they were saved in.',
  });
  if (!picked || picked === old) return;
  const snapshot = app.snapshot;
  const inOld = snapshot.expenses.filter((e) => e.amount.currencyCode === old).length;
  const budgets = snapshot.budgets.filter((b) => b.amount.currencyCode === old).length;
  if (inOld > 0 || budgets > 0) {
    const lines = [];
    if (inOld > 0) lines.push(`Your ${plural(inOld, 'expense')} in ${old} stay in ${old}. Nothing is converted, and no exchange rates are used.`);
    lines.push(`New expenses and budgets will use ${picked}. Totals on Home count one currency at a time, so ${old} amounts will not be added into ${picked} totals. In Reports you can switch which currency you are looking at.`);
    if (budgets > 0) lines.push(`Your ${plural(budgets, 'budget')} in ${old} keep measuring ${old} expenses only.`);
    const yes = await app.ui.confirm({ title: `Use ${picked} from now on?`, message: lines.join(' '), confirmLabel: `Use ${picked}` });
    if (!yes) return;
  }
  await app.perform('settings-write', () => app.updateSettings({ currencyCode: picked }), { title: 'Could not save' });
}

// ---------------------------------------------------------------- number, date and time formats

export function openFormats(app) {
  app.shell.push(createFormats);
}

export function createFormats(app) {
  const screen = page(app, { title: 'Formats', back: true, backLabel: 'Settings' });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  function refresh() {
    const settings = app.settings;
    const today = app.today();
    const sample = money(123_456, app.currency);
    const exampleFor = (patch) => new DisplayFormatter({ ...settings, ...patch }, app.locale);
    const save = (patch) => app.perform('settings-write', () => app.updateSettings(patch), { title: 'Could not save' });

    const numbers = NUMBER_FORMATS.map((style) => row({
      title: NUMBER_TITLES[style],
      value: new MoneyFormatter(app.locale, style).string(sample),
      check: settings.numberFormat === style,
      ariaLabel: `${NUMBER_TITLES[style]}, for example ${new MoneyFormatter(app.locale, style).string(sample)}`,
      onClick: () => save({ numberFormat: style }),
    }));
    const dates = DATE_FORMATS.map((style) => row({
      title: DATE_TITLES[style],
      value: exampleFor({ dateFormat: style }).day(today),
      check: settings.dateFormat === style,
      ariaLabel: `${DATE_TITLES[style]}, for example ${exampleFor({ dateFormat: style }).day(today)}`,
      onClick: () => save({ dateFormat: style }),
    }));
    const times = TIME_FORMATS.map((style) => row({
      title: TIME_TITLES[style],
      value: exampleFor({ timeFormat: style }).time(21, 5),
      check: settings.timeFormat === style,
      ariaLabel: `${TIME_TITLES[style]}, for example ${exampleFor({ timeFormat: style }).time(21, 5)}`,
      onClick: () => save({ timeFormat: style }),
    }));
    fill(holder,
      group(numbers, { title: 'Numbers', footer: 'Amounts are always stored exactly. This only changes how they are written on screen.' }),
      group(dates, { title: 'Dates' }),
      group(times, { title: 'Times' }));
  }

  return { el: screen.el, refresh };
}
