// The app's brain on the screen side. It opens the stored data, applies the lock, and gives every screen the same things:
// the data (`snapshot`), the services that change it, the formatter that writes amounts and dates, and a safe way to run an
// action (`perform`: one at a time, with errors shown in words).
//
// Nothing here draws anything. It talks to the screens through `subscribe` (events: 'phase', 'data', 'lock', 'alerts').

import { AppError } from '../core/util.js';
import { CalendarContext, currentTimeZone } from '../core/calendar.js';
import { DisplayFormatter, defaultLocale } from '../core/format.js';
import { LedgerChangeSet, LedgerDirectory, initialSnapshot } from '../core/snapshot.js';
import { normalizeSettings } from '../core/models.js';
import { ExpenseSearchIndex } from '../core/query.js';
import { ExpenseService } from '../core/expense_service.js';
import { CategoryService, PaymentMethodService, TagService } from '../core/catalog_service.js';
import { BudgetService } from '../core/budget_service.js';
import { RecurrenceService } from '../core/recurrence_service.js';
import { DataService } from '../core/data_service.js';
import { pendingOccurrences } from '../core/recurrence.js';
import { evaluateBudgetAlerts } from '../core/alerts.js';
import { AppLock } from '../core/app_lock.js';
import { IndexedDbBackend } from '../data/backend_indexeddb.js';
import { LedgerStore } from '../data/ledger_store.js';
import { BackendLockSettingsStore } from '../data/lock_store.js';
import { PasscodeAuthenticator } from '../data/passcode_authenticator.js';
import { bindLockToStore, confirmWithPasscode, unlockWithPasscode } from '../data/unlock_flow.js';
import { APP_VERSION } from './version.js';
import { forgetBackupMemory } from './backup_memory.js';

export const PHASES = Object.freeze({ failed: 'failed', welcome: 'welcome', locked: 'locked', ready: 'ready' });

/** Kinds of AppError that describe a rule the person ran into, not a fault in the app. */
const EXPECTED_KINDS = new Set(['catalog', 'expense', 'budget', 'recurrence', 'money', 'backup']);

export class AppController {
  /**
   * Opens the storage and everything built on it. Rejects only when the browser will not give the app any storage
   * (the caller then shows an explanation instead of the app).
   */
  static async start({ backend = null, now = () => Date.now(), locale = null } = {}) {
    const database = backend || await IndexedDbBackend.open();
    const store = await LedgerStore.open(database);
    const lockStore = new BackendLockSettingsStore(database);
    const appLock = await AppLock.open(lockStore, now);
    return new AppController({ backend: database, store, lockStore, appLock, now, locale });
  }

  constructor({ backend, store, lockStore, appLock, now, locale }) {
    this.backend = backend;
    this.store = store;
    this.lockStore = lockStore;
    this.appLock = appLock;
    this.clock = now;
    this.locale = locale || defaultLocale();
    this.authenticator = new PasscodeAuthenticator(store);
    this.ui = null; // set by main.js: dialogs, sheets, toasts
    this.shell = null; // set by main.js while the tabs are showing
    this.listeners = new Set();
    this.inflight = new Set();
    this.alerts = [];
    this.dataVersion = 0;
    this.cache = { formatterKey: null, formatter: null, directoryVersion: -1, directory: null, indexVersion: -1, index: null };
    this.zone = null;
    this.lastDay = null;
    this.persisted = null;
    this.phase = this.computePhase();
    this.appearance = null;
    this.afterOpenBusy = false;
    this.evaluateQueued = false;
    this.disposed = false;
    this.lifecycleAttached = false;

    this.services = {
      expenses: new ExpenseService(store, now),
      categories: new CategoryService(store, now),
      methods: new PaymentMethodService(store, now),
      tags: new TagService(store, now),
      budgets: new BudgetService(store, now),
    };
    this.services.recurrence = new RecurrenceService(store, this.services.expenses, now);
    this.services.data = new DataService(store, this.services.expenses);

    this.unsubscribeStore = store.subscribe((_, reason) => this.onStoreChange(reason));
    this.bindLock();
    this.applyAppearance();
  }

  // ------------------------------------------------------------ phase

  computePhase() {
    if (this.store.state === 'empty') return PHASES.welcome;
    if (this.appLock.isLocked || this.store.state === 'locked') return PHASES.locked;
    return PHASES.ready;
  }

  bindLock() {
    if (this.unbindLock) this.unbindLock();
    if (this.unsubscribeLock) this.unsubscribeLock();
    this.unbindLock = bindLockToStore(this.appLock, this.store);
    this.unsubscribeLock = this.appLock.subscribe(() => this.onLockChange());
  }

