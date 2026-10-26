// Add, rename, reorder, archive and merge categories, subcategories, payment methods and tags.
//
// The golden rule: history is never lost. A category is never deleted while anything refers to it;
// archiving only hides it from pickers, and merging re-points everything in one all-or-nothing step.

import { AppError, characterCount, newId } from './util.js';
import { LedgerChangeSet } from './snapshot.js';
import { MAX_NAME_LENGTH, comparisonKey, line, tag as normalizeTag, tags as normalizeTags } from './text.js';
import {
  makeBudget, makeCategory, makeExpense, makePaymentMethod, makeSubcategory, makeTag, makeTemplate,
} from './models.js';

export const CATALOG_MESSAGES = Object.freeze({
  nameRequired: 'Enter a name.',
  nameTooLong: 'That name is too long.',
  nameInUse: 'You already have one with that name.',
  notFound: 'That item no longer exists.',
  cannotMergeIntoSelf: 'Choose a different item to merge into.',
  targetWasMerged: 'That item was already merged into another one. Choose the one it was merged into.',
  differentParent: 'Subcategories can only be merged within the same category.',
  inUse: 'It is still used by expenses, budgets or recurring expenses, so it can be archived but not deleted.',
  lastActiveCategory: 'Keep at least one category in use, so there is always somewhere to put a new expense.',
  targetArchived: 'Choose one that is not archived.',
  alreadyMerged: 'This was merged into another one earlier. A merge is permanent, so it cannot be brought back.',
});

function fail(code) {
  return new AppError('catalog', code, CATALOG_MESSAGES[code] || 'That did not work.');
}

function cleanName(raw) {
  const name = line(raw);
  if (name === '') throw fail('nameRequired');
  if (characterCount(name) > MAX_NAME_LENGTH) throw fail('nameTooLong');
  return name;
}

