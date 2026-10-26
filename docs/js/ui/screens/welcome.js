// First start: what the app is, a few choices (currency, first day of the week, optional passcode), or restoring a backup.
// Nothing is saved until the person taps the final button.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { button, group, page, row, segmented, toggleRow } from '../components.js';
import { currencyFor } from '../../core/currency.js';
import { LOCK_TIMEOUTS, LOCK_TIMEOUT_TITLES } from '../../core/lock_settings.js';
import { planRestore } from '../../core/backup.js';
import { LedgerSnapshot } from '../../core/snapshot.js';
import { chooseCurrency } from './pickers.js';
import { passcodeFields } from './passcode_fields.js';
import { chooseAndOpenBackup } from './backup_flow.js';
import { APP_NAME } from '../version.js';

function fact(glyph, title, body) {
  return h('div', { class: 'fact' },
    h('div', { class: 'fact-icon', 'aria-hidden': 'true' }, icon(glyph, { size: '1.35rem' })),
    h('div', null, h('div', { class: 't-strong' }, title), h('p', { class: 't-sub' }, body)));
}

export function createWelcome(app) {
  const el = h('main', { class: 'welcome' });
  const choices = { currencyCode: 'AED', firstWeekday: 2, passcodeOn: true, timeout: 0 };
  let restoring = null; // { opened, snapshot, preview }

  function show(step) {
    el.replaceChildren(step === 'intro' ? intro() : setup());
    const scroller = el.querySelector('.page-scroll');
    if (scroller) scroller.scrollTop = 0;
  }

  // ------------------------------------------------------------ step 1: what this is

  function intro() {
    const restoreButton = button('Restore from a backup', {
      variant: 'secondary', block: true,
      onClick: async () => {
        const opened = await chooseAndOpenBackup(app);
        if (!opened) return;
        const result = planRestore(opened.payload, new LedgerSnapshot(), 'replaceAll');
        restoring = { opened, snapshot: result.result };
        show('setup');
      },
    });
    return h('div', { class: 'welcome-intro page-scroll' },
      h('div', { class: 'welcome-body' },
        h('div', { class: 'welcome-head' },
          h('h1', { class: 'welcome-title' }, APP_NAME),
          h('p', { class: 'welcome-tag' }, 'Track what you spend, privately.')),
        h('div', { class: 'stack-l' },
          fact('lock', 'Stays on this iPhone', 'No account, no cloud and no tracking. Nothing you enter is sent anywhere.'),
          fact('shield', 'Works offline', 'Once opened, the app needs no connection. It has no server to talk to.'),
          fact('download', 'You keep the backups', 'Export a backup file whenever you like. It goes only where you choose to send it.')),
        h('div', { class: 'notice' },
          icon('info', { size: '1.3rem' }),
          h('div', { class: 'notice-body' },
            h('div', { class: 'notice-title' }, 'Worth knowing'),
            h('div', null, 'Your data lives in this browser\'s storage on your iPhone. If you clear Safari\'s website data, or the system frees up space, it can be lost. Make a backup now and then.'))),
        h('div', { class: 'stack' },
          button('Set up', { block: true, onClick: () => { restoring = null; show('setup'); } }),
          restoreButton)));
  }

  // ------------------------------------------------------------ step 2: choices

  function setup() {
    const isRestore = restoring !== null;
    const screen = page(app, {
      title: isRestore ? 'Restore' : 'Set up', large: true, back: true, backLabel: APP_NAME, onBack: () => { restoring = null; show('intro'); },
    });
    const body = screen.body;
    let fields = null;
    const startButton = button(isRestore ? 'Restore my data' : 'Start tracking', { block: true, onClick: () => finish() });

    if (isRestore) {
      const { info } = restoring.opened;
      const counts = info.counts;
      const f = app.formatter;
      const span = counts.firstExpenseDay && counts.lastExpenseDay
        ? `${f.day(counts.firstExpenseDay)} to ${f.day(counts.lastExpenseDay)}`
        : 'no dated expenses';
      body.append(group([
        row({ title: 'Expenses', value: String(counts.expenses) }),
        row({ title: 'Dates', value: span }),
        row({ title: 'Categories', value: String(counts.categories) }),
        row({ title: 'Budgets', value: String(counts.budgets) }),
        row({ title: 'Repeating', value: String(counts.templates) }),
        row({ title: 'Made', value: f.timestamp(info.createdAt, app.timeZone()) }),
      ], { title: 'In this backup', footer: restoring.opened.warnings.length > 0 ? restoring.opened.warnings.join(' ') : 'The backup passed every check: it is complete and unchanged.' }));
    } else {
      const currencyRow = row({
        title: 'Currency', value: `${choices.currencyCode} · ${currencyFor(choices.currencyCode).name}`, chevron: true,
        onClick: async () => {
          const picked = await chooseCurrency(app, choices.currencyCode, { footer: 'You can change this later in Settings. No amounts are ever converted.' });
          if (picked) {
            choices.currencyCode = picked;
            currencyRow.querySelector('.row-value').textContent = `${picked} · ${currencyFor(picked).name}`;
          }
        },
      });
      const weekday = segmented({
        label: 'First day of the week',
        options: [{ value: 2, label: 'Monday' }, { value: 7, label: 'Saturday' }, { value: 1, label: 'Sunday' }],
        value: choices.firstWeekday,
        onChange: (value) => { choices.firstWeekday = Number(value); },
      });
      weekday.dataset.kind = 'weekday';
      // Segmented values are strings in the DOM; keep the number.
      body.append(
        group([currencyRow], { title: 'Money' }),
        h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'The week starts on'), weekday));
    }

    // Passcode
    const passcodeSection = h('div', { class: 'stack' });
    const timeoutRow = row({
      title: 'Lock', value: LOCK_TIMEOUT_TITLES[choices.timeout], chevron: true,
      onClick: async () => {
        const picked = await app.ui.actions({
          title: 'Lock the app',
          options: LOCK_TIMEOUTS.map((seconds) => ({ label: LOCK_TIMEOUT_TITLES[seconds], value: seconds, checked: seconds === choices.timeout })),
        });
        if (picked !== undefined) {
          choices.timeout = picked;
          timeoutRow.querySelector('.row-value').textContent = LOCK_TIMEOUT_TITLES[picked];
        }
      },
    });
    const off = h('p', { class: 't-foot footnote' }, 'Without a passcode, anyone who can open this app on this iPhone can read your expenses, and the stored data is not encrypted. You can add a passcode later in Settings.');
    const toggle = toggleRow({
      title: 'Protect with a passcode', sub: 'Recommended. Locks the app and encrypts what is stored.', checked: choices.passcodeOn,
      onChange: (checked) => {
        choices.passcodeOn = checked;
        draw();
      },
    });
    function draw() {
      if (choices.passcodeOn) {
        if (!fields) fields = passcodeFields({ onChange: refreshButton });
        passcodeSection.replaceChildren(fields.el, group([timeoutRow], { footer: 'How long the app may stay out of sight before it asks again.' }));
      } else {
        passcodeSection.replaceChildren(off);
      }
      refreshButton();
    }
    function refreshButton() {
      startButton.disabled = choices.passcodeOn && !(fields && fields.read().ok);
    }
    body.append(group([toggle], { title: 'Privacy' }), passcodeSection, startButton);
    draw();

    async function finish() {
      const passcode = choices.passcodeOn ? fields.read().passcode : null;
      if (choices.passcodeOn && passcode === null) return;
      const run = isRestore
        ? () => app.createLedgerFrom(restoring.snapshot, { passcode, timeout: choices.timeout })
        : () => app.createLedger({ currencyCode: choices.currencyCode, firstWeekday: choices.firstWeekday, passcode, timeout: choices.timeout });
      await app.perform('setup', run, { busy: passcode ? 'Encrypting and saving…' : 'Setting up…', title: isRestore ? 'Could not restore' : 'Could not set up' });
    }

    return screen.el;
  }

  show('intro');
  return { el, destroy() {} };
}
