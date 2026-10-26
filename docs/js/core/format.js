// Turns amounts, days and times into the text shown on screen, following the person's formatting settings.
// This never changes what is stored, only what is displayed. Amounts are formatted from exact whole numbers
// (never through floating point), and digits are always written 0-9 so an amount reads the same everywhere.

import { divideRoundHalfAwayFromZero } from './util.js';
import { digitsOf, doubleValue } from './money.js';
import { CalendarContext } from './calendar.js';

export function defaultLocale() {
  try {
    const candidate = (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || 'en-US';
    new Intl.NumberFormat(candidate);
    return candidate;
  } catch {
    return 'en-US';
  }
}

function usableLocale(locale) {
  try {
    new Intl.NumberFormat(locale);
    return locale;
  } catch {
    return 'en-US';
  }
}

const EXPLICIT_SEPARATORS = Object.freeze({
  commaDot: { grouping: ',', decimal: '.' },
  dotComma: { grouping: '.', decimal: ',' },
  spaceComma: { grouping: ' ', decimal: ',' },
  apostropheDot: { grouping: '’', decimal: '.' },
});

const MINUS = '−';

function groupDigits(digits, separator) {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += separator;
    out += digits[i];
  }
  return out;
}

export class MoneyFormatter {
  /** @param style one of 'system', 'commaDot', 'dotComma', 'spaceComma', 'apostropheDot' */
  constructor(locale = defaultLocale(), style = 'system') {
    this.locale = usableLocale(locale);
    this.style = style;
    this.cache = new Map();
    this.explicit = EXPLICIT_SEPARATORS[style] || null;
    if (this.explicit) {
      this.decimalSeparator = this.explicit.decimal;
      this.groupingSeparator = this.explicit.grouping;
    } else {
      const parts = new Intl.NumberFormat(this.locale, { numberingSystem: 'latn' }).formatToParts(1234567.5);
      this.decimalSeparator = (parts.find((p) => p.type === 'decimal') || { value: '.' }).value || '.';
      this.groupingSeparator = (parts.find((p) => p.type === 'group') || { value: ',' }).value || ',';
    }
  }

  cached(key, make) {
    let found = this.cache.get(key);
    if (!found) {
      found = make();
      this.cache.set(key, found);
    }
    return found;
  }

  /** The digits of a non-negative whole count of minor units, grouped and with the decimal point. */
  numberText(magnitude, digits) {
    const big = BigInt(magnitude);
    const divisor = BigInt(10) ** BigInt(digits);
    const whole = big / divisor;
    const fraction = digits === 0 ? '' : String(big % divisor).padStart(digits, '0');
    let wholeText;
    if (this.explicit) {
      wholeText = groupDigits(String(whole), this.explicit.grouping);
    } else {
      const formatter = this.cached('whole', () => new Intl.NumberFormat(this.locale, {
        numberingSystem: 'latn', useGrouping: true, maximumFractionDigits: 0,
      }));
      wholeText = formatter.format(whole);
    }
    return digits === 0 ? wholeText : wholeText + this.decimalSeparator + fraction;
  }

  currencyTemplate(code, digits, negative) {
    return this.cached(`template|${code}|${digits}|${negative}`, () => {
      try {
        return new Intl.NumberFormat(this.locale, {
          numberingSystem: 'latn', style: 'currency', currency: code,
          minimumFractionDigits: digits, maximumFractionDigits: digits,
        }).formatToParts(negative ? -1 : 1);
      } catch {
        return null;
      }
    });
  }

  /** Puts already-formatted digits into the locale's currency pattern ("AED 1,234.50", "1.234,50 €"). */
  composeCurrency(code, digits, negative, text) {
    const template = this.currencyTemplate(code, digits, negative);
    if (!template) return `${negative ? '-' : ''}${code}\u00A0${text}`;
    let out = '';
    let placed = false;
    for (const part of template) {
      if (part.type === 'integer' || part.type === 'group' || part.type === 'decimal' || part.type === 'fraction') {
        if (!placed) {
          out += text;
          placed = true;
        }
      } else {
        out += part.value;
      }
    }
    return out;
  }