export class CategoryService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
  }

  categoryNameTaken(name, excludingID, snapshot) {
    const key = comparisonKey(name);
    return snapshot.categories.some((c) => c.id !== excludingID && !c.mergedIntoID && comparisonKey(c.name) === key);
  }

  subcategoryNameTaken(name, categoryID, excludingID, snapshot) {
    const key = comparisonKey(name);
    return snapshot.subcategories.some(
      (s) => s.categoryID === categoryID && s.id !== excludingID && !s.mergedIntoID && comparisonKey(s.name) === key,
    );
  }

  // Categories ---------------------------------------------------------

  async addCategory(rawName, iconSymbol, colorHex) {
    const snapshot = this.store.snapshot;
    const name = cleanName(rawName);
    if (this.categoryNameTaken(name, null, snapshot)) throw fail('nameInUse');
    const now = this.clock();
    const nextOrder = snapshot.categories.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;
    const category = makeCategory({
      id: newId(), name, iconSymbol, colorHex, sortOrder: nextOrder, isArchived: false, mergedIntoID: null,
      createdAt: now, modifiedAt: now,
    });
    const changes = new LedgerChangeSet();
    changes.categoriesToUpsert = [category];
    await this.store.commit(changes);
    return category;
  }

  /** Renames and/or restyles a category. Expenses keep pointing at the same id, so history and reports follow the new name. */
  async updateCategory(id, rawName, iconSymbol, colorHex) {
    const snapshot = this.store.snapshot;
    const category = snapshot.category(id);
    if (!category) throw fail('notFound');
    const name = cleanName(rawName);
    if (this.categoryNameTaken(name, id, snapshot)) throw fail('nameInUse');
    const changes = new LedgerChangeSet();
    changes.categoriesToUpsert = [makeCategory({ ...category, name, iconSymbol, colorHex, modifiedAt: this.clock() })];
    await this.store.commit(changes);
  }

  async setCategoryArchived(archived, id) {
    const snapshot = this.store.snapshot;
    const category = snapshot.category(id);
    if (!category) throw fail('notFound');
    if (category.isArchived === archived) return;
    if (archived) {
      if (snapshot.activeCategories.length <= 1) throw fail('lastActiveCategory');
    } else if (category.mergedIntoID) {
      throw fail('alreadyMerged');
    }
    const changes = new LedgerChangeSet();
    changes.categoriesToUpsert = [makeCategory({ ...category, isArchived: archived, modifiedAt: this.clock() })];
    await this.store.commit(changes);
  }

  /** Stores the order the person chose. Categories not listed keep their relative order after the listed ones. */
  async reorderCategories(orderedIDs) {
    const snapshot = this.store.snapshot;
    const now = this.clock();
    const changes = new LedgerChangeSet();
    let position = 0;
    const seen = new Set();
    for (const id of orderedIDs) {
      const category = snapshot.category(id);
      if (!category || seen.has(id)) continue;
      seen.add(id);
      if (category.sortOrder !== position) {
        changes.categoriesToUpsert.push(makeCategory({ ...category, sortOrder: position, modifiedAt: now }));
      }
      position += 1;
    }
    for (const category of snapshot.categories) {
      if (seen.has(category.id)) continue;
      if (category.sortOrder !== position) changes.categoriesToUpsert.push(makeCategory({ ...category, sortOrder: position }));
      position += 1;
    }
    await this.store.commit(changes);
  }

  usageOfCategory(id) {
    const snapshot = this.store.snapshot;
    const usage = {
      expenseCount: snapshot.expenses.filter((e) => e.categoryID === id).length,
      budgetCount: snapshot.budgets.filter((b) => b.categoryID === id).length,
      templateCount: snapshot.templates.filter((t) => t.categoryID === id).length,
      subcategoryCount: snapshot.subcategories.filter((s) => s.categoryID === id).length,
    };
    usage.isUnused = usage.expenseCount === 0 && usage.budgetCount === 0 && usage.templateCount === 0;
    return usage;
  }

  /** Deletes a category nobody uses (for example one created by mistake). Anything used must be archived or merged. */
  async deleteUnusedCategory(id) {
    const snapshot = this.store.snapshot;
    if (!snapshot.category(id)) throw fail('notFound');
    if (!this.usageOfCategory(id).isUnused) throw fail('inUse');
    if (snapshot.categories.some((c) => c.mergedIntoID === id)) throw fail('inUse');
    const changes = new LedgerChangeSet();
    changes.categoryIDsToDelete = [id];
    changes.subcategoryIDsToDelete = snapshot.subcategories.filter((s) => s.categoryID === id).map((s) => s.id);
    await this.store.commit(changes);
  }

  /**
   * Moves everything from `sourceID` into `targetID` and archives the source (it stays on record as merged).
   * Subcategories move across; a source subcategory with the same name as one in the target is merged into it.
   * Expenses, budgets and recurring templates are re-pointed. Nothing is deleted. All or nothing.
   */
  async mergeCategory(sourceID, targetID) {
    const snapshot = this.store.snapshot;
    if (sourceID === targetID) throw fail('cannotMergeIntoSelf');
    const source = snapshot.category(sourceID);
    const target = snapshot.category(targetID);
    if (!source || !target) throw fail('notFound');
    if (target.mergedIntoID) throw fail('targetWasMerged');
    if (target.isArchived) throw fail('targetArchived');
    if (source.mergedIntoID) throw fail('alreadyMerged');

    const now = this.clock();
    const summary = { expensesMoved: 0, subcategoriesMoved: 0, budgetsMoved: 0, templatesMoved: 0 };
    const changes = new LedgerChangeSet();

    // 1. Subcategories: merge same-named ones, move the rest under the target.
    const targetSubs = snapshot.subcategoriesOf(targetID, true).filter((s) => !s.mergedIntoID);
    const mapped = new Map();
    for (const sub of snapshot.subcategoriesOf(sourceID, true)) {
      const key = comparisonKey(sub.name);
      const same = targetSubs.find((t) => comparisonKey(t.name) === key);
      let updated;
      if (same) {
        mapped.set(sub.id, same);
        updated = makeSubcategory({ ...sub, isArchived: true, mergedIntoID: same.id, modifiedAt: now });
      } else {
        updated = makeSubcategory({ ...sub, categoryID: targetID, modifiedAt: now });
        mapped.set(sub.id, updated);
      }
      changes.subcategoriesToUpsert.push(updated);
      summary.subcategoriesMoved += 1;
    }

    // 2. Expenses.
    for (const expense of snapshot.expenses) {
      if (expense.categoryID !== sourceID) continue;
      const newSub = expense.subcategoryID ? mapped.get(expense.subcategoryID) : undefined;
      changes.expensesToUpsert.push(makeExpense({
        ...expense,
        categoryID: targetID,
        categoryNameSnapshot: target.name,
        subcategoryID: newSub ? newSub.id : expense.subcategoryID,
        subcategoryNameSnapshot: newSub ? newSub.name : expense.subcategoryNameSnapshot,
        modifiedAt: now,
      }));
      summary.expensesMoved += 1;
    }

    // 3. Budgets and recurring templates.
    for (const budget of snapshot.budgets) {
      if (budget.categoryID !== sourceID) continue;
      changes.budgetsToUpsert.push(makeBudget({ ...budget, categoryID: targetID, modifiedAt: now }));
      summary.budgetsMoved += 1;
    }
    for (const template of snapshot.templates) {
      if (template.categoryID !== sourceID) continue;
      const newSub = template.subcategoryID ? mapped.get(template.subcategoryID) : undefined;
      changes.templatesToUpsert.push(makeTemplate({
        ...template, categoryID: targetID, subcategoryID: newSub ? newSub.id : template.subcategoryID, modifiedAt: now,
      }));
      summary.templatesMoved += 1;
    }

    // 4. Categories that were merged into the source earlier now point straight at the target.
    for (const earlier of snapshot.categories) {
      if (earlier.mergedIntoID !== sourceID) continue;
      changes.categoriesToUpsert.push(makeCategory({ ...earlier, mergedIntoID: targetID, modifiedAt: now }));
    }

    // 5. Archive the source, remembering where it went.
    changes.categoriesToUpsert.push(makeCategory({ ...source, isArchived: true, mergedIntoID: targetID, modifiedAt: now }));

    await this.store.commit(changes);
    return summary;
  }

  // Subcategories ------------------------------------------------------

  async addSubcategory(categoryID, rawName) {
    const snapshot = this.store.snapshot;
    if (!snapshot.category(categoryID)) throw fail('notFound');
    const name = cleanName(rawName);
    if (this.subcategoryNameTaken(name, categoryID, null, snapshot)) throw fail('nameInUse');
    const now = this.clock();
    const nextOrder = snapshot.subcategoriesOf(categoryID, true).reduce((max, s) => Math.max(max, s.sortOrder), -1) + 1;
    const sub = makeSubcategory({
      id: newId(), categoryID, name, sortOrder: nextOrder, isArchived: false, mergedIntoID: null, createdAt: now, modifiedAt: now,
    });
    const changes = new LedgerChangeSet();
    changes.subcategoriesToUpsert = [sub];
    await this.store.commit(changes);
    return sub;
  }

  async renameSubcategory(id, rawName) {
    const snapshot = this.store.snapshot;
    const sub = snapshot.subcategory(id);
    if (!sub) throw fail('notFound');
    const name = cleanName(rawName);
    if (this.subcategoryNameTaken(name, sub.categoryID, id, snapshot)) throw fail('nameInUse');
    const changes = new LedgerChangeSet();
    changes.subcategoriesToUpsert = [makeSubcategory({ ...sub, name, modifiedAt: this.clock() })];
    await this.store.commit(changes);
  }

  async setSubcategoryArchived(archived, id) {
    const sub = this.store.snapshot.subcategory(id);
    if (!sub) throw fail('notFound');
    if (sub.isArchived === archived) return;
    if (!archived && sub.mergedIntoID) throw fail('alreadyMerged');
    const changes = new LedgerChangeSet();
    changes.subcategoriesToUpsert = [makeSubcategory({ ...sub, isArchived: archived, modifiedAt: this.clock() })];
    await this.store.commit(changes);
  }

  async reorderSubcategories(categoryID, orderedIDs) {
    const snapshot = this.store.snapshot;
    const now = this.clock();
    const changes = new LedgerChangeSet();
    let position = 0;
    for (const id of orderedIDs) {
      const sub = snapshot.subcategory(id);
      if (!sub || sub.categoryID !== categoryID) continue;
      if (sub.sortOrder !== position) {
        changes.subcategoriesToUpsert.push(makeSubcategory({ ...sub, sortOrder: position, modifiedAt: now }));
      }
      position += 1;
    }
    await this.store.commit(changes);
  }

  async deleteUnusedSubcategory(id) {
    const snapshot = this.store.snapshot;
    if (!snapshot.subcategory(id)) throw fail('notFound');
    const used = snapshot.expenses.some((e) => e.subcategoryID === id)
      || snapshot.templates.some((t) => t.subcategoryID === id)
      || snapshot.subcategories.some((s) => s.mergedIntoID === id);
    if (used) throw fail('inUse');
    const changes = new LedgerChangeSet();
    changes.subcategoryIDsToDelete = [id];
    await this.store.commit(changes);
  }

  /** Merges one subcategory into another subcategory of the same category. */
  async mergeSubcategory(sourceID, targetID) {
    const snapshot = this.store.snapshot;
    if (sourceID === targetID) throw fail('cannotMergeIntoSelf');
    const source = snapshot.subcategory(sourceID);
    const target = snapshot.subcategory(targetID);
    if (!source || !target) throw fail('notFound');
    if (source.categoryID !== target.categoryID) throw fail('differentParent');
    if (target.mergedIntoID) throw fail('targetWasMerged');
    if (target.isArchived) throw fail('targetArchived');
    if (source.mergedIntoID) throw fail('alreadyMerged');

    const now = this.clock();
    const summary = { expensesMoved: 0, subcategoriesMoved: 0, budgetsMoved: 0, templatesMoved: 0 };
    const changes = new LedgerChangeSet();
    for (const expense of snapshot.expenses) {
      if (expense.subcategoryID !== sourceID) continue;
      changes.expensesToUpsert.push(makeExpense({
        ...expense, subcategoryID: targetID, subcategoryNameSnapshot: target.name, modifiedAt: now,
      }));
      summary.expensesMoved += 1;
    }
    for (const template of snapshot.templates) {
      if (template.subcategoryID !== sourceID) continue;
      changes.templatesToUpsert.push(makeTemplate({ ...template, subcategoryID: targetID, modifiedAt: now }));
      summary.templatesMoved += 1;
    }
    changes.subcategoriesToUpsert.push(makeSubcategory({ ...source, isArchived: true, mergedIntoID: targetID, modifiedAt: now }));
    await this.store.commit(changes);
    return summary;
  }
}

