// The records the app stores, the default categories, and how each record is written to / read from JSON.
//
// In memory a record is a frozen plain object (never edited in place: a change makes a new object).
// On disk and in backups the JSON is exactly the format the iPhone app uses (docs/BACKUP_FORMAT.md), so a backup
// written here can be restored there and the other way round:
//   - ids are upper-case UUID text, days are "yyyy-MM-dd", instants are whole milliseconds since 1970;
//   - an empty optional value is simply left out.

import { AppError, newId, withoutEmpty } from './util.js';
import { DEFAULT_CURRENCY_CODE, isCurrencyCode } from './currency.js';
import { LocalDate } from './localdate.js';
import { isPeriodKind } from './periods.js';
import { money } from './money.js';

// ---------------------------------------------------------------- choices

export const NUMBER_FORMATS = Object.freeze(['system', 'commaDot', 'dotComma', 'spaceComma', 'apostropheDot']);
export const DATE_FORMATS = Object.freeze(['system', 'dayMonthYear', 'monthDayYear', 'yearMonthDay']);
export const TIME_FORMATS = Object.freeze(['system', 'twelveHour', 'twentyFourHour']);
export const APPEARANCES = Object.freeze(['system', 'light', 'dark']);
export const BUDGET_PERIODS = Object.freeze(['weekly', 'monthly', 'custom']);
export const FREQUENCIES = Object.freeze(['daily', 'weekly', 'monthly', 'yearly']);
export const RECURRENCE_MODES = Object.freeze(['autoRecord', 'askToConfirm']);
export const OCCURRENCE_OUTCOMES = Object.freeze(['recorded', 'skipped']);

