// How one expense looks as a row in a list, and the small facts every list needs.

import { badge, row } from '../components.js';

export function categoryBadge(app, categoryID, size = '') {
  const category = app.snapshot.category(categoryID);
  return badge({ iconSymbol: category ? category.iconSymbol : 'questionmark.circle', colorHex: category ? category.colorHex : '#8E8E93' }, size);
}

/** The short text under an expense's title: category (when the title is a merchant), payment method, time, repeating. */
export function expenseSubtitle(app, expense) {
  const directory = app.directory;
  const category = directory.categoryName(expense);
  const subcategory = directory.subcategoryName(expense);
  const method = directory.paymentMethodName(expense);
  const time = app.formatter.timeOfExpense(expense);
  const parts = [];
  if (expense.merchant !== '') parts.push(subcategory ? `${category} › ${subcategory}` : category);
  else if (subcategory) parts.push(subcategory);
  if (method) parts.push(method);
  if (time) parts.push(time);
  if (expense.recurringTemplateID) parts.push('Repeating');
  return parts.join(' · ');
}

export function expenseTitle(app, expense) {
  return expense.merchant !== '' ? expense.merchant : app.directory.categoryName(expense);
}

/**
 * @param showDay    write the day under the amount (lists that are not grouped by day)
 * @param selectable null for a normal row; true/false shows a tick circle (selection mode)
 */
export function expenseRow(app, expense, { onClick = null, showDay = false, selectable = null, today = null } = {}) {
  const formatter = app.formatter;
  const sub = expenseSubtitle(app, expense);
  return row({
    title: expenseTitle(app, expense),
    sub: sub === '' ? null : sub,
    badge: categoryBadge(app, expense.categoryID),
    amount: formatter.money.string(expense.amount),
    amountSub: showDay ? formatter.relativeDay(expense.localDay, today || app.today()) : null,
    onClick,
    selectable,
  });
}
