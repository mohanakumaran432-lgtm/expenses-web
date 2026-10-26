// Handing a list of expenses to the person as a file. Nothing is uploaded anywhere: the file goes to the system share sheet
// (Save to Files, AirDrop, Mail...) or is downloaded, and the person decides where it ends up.

import { plural } from './dom.js';
import { makeCSV } from '../core/csv.js';
import { datedName, deliverFile } from './files.js';

/** The CSV file for these expenses, ready to hand over. */
export function buildCsvFile(app, expenses) {
  const text = makeCSV(expenses, app.directory);
  return {
    filename: datedName('expenses', app.today(), 'csv'),
    mime: 'text/csv',
    blob: new Blob([text], { type: 'text/csv;charset=utf-8' }),
  };
}

/**
 * Exports the given expenses as a CSV file. Pass the filtered list to export only that. Call it straight from a tap.
 * Resolves 'shared', 'downloaded', 'cancelled' or 'empty'.
 */
export async function exportExpensesCsv(app, expenses) {
  if (expenses.length === 0) {
    await app.ui.alert({ title: 'Nothing to export', message: 'There are no expenses here to put in a file.' });
    return 'empty';
  }
  const file = buildCsvFile(app, expenses);
  const outcome = await deliverFile(file);
  announceDelivery(app, outcome, file.filename, plural(expenses.length, 'expense'));
  return outcome;
}

/** The small message shown after a file was handed over. A cancelled share sheet says nothing. */
export function announceDelivery(app, outcome, filename, what) {
  if (outcome === 'shared') app.ui.toast(`${what} exported.`);
  else if (outcome === 'downloaded') app.ui.toast(`${what} saved as ${filename}. Look in your downloads.`);
}
