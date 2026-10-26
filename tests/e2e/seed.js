// Loads made-up spending into a running app, through the app's own services (so the real validation, change sets and
// storage code run). Used by the browser tests only. All names and amounts are invented.
//
// Imports use absolute paths so they resolve to the SAME module instances the app itself loaded.

import { LocalDate } from '/js/core/localdate.js';
import { makeDraft } from '/js/core/models.js';
import { parseMoney } from '/js/core/money.js';

/** A small, repeatable random-number generator (so every run produces the same ledger). */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// name, merchants, [min, max], chance per day, payment method, optional notes
const HABITS = [
  { category: 'Groceries', merchants: ['Spinneys', 'Carrefour', 'Lulu Hypermarket'], range: [34, 260], chance: 0.36, method: 'Debit Card' },
  { category: 'Coffee & Snacks', merchants: ['Starbucks', 'Tim Hortons', 'Costa Coffee', 'Common Grounds'], range: [12, 38], chance: 0.5, method: 'Apple Pay' },
  { category: 'Food & Dining', merchants: ['Operation Falafel', 'Zaatar w Zeit', 'Pizzeria Mamma', 'Wagamama'], range: [45, 210], chance: 0.28, method: 'Credit Card' },
  { category: 'Taxi & Ride-hailing', merchants: ['Careem', 'Uber'], range: [14, 66], chance: 0.24, method: 'Credit Card' },
  { category: 'Transport', merchants: ['Salik', 'RTA Nol top-up'], range: [20, 50], chance: 0.14, method: 'Debit Card' },
  { category: 'Fuel', merchants: ['ADNOC', 'ENOC', 'EPPCO'], range: [120, 235], chance: 0.11, method: 'Credit Card' },
  { category: 'Shopping', merchants: ['Amazon.ae', 'Noon', 'IKEA', 'Dubai Mall'], range: [60, 460], chance: 0.1, method: 'Credit Card' },
  { category: 'Entertainment', merchants: ['Reel Cinemas', 'VOX Cinemas', 'Dubai Parks'], range: [45, 190], chance: 0.07, method: 'Credit Card' },
  { category: 'Healthcare & Medicine', merchants: ['Aster Pharmacy', 'Life Pharmacy'], range: [22, 145], chance: 0.06, method: 'Debit Card' },
  { category: 'Personal Care', merchants: ['Gents Salon', 'Bateel Spa'], range: [60, 210], chance: 0.04, method: 'Cash' },
  { category: 'Clothing', merchants: ['H&M', 'Zara', 'Namshi'], range: [80, 520], chance: 0.04, method: 'Credit Card' },
];

// Things that happen once a month: day of month, category, merchant, amount text
const MONTHLY = [
  { day: 1, category: 'Rent & Housing', merchant: 'Landlord', amount: '6500', method: 'Bank Transfer', notes: 'Monthly rent' },
  { day: 3, category: 'Bills & Utilities', merchant: 'DEWA', amount: '512.40', method: 'Debit Card', notes: '' },
  { day: 5, category: 'Bills & Utilities', merchant: 'Etisalat', amount: '249', method: 'Credit Card', notes: 'Home internet and mobile' },
  { day: 7, category: 'Fitness & Wellness', merchant: 'Fitness First', amount: '299', method: 'Credit Card', notes: '' },
  { day: 9, category: 'Subscriptions', merchant: 'Netflix', amount: '39', method: 'Credit Card', notes: '' },
  { day: 9, category: 'Subscriptions', merchant: 'Spotify', amount: '21.99', method: 'Credit Card', notes: '' },
  { day: 14, category: 'Insurance', merchant: 'Orient Insurance', amount: '385.50', method: 'Bank Transfer', notes: 'Car insurance instalment' },
  { day: 21, category: 'Education', merchant: 'Language Centre', amount: '640', method: 'Debit Card', notes: '' },
];

const TAGS = ['family', 'work', 'weekend', 'treat'];

