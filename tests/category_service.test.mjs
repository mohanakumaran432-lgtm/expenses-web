import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger, rejectsWithCode } from './support.mjs';
import { CategoryService } from '../docs/js/core/catalog_service.js';
import { LedgerChangeSet } from '../docs/js/core/snapshot.js';
import { makeBudget, makeExpense, makeTemplate } from '../docs/js/core/models.js';
import { MAX_NAME_LENGTH } from '../docs/js/core/text.js';

let sample;
let store;
let service;

beforeEach(() => {
  sample = new SampleLedger();
  store = Fx.store(sample.snapshot);
  service = new CategoryService(store, () => Fx.now);
});

const fullReport = () => Fx.report(store.snapshot, SampleLedger.fullRange);

function totalsByName(report) {
  const result = {};
  for (const row of report.categories) result[row.name] = row.total.minorUnits;
  return result;
}

const budgetOn = (categoryID) => makeBudget({
  id: Fx.uuid(6001), name: 'Budget', categoryID, periodKind: 'monthly', customStart: null, customEnd: null,
  amount: Fx.money('1000'), alertThresholds: [80, 100], notificationsEnabled: false, isActive: true,
  createdAt: Fx.now, modifiedAt: Fx.now,
});

async function commit(build) {
  const changes = new LedgerChangeSet();
  build(changes);
  await store.commit(changes);
}

// Adding and naming ------------------------------------------------------------------------------

test('adding a category cleans the name and appends it', async () => {
  const highest = Math.max(...store.snapshot.categories.map((c) => c.sortOrder), -1);
  const pets = await service.addCategory('  Pets   &  Vet ', 'pawprint', '#112233');
  assert.equal(pets.name, 'Pets & Vet');
  assert.equal(pets.sortOrder, highest + 1);
  assert.equal(pets.isArchived, false);
  assert.equal(pets.mergedIntoID, null);
  assert.deepEqual(store.snapshot.activeCategories.at(-1), pets);
  assert.equal(store.snapshot.categories.length, 24);
});

test('names must be unique ignoring case, accents and spacing', async () => {
  await rejectsWithCode(service.addCategory('groceries', 'x', '#000000'), 'nameInUse');
  await rejectsWithCode(service.addCategory('  GROCERIES  ', 'x', '#000000'), 'nameInUse');
  await service.addCategory('Café', 'x', '#000000');
  await rejectsWithCode(service.addCategory('cafe', 'x', '#000000'), 'nameInUse');
  assert.equal(store.snapshot.categories.length, 24);
});

test('blank and overlong names are rejected', async () => {
  await rejectsWithCode(service.addCategory('  \n ', 'x', '#000000'), 'nameRequired');
  await rejectsWithCode(service.addCategory('a'.repeat(MAX_NAME_LENGTH + 1), 'x', '#000000'), 'nameTooLong');
  await service.addCategory('b'.repeat(MAX_NAME_LENGTH), 'x', '#000000');
});

test('renaming keeps history and reports follow the new name', async () => {
  assert.equal(totalsByName(fullReport()).Groceries, 9_250);
  await service.updateCategory(sample.groceries.id, 'Supermarket', 'cart', '#00FF00');

  const totals = totalsByName(fullReport());
  assert.equal(totals.Groceries, undefined);
  assert.equal(totals.Supermarket, 9_250);
  assert.equal(store.snapshot.expenses.filter((e) => e.categoryID === sample.groceries.id).length, 3);
  assert.equal(store.snapshot.category(sample.groceries.id).colorHex, '#00FF00');
});

test('rename rules', async () => {
  await rejectsWithCode(service.updateCategory(sample.groceries.id, 'transport', 'cart', '#000000'), 'nameInUse');
  await service.updateCategory(sample.groceries.id, 'GROCERIES', 'cart', '#000000');
  assert.equal(store.snapshot.category(sample.groceries.id).name, 'GROCERIES', 'Changing only the case is allowed');

  await rejectsWithCode(service.updateCategory(Fx.uuid(9999), 'X', 'x', '#000000'), 'notFound');
  await rejectsWithCode(service.updateCategory(sample.groceries.id, ' ', 'x', '#000000'), 'nameRequired');
  assert.equal(store.snapshot.category(sample.groceries.id).name, 'GROCERIES', 'A rejected rename changes nothing');
});

// Archiving and ordering -------------------------------------------------------------------------

test('archiving hides a category from pickers but keeps its history', async () => {
  await service.setCategoryArchived(true, sample.fuel.id);
  assert.equal(store.snapshot.activeCategories.some((c) => c.id === sample.fuel.id), false);
  assert.ok(store.snapshot.category(sample.fuel.id));

  const report = fullReport();
  assert.equal(totalsByName(report).Fuel, 20_000, 'Archived categories stay in reports');
  assert.equal(report.total.minorUnits, SampleLedger.grandTotalMinor);
  assert.equal(report.categories.find((r) => r.categoryID === sample.fuel.id).isArchived, true);

  const writes = store.writeCount;
  await service.setCategoryArchived(true, sample.fuel.id);
  assert.equal(store.writeCount, writes, 'Archiving twice changes nothing');

  await service.setCategoryArchived(false, sample.fuel.id);
  assert.equal(store.snapshot.activeCategories.some((c) => c.id === sample.fuel.id), true);
  await rejectsWithCode(service.setCategoryArchived(true, Fx.uuid(9999)), 'notFound');
});

