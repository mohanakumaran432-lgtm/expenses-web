// App lock: turn a passcode on, change it, turn it off, and choose when the app locks itself.
// The passcode locks the app AND encrypts what is stored (see core/vault.js). It is separate from the iPhone's own passcode.

import { fill, h } from '../dom.js';
import { button, group, notice, page, row, sheetContent, toggleRow } from '../components.js';
import { LOCK_TIMEOUTS, LOCK_TIMEOUT_TITLES } from '../../core/lock_settings.js';
import { passcodeFields } from './passcode_fields.js';
import { checkTypedPasscode as confirmed } from './reauth.js';

export function openAppLock(app) {
  app.shell.push(createAppLock);
}

/** Turning the lock on or off changes what the screens show; protection changes do not announce themselves as data changes. */
function redraw(app) {
  if (app.shell) app.shell.refresh();
}

export function createAppLock(app) {
  const screen = page(app, { title: 'App lock', back: true, backLabel: 'Settings' });
  const holder = h('div', { class: 'stack-l' });
  screen.body.append(holder);

  async function chooseTimeout() {
    const current = app.appLock.settings.timeout;
    const picked = await app.ui.actions({
      title: 'Lock the app',
      options: LOCK_TIMEOUTS.map((seconds) => ({ label: LOCK_TIMEOUT_TITLES[seconds], value: seconds, checked: seconds === current })),
    });
    if (picked === undefined || picked === current) return;
    const result = await app.perform('lock', () => app.setLockTimeout(picked), { title: 'Could not save' });
    if (result.ok) redraw(app);
  }

  async function turnOff() {
    const typed = await app.ui.prompt({
      title: 'Turn off the passcode?',
      message: 'Enter your passcode. Afterwards the app will not lock, and your data will be stored without encryption on this iPhone.',
      secure: true,
      confirmLabel: 'Turn off',
      label: 'Passcode',
    });
    if (typed === null) return;
    const right = await confirmed(app, typed);
    if (!right) return;
    const result = await app.perform('lock', () => app.disablePasscode(typed), { busy: 'Decrypting…', title: 'Could not turn off the passcode' });
    if (result.ok) {
      app.ui.toast('Passcode turned off');
      redraw(app);
    }
  }

  let drawnFor = null; // what the page was last built for: the page is only rebuilt when this changes
  let hideSwitch = null;

  function refresh() {
    const on = app.lockEnabled;
    const signature = `${on}|${on ? app.appLock.settings.timeout : ''}`;
    if (signature === drawnFor && hideSwitch) {
      // Only the switch can have changed. It is moved, not replaced, so it slides.
      const value = app.settings.hideContentInAppSwitcher;
      if (hideSwitch.input.checked !== value) {
        hideSwitch.input.checked = value;
        hideSwitch.input.setAttribute('aria-checked', value ? 'true' : 'false');
      }
      return;
    }
    drawnFor = signature;
    const sections = [];
    if (on) {
      sections.push(notice({ kind: 'good', glyph: 'lock', title: 'Passcode is on', body: 'The app asks for it when you come back, and what is stored on this iPhone is encrypted with it.' }));
      sections.push(group([
        row({ title: 'Lock now', onClick: () => app.lockNow() }),
        row({ title: 'Lock after', value: LOCK_TIMEOUT_TITLES[app.appLock.settings.timeout], chevron: true, onClick: chooseTimeout }),
        row({ title: 'Change passcode', chevron: true, onClick: async () => { if (await changePasscodeSheet(app)) redraw(app); } }),
        row({ title: 'Turn off passcode', destructive: true, onClick: turnOff }),
      ]));
    } else {
      sections.push(notice({
        kind: 'warn', glyph: 'warning', title: 'No passcode is set',
        body: 'Anyone who can open this app on this iPhone can read your expenses, and the stored data is not encrypted.',
      }));
      sections.push(button('Turn on a passcode', { block: true, onClick: async () => { if (await turnOnSheet(app)) redraw(app); } }));
    }
    hideSwitch = toggleRow({
      title: 'Hide contents in the app switcher',
      sub: 'Covers the screen when you leave the app, so the picture iOS keeps shows no amounts.',
      checked: app.settings.hideContentInAppSwitcher,
      onChange: (checked, input) => app.perform('settings-write', () => app.updateSettings({ hideContentInAppSwitcher: checked }), { title: 'Could not save' })
        .then((result) => { if (!result.ok) input.checked = !checked; }),
    });
    sections.push(group([hideSwitch], { footer: 'This is done by the web page and is best effort: iOS decides when it takes the picture, and this has not been verified on every iPhone.' }));
    sections.push(h('div', { class: 'stack-s' },
      h('h2', { class: 'section-title' }, 'What to know'),
      h('p', { class: 't-foot footnote' }, 'This passcode is separate from your iPhone passcode. A web app on iPhone cannot use Face ID, so the passcode is always asked for.'),
      h('p', { class: 't-foot footnote' }, 'There is no way to recover a forgotten passcode. If you forget it, the only way back in is to erase the app\'s data and restore a backup, so keep your backups.'),
      h('p', { class: 't-foot footnote' }, 'A short number passcode is quick to type but can be guessed by someone who copies your stored data and tries every combination on a fast computer. Longer, with letters and numbers, is much stronger. The app also makes you wait after several wrong tries, but that only slows down someone using the app itself.')));
    fill(holder, ...sections);
  }

  return { el: screen.el, refresh };
}