  /** "AED 1,234.50" (the symbol or code placement follows the locale). */
  string(m, showCurrency = true) {
    const digits = digitsOf(m);
    const negative = m.minorUnits < 0;
    const text = this.numberText(Math.abs(m.minorUnits), digits);
    if (!showCurrency) return (negative ? '-' : '') + text;
    return this.composeCurrency(m.currencyCode, digits, negative, text);
  }

  /** Whole units only, for tight spaces such as chart axis labels. */
  wholeString(m, showCurrency = false) {
    const digits = digitsOf(m);
    const whole = Number(divideRoundHalfAwayFromZero(BigInt(m.minorUnits), BigInt(10) ** BigInt(digits)));
    const negative = whole < 0;
    const text = this.numberText(Math.abs(whole), 0);
    if (!showCurrency) return (negative ? '-' : '') + text;
    return this.composeCurrency(m.currencyCode, 0, negative, text);
  }

  /** Short text such as "2.5K", "15K" or "3.4M" for chart labels (a trailing ".0" is dropped). Display only. */
  compactString(m) {
    const value = doubleValue(m);
    const magnitude = Math.abs(value);
    const scaled = (divisor, suffix) => {
      const text = (value / divisor).toFixed(1);
      return (text.endsWith('.0') ? text.slice(0, -2) : text.replace('.', this.decimalSeparator)) + suffix;
    };
    // The thresholds sit just under each unit so that rounding never produces "1000.0K".
    if (magnitude >= 999_950_000) return scaled(1_000_000_000, 'B');
    if (magnitude >= 999_950) return scaled(1_000_000, 'M');
    if (magnitude >= 1_000) return scaled(1_000, 'K');
    return this.wholeString(m);
  }

  /** A difference with an explicit direction: "+AED 120.00" or "−AED 30.00". Zero has no sign. */
  signedString(m) {
    if (m.minorUnits > 0) return `+${this.string(m)}`;
    if (m.minorUnits < 0) return MINUS + this.string(Object.freeze({ minorUnits: -m.minorUnits, currencyCode: m.currencyCode }));
    return this.string(m);
  }

  /** "12.3%" from a percentage that was already rounded to one decimal place. */
  percentString(percent) {
    const tenths = Math.round(Math.abs(percent) * 10);
    const whole = Math.floor(tenths / 10);
    const grouped = this.explicit
      ? groupDigits(String(whole), this.explicit.grouping)
      : this.cached('whole', () => new Intl.NumberFormat(this.locale, {
        numberingSystem: 'latn', useGrouping: true, maximumFractionDigits: 0,
      })).format(whole);
    return `${percent < 0 && tenths !== 0 ? '-' : ''}${grouped}${this.decimalSeparator}${tenths % 10}%`;
  }

  /** "+12.5%" or "−3.0%"; zero is "0.0%". */
  signedPercentString(percent) {
    if (percent > 0) return `+${this.percentString(percent)}`;
    if (percent < 0) return MINUS + this.percentString(-percent);
    return this.percentString(percent);
  }
}


// ---------------------------------------------------------------------------------------------------- days and times

const DAY_MS = 86_400_000;

