// Things that appear on top of the screen: sheets that slide up, dialogs, choice lists, a "working…" cover and short
// messages. It also owns the one browser-history step that lets the iPhone's back gesture close the top layer.
//
// Back gesture: while anything is open on top of a screen (a layer here, or a page pushed by the shell), one history entry is
// added, so swiping back closes the top layer instead of leaving the app. The visible Back and Cancel buttons never depend on
// it: they close the layer directly, and a missing or odd history simply means the gesture does nothing.

import { h } from './dom.js';

/** How long nothing must be open before the extra history entry is taken away again. */
const QUIET_MS = 90;
/** The longest to wait for the browser to report a step back before carrying on. */
const UNWIND_LIMIT_MS = 700;

function focusableIn(root) {
  return Array.from(root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.closest('[hidden]') && !el.closest('[inert]'));
}

export class Layers {
  /**
   * @param layerHost   where layer elements are added
   * @param toastHost   where short messages are shown
   * @param modeHost    the screen content underneath; it is made inert while a layer is open
   * @param pageDepth   () => number of pages the shell has pushed (they count for the back gesture)
   * @param popPage     () => void, closes the shell's top page (used by the back gesture)
   */
  constructor({ layerHost, toastHost, modeHost, pageDepth = () => 0, popPage = () => {} }) {
    this.layerHost = layerHost;
    this.toastHost = toastHost;
    this.modeHost = modeHost;
    this.pageDepth = pageDepth;
    this.popPage = popPage;
    this.app = null;
    this.layers = [];
    this.armed = false; // our one extra history entry is on top of the history
    this.unwinding = false; // we asked the browser to go back and its answer has not arrived yet
    this.disarmTimer = null;
    this.unwindTimer = null;
    this.disposed = false;
    this.onPop = () => this.handlePop();
    this.onKey = (event) => this.handleKey(event);
    window.addEventListener('popstate', this.onPop);
    document.addEventListener('keydown', this.onKey);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('popstate', this.onPop);
    document.removeEventListener('keydown', this.onKey);
    this.closeAll();
    this.toastHost.replaceChildren();
    this.cancelDisarm();
    if (this.unwindTimer !== null) clearTimeout(this.unwindTimer);
    this.unwindTimer = null;
    if (this.armed) {
      this.armed = false;
      try { history.back(); } catch { /* nothing to undo */ }
    }
  }

  get isOpen() { return this.layers.length > 0; }

  // ------------------------------------------------------------ the stack

  push(layer) {
    this.layerHost.appendChild(layer.el);
    this.layers.push(layer);
    this.syncInert();
    this.update();
  }

  close(layer, value) {
    const index = this.layers.indexOf(layer);
    if (index < 0) return;
    while (this.layers.length > index + 1) this.close(this.layers.at(-1), undefined);
    this.layers.pop();
    if (layer.screen && layer.screen.destroy) layer.screen.destroy();
    layer.el.remove();
    this.syncInert();
    const opener = layer.opener;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    layer.resolve(value);
    this.update();
  }

  closeAll() {
    while (this.layers.length > 0) this.close(this.layers.at(-1), undefined);
  }

  /** Escape, the back gesture and a tap on the dark area all end up here. Returns true if a layer took it. */
  dismissTop() {
    const layer = this.layers.at(-1);
    if (!layer) return false;
    if (layer.kind === 'busy') return true;
    if (layer.screen && typeof layer.screen.dismissible === 'function' && layer.screen.dismissible() === false) return true;
    this.close(layer, layer.cancelValue);
    return true;
  }

  syncInert() {
    this.modeHost.inert = this.layers.length > 0;
    this.layers.forEach((layer, index) => { layer.el.inert = index < this.layers.length - 1; });
  }

  // ------------------------------------------------------------ sheets

  /**
   * Slides a sheet up. `factory(app, params, handle)` returns { el, refresh?, destroy?, dismissible? }.
   * Call handle.close(value) to dismiss it. Returns { closed, handle } where `closed` resolves with that value.
   */
  present(factory, params = {}, { compact = false } = {}) {
    let resolve;
    const closed = new Promise((done) => { resolve = done; });
    const layer = { kind: 'sheet', el: null, screen: null, resolve, opener: document.activeElement, cancelValue: undefined };
    const handle = { params, close: (value) => this.close(layer, value) };
    layer.handle = handle;
    const screen = factory(this.app, params, handle);
    layer.screen = screen;
    const sheet = h('section', { class: ['sheet', compact ? 'compact-sheet' : ''], role: 'dialog', 'aria-modal': 'true', 'aria-label': screen.label || null }, screen.el);
    const backdrop = h('div', { class: 'backdrop', onClick: () => this.dismissTop() });
    layer.el = h('div', { class: 'layer sheet-layer' }, backdrop, sheet);
    this.push(layer);
    if (screen.refresh) screen.refresh();
    this.focusFirst(sheet);
    return { closed, handle };
  }

