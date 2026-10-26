// About: which version this is, where the data is kept, how much room it uses, and a counts-only summary that can be
// copied when something looks wrong. The summary never contains an amount, a name, a note or a merchant.

import { fill, h, plural } from '../dom.js';
import { button, group, notice, page, row } from '../components.js';
import { APP_NAME, APP_VERSION } from '../version.js';
import { checkForUpdate, updateStatus } from '../updates.js';
import { sizeText } from './file_ready.js';
import { openLimitations, openPrivacy } from './settings_info.js';

function openedFromHomeScreen() {
  try {
    return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

export function openAbout(app) {
  app.shell.push(createAbout);
}

export function createAbout(app) {
  const screen = page(app, { title: 'About', back: true, backLabel: 'Settings' });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  let storage = null; // what the browser says about storage, filled in once
  let offline = null; // the state of the offline copy, filled in once
  let loaded = false;

  async function load() {
    [storage, offline] = await Promise.all([app.storageFacts(), updateStatus()]);
    loaded = true;
    refresh();
  }

  function storageText() {
    if (!storage) return 'Checking…';
    if (storage.usage === null) return 'Not reported';
    return storage.quota ? `${sizeText(storage.usage)} of ${sizeText(storage.quota)}` : sizeText(storage.usage);
  }

  function keptText() {
    if (!storage || storage.persisted === null) return 'Not reported';
    return storage.persisted ? 'Yes' : 'Not guaranteed';
  }

  function offlineText() {
    if (!offline) return 'Checking…';
    if (!offline.supported) return 'Not available';
    if (offline.controlled) return 'Ready';
    return offline.registered ? 'Getting ready' : 'Not yet';
  }

  /** The counts-only summary, one fact per line. */
  function diagnosticLines() {
    const d = app.diagnostics();
    return [
      `${APP_NAME} ${d.appVersion}`,
      `Opened from: ${openedFromHomeScreen() ? 'Home Screen' : 'Safari tab'}`,
      `Offline copy: ${offlineText()}`,
      `Storage used: ${storageText()}`,
      `Protected from clearing: ${keptText()}`,
      `Passcode: ${d.passcodeSet ? 'on' : 'off'}`,
      `Expenses: ${d.expenses}`,
      `Categories: ${d.categories}`,
      `Subcategories: ${d.subcategories}`,
      `Payment methods: ${d.paymentMethods}`,
      `Tags: ${d.tags}`,
      `Budgets: ${d.budgets}`,
      `Repeating expenses: ${d.repeating}`,
      `Repeating history entries: ${d.repeatingLog}`,
      `Records that could not be read: ${d.unreadableRecords}`,
      `Time zone: ${d.timeZone}`,
    ];
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(diagnosticLines().join('\n'));
      app.ui.toast('Summary copied');
    } catch {
      app.ui.toast('Could not copy. Select the text above and copy it.');
    }
  }

  async function keepStorage() {
    const result = await app.perform('persist', () => app.requestPersistence(), { title: 'Could not ask' });
    if (!result.ok) return;
    storage = await app.storageFacts();
    refresh();
    if (result.value === true) {
      app.ui.toast('Your data is now protected from automatic clearing');
    } else {
      await app.ui.alert({
        title: 'Not guaranteed',
        message: 'The browser decides this and did not agree. Opening the app from its Home Screen icon and using it often helps. Keep making backups, which is the dependable protection.',
      });
    }
  }

  async function lookForUpdate() {
    const result = await app.perform('update', () => checkForUpdate(), { busy: 'Checking…', title: 'Could not check' });
    if (!result.ok) return;
    const messages = {
      new: ['A new version is ready', 'It has been downloaded. It starts the next time you open the app from scratch: swipe the app away in the app switcher, then open it again.'],
      current: ['You have the latest version', `${APP_NAME} ${APP_VERSION} is the newest one.`],
      offline: ['You are offline', 'Connect to the internet and try again. The app keeps working as it is.'],
      unavailable: ['Not available here', 'This browser does not keep an offline copy of the app, so there is nothing to update.'],
    };
    const [title, message] = messages[result.value];
    await app.ui.alert({ title, message });
    offline = await updateStatus();
    refresh();
  }

  function refresh() {
    const d = app.diagnostics();
    const fromHome = openedFromHomeScreen();
    const sections = [];
    sections.push(h('div', { class: 'about-head' },
      h('h2', { class: 'about-name' }, APP_NAME),
      h('p', { class: 't-sub' }, `Version ${APP_VERSION}`),
      h('p', { class: 't-foot' }, 'Private, offline expense tracking. No account, no server, no tracking.')));

    if (!fromHome) {
      sections.push(notice({
        kind: 'warn', glyph: 'info', title: 'Open it from the Home Screen',
        body: 'You are using the app in a Safari tab. Add it to the Home Screen and open it from there: it then runs as its own app without Safari\'s bars. On iPhone it usually keeps its own storage too, so what you enter in a Safari tab may not appear there. Use the Home Screen icon from the start, or move your data with a backup.',
      }));
    }
    if (d.unreadableRecords > 0) {
      sections.push(notice({
        kind: 'bad', glyph: 'warning', title: `${plural(d.unreadableRecords, 'record')} could not be read`,
        body: 'They are left untouched and not shown. Do not erase anything. If you have a backup, restoring it in Add mode brings back what is missing.',
      }));
    }

    sections.push(group([
      row({ title: 'Opened from', value: fromHome ? 'Home Screen' : 'Safari tab' }),
      row({ title: 'Works offline', value: offlineText() }),
      offline && offline.supported
        ? row({ title: offline.waiting ? 'A new version is ready' : 'Check for a new version', sub: offline.waiting ? 'Starts next time you open the app from scratch' : null, chevron: !offline.waiting, onClick: offline.waiting ? null : lookForUpdate })
        : null,
    ], { title: 'The app', footer: 'The app keeps its own copy on this iPhone. It only asks the website for a newer copy when you are online, and it never sends your data.' }));

    sections.push(group([
      row({ title: 'Stored', value: 'On this device only' }),
      row({ title: 'Space used', value: storageText() }),
      row({ title: 'Protected from clearing', value: keptText() }),
      loaded && storage && storage.persisted !== true
        ? row({ title: 'Ask the browser to keep it', sub: 'It may agree or not; it is the browser\'s decision', chevron: true, onClick: keepStorage })
        : null,
      row({ title: 'Passcode', value: d.passcodeSet ? 'On' : 'Off' }),
    ], { title: 'Your data', footer: 'If Safari\'s website data is cleared, or the Home Screen app is deleted, the stored data goes with it. Backups are what bring it back.' }));

    sections.push(group([
      row({ title: 'Privacy', chevron: true, onClick: () => openPrivacy(app) }),
      row({ title: 'Known limitations', chevron: true, onClick: () => openLimitations(app) }),
    ], { title: 'Read' }));

    sections.push(h('section', { class: 'section' },
      h('h2', { class: 'section-title' }, 'Summary for troubleshooting'),
      h('pre', { class: 'diagnostics', tabindex: '0', 'aria-label': 'Summary' }, diagnosticLines().join('\n')),
      h('p', { class: 't-foot footnote' }, 'Counts and settings only. It has no amounts, names, notes or merchants, and nothing is sent anywhere. Copy it only if you want to show it to someone.'),
      button('Copy summary', { variant: 'secondary', block: true, onClick: copyDiagnostics })));

    sections.push(h('p', { class: 't-foot footnote' }, 'Made with plain HTML, CSS and JavaScript. No third-party code, advertising or analytics.'));
    fill(holder, ...sections);
  }

  load();
  return { el: screen.el, refresh };
}
