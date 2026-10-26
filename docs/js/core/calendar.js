// Converts between exact instants (milliseconds since 1970) and calendar days in one time zone.
//
// This is the only place where time zones and daylight saving matter. Everything else (periods, buckets, totals)
// works on LocalDate values, so a report for "October 20" can never include part of October 19 or 21.
//
// The browser's Intl.DateTimeFormat is the source of truth for a zone's rules; no zone data is bundled here.

import { LocalDate } from './localdate.js';

const DAY_MS = 86_400_000;
const formatters = new Map();

/** The phone's current time zone, e.g. "Asia/Dubai". */
export function currentTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function isUsableZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

export class CalendarContext {
  /** An unknown zone name (for example from a damaged backup) falls back to the phone's own zone, never fails. */
  constructor(timeZone) {
    this.timeZone = timeZone && isUsableZone(timeZone) ? timeZone : currentTimeZone();
  }

  wallClock(ms) {
    const parts = formatterFor(this.timeZone).formatToParts(ms);
    const result = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    for (const part of parts) {
      if (part.type === 'literal') continue;
      if (part.type in result) result[part.type] = parseInt(part.value, 10);
    }
    if (result.hour === 24) result.hour = 0;
    return result;
  }

  /** How far this zone's clock is ahead of UTC at an instant, in milliseconds. */
  offsetMs(ms) {
    const p = this.wallClock(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }

  /** The calendar day an instant falls on in this time zone. */
  localDate(ms) {
    const p = this.wallClock(ms);
    return new LocalDate(p.year, p.month, p.day);
  }

  hourAndMinute(ms) {
    const p = this.wallClock(ms);
    return { hour: p.hour, minute: p.minute };
  }

  /**
   * The exact instant of a wall-clock time on a day.
   * - A time that happens twice (clocks go back) takes the first occurrence.
   * - A time that does not exist (the hour skipped when clocks go forward) moves forward to the next valid time.
   */
  instant(day, hour = 12, minute = 0) {
    const wall = Date.UTC(day.year, day.month - 1, day.day, hour, minute, 0);
    const before = this.offsetMs(wall - DAY_MS);
    const after = this.offsetMs(wall + DAY_MS);
    const candidates = before === after ? [wall - before] : [wall - before, wall - after];
    let best = null;
    for (const candidate of candidates) {
      const p = this.wallClock(candidate);
      if (p.year === day.year && p.month === day.month && p.day === day.day && p.hour === hour && p.minute === minute) {
        if (best === null || candidate < best) best = candidate;
      }
    }
    return best !== null ? best : wall - before;
  }

  /** The exact start of a calendar day (00:00, or later on days where midnight is skipped). */
  startOfDay(day) {
    return this.instant(day, 0, 0);
  }

  /** Today's calendar day in this time zone. */
  today(nowMs = Date.now()) {
    return this.localDate(nowMs);
  }

  /**
   * The instant stored for an expense: the clock time the person chose, or noon on that day when no time was
   * entered (noon keeps the instant safely inside the intended day, whatever the time zone).
   */
  instantFor(day, hasTime, hour, minute) {
    return hasTime ? this.instant(day, hour, minute) : this.instant(day, 12, 0);
  }
}