test('the last active category cannot be archived', async () => {
  for (const category of store.snapshot.activeCategories.slice(0, -1)) {
    await service.setCategoryArchived(true, category.id);
  }
  assert.equal(store.snapshot.activeCategories.length, 1);
  const last = store.snapshot.activeCategories[0];
  await rejectsWithCode(service.setCategoryArchived(true, last.id), 'lastActiveCategory');
  assert.equal(store.snapshot.activeCategories.length, 1, 'A refused archive changes nothing');
});

test('reordering stores the chosen order and keeps the rest', async () => {
  const originalOrder = store.snapshot.categories.map((c) => c.id);
  const wanted = [sample.transport.id, sample.groceries.id];
  // A repeated id and an unknown id are ignored.
  await service.reorderCategories([...wanted, sample.transport.id, Fx.uuid(9999)]);

  const order = store.snapshot.categories.map((c) => c.id);
  assert.deepEqual(order.slice(0, 2), wanted);
  assert.deepEqual(order.slice(2), originalOrder.filter((id) => !wanted.includes(id)), 'Everything else keeps its relative order');
  assert.deepEqual(store.snapshot.categories.map((c) => c.sortOrder), Array.from({ length: 23 }, (_, i) => i));
});

// Deleting ---------------------------------------------------------------------------------------

test('only unused categories can be deleted', async () => {
  const pets = await service.addCategory('Pets', 'pawprint', '#112233');
  assert.equal(service.usageOfCategory(pets.id).isUnused, true);
  await service.deleteUnusedCategory(pets.id);
  assert.equal(store.snapshot.category(pets.id), null);
  await rejectsWithCode(service.deleteUnusedCategory(pets.id), 'notFound');

  const usage = service.usageOfCategory(sample.groceries.id);
  assert.equal(usage.expenseCount, 3);
  assert.equal(usage.subcategoryCount, 1);
  await rejectsWithCode(service.deleteUnusedCategory(sample.groceries.id), 'inUse');
  assert.equal(store.snapshot.expenses.length, 8);
});

test('budgets and recurring templates also protect a category', async () => {
  const education = Fx.category('Education', store.snapshot);
  const insurance = Fx.category('Insurance', store.snapshot);
  await commit((changes) => {
    changes.budgetsToUpsert = [budgetOn(education.id)];
    changes.templatesToUpsert = [Fx.template({ categoryID: insurance.id, from: Fx.today })];
  });

  assert.equal(service.usageOfCategory(education.id).budgetCount, 1);
  assert.equal(service.usageOfCategory(insurance.id).templateCount, 1);
  await rejectsWithCode(service.deleteUnusedCategory(education.id), 'inUse');
  await rejectsWithCode(service.deleteUnusedCategory(insurance.id), 'inUse');
});

test('a category that others were merged into cannot be deleted', async () => {
  const pets = await service.addCategory('Pets', 'pawprint', '#112233');
  const dogs = await service.addCategory('Dogs', 'pawprint', '#445566');
  await service.mergeCategory(dogs.id, pets.id);

  // Neither has expenses, but Dogs still remembers that it went into Pets.
  await rejectsWithCode(service.deleteUnusedCategory(pets.id), 'inUse');
  await service.deleteUnusedCategory(dogs.id);
  await service.deleteUnusedCategory(pets.id);
  assert.equal(store.snapshot.category(pets.id), null);
  assert.equal(store.snapshot.category(dogs.id), null);
});

// Merging ----------------------------------------------------------------------------------------

