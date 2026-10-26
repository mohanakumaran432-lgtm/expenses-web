// "Every category and subcategory" for one period, with exact amounts and each share. Tapping a row lists its expenses.

import { fill, h, plural } from '../dom.js';
import { badge, emptyState, group, page, row } from '../components.js';
import { expensesInCategory, expensesInSubcategory } from '../../core/reports.js';
import { openDrilldown } from './drilldown.js';
import { reportGenerator } from './report_parts.js';

/**
 * @param params.range         the DayRange the report covers
 * @param params.currencyCode  the report currency (null for the app's currency)
 * @param params.subtitle      text for the period, shown under the title
 */
export function openCategoryDetail(app, params) {
  app.shell.push(createCategoryDetail, params);
}

export function createCategoryDetail(app, params) {
  const screen = page(app, { title: 'Categories', back: true, backLabel: 'Reports' });
  const generate = reportGenerator(params.range, params.currencyCode);
  const holder = h('div', { class: 'stack' });
  screen.body.append(holder);

  function refresh() {
    const f = app.formatter;
    const report = generate(app);
    if (report.count === 0) {
      fill(holder, emptyState({ mark: '🧾', title: 'No spending', message: 'There are no expenses in this period.' }));
      return;
    }
    const subsByCategory = new Map();
    for (const sub of report.subcategories) {
      if (!subsByCategory.has(sub.categoryID)) subsByCategory.set(sub.categoryID, []);
      subsByCategory.get(sub.categoryID).push(sub);
    }
    const sections = [h('p', { class: 't-sub padded' }, [params.subtitle, `${f.money.string(report.total)} in total`].filter(Boolean).join(' · '))];
    const rows = [];
    for (const category of report.categories) {
      rows.push(row({
        badge: badge({ iconSymbol: category.iconSymbol, colorHex: category.colorHex }),
        title: category.name,
        sub: plural(category.count, 'transaction'),
        amount: f.money.string(category.total),
        amountSub: f.money.percentString(category.percent),
        ariaLabel: `${category.name}, ${f.money.string(category.total)}, ${f.money.percentString(category.percent)} of the total, ${plural(category.count, 'transaction')}. View transactions.`,
        onClick: () => openDrilldown(app, {
          title: category.name, subtitle: f.range(params.range), backLabel: 'Categories',
          select: (a) => expensesInCategory(generate(a), category.categoryID),
        }),
      }));
      const subs = subsByCategory.get(category.categoryID) || [];
      // Subcategories are only worth listing when the category is actually split.
      const split = subs.some((s) => s.subcategoryID !== null);
      if (split) {
        for (const sub of subs) {
          const line = row({
            title: sub.name,
            sub: plural(sub.count, 'transaction'),
            amount: f.money.string(sub.total),
            amountSub: `${f.money.percentString(sub.percentOfCategory)} of ${category.name}`,
            ariaLabel: `${category.name}, ${sub.name}, ${f.money.string(sub.total)}, ${f.money.percentString(sub.percentOfCategory)} of ${category.name}. View transactions.`,
            onClick: () => openDrilldown(app, {
              title: `${category.name} › ${sub.name}`, subtitle: f.range(params.range), backLabel: 'Categories',
              select: (a) => expensesInSubcategory(generate(a), category.categoryID, sub.subcategoryID),
            }),
          });
          line.classList.add('indent');
          rows.push(line);
        }
      }
    }
    sections.push(group(rows, { footer: 'Percentages are shares of the total. Subcategory percentages are shares of their category.' }));
    fill(holder, ...sections);
  }

  return { el: screen.el, refresh };
}