/** Add, rename, reorder, archive payment methods. Same history-preserving rules as categories. */
export class PaymentMethodService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
  }

  nameTaken(name, excludingID, snapshot) {
    const key = comparisonKey(name);
    return snapshot.paymentMethods.some((p) => p.id !== excludingID && comparisonKey(p.name) === key);
  }

  async add(rawName, iconSymbol) {
    const snapshot = this.store.snapshot;
    const name = cleanName(rawName);
    if (this.nameTaken(name, null, snapshot)) throw fail('nameInUse');
    const now = this.clock();
    const nextOrder = snapshot.paymentMethods.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1;
    const method = makePaymentMethod({
      id: newId(), name, iconSymbol, sortOrder: nextOrder, isArchived: false, createdAt: now, modifiedAt: now,
    });
    const changes = new LedgerChangeSet();
    changes.paymentMethodsToUpsert = [method];
    await this.store.commit(changes);
    return method;
  }

  async update(id, rawName, iconSymbol) {
    const snapshot = this.store.snapshot;
    const method = snapshot.paymentMethod(id);
    if (!method) throw fail('notFound');
    const name = cleanName(rawName);
    if (this.nameTaken(name, id, snapshot)) throw fail('nameInUse');
    const changes = new LedgerChangeSet();
    changes.paymentMethodsToUpsert = [makePaymentMethod({ ...method, name, iconSymbol, modifiedAt: this.clock() })];
    await this.store.commit(changes);
  }

  async setArchived(archived, id) {
    const method = this.store.snapshot.paymentMethod(id);
    if (!method) throw fail('notFound');
    if (method.isArchived === archived) return;
    const changes = new LedgerChangeSet();
    changes.paymentMethodsToUpsert = [makePaymentMethod({ ...method, isArchived: archived, modifiedAt: this.clock() })];
    await this.store.commit(changes);
  }

  async reorder(orderedIDs) {
    const snapshot = this.store.snapshot;
    const now = this.clock();
    const changes = new LedgerChangeSet();
    let position = 0;
    for (const id of orderedIDs) {
      const method = snapshot.paymentMethod(id);
      if (!method) continue;
      if (method.sortOrder !== position) {
        changes.paymentMethodsToUpsert.push(makePaymentMethod({ ...method, sortOrder: position, modifiedAt: now }));
      }
      position += 1;
    }
    await this.store.commit(changes);
  }

  usageCount(id) {
    const snapshot = this.store.snapshot;
    return snapshot.expenses.filter((e) => e.paymentMethodID === id).length
      + snapshot.templates.filter((t) => t.paymentMethodID === id).length;
  }

  /** Deletes a payment method nothing refers to. Used ones can only be archived. */
  async deleteUnused(id) {
    const snapshot = this.store.snapshot;
    if (!snapshot.paymentMethod(id)) throw fail('notFound');
    if (this.usageCount(id) > 0) throw fail('inUse');
    const changes = new LedgerChangeSet();
    changes.paymentMethodIDsToDelete = [id];
    if (snapshot.settings.defaultPaymentMethodID === id) {
      changes.settings = Object.freeze({ ...snapshot.settings, defaultPaymentMethodID: null });
    }
    await this.store.commit(changes);
  }
}

