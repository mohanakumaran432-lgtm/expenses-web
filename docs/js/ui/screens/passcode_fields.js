// The two boxes (and the advice under them) used whenever a new passcode is chosen: first start, and Settings.
// The same boxes choose the password of a backup file; `noun` and `copied` change the words.

import { h } from '../dom.js';
import { PASSCODE_PROBLEMS, STRENGTH_NOTES, checkNewPasscode } from '../../core/vault.js';

const DEFAULT_HINT = 'Use at least 6 digits, or 8 or more letters and numbers. Longer is stronger. There is no way to recover a forgotten passcode.';

/**
 * Returns { el, read(), focus(), reset() }.
 * read() gives { ok, passcode, message }: `ok` is true only when the passcode is acceptable and typed the same twice.
 *
 * @param noun          what is being chosen: 'passcode' (default) or 'password'
 * @param copied        what an attacker would have to copy to guess it offline ("your stored data", "the backup file")
 * @param hint          the advice shown while nothing has been typed
 * @param startWithText start with the full keyboard instead of the number pad
 */
export function passcodeFields({
  onChange = () => {}, label = 'Passcode', confirmLabel = 'Type it again', noun = 'passcode', copied = 'your stored data', hint = null, startWithText = false,
} = {}) {
  let numeric = !startWithText;
  const say = (text) => (noun === 'passcode' ? text : text.replaceAll('passcodes', `${noun}s`).replaceAll('passcode', noun).replaceAll('Passcode', noun[0].toUpperCase() + noun.slice(1)));
  const note = (strength) => STRENGTH_NOTES[strength].replace('your stored data', copied);
  const mode = () => (numeric ? 'numeric' : 'text');
  const first = h('input', {
    class: 'input', type: 'password', inputmode: mode(), autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false',
    'aria-label': label, placeholder: label,
  });
  const second = h('input', {
    class: 'input', type: 'password', inputmode: mode(), autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false',
    'aria-label': confirmLabel, placeholder: confirmLabel,
  });
  const advice = h('p', { class: 't-foot', role: 'status', 'aria-live': 'polite' });
  const switchLabel = () => (numeric ? 'Use letters and numbers instead' : 'Use a number pad instead');
  const toggle = h('button', { type: 'button', class: 'link-button', onClick: () => {
    numeric = !numeric;
    for (const input of [first, second]) input.setAttribute('inputmode', mode());
    toggle.textContent = switchLabel();
    first.blur();
    first.focus();
  } }, switchLabel());

  function read() {
    const typed = first.value;
    const again = second.value;
    const check = checkNewPasscode(typed);
    if (!check.ok) return { ok: false, passcode: null, message: typed === '' ? '' : say(PASSCODE_PROBLEMS[check.problem]), strength: null };
    if (again === '') return { ok: false, passcode: null, message: say(note(check.strength)), strength: check.strength, waitingForSecond: true };
    if (again !== typed) return { ok: false, passcode: null, message: `The two ${noun}s are not the same.`, strength: check.strength, mismatch: true };
    return { ok: true, passcode: typed, message: say(note(check.strength)), strength: check.strength };
  }

  function update() {
    const state = read();
    advice.textContent = state.message || hint || say(DEFAULT_HINT);
    advice.classList.toggle('t-bad', Boolean(state.message) && !state.ok && (state.mismatch || (first.value !== '' && !state.waitingForSecond)));
    onChange(state);
  }

  first.addEventListener('input', update);
  second.addEventListener('input', update);
  update();

  return {
    el: h('div', { class: 'stack-s' }, first, second, advice, toggle),
    read,
    focus() { first.focus(); },
    reset() {
      first.value = '';
      second.value = '';
      update();
    },
  };
}
