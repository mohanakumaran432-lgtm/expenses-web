// Cells starting with = + - @ (or tab/CR) can run as formulas when a CSV is opened in Excel/Sheets.
// Text cells get a leading apostrophe so they stay plain text. Numbers are written as-is.
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: string | number): string {
  let s = String(value)
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** UTF-8 with BOM so Excel shows Arabic/other text correctly. */
export const toCsv = (rows: (string | number)[][]): string =>
  '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