export const NUMBER_FORMAT_TITLES = Object.freeze({
  system: 'System default', commaDot: '1,234.56', dotComma: '1.234,56', spaceComma: '1 234,56', apostropheDot: '1’234.56',
});
export const DATE_FORMAT_TITLES = Object.freeze({
  system: 'System default', dayMonthYear: '20/10/2026', monthDayYear: '10/20/2026', yearMonthDay: '2026-10-20',
});
export const TIME_FORMAT_TITLES = Object.freeze({ system: 'System default', twelveHour: '12-hour', twentyFourHour: '24-hour' });
export const APPEARANCE_TITLES = Object.freeze({ system: 'System', light: 'Light', dark: 'Dark' });
export const BUDGET_PERIOD_TITLES = Object.freeze({ weekly: 'Weekly', monthly: 'Monthly', custom: 'Custom period' });
export const FREQUENCY_TITLES = Object.freeze({ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' });
export const FREQUENCY_UNITS = Object.freeze({ daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' });
export const RECURRENCE_MODE_TITLES = Object.freeze({ autoRecord: 'Record automatically', askToConfirm: 'Ask me to confirm' });

// ---------------------------------------------------------------- settings

export const SETTINGS_SCHEMA_VERSION = 1;

export function defaultSettings() {
  return Object.freeze({
    currencyCode: DEFAULT_CURRENCY_CODE,
    numberFormat: 'system',
    dateFormat: 'system',
    timeFormat: 'system',
    firstWeekday: 2, // Monday
    defaultReportPeriod: 'thisMonth',
    appearance: 'system',
    defaultPaymentMethodID: null,
    budgetAlertsEnabled: false,
    recurringRemindersEnabled: false,
    notificationsShowAmounts: false,
    hideContentInAppSwitcher: true,
    excludeFromDeviceBackup: false,
    hasCompletedOnboarding: false,
  });
}

/** A settings object with every field valid; anything missing or nonsensical takes its default. */
export function normalizeSettings(input) {
  const defaults = defaultSettings();
  const source = input && typeof input === 'object' ? input : {};
  const pick = (key, allowed) => (allowed.includes(source[key]) ? source[key] : defaults[key]);
  const flag = (key) => (typeof source[key] === 'boolean' ? source[key] : defaults[key]);
  let code = typeof source.currencyCode === 'string' ? source.currencyCode.toUpperCase() : defaults.currencyCode;
  if (!isCurrencyCode(code)) code = defaults.currencyCode;
  let weekday = Number.isInteger(source.firstWeekday) ? source.firstWeekday : defaults.firstWeekday;
  if (weekday < 1 || weekday > 7) weekday = defaults.firstWeekday;
  const methodID = typeof source.defaultPaymentMethodID === 'string' && isUUID(source.defaultPaymentMethodID)
    ? source.defaultPaymentMethodID.toUpperCase()
    : null;
  return Object.freeze({
    currencyCode: code,
    numberFormat: pick('numberFormat', NUMBER_FORMATS),
    dateFormat: pick('dateFormat', DATE_FORMATS),
    timeFormat: pick('timeFormat', TIME_FORMATS),
    firstWeekday: weekday,
    defaultReportPeriod: isPeriodKind(source.defaultReportPeriod) ? source.defaultReportPeriod : defaults.defaultReportPeriod,
    appearance: pick('appearance', APPEARANCES),
    defaultPaymentMethodID: methodID,
    budgetAlertsEnabled: flag('budgetAlertsEnabled'),
    recurringRemindersEnabled: flag('recurringRemindersEnabled'),
    notificationsShowAmounts: flag('notificationsShowAmounts'),
    hideContentInAppSwitcher: flag('hideContentInAppSwitcher'),
    excludeFromDeviceBackup: flag('excludeFromDeviceBackup'),
    hasCompletedOnboarding: flag('hasCompletedOnboarding'),
  });
}

export function settingsToWire(settings) {
  return withoutEmpty({ ...settings });
}

// ---------------------------------------------------------------- default catalogue

export const DEFAULT_CATEGORIES = Object.freeze([
  ['Food & Dining', 'fork.knife', '#FF9500'],
  ['Groceries', 'cart', '#34C759'],
  ['Coffee & Snacks', 'cup.and.saucer', '#A2845E'],
  ['Transport', 'bus', '#007AFF'],
  ['Fuel', 'fuelpump', '#FF3B30'],
  ['Taxi & Ride-hailing', 'car', '#E0A100'],
  ['Shopping', 'bag', '#AF52DE'],
  ['Clothing', 'tshirt', '#FF2D55'],
  ['Bills & Utilities', 'bolt', '#5856D6'],
  ['Rent & Housing', 'house', '#30B0C7'],
  ['Healthcare & Medicine', 'cross.case', '#E5484D'],
  ['Fitness & Wellness', 'figure.run', '#00A86B'],
  ['Entertainment', 'film', '#BF5AF2'],
  ['Travel & Holidays', 'airplane', '#32ADE6'],
  ['Education', 'book', '#3F51B5'],
  ['Personal Care', 'sparkles', '#E879A8'],
  ['Family & Household', 'person.2', '#7CB342'],
  ['Gifts & Donations', 'gift', '#D81B60'],
  ['Subscriptions', 'repeat', '#6D4C9F'],
  ['Insurance', 'shield', '#546E7A'],
  ['Bank Fees & Charges', 'building.columns', '#78909C'],
  ['Business & Work', 'briefcase', '#8D6E63'],
  ['Other', 'ellipsis.circle', '#8E8E93'],
].map(([name, icon, colorHex]) => Object.freeze({ name, icon, colorHex })));

export const DEFAULT_PAYMENT_METHODS = Object.freeze([
  ['Cash', 'banknote'],
  ['Debit Card', 'creditcard'],
  ['Credit Card', 'creditcard'],
  ['Apple Pay', 'iphone'],
  ['Bank Transfer', 'arrow.left.arrow.right'],
].map(([name, icon]) => Object.freeze({ name, icon })));

/** Colors offered when creating or editing a category. */
export const COLOR_PALETTE = Object.freeze([
  '#FF9500', '#34C759', '#A2845E', '#007AFF', '#FF3B30', '#E0A100',
  '#AF52DE', '#FF2D55', '#5856D6', '#30B0C7', '#E5484D', '#00A86B',
  '#BF5AF2', '#32ADE6', '#3F51B5', '#E879A8', '#7CB342', '#D81B60',
  '#6D4C9F', '#546E7A', '#78909C', '#8D6E63', '#8E8E93', '#1B1B1F',
]);

/** Icon names offered in the icon picker (SF Symbol names, as the iPhone app stores them; the web app draws an emoji for each). */
export const ICON_CHOICES = Object.freeze([
  'tag', 'fork.knife', 'cart', 'cup.and.saucer', 'bus', 'fuelpump', 'car', 'bag', 'tshirt',
  'bolt', 'house', 'cross.case', 'figure.run', 'film', 'airplane', 'book', 'sparkles',
  'person.2', 'gift', 'repeat', 'shield', 'building.columns', 'briefcase', 'ellipsis.circle',
  'creditcard', 'banknote', 'iphone', 'laptopcomputer', 'gamecontroller', 'pawprint',
  'leaf', 'drop', 'flame', 'wifi', 'phone', 'wrench.and.screwdriver', 'hammer',
  'stethoscope', 'pills', 'graduationcap', 'music.note', 'camera', 'heart', 'star',
  'tram', 'bicycle', 'ferry', 'bed.double', 'scissors', 'basket', 'takeoutbag.and.cup.and.straw',
]);

// ---------------------------------------------------------------- record builders

export function makeCategory(fields) {
  return Object.freeze({
    id: fields.id,
    name: fields.name,
    iconSymbol: fields.iconSymbol,
    colorHex: fields.colorHex,
    sortOrder: fields.sortOrder,
    isArchived: Boolean(fields.isArchived),
    mergedIntoID: fields.mergedIntoID ?? null,
    createdAt: fields.createdAt,
    modifiedAt: fields.modifiedAt,
  });
}

export function makeSubcategory(fields) {
  return Object.freeze({
    id: fields.id,
    categoryID: fields.categoryID,
    name: fields.name,
    sortOrder: fields.sortOrder,
    isArchived: Boolean(fields.isArchived),
    mergedIntoID: fields.mergedIntoID ?? null,
    createdAt: fields.createdAt,
    modifiedAt: fields.modifiedAt,
  });
}

export function makePaymentMethod(fields) {
  return Object.freeze({
    id: fields.id,
    name: fields.name,
    iconSymbol: fields.iconSymbol,
    sortOrder: fields.sortOrder,
    isArchived: Boolean(fields.isArchived),
    createdAt: fields.createdAt,
    modifiedAt: fields.modifiedAt,
  });
}

export function makeTag(fields) {
  return Object.freeze({ id: fields.id, name: fields.name, createdAt: fields.createdAt });
}

export function makeExpense(fields) {
  return Object.freeze({
    id: fields.id,
    amount: fields.amount,
    occurredAt: fields.occurredAt,
    timeZoneID: fields.timeZoneID,
    hasExplicitTime: Boolean(fields.hasExplicitTime),
    localDay: fields.localDay,
    categoryID: fields.categoryID,
    subcategoryID: fields.subcategoryID ?? null,
    paymentMethodID: fields.paymentMethodID ?? null,
    categoryNameSnapshot: fields.categoryNameSnapshot,
    subcategoryNameSnapshot: fields.subcategoryNameSnapshot ?? null,
    paymentMethodNameSnapshot: fields.paymentMethodNameSnapshot ?? null,
    merchant: fields.merchant ?? '',
    notes: fields.notes ?? '',
    tags: Object.freeze([...(fields.tags ?? [])]),
    recurringTemplateID: fields.recurringTemplateID ?? null,
    occurrenceKey: fields.occurrenceKey ?? null,
    createdAt: fields.createdAt,
    modifiedAt: fields.modifiedAt,
  });
}

export function makeBudget(fields) {
  return Object.freeze({
    id: fields.id,
    name: fields.name,
    categoryID: fields.categoryID ?? null,
    periodKind: fields.periodKind,
    customStart: fields.customStart ?? null,
    customEnd: fields.customEnd ?? null,
    amount: fields.amount,
    alertThresholds: Object.freeze([...(fields.alertThresholds ?? [80, 100])]),
    notificationsEnabled: Boolean(fields.notificationsEnabled),
    isActive: fields.isActive === undefined ? true : Boolean(fields.isActive),
    createdAt: fields.createdAt,
    modifiedAt: fields.modifiedAt,
  });
}

export function makeTemplate(fields) {
  return Object.freeze({
    id: fields.id,
    title: fields.title,
    amount: fields.amount,
    categoryID: fields.categoryID,
    subcategoryID: fields.subcategoryID ?? null,
    paymentMethodID: fields.paymentMethodID ?? null,
    merchant: fields.merchant ?? '',
    notes: fields.notes ?? '',
    tags: Object.freeze([...(fields.tags ?? [])]),
    frequency: fields.frequency,
    interval: fields.interval,
    startDay: fields.startDay,
    endDay: fields.endDay ?? null,
    mode: fields.mode,
    reminderEnabled: Boolean(fields.reminderEnabled),
    reminderDaysBefore: fields.reminderDaysBefore ?? 0,
    reminderHour: fields.reminderHour ?? 9,
    reminderMinute: fields.reminderMinute ?? 0,
    isActive: fields.isActive === undefined ? true : Boolean(fields.isActive),
    timeZoneID: fields.timeZoneID,
    createdAt: fields.createdAt,
    modifiedAt: fields.modifiedAt,
  });
}

export function makeLogEntry(fields) {
  return Object.freeze({
    id: fields.id,
    templateID: fields.templateID,
    dueDay: fields.dueDay,
    outcome: fields.outcome,
    expenseID: fields.expenseID ?? null,
    decidedAt: fields.decidedAt,
  });
}

export function occurrenceKey(templateID, dueDay) {
  return `${templateID}#${dueDay.toString()}`;
}

export function logEntryKey(entry) {
  return occurrenceKey(entry.templateID, entry.dueDay);
}

// ---------------------------------------------------------------- expense drafts (what the form holds)

export function makeDraft(fields) {
  return {
    id: fields.id ?? newId(),
    amount: fields.amount,
    day: fields.day,
    hasExplicitTime: Boolean(fields.hasExplicitTime),
    hour: fields.hour ?? 12,
    minute: fields.minute ?? 0,
    timeZoneID: fields.timeZoneID,
    categoryID: fields.categoryID ?? null,
    subcategoryID: fields.subcategoryID ?? null,
    paymentMethodID: fields.paymentMethodID ?? null,
    merchant: fields.merchant ?? '',
    notes: fields.notes ?? '',
    tags: [...(fields.tags ?? [])],
    recurringTemplateID: fields.recurringTemplateID ?? null,
    occurrenceKey: fields.occurrenceKey ?? null,
  };
}

/** Starts an edit from an existing expense. `hourAndMinute` is the wall-clock time in the expense's own time zone. */
export function draftFromExpense(expense, hourAndMinute) {
  return makeDraft({
    id: expense.id,
    amount: expense.amount,
    day: expense.localDay,
    hasExplicitTime: expense.hasExplicitTime,
    hour: expense.hasExplicitTime ? hourAndMinute.hour : 12,
    minute: expense.hasExplicitTime ? hourAndMinute.minute : 0,
    timeZoneID: expense.timeZoneID,
    categoryID: expense.categoryID,
    subcategoryID: expense.subcategoryID,
    paymentMethodID: expense.paymentMethodID,
    merchant: expense.merchant,
    notes: expense.notes,
    tags: expense.tags,
    recurringTemplateID: expense.recurringTemplateID,
    occurrenceKey: expense.occurrenceKey,
  });
}

// ---------------------------------------------------------------- JSON: writing

function moneyToWire(m) {
  return { currencyCode: m.currencyCode, minorUnits: m.minorUnits };
}

export const toWire = {
  expense: (e) => withoutEmpty({
    id: e.id,
    amount: moneyToWire(e.amount),
    occurredAt: e.occurredAt,
    timeZoneID: e.timeZoneID,
    hasExplicitTime: e.hasExplicitTime,
    localDay: e.localDay.toString(),
    categoryID: e.categoryID,
    subcategoryID: e.subcategoryID,
    paymentMethodID: e.paymentMethodID,
    categoryNameSnapshot: e.categoryNameSnapshot,
    subcategoryNameSnapshot: e.subcategoryNameSnapshot,
    paymentMethodNameSnapshot: e.paymentMethodNameSnapshot,
    merchant: e.merchant,
    notes: e.notes,
    tags: [...e.tags],
    recurringTemplateID: e.recurringTemplateID,
    occurrenceKey: e.occurrenceKey,
    createdAt: e.createdAt,
    modifiedAt: e.modifiedAt,
  }),
  category: (c) => withoutEmpty({
    id: c.id, name: c.name, iconSymbol: c.iconSymbol, colorHex: c.colorHex, sortOrder: c.sortOrder,
    isArchived: c.isArchived, mergedIntoID: c.mergedIntoID, createdAt: c.createdAt, modifiedAt: c.modifiedAt,
  }),
  subcategory: (s) => withoutEmpty({
    id: s.id, categoryID: s.categoryID, name: s.name, sortOrder: s.sortOrder, isArchived: s.isArchived,
    mergedIntoID: s.mergedIntoID, createdAt: s.createdAt, modifiedAt: s.modifiedAt,
  }),
  paymentMethod: (p) => ({
    id: p.id, name: p.name, iconSymbol: p.iconSymbol, sortOrder: p.sortOrder, isArchived: p.isArchived,
    createdAt: p.createdAt, modifiedAt: p.modifiedAt,
  }),
  tag: (t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }),
  budget: (b) => withoutEmpty({
    id: b.id,
    name: b.name,
    categoryID: b.categoryID,
    periodKind: b.periodKind,
    customStart: b.customStart ? b.customStart.toString() : null,
    customEnd: b.customEnd ? b.customEnd.toString() : null,
    amount: moneyToWire(b.amount),
    alertThresholds: [...b.alertThresholds],
    notificationsEnabled: b.notificationsEnabled,
    isActive: b.isActive,
    createdAt: b.createdAt,
    modifiedAt: b.modifiedAt,
  }),
  template: (t) => withoutEmpty({
    id: t.id,
    title: t.title,
    amount: moneyToWire(t.amount),
    categoryID: t.categoryID,
    subcategoryID: t.subcategoryID,
    paymentMethodID: t.paymentMethodID,
    merchant: t.merchant,
    notes: t.notes,
    tags: [...t.tags],
    frequency: t.frequency,
    interval: t.interval,
    startDay: t.startDay.toString(),
    endDay: t.endDay ? t.endDay.toString() : null,
    mode: t.mode,
    reminderEnabled: t.reminderEnabled,
    reminderDaysBefore: t.reminderDaysBefore,
    reminderHour: t.reminderHour,
    reminderMinute: t.reminderMinute,
    isActive: t.isActive,
    timeZoneID: t.timeZoneID,
    createdAt: t.createdAt,
    modifiedAt: t.modifiedAt,
  }),
  logEntry: (l) => withoutEmpty({
    id: l.id, templateID: l.templateID, dueDay: l.dueDay.toString(), outcome: l.outcome,
    expenseID: l.expenseID, decidedAt: l.decidedAt,
  }),
};

// ---------------------------------------------------------------- JSON: reading (strict; the input may be a damaged or hand-edited file)

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUUID(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Thrown for any shape or value problem while reading a record. Carries no personal data. */
export class WireError extends AppError {
  constructor(detail) {
    super('wire', 'unreadable', `The content could not be read (${detail}).`);
  }
}

class Reader {
  constructor(object, what) {
    if (object === null || typeof object !== 'object' || Array.isArray(object)) throw new WireError(`${what} is not an object`);
    this.object = object;
    this.what = what;
  }

  fail(key, expected) {
    throw new WireError(`${this.what}.${key} should be ${expected}`);
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.object, key) && this.object[key] !== null && this.object[key] !== undefined;
  }

  string(key) {
    const value = this.object[key];
    if (typeof value !== 'string') this.fail(key, 'text');
    return value;
  }

  optString(key) {
    return this.has(key) ? this.string(key) : null;
  }

  int(key) {
    const value = this.object[key];
    if (!Number.isSafeInteger(value)) this.fail(key, 'a whole number');
    return value;
  }

  bool(key) {
    const value = this.object[key];
    if (typeof value !== 'boolean') this.fail(key, 'true or false');
    return value;
  }

  uuid(key) {
    const value = this.object[key];
    if (!isUUID(value)) this.fail(key, 'an id');
    return value.toUpperCase();
  }

  optUuid(key) {
    return this.has(key) ? this.uuid(key) : null;
  }

  day(key) {
    const value = LocalDate.fromISO(this.object[key]);
    if (!value) this.fail(key, 'a date');
    return value;
  }

  optDay(key) {
    return this.has(key) ? this.day(key) : null;
  }

  oneOf(key, allowed) {
    const value = this.object[key];
    if (!allowed.includes(value)) this.fail(key, 'a known choice');
    return value;
  }

  money(key) {
    const inner = new Reader(this.object[key], `${this.what}.${key}`);
    const code = inner.string('currencyCode');
    return money(inner.int('minorUnits'), code);
  }

  strings(key) {
    const value = this.object[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) this.fail(key, 'a list of text');
    return value;
  }

  ints(key) {
    const value = this.object[key];
    if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item))) this.fail(key, 'a list of numbers');
    return value;
  }
}