  onLockChange() {
    this.updatePhase();
    this.emit({ type: 'lock' });
  }

  onStoreChange(reason) {
    this.dataVersion += 1;
    const changed = this.updatePhase();
    if (changed) return;
    if (this.phase === PHASES.ready && (reason === 'commit' || reason === 'replace')) {
      this.applyAppearance();
      this.emit({ type: 'data', reason });
      this.queueEvaluate();
    }
  }

  /** Recomputes the phase; announces a change. Returns true when it changed. */
  updatePhase() {
    const next = this.computePhase();
    if (next === this.phase) return false;
    this.phase = next;
    this.applyAppearance();
    this.emit({ type: 'phase', phase: next });
    return true;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
  }

  // ------------------------------------------------------------ what screens read

  get snapshot() { return this.store.snapshot; }
  get settings() { return this.store.snapshot.settings; }
  get currency() { return this.settings.currencyCode; }
  get isReady() { return this.phase === PHASES.ready; }
  get lockEnabled() { return this.appLock.settings.isEnabled; }

  get formatter() {
    const s = this.settings;
    const key = `${this.locale}|${s.numberFormat}|${s.dateFormat}|${s.timeFormat}`;
    if (this.cache.formatterKey !== key) {
      this.cache.formatter = new DisplayFormatter(s, this.locale);
      this.cache.formatterKey = key;
    }
    return this.cache.formatter;
  }

  /** Amount as text: "AED 1,234.50". */
  money(m, showCurrency = true) { return this.formatter.money.string(m, showCurrency); }

  get directory() {
    if (this.cache.directoryVersion !== this.dataVersion) {
      this.cache.directory = new LedgerDirectory(this.snapshot);
      this.cache.directoryVersion = this.dataVersion;
    }
    return this.cache.directory;
  }

  get searchIndex() {
    if (this.cache.indexVersion !== this.dataVersion) {
      this.cache.index = new ExpenseSearchIndex(this.snapshot.expenses, this.directory);
      this.cache.indexVersion = this.dataVersion;
    }
    return this.cache.index;
  }

  timeZone() {
    if (this.zone === null) this.zone = currentTimeZone();
    return this.zone;
  }

  now() { return this.clock(); }

  today() { return new CalendarContext(this.timeZone()).today(this.now()); }

  /** Repeating expenses that are waiting for the person to confirm them. */
  waitingOccurrences() {
    if (!this.isReady) return [];
    const templates = new Map(this.snapshot.templates.map((t) => [t.id, t]));
    return pendingOccurrences(this.snapshot, this.today()).filter((o) => {
      const template = templates.get(o.templateID);
      return template && template.mode === 'askToConfirm';
    });
  }

  applyAppearance() {
    const choice = this.phase === PHASES.ready ? this.settings.appearance : (this.appearance || 'system');
    if (choice === this.appearance && document.documentElement.dataset.theme === (choice === 'system' ? undefined : choice)) return;
    this.appearance = choice;
    if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
  }

  // ------------------------------------------------------------ running actions

  /**
   * Runs one action at a time per `key` (a second tap while the first is still working does nothing), optionally behind a
   * "working" cover, and shows a problem in words. Resolves { ok: true, value } or { ok: false }.
   */
  async perform(key, task, { busy = null, title = 'That did not work' } = {}) {
    if (this.inflight.has(key)) return { ok: false, busy: true };
    this.inflight.add(key);
    const done = busy && this.ui ? this.ui.busy(busy) : null;
    try {
      const value = await task();
      return { ok: true, value };
    } catch (error) {
      if (done) done();
      await this.reportError(error, title);
      return { ok: false, error };
    } finally {
      if (done) done();
      this.inflight.delete(key);
    }
  }

  errorMessage(error) {
    if (error instanceof AppError) return error.message;
    return 'Something went wrong, and nothing was changed.';
  }

  async reportError(error, title = 'That did not work') {
    if (!this.ui) return;
    if (error instanceof AppError && error.kind === 'storage' && error.code === 'conflict') {
      const reload = await this.ui.confirm({
        title: 'Changed in another window',
        message: error.message,
        confirmLabel: 'Reload',
        cancelLabel: 'Not now',
      });
      if (reload) await this.reload();
      return;
    }
    // A rule the person ran into (a name already used, an amount that is too large) is told to them in the alert and needs no
    // log line. Anything else is a fault, and only its kind is written to the console, never any of the person's data.
    const expected = error instanceof AppError && EXPECTED_KINDS.has(error.kind);
    if (!expected) console.error(`[expenses] ${error && error.name ? error.name : 'Error'}${error && error.code ? `: ${error.code}` : ''}`);
    await this.ui.alert({ title, message: this.errorMessage(error) });
  }