test('merging moves everything without changing totals', async () => {
  const coffeeMilk = await service.addSubcategory(sample.coffee.id, 'milk');
  const pastry = await service.addSubcategory(sample.coffee.id, 'Pastry');
  const edited = makeExpense({ ...sample.e[3], subcategoryID: coffeeMilk.id, subcategoryNameSnapshot: coffeeMilk.name });
  await commit((changes) => {
    changes.expensesToUpsert = [edited];
    changes.budgetsToUpsert = [budgetOn(sample.coffee.id)];
    changes.templatesToUpsert = [Fx.template({ categoryID: sample.coffee.id, from: Fx.today })];
  });
  assert.equal(fullReport().total.minorUnits, SampleLedger.grandTotalMinor);

  const summary = await service.mergeCategory(sample.coffee.id, sample.groceries.id);
  assert.deepEqual(summary, { expensesMoved: 1, subcategoriesMoved: 2, budgetsMoved: 1, templatesMoved: 1 });

  const snapshot = store.snapshot;
  const source = snapshot.category(sample.coffee.id);
  assert.equal(source.isArchived, true);
  assert.equal(source.mergedIntoID, sample.groceries.id);

  const moved = snapshot.expense(edited.id);
  assert.equal(moved.categoryID, sample.groceries.id);
  assert.equal(moved.categoryNameSnapshot, 'Groceries');
  assert.equal(moved.subcategoryID, sample.milk.id, 'The same-named subcategory absorbed it');
  assert.equal(moved.subcategoryNameSnapshot, 'Milk');
  assert.equal(moved.amount.minorUnits, 1_800);

  const absorbed = snapshot.subcategory(coffeeMilk.id);
  assert.equal(absorbed.isArchived, true);
  assert.equal(absorbed.mergedIntoID, sample.milk.id);
  assert.equal(snapshot.subcategory(pastry.id).categoryID, sample.groceries.id);
  assert.equal(snapshot.budgets[0].categoryID, sample.groceries.id);
  assert.equal(snapshot.templates[0].categoryID, sample.groceries.id);

  const report = fullReport();
  assert.equal(report.total.minorUnits, SampleLedger.grandTotalMinor, 'Merging never changes the grand total');
  assert.equal(totalsByName(report).Groceries, 11_050);
  assert.equal(totalsByName(report)['Coffee & Snacks'], undefined);
  assert.equal(report.categories.reduce((sum, row) => sum + row.total.minorUnits, 0), report.total.minorUnits);
  const milkRow = report.subcategories.find((row) => row.subcategoryID === sample.milk.id);
  assert.equal(milkRow.total.minorUnits, 6_800);
  assert.equal(milkRow.count, 2);
});

test('earlier merges follow the latest target', async () => {
  const food = Fx.category('Food & Dining', store.snapshot);
  await service.mergeCategory(sample.coffee.id, sample.groceries.id);
  await service.mergeCategory(sample.groceries.id, food.id);

  assert.equal(store.snapshot.category(sample.coffee.id).mergedIntoID, food.id);
  assert.equal(store.snapshot.category(sample.groceries.id).mergedIntoID, food.id);
  assert.equal(store.snapshot.expenses.filter((e) => e.categoryID === food.id).length, 4);
  const report = fullReport();
  assert.equal(totalsByName(report)['Food & Dining'], 11_050);
  assert.equal(report.total.minorUnits, SampleLedger.grandTotalMinor);
});

test('merge rules', async () => {
  await rejectsWithCode(service.mergeCategory(sample.fuel.id, sample.fuel.id), 'cannotMergeIntoSelf');
  await rejectsWithCode(service.mergeCategory(Fx.uuid(9999), sample.fuel.id), 'notFound');
  await rejectsWithCode(service.mergeCategory(sample.fuel.id, Fx.uuid(9999)), 'notFound');
  await service.mergeCategory(sample.coffee.id, sample.groceries.id);
  await rejectsWithCode(service.mergeCategory(sample.fuel.id, sample.coffee.id), 'targetWasMerged');
});

test('a merge is permanent', async () => {
  await service.mergeCategory(sample.coffee.id, sample.groceries.id);
  await rejectsWithCode(service.setCategoryArchived(false, sample.coffee.id), 'alreadyMerged');
  await rejectsWithCode(service.mergeCategory(sample.coffee.id, sample.fuel.id), 'alreadyMerged');
  assert.equal(store.snapshot.category(sample.coffee.id).mergedIntoID, sample.groceries.id);
  assert.equal(store.snapshot.category(sample.coffee.id).isArchived, true);
});

test('nothing can be merged into an archived category', async () => {
  await service.setCategoryArchived(true, sample.fuel.id);
  await rejectsWithCode(service.mergeCategory(sample.coffee.id, sample.fuel.id), 'targetArchived');
  assert.equal(store.snapshot.expenses.some((e) => e.categoryID === sample.coffee.id), true, 'A refused merge moves nothing');
});

test('the name of a merged category can be used again', async () => {
  await service.mergeCategory(sample.coffee.id, sample.groceries.id);
  const again = await service.addCategory('Coffee & Snacks', 'cup.and.saucer', '#A2845E');
  assert.notEqual(again.id, sample.coffee.id);
  assert.equal(store.snapshot.expenses.filter((e) => e.categoryID === again.id).length, 0);
});

test('a failed merge changes nothing', async () => {
  const before = store.snapshot;
  const expensesBefore = [...before.expenses];
  const categoriesBefore = [...before.categories];
  store.failNextWrite = true;
  await assert.rejects(service.mergeCategory(sample.coffee.id, sample.groceries.id));
  assert.deepEqual(store.snapshot.expenses, expensesBefore);
  assert.deepEqual(store.snapshot.categories, categoriesBefore);
  assert.deepEqual(store.stored.expenses, expensesBefore);
  assert.deepEqual(store.stored.categories, categoriesBefore);
});

void makeTemplate;
