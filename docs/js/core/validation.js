// What counts as a valid expense. Every rule lives here, so the form, the importer and the recurring-expense
// engine all agree.

import { LocalDate } from './localdate.js';
import { MAX_MINOR_UNITS } from './money.js';
import { MAX_MERCHANT_LENGTH, MAX_NOTES_LENGTH, MAX_TAGS_PER_EXPENSE } from './text.js';
import { characterCount } from './util.js';

/** Plain-language text for the screen. Never includes the amount or any other personal detail. */
export const EXPENSE_PROBLEM_MESSAGES = Object.freeze({
  amountNotPositive: 'Enter an amount greater than zero.',
  amountTooLarge: 'That amount is too large.',
  categoryRequired: 'Choose a category.',
  categoryNotFound: 'That category no longer exists.',
  subcategoryNotInCategory: 'That subcategory does not belong to the chosen category.',
  paymentMethodNotFound: 'That payment method no longer exists.',
  dateTooEarly: 'The date is too far in the past.',
  dateTooFarInFuture: 'The date is too far in the future.',
  invalidTime: 'The time is not valid.',
  merchantTooLong: 'The merchant name is too long.',
  notesTooLong: 'The notes are too long.',
  tooManyTags: 'Too many tags.',
});

export const EARLIEST_DAY = new LocalDate(2000, 1, 1);
/** An expense may be dated up to this many days after today (for example a bill paid in advance). */
export const MAX_DAYS_IN_FUTURE = 366;

/** Checks a draft whose text has already been normalized. Returns a list of problem codes (empty means valid). */
export function validateDraft(draft, snapshot, today) {
  const problems = [];

  if (!(draft.amount.minorUnits > 0)) problems.push('amountNotPositive');
  if (draft.amount.minorUnits > MAX_MINOR_UNITS) problems.push('amountTooLarge');

  if (draft.categoryID) {
    if (!snapshot.category(draft.categoryID)) {
      problems.push('categoryNotFound');
    } else if (draft.subcategoryID) {
      const subcategory = snapshot.subcategory(draft.subcategoryID);
      if (!subcategory || subcategory.categoryID !== draft.categoryID) problems.push('subcategoryNotInCategory');
    }
  } else {
    problems.push('categoryRequired');
  }

  if (draft.paymentMethodID && !snapshot.paymentMethod(draft.paymentMethodID)) problems.push('paymentMethodNotFound');

  if (draft.day.raw < EARLIEST_DAY.raw) problems.push('dateTooEarly');
  if (draft.day.raw > today.addingDays(MAX_DAYS_IN_FUTURE).raw) problems.push('dateTooFarInFuture');

  if (draft.hasExplicitTime) {
    const { hour, minute } = draft;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      problems.push('invalidTime');
    }
  }

  if (characterCount(draft.merchant) > MAX_MERCHANT_LENGTH) problems.push('merchantTooLong');
  if (characterCount(draft.notes) > MAX_NOTES_LENGTH) problems.push('notesTooLong');
  if (draft.tags.length > MAX_TAGS_PER_EXPENSE) problems.push('tooManyTags');

  return problems;
}