/** Rename or remove tags everywhere at once. */
export class TagService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
  }

  usageCount(tagName) {
    const key = tagName.toLowerCase();
    return this.store.snapshot.expenses.filter((e) => e.tags.some((t) => t.toLowerCase() === key)).length;
  }

  /**
   * Renames a tag on every expense. If the new name already exists, the two tags become one and keep the existing
   * spelling. Changing only the capitalisation (work -> Work) adopts the new spelling.
   */
  async rename(oldName, rawNewName) {
    const typedName = normalizeTag(rawNewName);
    if (typedName === null) throw fail('nameRequired');
    const snapshot = this.store.snapshot;
    const oldKey = oldName.toLowerCase();
    const newKey = typedName.toLowerCase();
    const now = this.clock();
    const existing = snapshot.tags.find((t) => t.name.toLowerCase() === newKey) || null;
    const newName = (oldKey !== newKey && existing ? existing.name : null) || typedName;
    const changes = new LedgerChangeSet();

    for (const expense of snapshot.expenses) {
      if (!expense.tags.some((t) => t.toLowerCase() === oldKey)) continue;
      const replaced = expense.tags.map((t) => (t.toLowerCase() === oldKey ? newName : t));
      const updated = normalizeTags(replaced);
      if (updated.length === expense.tags.length && updated.every((t, i) => t === expense.tags[i])) continue;
      changes.expensesToUpsert.push(makeExpense({ ...expense, tags: updated, modifiedAt: now }));
    }

    if (oldKey !== newKey) {
      for (const record of snapshot.tags) {
        if (record.name.toLowerCase() === oldKey) changes.tagIDsToDelete.push(record.id);
      }
    }
    if (existing) {
      if (oldKey === newKey && existing.name !== newName) {
        changes.tagsToUpsert.push(makeTag({ ...existing, name: newName }));
      }
    } else {
      changes.tagsToUpsert.push(makeTag({ id: newId(), name: newName, createdAt: now }));
    }
    await this.store.commit(changes);
  }

  /** Removes a tag from every expense and from the suggestion list. The expenses themselves stay. */
  async delete(name) {
    const snapshot = this.store.snapshot;
    const key = name.toLowerCase();
    const now = this.clock();
    const changes = new LedgerChangeSet();
    for (const expense of snapshot.expenses) {
      if (!expense.tags.some((t) => t.toLowerCase() === key)) continue;
      changes.expensesToUpsert.push(makeExpense({
        ...expense, tags: expense.tags.filter((t) => t.toLowerCase() !== key), modifiedAt: now,
      }));
    }
    for (const record of snapshot.tags) {
      if (record.name.toLowerCase() === key) changes.tagIDsToDelete.push(record.id);
    }
    await this.store.commit(changes);
  }
}
