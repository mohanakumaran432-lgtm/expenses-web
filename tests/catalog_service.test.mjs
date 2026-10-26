import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Fx, SampleLedger, rejectsWithCode } from './support.mjs';
import { CategoryService, PaymentMethodService, TagService } from '../docs/js/core/catalog_service.js';
import { LedgerChangeSet } from '../docs/js/core/snapshot.js';
import { makeExpense, makeTag, makeTemplate } from '../docs/js/core/models.js';
import { MAX_NAME_LENGTH } from '../docs/js/core/text.js';

let sample;
let store;
let categories;
let methods;
let tags;

beforeEach(() => {
  sample = new SampleLedger();
  store = Fx.store(sample.snapshot);
  categories = new CategoryService(store, () => Fx.now);
  methods = new PaymentMethodService(store, () => Fx.now);
  tags = new TagService(store, () => Fx.now + 1_000);
});

const fullReport = () => Fx.report(store.snapshot, SampleLedger.fullRange);
const subcategoryNames = (categoryID, includeArchived = false) => store.snapshot
  .subcategoriesOf(categoryID, includeArchived).map((s) => s.name);

async function commit(build) {
  const changes = new LedgerChangeSet();
  build(changes);
  await store.commit(changes);
}

// Subcategories ----------------------------------------------------------------------------------

test('subcategories are appended and unique within their category', async () => {
  const dairy = await categories.addSubcategory(sample.groceries.id, '  Dairy ');
  const bakery = await categories.addSubcategory(sample.groceries.id, 'Bakery');
  assert.equal(dairy.name, 'Dairy');
  assert.equal(dairy.sortOrder, 1, 'Milk already has position 0');
  assert.equal(bakery.sortOrder, 2);

  await rejectsWithCode(categories.addSubcategory(sample.groceries.id, 'MILK'), 'nameInUse');
  await rejectsWithCode(categories.addSubcategory(sample.groceries.id, ' '), 'nameRequired');
  await rejectsWithCode(categories.addSubcategory(Fx.uuid(9999), 'X'), 'notFound');
  await categories.addSubcategory(sample.coffee.id, 'Milk'); // The same name under another category is fine
});

test('renaming a subcategory keeps history and reports follow it', async () => {
  const dairy = await categories.addSubcategory(sample.groceries.id, 'Dairy');
  await categories.renameSubcategory(sample.milk.id, 'Fresh milk');
  assert.equal(store.snapshot.subcategory(sample.milk.id).name, 'Fresh milk');
  assert.equal(store.snapshot.expense(sample.e[0].id).subcategoryID, sample.milk.id);
  const row = fullReport().subcategories.find((r) => r.subcategoryID === sample.milk.id);
  assert.equal(row.name, 'Fresh milk');
  assert.equal(row.total.minorUnits, 5_000);

  await rejectsWithCode(categories.renameSubcategory(dairy.id, 'fresh  MILK'), 'nameInUse');
  await rejectsWithCode(categories.renameSubcategory(Fx.uuid(9999), 'X'), 'notFound');
  await rejectsWithCode(categories.renameSubcategory(dairy.id, ''), 'nameRequired');
});

test('archiving and reordering subcategories', async () => {
  const dairy = await categories.addSubcategory(sample.groceries.id, 'Dairy');
  const bakery = await categories.addSubcategory(sample.groceries.id, 'Bakery');
  await categories.reorderSubcategories(sample.groceries.id, [bakery.id, dairy.id, sample.milk.id]);
  assert.deepEqual(subcategoryNames(sample.groceries.id), ['Bakery', 'Dairy', 'Milk']);

  await categories.setSubcategoryArchived(true, dairy.id);
  assert.deepEqual(subcategoryNames(sample.groceries.id), ['Bakery', 'Milk']);
  assert.deepEqual(subcategoryNames(sample.groceries.id, true), ['Bakery', 'Dairy', 'Milk']);
  const writes = store.writeCount;
  await categories.setSubcategoryArchived(true, dairy.id);
  assert.equal(store.writeCount, writes, 'Archiving twice changes nothing');
  await rejectsWithCode(categories.setSubcategoryArchived(true, Fx.uuid(9999)), 'notFound');
});

test('only unused subcategories can be deleted', async () => {
  const dairy = await categories.addSubcategory(sample.groceries.id, 'Dairy');
  await categories.deleteUnusedSubcategory(dairy.id);
  assert.equal(store.snapshot.subcategory(dairy.id), null);
  await rejectsWithCode(categories.deleteUnusedSubcategory(dairy.id), 'notFound');
  await rejectsWithCode(categories.deleteUnusedSubcategory(sample.milk.id), 'inUse');
  assert.equal(store.snapshot.expense(sample.e[0].id).subcategoryID, sample.milk.id);
});