// ---------------------------------------------------------------- sheets

/** Resolves true when a passcode was turned on. */
function turnOnSheet(app) {
  const { closed } = app.ui.present((_, __, handle) => {
    let timeout = 0;
    const sheet = sheetContent({
      title: 'Turn on passcode',
      onCancel: () => handle.close(false),
      actionLabel: 'Turn on',
      actionDisabled: true,
      onAction: async () => {
        const state = fields.read();
        if (!state.ok) return;
        const result = await app.perform('lock', () => app.enablePasscode(state.passcode, timeout), { busy: 'Encrypting your data…', title: 'Could not turn on the passcode' });
        if (!result.ok) return;
        handle.close(true);
        app.ui.toast('Passcode is on');
      },
    });
    const fields = passcodeFields({ onChange: (state) => sheet.setActionDisabled(!state.ok) });
    const timeoutRow = row({
      title: 'Lock after', value: LOCK_TIMEOUT_TITLES[timeout], chevron: true,
      onClick: async () => {
        const picked = await app.ui.actions({
          title: 'Lock the app',
          options: LOCK_TIMEOUTS.map((seconds) => ({ label: LOCK_TIMEOUT_TITLES[seconds], value: seconds, checked: seconds === timeout })),
        });
        if (picked === undefined) return;
        timeout = picked;
        timeoutRow.querySelector('.row-value').textContent = LOCK_TIMEOUT_TITLES[picked];
      },
    });
    sheet.body.append(h('div', { class: 'stack-l' },
      fields.el,
      group([timeoutRow], { footer: 'How long the app may stay out of sight before it asks again.' })));
    return { el: sheet.el, label: 'Turn on passcode' };
  });
  return closed;
}

/** Resolves true when the passcode was changed. */
function changePasscodeSheet(app) {
  const { closed } = app.ui.present((_, __, handle) => {
    const sheet = sheetContent({
      title: 'Change passcode',
      onCancel: () => handle.close(false),
      actionLabel: 'Change',
      actionDisabled: true,
      onAction: async () => {
        const state = fields.read();
        const current = currentInput.value;
        if (!state.ok || current === '') return;
        if (!(await confirmed(app, current))) return;
        const result = await app.perform('lock', () => app.changePasscode(current, state.passcode), { busy: 'Re-encrypting your data…', title: 'Could not change the passcode' });
        if (!result.ok) return;
        handle.close(true);
        app.ui.toast('Passcode changed');
      },
    });
    const currentInput = h('input', {
      class: 'input', type: 'password', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Current passcode', placeholder: 'Current passcode', 'data-autofocus': '',
    });
    const update = (state) => sheet.setActionDisabled(!(state.ok && currentInput.value !== ''));
    const fields = passcodeFields({ onChange: update, label: 'New passcode', confirmLabel: 'Type the new one again' });
    currentInput.addEventListener('input', () => update(fields.read()));
    sheet.body.append(h('div', { class: 'stack-l' },
      currentInput,
      fields.el,
      h('p', { class: 't-foot footnote' }, 'Changing the passcode makes a new key and re-encrypts everything stored. Backups you made earlier are not affected by it.')));
    return { el: sheet.el, label: 'Change passcode' };
  });
  return closed;
}