export async function seedLedger(app, { days = 76, seed = 7 } = {}) {
  const random = generator(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const between = (low, high) => low + random() * (high - low);

  const today = app.today();
  const zone = app.timeZone();
  const snapshot = app.snapshot;
  const categoryNamed = (name) => snapshot.categories.find((c) => c.name === name);
  const methodNamed = (name) => snapshot.paymentMethods.find((m) => m.name === name) || null;
  const amountText = (value) => (Math.round(value * 4) / 4).toFixed(2);
  const currency = app.currency;

  const drafts = [];
  const add = (day, categoryName, merchant, text, methodName, { notes = '', tags = [], time = null } = {}) => {
    const parsed = parseMoney(text, currency);
    if (!parsed.ok) throw new Error(`Seed amount ${text} is not valid`);
    const category = categoryNamed(categoryName);
    const method = methodNamed(methodName);
    drafts.push(makeDraft({
      amount: parsed.money,
      day,
      timeZoneID: zone,
      categoryID: category.id,
      paymentMethodID: method ? method.id : null,
      merchant,
      notes,
      tags,
      hasExplicitTime: time !== null,
      hour: time ? time[0] : 12,
      minute: time ? time[1] : 0,
    }));
  };

  for (let back = days - 1; back >= 0; back -= 1) {
    const day = today.addingDays(-back);
    const weekend = day.weekday === 1 || day.weekday === 7; // Sunday or Saturday (weekday numbers run 1 = Sunday to 7 = Saturday)
    for (const habit of HABITS) {
      let chance = habit.chance;
      if (weekend && ['Food & Dining', 'Entertainment', 'Shopping'].includes(habit.category)) chance *= 1.8;
      if (weekend && habit.category === 'Transport') chance *= 0.4;
      if (random() < chance) {
        const [low, high] = habit.range;
        const text = amountText(between(low, high));
        const withTime = random() < 0.35;
        add(day, habit.category, pick(habit.merchants), text, habit.method, {
          tags: random() < 0.12 ? [pick(TAGS)] : [],
          time: withTime ? [Math.floor(between(7, 22)), Math.floor(between(0, 59))] : null,
          notes: random() < 0.08 ? 'Shared with a friend' : '',
        });
      }
    }
    for (const monthly of MONTHLY) {
      if (day.day === monthly.day) add(day, monthly.category, monthly.merchant, monthly.amount, monthly.method, { notes: monthly.notes });
    }
  }

  // One day with a very large expense and a very long merchant name, to look at the awkward cases.
  add(today.addingDays(-12), 'Travel & Holidays', 'Emirates Holidays: an extremely long merchant name that has to wrap neatly', '12480.00', 'Credit Card', {
    notes: 'Flights and hotel for the family trip', tags: ['family'],
  });

  let saved = 0;
  for (const draft of drafts) {
    await app.services.expenses.save(draft, today);
    saved += 1;
  }
  return saved;
}

export { LocalDate };

/** One budget and one repeating expense (starting in the future, so nothing is due yet), so the tests have more than expenses to look after. */
export async function seedBudgetAndRepeating(app) {
  const { newId } = await import('/js/core/util.js');
  const { money } = await import('/js/core/money.js');
  const category = app.snapshot.categories.find((c) => c.name === 'Groceries');
  await app.services.budgets.save({
    id: newId(), name: 'Groceries each month', categoryID: category.id, periodKind: 'monthly', amount: money(150000, app.currency), alertThresholds: [80, 100],
  });
  const today = app.today();
  await app.services.recurrence.saveTemplate({
    id: newId(), title: 'Gym membership', amount: money(29900, app.currency), categoryID: category.id, frequency: 'monthly', interval: 1,
    startDay: today.addingDays(12), endDay: null, mode: 'askToConfirm', reminderEnabled: false, reminderDaysBefore: 0, isActive: true,
    timeZoneID: app.timeZone(), merchant: 'Fitness First', notes: '', tags: [],
  }, { today });
}
