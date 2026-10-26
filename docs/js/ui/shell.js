// The frame of the running app: the five tabs and the pages pushed on top of them. Sheets, dialogs and messages are in
// layers.js; the shell tells it when a page is pushed or closed so the back gesture knows about pages too.

import { h } from './dom.js';
import { icon } from './icons.js';

export const TABS = Object.freeze([
  Object.freeze({ id: 'home', title: 'Home', icon: 'home' }),
  Object.freeze({ id: 'transactions', title: 'Transactions', icon: 'list' }),
  Object.freeze({ id: 'reports', title: 'Reports', icon: 'chart' }),
  Object.freeze({ id: 'budgets', title: 'Budgets', icon: 'wallet' }),
  Object.freeze({ id: 'settings', title: 'Settings', icon: 'sliders' }),
]);

export class Shell {
  /**
   * @param modeHost   the element the tabs are drawn into
   * @param app        passed to every screen factory: factory(app, params, handle)
   * @param layers     the Layers object (sheets, dialogs, toasts)
   * @param factories  { home: fn, transactions: fn, ... } the root screen of each tab
   */
  constructor(modeHost, app, layers, factories) {
    this.modeHost = modeHost;
    this.app = app;
    this.layers = layers;
    this.factories = factories;
    this.current = 'home';
    this.tabs = new Map();
    this.refreshQueued = false;
    this.destroyed = false;

    this.tabsRoot = h('div', { class: 'tabs-root' });
    this.tabbar = h('nav', { class: 'tabbar', role: 'tablist', 'aria-label': 'Main' });
    for (const tab of TABS) {
      const view = h('div', { class: 'tabview', role: 'tabpanel', 'aria-labelledby': `tab-${tab.id}`, hidden: tab.id !== this.current });
      this.tabsRoot.appendChild(view);
      this.tabs.set(tab.id, { view, entries: [] });
      this.tabbar.appendChild(h('button', {
        class: 'tab', role: 'tab', id: `tab-${tab.id}`, 'aria-selected': tab.id === this.current ? 'true' : 'false', dataset: { tab: tab.id },
        onClick: () => this.selectTab(tab.id),
      }, icon(tab.icon), h('span', null, tab.title)));
    }
    modeHost.replaceChildren(this.tabsRoot, this.tabbar);
  }

  // ------------------------------------------------------------ what the layers need to know

  get pageDepth() {
    return Math.max(0, this.tabs.get(this.current).entries.length - 1);
  }

  /** The back gesture asks for the top page to close. */
  popFromGesture() {
    const tab = this.tabs.get(this.current);
    if (tab.entries.length > 1) this.removeTopPage(tab);
  }

  // ------------------------------------------------------------ tabs

  start(tabId = 'home') {
    this.current = tabId;
    this.showTab(tabId, true);
  }

  ensureRoot(id) {
    const tab = this.tabs.get(id);
    if (tab.entries.length > 0) return;
    const entry = this.makeEntry(this.factories[id], {}, tab.view, false);
    entry.dirty = true; // a tab's first screen is drawn when the tab is first shown
    tab.entries.push(entry);
  }

  makeEntry(factory, params, host, animate) {
    const handle = { shell: this, params, close: () => this.pop() };
    const screen = factory(this.app, params, handle);
    const entry = { screen, el: screen.el, dirty: false, scrollTop: 0 };
    host.appendChild(screen.el);
    if (animate) {
      screen.el.classList.add('enter');
      screen.el.addEventListener('animationend', () => screen.el.classList.remove('enter'), { once: true });
    }
    return entry;
  }

  showTab(id, first = false) {
    for (const tab of TABS) this.tabs.get(tab.id).view.hidden = tab.id !== id;
    for (const button of this.tabbar.querySelectorAll('.tab')) {
      button.setAttribute('aria-selected', button.dataset.tab === id ? 'true' : 'false');
    }
    this.ensureRoot(id);
    const top = this.tabs.get(id).entries.at(-1);
    if (top.dirty || first) this.refreshEntry(top);
    if (top.screen.onShow) top.screen.onShow();
  }

  selectTab(id) {
    if (this.destroyed) return;
    if (id === this.current) {
      if (this.pageDepth > 0) this.popToRoot();
      else {
        const scroller = this.tabs.get(id).entries[0].el.querySelector('.page-scroll');
        if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }
    this.popToRoot();
    this.current = id;
    this.showTab(id);
  }

  // ------------------------------------------------------------ pages

  push(factory, params = {}) {
    const tab = this.tabs.get(this.current);
    const below = tab.entries.at(-1);
    const scroller = below.el.querySelector('.page-scroll');
    below.scrollTop = scroller ? scroller.scrollTop : 0;
    const entry = this.makeEntry(factory, params, tab.view, true);
    tab.entries.push(entry);
    below.el.dataset.state = 'covered';
    below.el.inert = true;
    this.refreshEntry(entry);
    this.layers.update();
    requestAnimationFrame(() => {
      const target = entry.el.querySelector('[data-autofocus]');
      if (target) target.focus({ preventScroll: true });
    });
    return entry;
  }

  /** Closes the top pushed page of the current tab (or the top sheet, if one is open). */
  pop() {
    if (this.layers.isOpen) {
      this.layers.dismissTop();
      return;
    }
    const tab = this.tabs.get(this.current);
    if (tab.entries.length <= 1) return;
    this.removeTopPage(tab);
    this.layers.update();
  }

  removeTopPage(tab) {
    const entry = tab.entries.pop();
    if (entry.screen.destroy) entry.screen.destroy();
    entry.el.remove();
    const below = tab.entries.at(-1);
    below.el.inert = false;
    delete below.el.dataset.state;
    if (below.dirty) this.refreshEntry(below);
    const scroller = below.el.querySelector('.page-scroll');
    if (scroller) scroller.scrollTop = below.scrollTop;
    if (below.screen.onShow) below.screen.onShow();
  }

  popToRoot() {
    const tab = this.tabs.get(this.current);
    let closed = 0;
    while (tab.entries.length > 1) {
      this.removeTopPage(tab);
      closed += 1;
    }
    if (closed > 0) this.layers.update();
  }

  // ------------------------------------------------------------ keeping screens up to date

  refreshEntry(entry) {
    entry.dirty = false;
    if (entry.screen && entry.screen.refresh) entry.screen.refresh();
  }

  /** Call after the data changed. Visible screens redraw now (once per turn); the others redraw when they are shown again. */
  refresh() {
    if (this.refreshQueued || this.destroyed) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.destroyed) return;
      for (const [id, tab] of this.tabs) {
        tab.entries.forEach((entry, index) => {
          const visible = id === this.current && index === tab.entries.length - 1;
          if (visible) this.refreshEntry(entry);
          else entry.dirty = true;
        });
      }
      for (const layer of this.layers.layers) {
        if (layer.screen && layer.screen.refresh) layer.screen.refresh();
      }
    });
  }

  // ------------------------------------------------------------ teardown

  /** Removes everything that was drawn (used when the app locks, so nothing is left on the page). */
  destroy() {
    this.destroyed = true;
    this.layers.closeAll();
    for (const tab of this.tabs.values()) {
      for (const entry of tab.entries) if (entry.screen && entry.screen.destroy) entry.screen.destroy();
      tab.entries = [];
      tab.view.replaceChildren();
    }
    this.modeHost.replaceChildren();
    this.layers.update();
  }
}
