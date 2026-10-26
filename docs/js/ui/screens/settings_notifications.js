// Notifications. A web app on an iPhone cannot send a notification to the lock screen, or wake up while closed, without a
// server that pushes messages to it. This app has no server on purpose, so its alerts are shown inside the app (on Home)
// when it is open. That is also why nothing about spending can ever appear on the lock screen.

import { h } from '../dom.js';
import { group, notice, page, toggleRow } from '../components.js';
import { money } from '../../core/money.js';

export function openNotifications(app) {
  app.shell.push(createNotifications);
}

export function createNotifications(app) {
  const screen = page(app, { title: 'Notifications', back: true, backLabel: 'Settings' });

  const save = (patch, input, previous) => app.perform('settings-write', () => app.updateSettings(patch), { title: 'Could not save' })
    .then((result) => { if (!result.ok) input.checked = previous; });

  // The switches are made once and only their position is updated afterwards, so a switch slides instead of being replaced.
  const budgetAlerts = toggleRow({
    title: 'Budget alerts', sub: 'Show a message on Home when a budget reaches one of its alert levels.', checked: app.settings.budgetAlertsEnabled,
    onChange: (checked, input) => save({ budgetAlertsEnabled: checked }, input, !checked),
  });
  const reminders = toggleRow({
    title: 'Repeating expense reminders', sub: 'Show a message on Home when a repeating expense is due soon.', checked: app.settings.recurringRemindersEnabled,
    onChange: (checked, input) => save({ recurringRemindersEnabled: checked }, input, !checked),
  });
  const amounts = toggleRow({
    title: 'Show amounts in alerts', sub: 'Off: an alert only says a budget needs attention. On: it names the budget and the amounts.', checked: app.settings.notificationsShowAmounts,
    onChange: (checked, input) => save({ notificationsShowAmounts: checked }, input, !checked),
  });
  const sampleTitle = h('div', { class: 'notice-title' });
  const sampleBody = h('div');

  screen.body.append(h('div', { class: 'stack-l' },
    notice({
      kind: '', glyph: 'info', title: 'Alerts stay inside the app',
      body: 'A web app on iPhone cannot send notifications to the lock screen without a server, and this app has none by design. Alerts and reminders show on Home when you open the app. Nothing about your spending is ever shown on your lock screen.',
    }),
    group([budgetAlerts, reminders], {
      title: 'Show on Home',
      footer: 'Each budget has its own alert levels, such as 80% and 100%. Set them when you add or edit a budget. An expense waiting for your confirmation is always shown.',
    }),
    group([amounts], { title: 'Privacy' }),
    h('section', { class: 'section' },
      h('h2', { class: 'section-title' }, 'How an alert reads'),
      h('div', { class: 'notice warn sample', 'aria-label': 'Example alert' },
        h('div', { class: 'notice-body' }, sampleTitle, sampleBody)))));

  function refresh() {
    const s = app.settings;
    const m = app.formatter.money;
    for (const [row, value] of [[budgetAlerts, s.budgetAlertsEnabled], [reminders, s.recurringRemindersEnabled], [amounts, s.notificationsShowAmounts]]) {
      if (row.input.checked !== value) {
        row.input.checked = value;
        row.input.setAttribute('aria-checked', value ? 'true' : 'false');
      }
    }
    const sample = s.notificationsShowAmounts
      ? { title: 'Groceries: 80% used', body: `${m.string(money(64000, app.currency))} of ${m.string(money(80000, app.currency))} spent. ${m.string(money(16000, app.currency))} left.` }
      : { title: 'Budget alert', body: 'One of your budgets needs attention. Open Budgets to review it.' };
    sampleTitle.textContent = sample.title;
    sampleBody.textContent = sample.body;
  }

  return { el: screen.el, refresh };
}
