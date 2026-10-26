// Everything the app knows, as plain values. Reports and screens read from this; they never touch the database.
// Also: the group of edits that must succeed or fail together, and the id-to-name lookups.

import { defaultSettings, makeCategory, makePaymentMethod } from './models.js';
import { DEFAULT_CATEGORIES, DEFAULT_PAYMENT_METHODS } from './models.js';
import { newId } from './util.js';

/** Newest first: by day, then clock time, then creation, and finally the id so the order is always the same. */
export function compareNewestFirst(a, b) {
  if (a.localDay.raw !== b.localDay.raw) return b.localDay.raw - a.localDay.raw;
  if (a.occurredAt !== b.occurredAt) return b.occurredAt - a.occurredAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

/** Oldest first: the exact opposite of compareNewestFirst. */
export function compareOldestFirst(a, b) {
  return compareNewestFirst(b, a);
}

/** True when `a` comes after `b` in chronological order. */
export function isNewer(a, b) {
  return compareNewestFirst(a, b) < 0;
}

const byOrderThenName = (a, b) => {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

function byId(items) {
  const map = new Map();
  for (const item of items) map.set(item.id, item);
  return map;
}

function upsert(items, updates) {
  if (updates.length === 0) return items;
  const positions = new Map();
  items.forEach((item, index) => positions.set(item.id, index));
  const result = items.slice();
  for (const update of updates) {
    const position = positions.get(update.id);
    if (position === undefined) {
      positions.set(update.id, result.length);
      result.push(update);
    } else {
      result[position] = update;
    }
  }
  return result;
}

function remove(items, ids) {
  if (ids.length === 0) return items;
  const doomed = new Set(ids);
  return items.filter((item) => !doomed.has(item.id));
}

export class LedgerChangeSet {
  constructor() {
    this.expensesToUpsert = [];
    this.expenseIDsToDelete = [];
    this.categoriesToUpsert = [];
    this.categoryIDsToDelete = [];
    this.subcategoriesToUpsert = [];
    this.subcategoryIDsToDelete = [];
    this.paymentMethodsToUpsert = [];
    this.paymentMethodIDsToDelete = [];
    this.tagsToUpsert = [];
    this.tagIDsToDelete = [];
    this.budgetsToUpsert = [];
    this.budgetIDsToDelete = [];
    this.templatesToUpsert = [];
    this.templateIDsToDelete = [];
    this.logEntriesToUpsert = [];
    this.logEntryIDsToDelete = [];
    this.settings = null;
  }

  get isEmpty() {
    return Object.keys(this).every((key) => (key === 'settings' ? this.settings === null : this[key].length === 0));
  }
}

export class LedgerSnapshot {
  constructor(parts = {}) {
    /** Newest first. */
    this.expenses = parts.expenses || [];
    this.categories = parts.categories || [];
    this.subcategories = parts.subcategories || [];
    this.paymentMethods = parts.paymentMethods || [];
    this.tags = parts.tags || [];
    this.budgets = parts.budgets || [];
    this.templates = parts.templates || [];
    this.recurrenceLog = parts.recurrenceLog || [];
    this.settings = parts.settings || defaultSettings();
    this._index = null;
  }

  clone() {
    return new LedgerSnapshot({
      expenses: this.expenses.slice(),
      categories: this.categories.slice(),
      subcategories: this.subcategories.slice(),
      paymentMethods: this.paymentMethods.slice(),
      tags: this.tags.slice(),
      budgets: this.budgets.slice(),
      templates: this.templates.slice(),
      recurrenceLog: this.recurrenceLog.slice(),
      settings: this.settings,
    });
  }

  /** Forget the lookup tables. Needed only if a list was replaced directly instead of through apply(). */
  invalidate() {
    this._index = null;
  }

  get index() {
    if (!this._index) {
      this._index = {
        expenses: byId(this.expenses),
        categories: byId(this.categories),
        subcategories: byId(this.subcategories),
        paymentMethods: byId(this.paymentMethods),
      };
    }
    return this._index;
  }

  // Lookups -----------------------------------------------------------

  category(id) { return this.index.categories.get(id) || null; }
  subcategory(id) { return this.index.subcategories.get(id) || null; }
  paymentMethod(id) { return this.index.paymentMethods.get(id) || null; }
  expense(id) { return this.index.expenses.get(id) || null; }

  subcategoriesOf(categoryID, includeArchived = false) {
    return this.subcategories.filter((s) => s.categoryID === categoryID && (includeArchived || !s.isArchived));
  }

  /** Categories shown in pickers (not archived), in the person's chosen order. */
  get activeCategories() { return this.categories.filter((c) => !c.isArchived); }
  get activePaymentMethods() { return this.paymentMethods.filter((p) => !p.isArchived); }

  // Changes -----------------------------------------------------------

  apply(changes) {
    if (changes.expenseIDsToDelete.length > 0 || changes.expensesToUpsert.length > 0) {
      const map = new Map();
      for (const expense of this.expenses) map.set(expense.id, expense);
      for (const id of changes.expenseIDsToDelete) map.delete(id);
      for (const expense of changes.expensesToUpsert) map.set(expense.id, expense);
      this.expenses = Array.from(map.values()).sort(compareNewestFirst);
    }
    this.categories = upsert(this.categories, changes.categoriesToUpsert);
    this.categories = remove(this.categories, changes.categoryIDsToDelete);
    this.subcategories = upsert(this.subcategories, changes.subcategoriesToUpsert);
    this.subcategories = remove(this.subcategories, changes.subcategoryIDsToDelete);
    this.paymentMethods = upsert(this.paymentMethods, changes.paymentMethodsToUpsert);
    this.paymentMethods = remove(this.paymentMethods, changes.paymentMethodIDsToDelete);
    this.tags = upsert(this.tags, changes.tagsToUpsert);
    this.tags = remove(this.tags, changes.tagIDsToDelete);
    this.budgets = upsert(this.budgets, changes.budgetsToUpsert);
    this.budgets = remove(this.budgets, changes.budgetIDsToDelete);
    this.templates = upsert(this.templates, changes.templatesToUpsert);
    this.templates = remove(this.templates, changes.templateIDsToDelete);
    this.recurrenceLog = upsert(this.recurrenceLog, changes.logEntriesToUpsert);
    this.recurrenceLog = remove(this.recurrenceLog, changes.logEntryIDsToDelete);

    if (changes.categoriesToUpsert.length > 0) this.categories.sort(byOrderThenName);
    if (changes.subcategoriesToUpsert.length > 0) this.subcategories.sort(byOrderThenName);
    if (changes.paymentMethodsToUpsert.length > 0) this.paymentMethods.sort(byOrderThenName);
    if (changes.settings) this.settings = changes.settings;
    this.invalidate();
  }

  /** Orders every list for a snapshot freshly loaded from the database or a backup. */
  normalizeOrder() {
    this.expenses.sort(compareNewestFirst);
    this.categories.sort(byOrderThenName);
    this.subcategories.sort(byOrderThenName);
    this.paymentMethods.sort(byOrderThenName);
    this.tags.sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    this.budgets.sort((a, b) => a.createdAt - b.createdAt);
    this.templates.sort((a, b) => a.createdAt - b.createdAt);
    this.recurrenceLog.sort((a, b) => a.dueDay.raw - b.dueDay.raw);
    this.invalidate();
    return this;
  }
}

/** A fresh ledger: the default categories, payment methods and settings. `makeId` can be replaced so tests get predictable ids. */
export function initialSnapshot(nowMs, firstWeekday, makeId = newId) {
  const snapshot = new LedgerSnapshot();
  DEFAULT_CATEGORIES.forEach((seed, position) => {
    snapshot.categories.push(makeCategory({
      id: makeId(), name: seed.name, iconSymbol: seed.icon, colorHex: seed.colorHex, sortOrder: position,
      isArchived: false, mergedIntoID: null, createdAt: nowMs, modifiedAt: nowMs,
    }));
  });
  DEFAULT_PAYMENT_METHODS.forEach((seed, position) => {
    snapshot.paymentMethods.push(makePaymentMethod({
      id: makeId(), name: seed.name, iconSymbol: seed.icon, sortOrder: position, isArchived: false,
      createdAt: nowMs, modifiedAt: nowMs,
    }));
  });
  snapshot.settings = Object.freeze({
    ...defaultSettings(),
    firstWeekday: Math.min(Math.max(firstWeekday, 1), 7),
    hasCompletedOnboarding: true,
  });
  snapshot.invalidate();
  return snapshot;
}

/**
 * Fast id-to-name lookups. If a record is ever missing, the name saved on the expense itself is used,
 * so history never shows a blank category.
 */
export class LedgerDirectory {
  constructor(snapshot) {
    this.categoriesByID = snapshot.index.categories;
    this.subcategoriesByID = snapshot.index.subcategories;
    this.paymentMethodsByID = snapshot.index.paymentMethods;
  }

  categoryName(expense) {
    const category = this.categoriesByID.get(expense.categoryID);
    return category ? category.name : expense.categoryNameSnapshot;
  }

  subcategoryName(expense) {
    if (!expense.subcategoryID) return null;
    const subcategory = this.subcategoriesByID.get(expense.subcategoryID);
    return subcategory ? subcategory.name : expense.subcategoryNameSnapshot;
  }

  paymentMethodName(expense) {
    if (!expense.paymentMethodID) return null;
    const method = this.paymentMethodsByID.get(expense.paymentMethodID);
    return method ? method.name : expense.paymentMethodNameSnapshot;
  }
}

/**
 * A store that keeps everything in memory. Used by the tests; the app's real store (data/store.js) has the same shape:
 * `snapshot` (what the screens read), `commit(changes)` (all-or-nothing), and nothing becomes visible in `snapshot`
 * unless the write succeeded. `stored` plays the part of the database, so a test can prove a change really reached it.
 */
export class MemoryStore {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.stored = snapshot.clone();
    this.writeCount = 0;
    this.failNextWrite = false;
  }

  async commit(changes) {
    if (changes.isEmpty) return;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('Simulated storage failure');
    }
    this.stored.apply(changes);
    this.snapshot.apply(changes);
    this.writeCount += 1;
  }

  /** Replaces everything in one all-or-nothing step (restoring a backup, erasing everything). */
  async replaceAll(snapshot) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('Simulated storage failure');
    }
    this.stored = snapshot.clone();
    this.snapshot = snapshot.clone();
    this.writeCount += 1;
  }
}