export const fromWire = {
  expense(object) {
    const r = new Reader(object, 'expense');
    return makeExpense({
      id: r.uuid('id'),
      amount: r.money('amount'),
      occurredAt: r.int('occurredAt'),
      timeZoneID: r.string('timeZoneID'),
      hasExplicitTime: r.bool('hasExplicitTime'),
      localDay: r.day('localDay'),
      categoryID: r.uuid('categoryID'),
      subcategoryID: r.optUuid('subcategoryID'),
      paymentMethodID: r.optUuid('paymentMethodID'),
      categoryNameSnapshot: r.string('categoryNameSnapshot'),
      subcategoryNameSnapshot: r.optString('subcategoryNameSnapshot'),
      paymentMethodNameSnapshot: r.optString('paymentMethodNameSnapshot'),
      merchant: r.string('merchant'),
      notes: r.string('notes'),
      tags: r.strings('tags'),
      recurringTemplateID: r.optUuid('recurringTemplateID'),
      occurrenceKey: r.optString('occurrenceKey'),
      createdAt: r.int('createdAt'),
      modifiedAt: r.int('modifiedAt'),
    });
  },
  category(object) {
    const r = new Reader(object, 'category');
    return makeCategory({
      id: r.uuid('id'), name: r.string('name'), iconSymbol: r.string('iconSymbol'), colorHex: r.string('colorHex'),
      sortOrder: r.int('sortOrder'), isArchived: r.bool('isArchived'), mergedIntoID: r.optUuid('mergedIntoID'),
      createdAt: r.int('createdAt'), modifiedAt: r.int('modifiedAt'),
    });
  },
  subcategory(object) {
    const r = new Reader(object, 'subcategory');
    return makeSubcategory({
      id: r.uuid('id'), categoryID: r.uuid('categoryID'), name: r.string('name'), sortOrder: r.int('sortOrder'),
      isArchived: r.bool('isArchived'), mergedIntoID: r.optUuid('mergedIntoID'),
      createdAt: r.int('createdAt'), modifiedAt: r.int('modifiedAt'),
    });
  },
  paymentMethod(object) {
    const r = new Reader(object, 'paymentMethod');
    return makePaymentMethod({
      id: r.uuid('id'), name: r.string('name'), iconSymbol: r.string('iconSymbol'), sortOrder: r.int('sortOrder'),
      isArchived: r.bool('isArchived'), createdAt: r.int('createdAt'), modifiedAt: r.int('modifiedAt'),
    });
  },
  tag(object) {
    const r = new Reader(object, 'tag');
    return makeTag({ id: r.uuid('id'), name: r.string('name'), createdAt: r.int('createdAt') });
  },
  budget(object) {
    const r = new Reader(object, 'budget');
    return makeBudget({
      id: r.uuid('id'), name: r.string('name'), categoryID: r.optUuid('categoryID'),
      periodKind: r.oneOf('periodKind', BUDGET_PERIODS), customStart: r.optDay('customStart'), customEnd: r.optDay('customEnd'),
      amount: r.money('amount'), alertThresholds: r.ints('alertThresholds'),
      notificationsEnabled: r.bool('notificationsEnabled'), isActive: r.bool('isActive'),
      createdAt: r.int('createdAt'), modifiedAt: r.int('modifiedAt'),
    });
  },
  template(object) {
    const r = new Reader(object, 'template');
    return makeTemplate({
      id: r.uuid('id'), title: r.string('title'), amount: r.money('amount'), categoryID: r.uuid('categoryID'),
      subcategoryID: r.optUuid('subcategoryID'), paymentMethodID: r.optUuid('paymentMethodID'),
      merchant: r.string('merchant'), notes: r.string('notes'), tags: r.strings('tags'),
      frequency: r.oneOf('frequency', FREQUENCIES), interval: r.int('interval'),
      startDay: r.day('startDay'), endDay: r.optDay('endDay'), mode: r.oneOf('mode', RECURRENCE_MODES),
      reminderEnabled: r.bool('reminderEnabled'), reminderDaysBefore: r.int('reminderDaysBefore'),
      reminderHour: r.int('reminderHour'), reminderMinute: r.int('reminderMinute'),
      isActive: r.bool('isActive'), timeZoneID: r.string('timeZoneID'),
      createdAt: r.int('createdAt'), modifiedAt: r.int('modifiedAt'),
    });
  },
  logEntry(object) {
    const r = new Reader(object, 'recurrenceLog');
    return makeLogEntry({
      id: r.uuid('id'), templateID: r.uuid('templateID'), dueDay: r.day('dueDay'),
      outcome: r.oneOf('outcome', OCCURRENCE_OUTCOMES), expenseID: r.optUuid('expenseID'), decidedAt: r.int('decidedAt'),
    });
  },
  settings(object) {
    if (object === null || typeof object !== 'object' || Array.isArray(object)) throw new WireError('settings is not an object');
    return normalizeSettings(object);
  },
};
