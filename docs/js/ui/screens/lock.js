// The lock screen: shown whenever a passcode is set and the app has just been opened (or left for longer than the chosen time).
// It contains no financial information at all, so a picture of it in the app switcher reveals nothing.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { button } from '../components.js';
import { lockNoticeMessage } from '../../core/app_lock.js';
import { VAULT_MESSAGES } from '../../core/vault.js';
import { STORAGE_MESSAGES } from '../../data/stores.js';
import { eraseWithConfirmation } from './erase.js';

function problemMessage(code) {
  if (!code) return null;
  return STORAGE_MESSAGES[code] || VAULT_MESSAGES[code] || 'The data could not be opened.';
}

export function createLockScreen(app) {
  let numeric = true;
  let working = false;
  let problem = null;
  let timer = null;

  const input = h('input', {
    class: 'input lock-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none',
    spellcheck: 'false', 'aria-label': 'Passcode', placeholder: 'Passcode', 'data-autofocus': '',
  });
  // No <form> on purpose: a password field inside a form can make the browser offer to save the passcode in a password manager.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  const message = h('p', { class: 'lock-message', role: 'status', 'aria-live': 'polite' });
  const unlockButton = button('Unlock', { block: true, onClick: () => submit() });
  const modeButton = h('button', { type: 'button', class: 'link-button', onClick: () => toggleMode() }, 'Use letters and numbers');
  const forgot = h('button', { type: 'button', class: 'link-button subtle', onClick: () => forgotPasscode() }, 'Forgot passcode?');

  const el = h('main', { class: 'lock', 'aria-label': 'Locked' },
    h('div', { class: 'lock-card' },
      h('div', { class: 'lock-mark', 'aria-hidden': 'true' }, icon('lock', { size: '1.9rem' })),
      h('h1', { class: 'lock-title' }, 'Expenses'),
      h('p', { class: 'lock-sub' }, 'Enter your passcode to open your expenses.'),
      h('div', { class: 'lock-form' }, input, message, unlockButton),
      h('div', { class: 'lock-links' }, modeButton, forgot)));

  function toggleMode() {
    numeric = !numeric;
    input.setAttribute('inputmode', numeric ? 'numeric' : 'text');
    modeButton.textContent = numeric ? 'Use letters and numbers' : 'Use number pad';
    input.blur();
    input.focus();
  }

  function remaining() {
    return app.appLock.lockoutRemainingSeconds();
  }

  function render() {
    const wait = remaining();
    const notice = app.appLock.notice;
    let text = problemMessage(problem);
    if (!text) text = notice === 'lockedOut' || wait > 0 ? lockNoticeMessage('lockedOut', wait) : lockNoticeMessage(notice, wait);
    message.textContent = text || '';
    message.classList.toggle('bad', Boolean(text) && (notice === 'failed' || notice === 'lockedOut' || wait > 0 || Boolean(problem)));
    const blocked = working || wait > 0;
    unlockButton.disabled = blocked;
    unlockButton.textContent = working ? 'Checking…' : 'Unlock';
    input.disabled = working || wait > 0;
    if (wait > 0 && timer === null) timer = setInterval(render, 1000);
    if (wait <= 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      if (!working) input.focus({ preventScroll: true });
    }
  }

  async function submit() {
    if (working || remaining() > 0) return;
    const value = input.value;
    if (value === '') {
      problem = null;
      message.textContent = 'Enter your passcode.';
      message.classList.add('bad');
      input.focus();
      return;
    }
    working = true;
    problem = null;
    render();
    let result;
    try {
      result = await app.unlock(value);
    } finally {
      working = false;
    }
    input.value = '';
    if (!result.unlocked) {
      problem = result.problem;
      render();
      if (remaining() <= 0) input.focus({ preventScroll: true });
    }
    // When it did unlock, the controller announces the new phase and this screen is replaced.
  }

  async function forgotPasscode() {
    const erased = await eraseWithConfirmation(app, {
      title: 'Forgot your passcode?',
      message: 'Your expenses are locked with that passcode, and it cannot be recovered or reset. The only way forward is to erase everything stored in this app and start again. If you made a backup file, you can restore it afterwards.',
    });
    if (erased) problem = null;
  }

  render();
  return {
    el,
    refresh: render,
    destroy() {
      if (timer !== null) clearInterval(timer);
      input.value = '';
    },
    focus() { input.focus({ preventScroll: true }); },
  };
}