test('merging subcategories re-points expenses and templates', async () => {
  const dairy = await categories.addSubcategory(sample.groceries.id, 'Dairy');
  const template = makeTemplate({
    ...Fx.template({ categoryID: sample.groceries.id, from: Fx.today }), subcategoryID: sample.milk.id,
  });
  await commit((changes) => { changes.templatesToUpsert = [template]; });

  const summary = await categories.mergeSubcategory(sample.milk.id, dairy.id);
  assert.deepEqual(summary, { expensesMoved: 1, subcategoriesMoved: 0, budgetsMoved: 0, templatesMoved: 1 });

  const moved = store.snapshot.expense(sample.e[0].id);
  assert.equal(moved.subcategoryID, dairy.id);
  assert.equal(moved.subcategoryNameSnapshot, 'Dairy');
  assert.equal(store.snapshot.templates[0].subcategoryID, dairy.id);
  const milk = store.snapshot.subcategory(sample.milk.id);
  assert.equal(milk.isArchived, true);
  assert.equal(milk.mergedIntoID, dairy.id);

  const report = fullReport();
  assert.equal(report.total.minorUnits, SampleLedger.grandTotalMinor);
  assert.equal(report.subcategories.find((r) => r.subcategoryID === dairy.id).total.minorUnits, 5_000);
  await categories.addSubcategory(sample.groceries.id, 'Milk'); // The name of a merged subcategory can be used again
});

test('subcategory merge rules', async () => {
  const dairy = await categories.addSubcategory(sample.groceries.id, 'Dairy');
  const bakery = await categories.addSubcategory(sample.groceries.id, 'Bakery');
  const latte = await categories.addSubcategory(sample.coffee.id, 'Latte');

  await rejectsWithCode(categories.mergeSubcategory(dairy.id, dairy.id), 'cannotMergeIntoSelf');
  await rejectsWithCode(categories.mergeSubcategory(Fx.uuid(9999), dairy.id), 'notFound');
  await rejectsWithCode(categories.mergeSubcategory(dairy.id, latte.id), 'differentParent');
  await categories.mergeSubcategory(bakery.id, dairy.id);
  await rejectsWithCode(categories.mergeSubcategory(sample.milk.id, bakery.id), 'targetWasMerged');
});

test('a subcategory merge is permanent and needs an active target', async () => {
  const dairy = await categories.addSubcategory(sample.groceries.id, 'Dairy');
  const bakery = await categories.addSubcategory(sample.groceries.id, 'Bakery');
  await categories.mergeSubcategory(bakery.id, dairy.id);
  await rejectsWithCode(categories.setSubcategoryArchived(false, bakery.id), 'alreadyMerged');
  await rejectsWithCode(categories.mergeSubcategory(bakery.id, sample.milk.id), 'alreadyMerged');

  await categories.setSubcategoryArchived(true, dairy.id);
  await rejectsWithCode(categories.mergeSubcategory(sample.milk.id, dairy.id), 'targetArchived');
  assert.equal(store.snapshot.expense(sample.e[0].id).subcategoryID, sample.milk.id, 'A refused merge moves nothing');
});

// Payment methods --------------------------------------------------------------------------------

test('adding payment methods', async () => {
  const highest = Math.max(...store.snapshot.paymentMethods.map((p) => p.sortOrder), -1);
  const savings = await methods.add('  Savings   Account ', 'banknote');
  assert.equal(savings.name, 'Savings Account');
  assert.equal(savings.sortOrder, highest + 1);
  assert.equal(store.snapshot.paymentMethods.length, 6);

  await rejectsWithCode(methods.add('cash', 'x'), 'nameInUse');
  await rejectsWithCode(methods.add(' DEBIT   card ', 'x'), 'nameInUse');
  await rejectsWithCode(methods.add('  ', 'x'), 'nameRequired');
  await rejectsWithCode(methods.add('p'.repeat(MAX_NAME_LENGTH + 1), 'x'), 'nameTooLong');
});

test('renaming a method keeps history and reports follow the new name', async () => {
  await methods.update(sample.cash.id, 'Cash on hand', 'banknote');
  assert.equal(store.snapshot.expense(sample.e[0].id).paymentMethodID, sample.cash.id);
  const row = fullReport().paymentMethods.find((r) => r.methodID === sample.cash.id);
  assert.equal(row.name, 'Cash on hand');
  assert.equal(row.total.minorUnits, 8_800);
  assert.equal(row.count, 3);

  await rejectsWithCode(methods.update(sample.cash.id, 'debit card', 'x'), 'nameInUse');
  await rejectsWithCode(methods.update(Fx.uuid(9999), 'X', 'x'), 'notFound');
});

test('archiving a method keeps it in history', async () => {
  await methods.setArchived(true, sample.cash.id);
  assert.equal(store.snapshot.activePaymentMethods.some((p) => p.id === sample.cash.id), false);
  assert.equal(store.snapshot.expenses.filter((e) => e.paymentMethodID === sample.cash.id).length, 3);
  assert.equal(fullReport().paymentMethods.find((r) => r.methodID === sample.cash.id).total.minorUnits, 8_800);
  const writes = store.writeCount;
  await methods.setArchived(true, sample.cash.id);
  assert.equal(store.writeCount, writes);
  await methods.setArchived(false, sample.cash.id);
  assert.equal(store.snapshot.activePaymentMethods.some((p) => p.id === sample.cash.id), true);
});

