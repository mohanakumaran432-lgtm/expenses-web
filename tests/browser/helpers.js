// A small ledger and an "add expense" helper that work in a browser page (the Node test helpers use node:assert).

import { initialSnapshot } from '../../docs/js/core/snapshot.js';
import { CalendarContext } from '../../docs/js/core/calendar.js';
import { LocalDate } from '../../docs/js/core/localdate.js';
import { makeDraft, makeExpense } from '../../docs/js/core/models.js';
import { parseMoney } from '../../docs/js/core/money.js';
import { ExpenseService } from '../../docs/js/core/expense_service.js';

export const NOW = 1_792_497_600_000;
export const TODAY = new LocalDate(2026, 10, 20);

export function money(text) {
  const parsed = parseMoney(text, 'AED');
  if (!parsed.ok) throw new Error(`${text} is not an amount`);
  return parsed.money;
}

const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** The default categories plus eight expenses (merchants such as "Spinneys"). */
export function sampleLedger() {
  let counter = 0;
  const snapshot = initialSnapshot(NOW, 2, () => uuid((counter += 1)));
  const category = (name) => snapshot.categories.find((c) => c.name === name);
  const context = new CalendarContext('Asia/Dubai');
  const rows = [
    ['50', [2026, 10, 20], 'Groceries', 'Spinneys'], ['12.50', [2026, 10, 20], 'Groceries', 'Carrefour'],
    ['8', [2026, 10, 20], 'Transport', ''], ['18', [2026, 10, 19], 'Coffee & Snacks', 'Café Nero'],
    ['120', [2026, 10, 19], 'Entertainment', 'Reel Cinemas'], ['30', [2026, 10, 1], 'Groceries', 'Spinneys'],
    ['15', [2026, 9, 30], 'Transport', 'RTA'], ['200', [2026, 9, 15], 'Fuel', 'ADNOC'],
  ];
  rows.forEach(([amount, [year, month, day], name, merchant], index) => {
    const localDay = new LocalDate(year, month, day);
    const chosen = category(name);
    snapshot.expenses.push(makeExpense({
      id: uuid(100 + index),
      amount: money(amount),
      occurredAt: context.instant(localDay, 12, 0),
      timeZoneID: 'Asia/Dubai',
      hasExplicitTime: false,
      localDay,
      categoryID: chosen.id,
      subcategoryID: null,
      paymentMethodID: null,
      categoryNameSnapshot: chosen.name,
      subcategoryNameSnapshot: null,
      paymentMethodNameSnapshot: null,
      merchant,
      notes: '',
      tags: index === 0 ? ['family'] : [],
      recurringTemplateID: null,
      occurrenceKey: null,
      createdAt: NOW + index * 1000,
      modifiedAt: NOW + index * 1000,
    }));
  });
  return snapshot.normalizeOrder();
}

/** Adds one expense through the real service (so the real validation and change-set code runs). */
export function addExpense(store, amount) {
  const service = new ExpenseService(store, () => NOW);
  const category = store.snapshot.categories[0];
  return service.save(makeDraft({
    amount: money(amount), day: TODAY, timeZoneID: 'Asia/Dubai', categoryID: category.id,
  }), TODAY);
}
