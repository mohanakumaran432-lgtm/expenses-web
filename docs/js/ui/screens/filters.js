// The filter sheet for the Transactions list (dates, categories, subcategories, payment methods, tags) and the short
// descriptions shown for filters that are switched on.

import { fill, h } from '../dom.js';
import { badge, button, group, row, sheetContent } from '../components.js';
import { DayRange } from '../../core/dayrange.js';
import { PeriodResolver } from '../../core/periods.js';
import { filterIsActive, makeFilter } from '../../core/query.js';
import { chooseMany, choosePeriod } from './pickers.js';

/** A copy that can be changed without touching the original. */
export function copyFilter(filter) {
  return makeFilter({
    range: filter.range,
    categoryIDs: new Set(filter.categoryIDs),
    subcategoryIDs: new Set(filter.subcategoryIDs),
    paymentMethodIDs: new Set(filter.paymentMethodIDs),
    tags: new Set(filter.tags),
  });
}

/** Switches one facet off. Returns a new filter. */
export function withoutFacet(filter, facet) {
  const next = copyFilter(filter);
  if (facet === 'range') next.range = null;
  if (facet === 'categories') next.categoryIDs.clear();
  if (facet === 'subcategories') next.subcategoryIDs.clear();
  if (facet === 'methods') next.paymentMethodIDs.clear();
  if (facet === 'tags') next.tags.clear();
  return next;
}

/** One short phrase per filter that is on: [{ facet, label }]. */
export function describeFilter(app, filter) {
  const snapshot = app.snapshot;
  const f = app.formatter;
  const items = [];
  const few = (set, nameOf, noun) => {
    if (set.size === 1) return nameOf([...set][0]);
    return `${set.size} ${noun}`;
  };
  if (filter.range) items.push({ facet: 'range', label: f.range(filter.range) });
  if (filter.categoryIDs.size > 0) {
    items.push({ facet: 'categories', label: few(filter.categoryIDs, (id) => (snapshot.category(id) ? snapshot.category(id).name : 'Category'), 'categories') });
  }
  if (filter.subcategoryIDs.size > 0) {
    items.push({ facet: 'subcategories', label: few(filter.subcategoryIDs, (id) => (snapshot.subcategory(id) ? snapshot.subcategory(id).name : 'Subcategory'), 'subcategories') });
  }
  if (filter.paymentMethodIDs.size > 0) {
    items.push({ facet: 'methods', label: few(filter.paymentMethodIDs, (id) => (snapshot.paymentMethod(id) ? snapshot.paymentMethod(id).name : 'Payment method'), 'payment methods') });
  }
  if (filter.tags.size > 0) items.push({ facet: 'tags', label: few(filter.tags, (name) => `#${name}`, 'tags') });
  return items;
}

function summaryOf(set, plural, nameOf) {
  if (set.size === 0) return 'Any';
  if (set.size === 1) return nameOf([...set][0]);
  return `${set.size} ${plural}`;
}

/**
 * Opens the filter sheet. Resolves with the new filter when "Done" is tapped, or undefined when cancelled.
 * `current` is not changed.
 */