/** A LocalDate as noon UTC, read through UTC formatters, so the printed day can never shift with the phone's time zone. */
function referenceDate(day) {
  return new Date(day.dayNumber * DAY_MS + DAY_MS / 2);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export class DisplayFormatter {
  /** @param settings an app settings object (dateFormat, timeFormat, numberFormat) */
  constructor(settings, locale = defaultLocale()) {
    this.locale = usableLocale(locale);
    this.dateStyle = settings.dateFormat;
    this.timeStyle = settings.timeFormat;
    this.money = new MoneyFormatter(this.locale, settings.numberFormat);
    this.cache = new Map();
  }

  formatter(key, options) {
    let found = this.cache.get(key);
    if (!found) {
      found = new Intl.DateTimeFormat(this.locale, { numberingSystem: 'latn', calendar: 'gregory', ...options });
      this.cache.set(key, found);
    }
    return found;
  }

  utcFormatter(key, options) {
    return this.formatter(key, { timeZone: 'UTC', ...options });
  }

  // Days ------------------------------------------------------------------------------------------

  /** "20/10/2026", "2026-10-20", or the system style such as "20 Oct 2026". */
  day(day) {
    switch (this.dateStyle) {
      case 'dayMonthYear': return `${pad2(day.day)}/${pad2(day.month)}/${String(day.year).padStart(4, '0')}`;
      case 'monthDayYear': return `${pad2(day.month)}/${pad2(day.day)}/${String(day.year).padStart(4, '0')}`;
      case 'yearMonthDay': return day.toString();
      default: return this.utcFormatter('medium', { dateStyle: 'medium' }).format(referenceDate(day));
    }
  }

  weekdayShort(day) {
    return this.utcFormatter('weekday-short', { weekday: 'short' }).format(referenceDate(day));
  }

  weekdayLong(day) {
    return this.utcFormatter('weekday-long', { weekday: 'long' }).format(referenceDate(day));
  }

  /** "October 2026". */
  monthYear(day) {
    return this.utcFormatter('month-year', { month: 'long', year: 'numeric' }).format(referenceDate(day));
  }

  /** "Oct 2026". */
  monthYearShort(day) {
    return this.utcFormatter('month-year-short', { month: 'short', year: 'numeric' }).format(referenceDate(day));
  }

  /** "20 Oct" (axis labels). */
  dayMonthShort(day) {
    return this.utcFormatter('day-month', { day: 'numeric', month: 'short' }).format(referenceDate(day));
  }

  /** "Today", "Yesterday", otherwise "Tue, 20/10/2026". */
  dayHeader(target, today) {
    if (target.raw === today.raw) return 'Today';
    if (target.raw === today.addingDays(-1).raw) return 'Yesterday';
    return `${this.weekdayShort(target)}, ${this.day(target)}`;
  }

  /** "Today", "Yesterday", otherwise "18 Oct 2026" (shorter than dayHeader, for small spaces beside an amount). */
  relativeDay(target, today) {
    if (target.raw === today.raw) return 'Today';
    if (target.raw === today.addingDays(-1).raw) return 'Yesterday';
    return this.day(target);
  }

  /** "20 Oct 2026" for one day, "1 Oct 2026 – 20 Oct 2026" for a range. */
  range(range) {
    if (range.start.raw === range.end.raw) return this.day(range.start);
    return `${this.day(range.start)} – ${this.day(range.end)}`;
  }

  // Times -----------------------------------------------------------------------------------------

  time(hour, minute) {
    const date = new Date(Date.UTC(1970, 0, 1, hour, minute));
    switch (this.timeStyle) {
      case 'twelveHour': {
        const suffix = hour < 12 ? 'AM' : 'PM';
        const twelve = hour % 12 === 0 ? 12 : hour % 12;
        return `${twelve}:${pad2(minute)} ${suffix}`;
      }
      case 'twentyFourHour':
        return `${pad2(hour)}:${pad2(minute)}`;
      default:
        return this.utcFormatter('time-short', { timeStyle: 'short' }).format(date);
    }
  }

  /** The wall-clock time the expense was recorded at, or null when no time was entered. */
  timeOfExpense(expense) {
    if (!expense.hasExplicitTime) return null;
    const clock = new CalendarContext(expense.timeZoneID).hourAndMinute(expense.occurredAt);
    return this.time(clock.hour, clock.minute);
  }

  /** "20 Oct 2026, 21:29" in a given time zone (for "Generated on" lines). */
  timestamp(ms, timeZone) {
    let zone = timeZone;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      zone = 'UTC';
    }
    return this.formatter(`timestamp|${zone}`, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(ms));
  }
}