  focusFirst(container) {
    requestAnimationFrame(() => {
      if (!container.isConnected) return;
      const target = container.querySelector('[data-autofocus]');
      if (target) {
        target.focus({ preventScroll: true });
      } else {
        container.setAttribute('tabindex', '-1');
        container.focus({ preventScroll: true });
      }
    });
  }

  // ------------------------------------------------------------ dialogs

  dialog({ title, message, buttons, cancelValue = null, body = null, vertical = false }) {
    return new Promise((resolve) => {
      const layer = { kind: 'dialog', el: null, screen: null, resolve, opener: document.activeElement, cancelValue };
      const handle = { close: (value) => this.close(layer, value) };
      layer.handle = handle;
      const actionEls = buttons.map((button) => h('button', {
        type: 'button', dataset: { role: button.role || 'normal' }, 'data-autofocus': button.primary ? '' : null, onClick: () => handle.close(button.value),
      }, button.label));
      const box = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title || message || 'Message' },
        h('div', { class: 'dialog-body' },
          title ? h('h2', { class: 'dialog-title' }, title) : null,
          message ? h('p', { class: 'dialog-message' }, message) : null,
          body),
        h('div', { class: ['dialog-actions', vertical ? '' : 'row-actions'] }, actionEls));
      layer.el = h('div', { class: 'layer dialog-layer' }, h('div', { class: 'backdrop' }), box);
      this.push(layer);
      this.trapTab(box);
      requestAnimationFrame(() => {
        const first = box.querySelector('input') || box.querySelector('[data-autofocus]') || actionEls[actionEls.length - 1];
        if (first) first.focus({ preventScroll: true });
      });
    });
  }

  confirm({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', destructive = false }) {
    return this.dialog({
      title,
      message,
      cancelValue: false,
      buttons: [
        { label: cancelLabel, value: false, primary: destructive },
        { label: confirmLabel, value: true, role: destructive ? 'destructive' : 'primary', primary: !destructive },
      ],
    });
  }

  alert({ title, message, okLabel = 'OK' }) {
    return this.dialog({ title, message, cancelValue: undefined, buttons: [{ label: okLabel, value: undefined, role: 'primary', primary: true }] });
  }

  /** Asks for some text. Resolves with the typed text, or null when cancelled. */
  prompt({ title, message, placeholder = '', value = '', confirmLabel = 'OK', secure = false, inputMode = null, maxLength = null, label = null }) {
    const input = h('input', {
      class: 'input', type: secure ? 'password' : 'text', value, placeholder, autocomplete: 'off', autocapitalize: secure ? 'none' : 'sentences',
      autocorrect: 'off', spellcheck: 'false', inputmode: inputMode, maxlength: maxLength, 'aria-label': label || title || 'Text',
    });
    const promise = this.dialog({
      title,
      message,
      cancelValue: null,
      body: h('div', { class: 'dialog-field' }, input),
      buttons: [
        { label: 'Cancel', value: null },
        { label: confirmLabel, value: '__submit__', role: 'primary' },
      ],
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const submit = input.closest('.dialog').querySelector('[data-role="primary"]');
      if (submit) submit.click();
    });
    return promise.then((result) => (result === '__submit__' ? input.value : null));
  }

  /** A list of choices from the bottom of the screen. Resolves with the chosen value, or undefined when cancelled. */
  actions({ title = null, options, cancelLabel = 'Cancel' }) {
    return new Promise((resolve) => {
      const layer = { kind: 'actions', el: null, screen: null, resolve, opener: document.activeElement, cancelValue: undefined };
      const handle = { close: (value) => this.close(layer, value) };
      layer.handle = handle;
      const buttons = options.map((option) => h('button', {
        type: 'button', dataset: { role: option.destructive ? 'destructive' : 'normal' }, role: 'menuitemradio',
        'aria-checked': option.checked ? 'true' : 'false', onClick: () => handle.close(option.value),
      }, option.label));
      const group = h('div', { class: 'action-group', role: 'menu' }, title ? h('div', { class: 'action-title' }, title) : null, buttons);
      const cancel = h('div', { class: 'action-group' }, h('button', { type: 'button', class: 'cancel', onClick: () => handle.close(undefined) }, cancelLabel));
      const sheet = h('div', { class: 'action-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Choose' }, group, cancel);
      layer.el = h('div', { class: 'layer sheet-layer' }, h('div', { class: 'backdrop', onClick: () => handle.close(undefined) }), sheet);
      this.push(layer);
      this.trapTab(sheet);
      requestAnimationFrame(() => {
        const first = buttons.find((button) => button.getAttribute('aria-checked') === 'true') || buttons[0];
        if (first) first.focus({ preventScroll: true });
      });
    });
  }

  trapTab(container) {
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const items = focusableIn(container);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  /** Blocks the screen while something slow runs. Returns a function that removes the cover. */
  busy(message = 'Working…') {
    const layer = { kind: 'busy', el: null, screen: null, resolve: () => {}, opener: document.activeElement, cancelValue: undefined };
    layer.el = h('div', { class: 'layer busy-layer', role: 'alert', 'aria-busy': 'true' },
      h('div', { class: 'backdrop' }),
      h('div', { class: 'busy-box' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, message)));
    this.push(layer);
    return () => {
      if (this.layers.includes(layer)) this.close(layer);
    };
  }

  async working(message, task) {
    const done = this.busy(message);
    try {
      return await task();
    } finally {
      done();
    }
  }

  toast(message, { action = null, duration = 3600 } = {}) {
    let timer = null;
    const remove = () => {
      clearTimeout(timer);
      el.remove();
    };
    const el = h('div', { class: 'toast' }, h('span', null, message),
      action ? h('button', { type: 'button', onClick: () => { remove(); action.onClick(); } }, action.label) : null);
    timer = setTimeout(remove, action ? Math.max(duration, 6000) : duration);
    this.toastHost.appendChild(el);
    while (this.toastHost.children.length > 3) this.toastHost.firstElementChild.remove();
    return remove;
  }

  // ------------------------------------------------------------ the back gesture
  //
  // One history entry is added while anything is open on top of a screen, and taken away again afterwards. The two steps must
  // never overlap: a browser that is asked to go back and to add an entry at nearly the same moment can end up one step too
  // far back, which in a Safari tab would leave the app. So the entry is removed only after a short quiet moment (a sheet
  // closing and a dialog opening straight after it keep the same entry), and no new one is added while a step back is still
  // under way.

  /** Call whenever a layer or a pushed page opened or closed. */
  update() {
    if (this.disposed) return;
    const count = this.layers.length + this.pageDepth();
    if (count > 0) {
      this.cancelDisarm();
      if (!this.armed && !this.unwinding) this.arm();
    } else if (this.armed && this.disarmTimer === null) {
      this.disarmTimer = setTimeout(() => this.disarm(), QUIET_MS);
    }
  }

  arm() {
    try {
      history.pushState({ expensesLayer: true }, '');
      this.armed = true;
    } catch {
      this.armed = false;
    }
  }

  cancelDisarm() {
    if (this.disarmTimer === null) return;
    clearTimeout(this.disarmTimer);
    this.disarmTimer = null;
  }

  disarm() {
    this.disarmTimer = null;
    if (!this.armed || this.disposed) return;
    if (this.layers.length + this.pageDepth() > 0) return; // something opened in the meantime: keep the entry
    this.armed = false;
    this.unwinding = true;
    try {
      history.back();
    } catch {
      this.unwinding = false;
      return;
    }
    // If the browser never reports the step back, carry on anyway rather than waiting for ever.
    this.unwindTimer = setTimeout(() => this.finishUnwind(), UNWIND_LIMIT_MS);
  }

  finishUnwind() {
    this.unwinding = false;
    if (this.unwindTimer !== null) clearTimeout(this.unwindTimer);
    this.unwindTimer = null;
    this.update(); // something may have opened while the step back was under way
  }

  handlePop() {
    if (this.disposed) return;
    if (this.unwinding) {
      this.finishUnwind(); // this is the step we asked for, not the person's
      return;
    }
    if (!this.armed) return;
    this.armed = false; // the browser just used up our step
    this.cancelDisarm();
    if (this.layers.length > 0) this.dismissTop();
    else if (this.pageDepth() > 0) this.popPage();
    this.update();
  }

  handleKey(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (this.layers.length > 0) {
      event.preventDefault();
      this.dismissTop();
    } else if (this.pageDepth() > 0) {
      event.preventDefault();
      this.popPage();
      this.update();
    }
  }
}
