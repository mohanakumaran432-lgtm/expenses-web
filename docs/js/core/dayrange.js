// A run of whole calendar days, both ends included.
//
// "The end date includes the entire selected day" is true by construction: a range is expressed in days,
// not in instants, so there is no 23:59:59 cut-off to get wrong.

import { LocalDate, maxDate, minDate } from './localdate.js';

export class DayRange {
  /** Use DayRange.make(...) or DayRange.between(...); the constructor trusts start <= end. */
  constructor(start, end) {
    this.start = start;
    this.end = end;
    Object.freeze(this);
  }

  /** null when `end` is before `start`. */
  static make(start, end) {
    return start.raw <= end.raw ? new DayRange(start, end) : null;
  }

  /** Accepts the two days in either order. */
  static between(first, second) {
    return new DayRange(minDate(first, second), maxDate(first, second));
  }

  static single(day) {
    return new DayRange(day, day);
  }

  get dayCount() {
    return this.start.daysUntil(this.end) + 1;
  }

  contains(day) {
    return day.raw >= this.start.raw && day.raw <= this.end.raw;
  }

  equals(other) {
    return other !== null && other !== undefined && this.start.raw === other.start.raw && this.end.raw === other.end.raw;
  }

  /** Every day in the range, oldest first. */
  days() {
    const result = [];
    const first = this.start.dayNumber;
    const count = this.dayCount;
    for (let i = 0; i < count; i += 1) result.push(LocalDate.fromDayNumber(first + i));
    return result;
  }

  /**
   * How many of the range's days have already happened (counting `today`). Zero for a range that has not started.
   * Averages divide by this, so "this month so far" is not diluted by days that have not happened yet.
   */
  elapsedDayCount(today) {
    if (today.raw < this.start.raw) return 0;
    const last = minDate(this.end, today);
    return this.start.daysUntil(last) + 1;
  }

  /** The part of the range up to and including `today`, or null if the range has not started. */
  elapsed(today) {
    if (today.raw < this.start.raw) return null;
    return new DayRange(this.start, minDate(this.end, today));
  }

  shifted(byDays) {
    return new DayRange(this.start.addingDays(byDays), this.end.addingDays(byDays));
  }

  /** Splits the range into calendar weeks (starting on `firstWeekday`). The first and last bucket may be partial. */
  weekBuckets(firstWeekday) {
    const buckets = [];
    let cursor = this.start;
    while (cursor.raw <= this.end.raw) {
      const weekEnd = cursor.startOfWeek(firstWeekday).addingDays(6);
      const bucketEnd = minDate(weekEnd, this.end);
      buckets.push(DayRange.between(cursor, bucketEnd));
      cursor = bucketEnd.addingDays(1);
    }
    return buckets;
  }

  /** Splits the range into calendar months. The first and last bucket may be partial. */
  monthBuckets() {
    const buckets = [];
    let cursor = this.start;
    while (cursor.raw <= this.end.raw) {
      const bucketEnd = minDate(cursor.endOfMonth, this.end);
      buckets.push(DayRange.between(cursor, bucketEnd));
      cursor = bucketEnd.addingDays(1);
    }
    return buckets;
  }

  toJSON() {
    return { start: this.start.toString(), end: this.end.toString() };
  }
}
