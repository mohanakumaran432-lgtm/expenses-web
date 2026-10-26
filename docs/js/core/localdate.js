// A calendar day with no time of day and no time zone, for example 2026-10-20.
//
// All "which day / week / month does this belong to" logic works on LocalDate with plain integer calendar
// arithmetic (proleptic Gregorian), so it never depends on the phone's time zone or on daylight saving.
// Time zones only matter when a clock time is turned into an exact instant (see calendar.js).

function floorDiv(a, b) {
  return Math.floor(a / b);
}

// Howard Hinnant's civil-date algorithms (days since 1970-01-01).
export function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = floorDiv(y, 400);
  const yearOfEra = y - era * 400;
  const monthIndex = (month + 9) % 12;
  const dayOfYear = floorDiv(153 * monthIndex + 2, 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

export function civilFromDays(daysSinceEpoch) {
  const z = daysSinceEpoch + 719468;
  const era = floorDiv(z, 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = floorDiv(
    dayOfEra - floorDiv(dayOfEra, 1460) + floorDiv(dayOfEra, 36524) - floorDiv(dayOfEra, 146096),
    365,
  );
  const y = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100));
  const monthIndex = floorDiv(5 * dayOfYear + 2, 153);
  const d = dayOfYear - floorDiv(153 * monthIndex + 2, 5) + 1;
  const m = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year, month) {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
    case 4: case 6: case 9: case 11: return 30;
    default: return isLeapYear(year) ? 29 : 28;
  }
}

export class LocalDate {
  /** Trusts the caller. Use LocalDate.valid(...) for values a person typed or a file contained. */
  constructor(year, month, day) {
    this.year = year;
    this.month = month;
    this.day = day;
    /** 20261020: compares and sorts like the date itself, handy as a map key. */
    this.raw = year * 10000 + month * 100 + day;
    Object.freeze(this);
  }

  /** null for impossible dates such as 2026-02-30 or month 13. */
  static valid(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return new LocalDate(year, month, day);
  }

  /** Parses "yyyy-MM-dd". null when it is not a real date. */
  static fromISO(text) {
    if (typeof text !== 'string') return null;
    const match = /^(\d{1,6})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (!match) return null;
    return LocalDate.valid(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  static fromRaw(raw) {
    if (!Number.isInteger(raw)) return null;
    return LocalDate.valid(Math.floor(raw / 10000), Math.floor(raw / 100) % 100, raw % 100);
  }

  static fromDayNumber(dayNumber) {
    const [year, month, day] = civilFromDays(dayNumber);
    return new LocalDate(year, month, day);
  }

  /** Days since 1970-01-01. */
  get dayNumber() {
    return daysFromCivil(this.year, this.month, this.day);
  }

  addingDays(days) {
    return days === 0 ? this : LocalDate.fromDayNumber(this.dayNumber + days);
  }

  /** Whole days from this day to `other` (negative if `other` is earlier). */
  daysUntil(other) {
    return other.dayNumber - this.dayNumber;
  }

  /** Adds months, keeping the day when possible and clamping to the month's last day otherwise (Jan 31 + 1 month = Feb 28/29). */
  addingMonths(months) {
    const total = this.year * 12 + (this.month - 1) + months;
    const newYear = floorDiv(total, 12);
    const newMonth = total - newYear * 12 + 1;
    return new LocalDate(newYear, newMonth, Math.min(this.day, daysInMonth(newYear, newMonth)));
  }

  addingYears(years) {
    return this.addingMonths(years * 12);
  }

  /** 1 = Sunday ... 7 = Saturday (the same numbering the iPhone app uses). */
  get weekday() {
    const mod = ((this.dayNumber % 7) + 7) % 7; // 0 for 1970-01-01, a Thursday
    return ((mod + 4) % 7) + 1;
  }

  get startOfMonth() { return new LocalDate(this.year, this.month, 1); }
  get endOfMonth() { return new LocalDate(this.year, this.month, daysInMonth(this.year, this.month)); }

  get startOfQuarter() {
    return new LocalDate(this.year, floorDiv(this.month - 1, 3) * 3 + 1, 1);
  }

  get endOfQuarter() { return this.startOfQuarter.addingMonths(2).endOfMonth; }
  get startOfYear() { return new LocalDate(this.year, 1, 1); }
  get endOfYear() { return new LocalDate(this.year, 12, 31); }

  /** First day of the week containing this day, where `firstWeekday` is 1 (Sunday) to 7 (Saturday). */
  startOfWeek(firstWeekday) {
    const first = Math.min(Math.max(firstWeekday, 1), 7);
    const offset = (this.weekday - first + 7) % 7;
    return this.addingDays(-offset);
  }

  equals(other) { return other !== null && other !== undefined && this.raw === other.raw; }
  isBefore(other) { return this.raw < other.raw; }
  isAfter(other) { return this.raw > other.raw; }
  compare(other) { return this.raw - other.raw; }

  /** "yyyy-MM-dd" */
  toString() {
    return `${String(this.year).padStart(4, '0')}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
  }

  /** JSON.stringify writes a LocalDate as "yyyy-MM-dd", the same text the iPhone app writes. */
  toJSON() { return this.toString(); }
}

export function minDate(a, b) { return a.raw <= b.raw ? a : b; }
export function maxDate(a, b) { return a.raw >= b.raw ? a : b; }