test('reordering methods', async () => {
  const reversed = store.snapshot.paymentMethods.map((p) => p.id).reverse();
  await methods.reorder(reversed);
  assert.deepEqual(store.snapshot.paymentMethods.map((p) => p.id), reversed);
  assert.deepEqual(store.snapshot.paymentMethods.map((p) => p.sortOrder), [0, 1, 2, 3, 4]);
});

test('only unused methods can be deleted and the default is cleared', async () => {
  assert.equal(methods.usageCount(sample.cash.id), 3);
  await rejectsWithCode(methods.deleteUnused(sample.cash.id), 'inUse');

  const applePay = Fx.method('Apple Pay', store.snapshot);
  await commit((changes) => { changes.settings = { ...store.snapshot.settings, defaultPaymentMethodID: applePay.id }; });
  assert.equal(store.snapshot.settings.defaultPaymentMethodID, applePay.id);

  await methods.deleteUnused(applePay.id);
  assert.equal(store.snapshot.paymentMethod(applePay.id), null);
  assert.equal(store.snapshot.settings.defaultPaymentMethodID, null, 'A deleted method cannot stay the default');
  await rejectsWithCode(methods.deleteUnused(applePay.id), 'notFound');
});

test('a recurring template also protects a method', async () => {
  const bank = Fx.method('Bank Transfer', store.snapshot);
  const template = makeTemplate({
    ...Fx.template({ categoryID: sample.groceries.id, from: Fx.today }), paymentMethodID: bank.id,
  });
  await commit((changes) => { changes.templatesToUpsert = [template]; });
  assert.equal(methods.usageCount(bank.id), 1);
  await rejectsWithCode(methods.deleteUnused(bank.id), 'inUse');
});

// Tags -------------------------------------------------------------------------------------------

async function addTagRecords(names) {
  await commit((changes) => {
    names.forEach((name, offset) => changes.tagsToUpsert.push(makeTag({ id: Fx.uuid(7001 + offset), name, createdAt: Fx.now })));
  });
}

test('renaming a tag changes only the expenses that have it', async () => {
  assert.equal(tags.usageCount('FAMILY'), 1);
  assert.equal(tags.usageCount('work'), 1);
  await tags.rename('family', '  #household ');

  const renamed = store.snapshot.expense(sample.e[0].id);
  assert.deepEqual([...renamed.tags], ['household']);
  assert.equal(renamed.modifiedAt, Fx.now + 1_000);
  assert.deepEqual(store.snapshot.expense(sample.e[3].id), sample.e[3], 'Other expenses are untouched');
  assert.deepEqual(store.snapshot.tags.map((t) => t.name), ['household']);
  assert.equal(tags.usageCount('family'), 0);
});

test('renaming a tag into an existing one merges them and keeps the existing spelling', async () => {
  const both = makeExpense({ ...sample.e[0], tags: ['family', 'work'] });
  await commit((changes) => { changes.expensesToUpsert = [both]; });
  await addTagRecords(['family', 'Work']);

  await tags.rename('WORK', 'Family');
  assert.deepEqual([...store.snapshot.expense(both.id).tags], ['family'], 'The duplicate collapses to one tag');
  assert.deepEqual([...store.snapshot.expense(sample.e[3].id).tags], ['family']);
  assert.deepEqual(store.snapshot.tags.map((t) => t.name), ['family']);
  assert.equal(tags.usageCount('family'), 2);
});

test('changing only the capitalisation adopts the new spelling', async () => {
  await addTagRecords(['Work']);
  await tags.rename('work', 'WORK');
  assert.deepEqual([...store.snapshot.expense(sample.e[3].id).tags], ['WORK']);
  assert.deepEqual(store.snapshot.tags.map((t) => t.name), ['WORK']);

  const writes = store.writeCount;
  await tags.rename('work', 'WORK');
  assert.equal(store.writeCount, writes, 'Renaming to the same spelling writes nothing');
});

test('a tag needs something left after cleaning', async () => {
  await rejectsWithCode(tags.rename('work', ' #, ; '), 'nameRequired');
  assert.deepEqual([...store.snapshot.expense(sample.e[3].id).tags], ['Work']);
});

test('deleting a tag removes it everywhere but keeps the expenses', async () => {
  await addTagRecords(['family', 'Work']);
  await tags.delete('FAMILY');
  assert.deepEqual([...store.snapshot.expense(sample.e[0].id).tags], []);
  assert.deepEqual([...store.snapshot.expense(sample.e[3].id).tags], ['Work']);
  assert.equal(store.snapshot.expenses.length, 8);
  assert.deepEqual(store.snapshot.tags.map((t) => t.name), ['Work']);
  assert.equal(tags.usageCount('family'), 0);
  assert.equal(fullReport().total.minorUnits, SampleLedger.grandTotalMinor);
});