  async reload() {
    try {
      await this.store.reload();
    } catch (error) {
      await this.reportError(error, 'Could not reload');
      return;
    }
    this.dataVersion += 1;
    this.updatePhase();
    this.emit({ type: 'data', reason: 'reload' });
  }

  // ------------------------------------------------------------ starting out

  /** First start: stores the default categories (or nothing else) with the chosen basics, optionally protected by a passcode. */
  async createLedger({ currencyCode, firstWeekday, passcode = null, timeout = 0 }) {
    const snapshot = initialSnapshot(this.now(), firstWeekday);
    snapshot.settings = Object.freeze({ ...snapshot.settings, currencyCode });
    await this.store.initializeNew(snapshot, passcode === null ? {} : { passcode });
    if (passcode !== null) await this.appLock.didEnableProtection(timeout);
    await this.requestPersistence();
  }

  /** First start with a backup: stores its contents instead of the defaults. */
  async createLedgerFrom(snapshot, { passcode = null, timeout = 0 } = {}) {
    await this.store.initializeNew(snapshot, passcode === null ? {} : { passcode });
    if (passcode !== null) await this.appLock.didEnableProtection(timeout);
    await this.requestPersistence();
    await this.primeAlerts();
  }

  /**
   * Restoring a backup in Settings: swaps everything for `snapshot` (the passcode and lock settings are untouched).
   * Alerts already reached in the restored data are remembered silently, so old news is not announced as new.
   */
  async restoreSnapshot(snapshot) {
    this.evaluateQueued = true; // hold back the automatic alert check that a data change would start
    try {
      await this.store.replaceAll(snapshot);
      this.alerts = [];
      await this.primeAlerts();
    } finally {
      this.evaluateQueued = false;
    }
  }

  async updateSettings(patch) {
    const next = normalizeSettings({ ...this.settings, ...patch });
    const changes = new LedgerChangeSet();
    changes.settings = next;
    await this.store.commit(changes);
  }

  // ------------------------------------------------------------ the lock

  async unlock(passcode) {
    return unlockWithPasscode({ appLock: this.appLock, store: this.store, authenticator: this.authenticator, passcode });
  }

  lockNow() {
    this.appLock.lockNow();
  }

  /** True when the passcode typed is the right one (or no lock is set). Wrong answers count like on the lock screen. */
  async confirmPasscode(passcode) {
    return confirmWithPasscode({ appLock: this.appLock, authenticator: this.authenticator, passcode });
  }

  async enablePasscode(passcode, timeout = 0) {
    await this.store.enableProtection(passcode);
    await this.appLock.didEnableProtection(timeout);
  }

  async disablePasscode(passcode) {
    await this.store.disableProtection(passcode);
    await this.appLock.didDisableProtection();
  }

  async changePasscode(current, next) {
    await this.store.changePasscode(current, next);
  }

  async setLockTimeout(timeout) {
    return this.appLock.setTimeout(timeout);
  }

  /** Deletes everything this app stored (also the way out when the passcode is forgotten). */
  async eraseEverything() {
    await this.store.eraseEverything();
    forgetBackupMemory();
    this.alerts = [];
    this.appLock = await AppLock.open(this.lockStore, this.clock);
    this.bindLock();
    this.dataVersion += 1;
    this.updatePhase();
    this.emit({ type: 'lock' });
  }

  // ------------------------------------------------------------ alerts and repeating expenses

  queueEvaluate() {
    if (this.evaluateQueued) return;
    this.evaluateQueued = true;
    queueMicrotask(async () => {
      this.evaluateQueued = false;
      try {
        await this.evaluateAlerts();
      } catch (error) {
        console.error(`[expenses] alerts: ${error && error.code ? error.code : error && error.name}`);
      }
    });
  }

  /** Looks for budget alerts that are due. Shows them inside the app (nothing leaves the device). */
  async evaluateAlerts({ announce = true } = {}) {
    if (!this.isReady) return;
    const result = evaluateBudgetAlerts({
      snapshot: this.snapshot, today: this.today(), firedKeys: this.store.firedAlertKeys, formatter: this.formatter,
    });
    if (result.changed) await this.store.saveFiredAlertKeys(result.firedKeys);
    if (announce && result.messages.length > 0) {
      const known = new Set(this.alerts.map((a) => a.id));
      const fresh = result.messages.filter((m) => !known.has(m.id));
      if (fresh.length > 0) {
        this.alerts = [...this.alerts, ...fresh];
        this.emit({ type: 'alerts' });
      }
    }
  }