export function openFilterSheet(app, current) {
  const { closed } = app.ui.present((_, __, handle) => {
    const draft = copyFilter(current);
    const snapshot = app.snapshot;
    const f = app.formatter;
    const sheet = sheetContent({ title: 'Filters', onCancel: () => handle.close(undefined), actionLabel: 'Done', onAction: () => handle.close(draft) });
    const holder = h('div', { class: 'stack' });
    sheet.body.append(holder);

    const categories = snapshot.categories.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    const methods = snapshot.paymentMethods.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    const subcategories = snapshot.subcategories.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    const tagNames = snapshot.tags.map((t) => t.name).sort((a, b) => a.localeCompare(b));

    async function chooseRange() {
      const picked = await choosePeriod(app, {
        title: 'Dates', allowAny: true, anyLabel: 'Any date', value: draft.range ? { kind: 'custom', start: draft.range.start, end: draft.range.end } : null,
      });
      if (!picked) return;
      if (picked.kind === 'any') draft.range = null;
      else if (picked.kind === 'custom') draft.range = DayRange.between(picked.start, picked.end);
      else draft.range = new PeriodResolver(app.settings.firstWeekday).range(picked.kind, app.today());
      draw();
    }

    async function chooseCategories() {
      const picked = await chooseMany(app, {
        title: 'Categories',
        searchable: true,
        selected: draft.categoryIDs,
        options: categories.map((c) => ({ value: c.id, label: c.name, sub: c.isArchived ? 'Archived' : null, badge: badge(c) })),
      });
      if (picked) {
        draft.categoryIDs = picked;
        draw();
      }
    }

    async function chooseSubcategories() {
      const names = new Map(categories.map((c) => [c.id, c.name]));
      const picked = await chooseMany(app, {
        title: 'Subcategories',
        searchable: true,
        selected: draft.subcategoryIDs,
        options: subcategories.map((s) => ({ value: s.id, label: s.name, sub: names.get(s.categoryID) || null })),
      });
      if (picked) {
        draft.subcategoryIDs = picked;
        draw();
      }
    }

    async function chooseMethods() {
      const picked = await chooseMany(app, {
        title: 'Payment methods',
        selected: draft.paymentMethodIDs,
        options: methods.map((m) => ({ value: m.id, label: m.name, sub: m.isArchived ? 'Archived' : null, badge: badge({ iconSymbol: m.iconSymbol, colorHex: '#8E8E93' }) })),
      });
      if (picked) {
        draft.paymentMethodIDs = picked;
        draw();
      }
    }

    async function chooseTags() {
      const picked = await chooseMany(app, {
        title: 'Tags',
        searchable: tagNames.length > 8,
        selected: draft.tags,
        options: tagNames.map((name) => ({ value: name, label: `#${name}` })),
        footer: 'Shows expenses that have any of the chosen tags.',
      });
      if (picked) {
        draft.tags = picked;
        draw();
      }
    }

    function draw() {
      const rows = [
        row({ title: 'Dates', value: draft.range ? f.range(draft.range) : 'Any', chevron: true, onClick: chooseRange }),
        row({ title: 'Categories', value: summaryOf(draft.categoryIDs, 'categories', (id) => (snapshot.category(id) || { name: 'Category' }).name), chevron: true, onClick: chooseCategories }),
      ];
      if (subcategories.length > 0) {
        rows.push(row({ title: 'Subcategories', value: summaryOf(draft.subcategoryIDs, 'subcategories', (id) => (snapshot.subcategory(id) || { name: 'Subcategory' }).name), chevron: true, onClick: chooseSubcategories }));
      }
      rows.push(row({ title: 'Payment methods', value: summaryOf(draft.paymentMethodIDs, 'methods', (id) => (snapshot.paymentMethod(id) || { name: 'Payment method' }).name), chevron: true, onClick: chooseMethods }));
      if (tagNames.length > 0) {
        rows.push(row({ title: 'Tags', value: draft.tags.size === 0 ? 'Any' : draft.tags.size === 1 ? `#${[...draft.tags][0]}` : `${draft.tags.size} tags`, chevron: true, onClick: chooseTags }));
      }
      fill(holder,
        group(rows, { footer: 'Every filter you turn on must match. Within one filter, any of your choices can match.' }),
        filterIsActive({ ...draft, searchText: '' })
          ? button('Clear all filters', { variant: 'secondary', block: true, onClick: () => {
            draft.range = null;
            draft.categoryIDs = new Set();
            draft.subcategoryIDs = new Set();
            draft.paymentMethodIDs = new Set();
            draft.tags = new Set();
            draw();
          } })
          : null);
    }
    draw();
    return { el: sheet.el, label: 'Filters' };
  }, {}, { compact: true });
  return closed;
}
