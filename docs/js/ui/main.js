// Start-up: opens the stored data, then shows whichever screen fits (first start, locked, or the tabs), and keeps it that way
// as the data and the lock change. This is the only file index.html loads.

import { h } from './dom.js';
import { AppController, PHASES } from './controller.js';
import { Layers } from './layers.js';
import { Shell } from './shell.js';
import { createWelcome } from './screens/welcome.js';
import { createLockScreen } from './screens/lock.js';
import { tabFactories } from './screens/tabs.js';
import { button } from './components.js';
import { STORAGE_MESSAGES } from '../data/stores.js';

const root = document.getElementById('app');
const boot = document.getElementById('boot');

function showFailure(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'failed';
  const message = STORAGE_MESSAGES[code] || STORAGE_MESSAGES.unavailable;
  console.error(`[expenses] could not open: ${error && error.name ? error.name : 'Error'}${error && error.code ? `: ${error.code}` : ''}`);
  root.replaceChildren(h('main', { class: 'failure' },
    h('div', { class: 'failure-card' },
      h('h1', null, 'Can’t open your expenses'),
      h('p', null, message),
      button('Try again', { onClick: () => location.reload() }))));
  if (boot) boot.remove();
}

async function main() {
  const modeHost = h('div', { class: 'mode-host' });
  const layerHost = h('div', { class: 'layer-host' });
  const toastHost = h('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
  root.replaceChildren(modeHost, layerHost, toastHost);

  let app;
  try {
    app = await AppController.start();
  } catch (error) {
    showFailure(error);
    return;
  }

  const layers = new Layers({
    layerHost,
    toastHost,
    modeHost,
    pageDepth: () => (app.shell ? app.shell.pageDepth : 0),
    popPage: () => { if (app.shell) app.shell.popFromGesture(); },
  });
  layers.app = app;
  app.ui = layers;

  let current = null; // { phase, screen }

  /** Takes everything off the page. A locked app leaves nothing of the person's data in the page. */
  function clearScreen() {
    layers.closeAll();
    toastHost.replaceChildren(); // a message about the ledger must not stay on the lock screen
    if (app.shell) {
      app.shell.destroy();
      app.shell = null;
    }
    if (current && current.screen && current.screen.destroy) current.screen.destroy();
    current = null;
    modeHost.replaceChildren();
  }

  function render() {
    const phase = app.phase;
    if (current && current.phase === phase) return;
    clearScreen();
    if (phase === PHASES.welcome) {
      const screen = createWelcome(app);
      modeHost.replaceChildren(screen.el);
      current = { phase, screen };
    } else if (phase === PHASES.locked) {
      const screen = createLockScreen(app);
      modeHost.replaceChildren(screen.el);
      current = { phase, screen };
      screen.focus();
    } else if (phase === PHASES.ready) {
      const shell = new Shell(modeHost, app, layers, tabFactories);
      app.shell = shell;
      current = { phase, screen: null };
      shell.start('home');
      app.afterOpen();
    }
  }

  app.subscribe((event) => {
    if (event.type === 'phase') {
      render();
    } else if (event.type === 'lock') {
      if (current && current.screen && current.screen.refresh) current.screen.refresh();
    } else if (event.type === 'data' || event.type === 'alerts') {
      if (app.shell) app.shell.refresh();
    }
  });

  render();
  app.attachLifecycle();
  if (boot) boot.remove();
  // Only on a developer's own machine, for the browser tests. A published app does not hand its controller to the page.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') window.__expensesApp = app;
  followViewport();
  watchSystemAppearance(app);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    console.error(`[expenses] unhandled: ${reason && reason.name ? reason.name : 'Error'}${reason && reason.code ? `: ${reason.code}` : ''}`);
  });

  registerServiceWorker();
}

/**
 * iPhone keyboards cover the page instead of resizing it. The app is kept the size of the part of the screen that can
 * really be seen, so the sheet being typed into is never hidden behind the keyboard. (Not checked on a real iPhone.)
 */
function followViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty('--app-h', `${Math.round(viewport.height)}px`);
    // iOS can leave the page scrolled after the keyboard closes; the app has no page scroll of its own.
    if (viewport.offsetTop !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  apply();
}

/** When the phone switches between light and dark and the app follows the system, charts and colours are redrawn. */
function watchSystemAppearance(app) {
  if (!window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const changed = () => { if (app.shell && app.settings.appearance === 'system') app.shell.refresh(); };
  if (query.addEventListener) query.addEventListener('change', changed);
  else if (query.addListener) query.addListener(changed);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure || new URLSearchParams(location.search).has('nosw')) return;
  navigator.serviceWorker.register('sw.js').catch(() => {
    // Without it the app still works; it just cannot start without a connection.
  });
}

main();
