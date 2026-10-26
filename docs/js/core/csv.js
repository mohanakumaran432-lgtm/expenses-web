// Writes expenses as CSV (RFC 4180) that opens correctly in Numbers, Excel and Google Sheets.
//
// - Amounts are exact decimals with a "." point and the currency's own number of decimals ("12.50").
// - Dates are ISO (yyyy-MM-dd), times are 24-hour (HH:mm) and blank when no time was entered.
// - Commas, quotes and line breaks inside text are escaped by quoting.
// - Text that a spreadsheet could run as a formula (starts with = + - @ tab or CR) gets a leading apostrophe.
// - The file starts with a UTF-8 byte order mark so Arabic and other non-English text displays correctly.

import { CalendarContext } from './calendar.js';
import { compareOldestFirst } from './snapshot.js';
import { plainString } from './money.js';

export const CSV_COLUMNS = Object.freeze([
  'Date', 'Time', 'Amount', 'Currency', 'Category', 'Subcategory',
  'Payment Method', 'Merchant', 'Notes', 'Tags', 'Recurring', 'ID',
]);

export const LINE_BREAK = '\r\n';
export const BYTE_ORDER_MARK = '\uFEFF';

/**
 * Spreadsheet formula-injection defence: text that starts with = + - @ tab or carriage return
 * would be executed as a formula by Excel or Sheets, so it is prefixed with an apostrophe.
 */
export function neutralizeFormula(text) {
  if (text.length === 0) return text;
  const first = text[0];
  return first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r'
    ? `'${text}`
    : text;
}

/** Quotes a field when needed and doubles any quotes inside it. */
export function escapeField(field) {
  let needsQuotes = /[,"\n\r]/.test(field);
  if (field.startsWith(' ') || field.endsWith(' ')) needsQuotes = true;
  if (!needsQuotes) return field;
  return `"${field.replaceAll('"', '""')}"`;
}

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

/** The field values of one row, already protected against formula injection (but not yet quoted). */
export function csvRow(expense, directory) {
  let timeText = '';
  if (expense.hasExplicitTime) {
    const clock = new CalendarContext(expense.timeZoneID).hourAndMinute(expense.occurredAt);
    timeText = `${twoDigits(clock.hour)}:${twoDigits(clock.minute)}`;
  }
  return [
    expense.localDay.toString(),
    timeText,
    plainString(expense.amount),
    expense.amount.currencyCode,
    neutralizeFormula(directory.categoryName(expense)),
    neutralizeFormula(directory.subcategoryName(expense) || ''),
    neutralizeFormula(directory.paymentMethodName(expense) || ''),
    neutralizeFormula(expense.merchant),
    neutralizeFormula(expense.notes),
    neutralizeFormula(expense.tags.join('; ')),
    expense.recurringTemplateID ? 'Yes' : 'No',
    expense.id,
  ];
}

/** The whole file as text, oldest expense first. Pass already-filtered expenses to export only those. */
export function makeCSV(expenses, directory) {
  const ordered = expenses.slice().sort(compareOldestFirst);
  const lines = [CSV_COLUMNS.map(escapeField).join(',')];
  for (const expense of ordered) lines.push(csvRow(expense, directory).map(escapeField).join(','));
  return BYTE_ORDER_MARK + lines.join(LINE_BREAK) + LINE_BREAK;
}

/** Minimal RFC 4180 reader. Used by tests to prove that what is exported can be read back exactly. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  const scalars = Array.from(text);
  let index = 0;
  if (scalars.length > 0 && scalars[0] === BYTE_ORDER_MARK) index = 1;

  while (index < scalars.length) {
    const scalar = scalars[index];
    if (inQuotes) {
      if (scalar === '"') {
        if (index + 1 < scalars.length && scalars[index + 1] === '"') {
          field += '"';
          index += 2;
        } else {
          inQuotes = false;
          index += 1;
        }
      } else {
        field += scalar;
        index += 1;
      }
      continue;
    }
    if (scalar === '"') {
      inQuotes = true;
      fieldStarted = true;
      index += 1;
    } else if (scalar === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
      index += 1;
    } else if (scalar === '\r') {
      index += 1;
    } else if (scalar === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      index += 1;
    } else {
      field += scalar;
      fieldStarted = true;
      index += 1;
    }
  }
  if (fieldStarted || row.length > 0 || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