  /** After a restore: remember everything already reached, so old news is not announced as new. */
  async primeAlerts() {
    if (!this.isReady) return;
    await this.evaluateAlerts({ announce: false });
  }

  dismissAlert(id) {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.emit({ type: 'alerts' });
  }

  /** When the app opens, comes back to the front, or the day changes: record what is due, then check budgets. */
  async afterOpen() {
    if (!this.isReady || this.afterOpenBusy) return;
    this.afterOpenBusy = true;
    try {
      this.zone = null;
      this.lastDay = this.today().raw;
      const result = await this.services.recurrence.run(this.today());
      if (result.recorded.length > 0 && this.ui) {
        const count = result.recorded.length;
        this.ui.toast(`${count} repeating ${count === 1 ? 'expense was' : 'expenses were'} added.`);
      }
      if (result.failedTemplateIDs.length > 0 && this.ui) {
        this.ui.toast('A repeating expense could not be added. Open Repeating expenses to check it.');
      }
      await this.evaluateAlerts();
      this.emit({ type: 'data', reason: 'afterOpen' });
    } catch (error) {
      await this.reportError(error, 'Could not update repeating expenses');
    } finally {
      this.afterOpenBusy = false;
    }
  }

  // ------------------------------------------------------------ the app going away and coming back

  attachLifecycle() {
    if (this.lifecycleAttached) return;
    this.lifecycleAttached = true;
    this.onVisibility = () => (document.visibilityState === 'hidden' ? this.goingAway() : this.comingBack());
    this.onPageHide = () => this.goingAway();
    this.onPageShow = (event) => { if (event.persisted) this.comingBack(); };
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    this.dayTimer = setInterval(() => this.checkDay(), 30_000);
  }

  detachLifecycle() {
    if (!this.lifecycleAttached) return;
    this.lifecycleAttached = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    clearInterval(this.dayTimer);
  }

  coverElement() {
    return document.getElementById('cover');
  }

  goingAway() {
    // Cover the screen first: the picture iOS keeps for the app switcher is taken about now (best effort; see Privacy).
    const cover = this.coverElement();
    if (cover && this.phase === PHASES.ready && this.settings.hideContentInAppSwitcher) cover.hidden = false;
    this.appLock.sceneDidEnterBackground();
  }

  comingBack() {
    this.appLock.sceneWillEnterForeground();
    const cover = this.coverElement();
    if (cover) cover.hidden = true;
    this.zone = null;
    if (this.isReady) this.afterOpen();
  }

  checkDay() {
    if (!this.isReady || document.visibilityState === 'hidden') return;
    const today = this.today().raw;
    if (this.lastDay !== null && today !== this.lastDay) this.afterOpen();
  }

  // ------------------------------------------------------------ storage facts

  async requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) this.persisted = await navigator.storage.persist();
    } catch {
      this.persisted = null;
    }
    return this.persisted;
  }

  async storageFacts() {
    const facts = { persisted: null, usage: null, quota: null };
    try {
      if (navigator.storage && navigator.storage.persisted) facts.persisted = await navigator.storage.persisted();
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        facts.usage = typeof estimate.usage === 'number' ? estimate.usage : null;
        facts.quota = typeof estimate.quota === 'number' ? estimate.quota : null;
      }
    } catch {
      // The browser does not say; the screen shows "unknown".
    }
    return facts;
  }

  /** Counts and settings only. Never any amount, name or note. */
  diagnostics() {
    const s = this.snapshot;
    return {
      appVersion: APP_VERSION,
      expenses: s.expenses.length,
      categories: s.categories.length,
      subcategories: s.subcategories.length,
      paymentMethods: s.paymentMethods.length,
      tags: s.tags.length,
      budgets: s.budgets.length,
      repeating: s.templates.length,
      repeatingLog: s.recurrenceLog.length,
      unreadableRecords: this.store.unreadableCount,
      passcodeSet: this.store.isProtected,
      timeZone: this.timeZone(),
    };
  }

  dispose() {
    this.disposed = true;
    this.detachLifecycle();
    if (this.unsubscribeStore) this.unsubscribeStore();
    if (this.unsubscribeLock) this.unsubscribeLock();
    if (this.unbindLock) this.unbindLock();
  }
}
