// Settings: the root of the last tab. A list of groups; each row opens a page or a chooser. The value on the right of a row
// says what is chosen now, so most things can be checked without opening them.

import { fill, h } from '../dom.js';
import { icon } from '../icons.js';
import { group, page, row } from '../components.js';
import { money } from '../../core/money.js';
import { APPEARANCE_TITLES } from '../../core/models.js';
import { PERIOD_TITLES } from '../../core/periods.js';
import { APP_VERSION } from '../version.js';
import { daysBetween, lastBackupAt } from '../backup_memory.js';
import {
  changeCurrency, chooseAppearance, chooseDefaultPeriod, chooseWeekStart, openFormats, weekdayName,
} from './settings_display.js';
import { openCategories } from './categories.js';
import { openPaymentMethods, openTags } from './methods_tags.js';
import { openRecurring } from './recurring.js';
import { openAppLock } from './settings_lock.js';
import { openNotifications } from './settings_notifications.js';
import { exportAllCsv, openBackupRestore } from './settings_backup.js';
import { openDeleteData } from './settings_delete.js';
import { openLimitations, openPrivacy } from './settings_info.js';
import { openAbout } from './settings_about.js';

function backupWords(app) {
  const last = lastBackupAt();
  if (last === null) return 'Never';
  const days = daysBetween(last, app.now());
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export function createSettings(app) {
  const screen = page(app, { title: 'Settings', large: true });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  function refresh() {
    const settings = app.settings;
    const snapshot = app.snapshot;
    const f = app.formatter;
    const activeSchedules = snapshot.templates.filter((template) => template.isActive).length;
    const waiting = app.waitingOccurrences().length;
    const alertsOn = settings.budgetAlertsEnabled || settings.recurringRemindersEnabled;
    const neverBackedUp = lastBackupAt() === null;

    fill(holder,
      group([
        row({ title: 'Currency', value: app.currency, chevron: true, onClick: () => changeCurrency(app) }),
        row({ title: 'The week starts on', value: weekdayName(app, settings.firstWeekday), chevron: true, onClick: () => chooseWeekStart(app) }),
        row({ title: 'Default period', value: PERIOD_TITLES[settings.defaultReportPeriod], chevron: true, onClick: () => chooseDefaultPeriod(app) }),
        row({ title: 'Formats', value: f.money.string(money(123456, app.currency)), chevron: true, onClick: () => openFormats(app) }),
        row({ title: 'Appearance', value: APPEARANCE_TITLES[settings.appearance], chevron: true, onClick: () => chooseAppearance(app) }),
      ], { title: 'General' }),
      group([
        row({ title: 'Categories', value: String(snapshot.activeCategories.length), chevron: true, onClick: () => openCategories(app) }),
        row({ title: 'Payment methods', value: String(snapshot.activePaymentMethods.length), chevron: true, onClick: () => openPaymentMethods(app) }),
        row({ title: 'Tags', value: String(snapshot.tags.length), chevron: true, onClick: () => openTags(app) }),
        row({
          title: 'Repeating expenses', value: String(activeSchedules), sub: waiting > 0 ? `${waiting} waiting for you` : null, subClass: 'sub-warn',
          chevron: true, onClick: () => openRecurring(app),
        }),
      ], { title: 'Your lists' }),
      group([
        row({ title: 'App lock', value: app.lockEnabled ? 'On' : 'Off', sub: app.lockEnabled ? null : 'No passcode is set', subClass: 'sub-warn', chevron: true, onClick: () => openAppLock(app) }),
        row({ title: 'Notifications', value: alertsOn ? 'On' : 'Off', chevron: true, onClick: () => openNotifications(app) }),
      ], { title: 'Privacy and security' }),
      group([
        row({
          title: 'Back up and restore', value: backupWords(app), sub: neverBackedUp && snapshot.expenses.length > 0 ? 'No backup made yet' : null, subClass: 'sub-warn',
          chevron: true, onClick: () => openBackupRestore(app),
        }),
        row({ title: 'Export all as CSV', sub: 'A file for a spreadsheet', trailing: icon('share', { className: 'row-glyph' }), onClick: () => exportAllCsv(app) }),
        row({ title: 'Delete data', chevron: true, onClick: () => openDeleteData(app) }),
      ], { title: 'Your data', footer: 'Your data lives only on this iPhone. Backups are how you keep a copy elsewhere.' }),
      group([
        row({ title: 'Privacy', chevron: true, onClick: () => openPrivacy(app) }),
        row({ title: 'Known limitations', chevron: true, onClick: () => openLimitations(app) }),
        row({ title: 'About this app', value: APP_VERSION, chevron: true, onClick: () => openAbout(app) }),
      ], { title: 'About' }));
  }

  return { el: screen.el, refresh };
}
