// Choosing how a category or payment method looks: an icon from a grid, and a colour from a palette (or any colour).
// Neither relies on colour alone: the chosen icon and colour carry a tick, and every choice has a spoken name.

import { h } from '../dom.js';
import { icon, glyphFor, iconLabel } from '../icons.js';
import { COLOR_PALETTE, ICON_CHOICES } from '../../core/models.js';

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function isHexColor(text) {
  return typeof text === 'string' && HEX.test(text);
}

/**
 * @param value     the icon name chosen now
 * @param choices   icon names to offer (the current one is added if it is not among them)
 * @param onChange  (name) => void
 * Returns an element with `.set(name)`.
 */
export function iconGrid({ value, choices = ICON_CHOICES, onChange, label = 'Icon' }) {
  const names = choices.includes(value) ? [...choices] : [value, ...choices];
  const el = h('div', { class: 'icon-grid', role: 'group', 'aria-label': label });
  const buttons = names.map((name) => h('button', {
    type: 'button',
    class: 'icon-choice',
    'aria-pressed': name === value ? 'true' : 'false',
    'aria-label': iconLabel(name),
    dataset: { name },
    onClick: () => {
      el.set(name);
      onChange(name);
    },
  }, glyphFor(name)));
  el.set = (next) => {
    for (const button of buttons) button.setAttribute('aria-pressed', button.dataset.name === next ? 'true' : 'false');
  };
  el.append(...buttons);
  return el;
}

/**
 * @param value     the colour chosen now, "#RRGGBB"
 * @param onChange  (hex) => void, with an upper-case hex colour
 * Returns an element with `.set(hex)`. The last swatch opens the phone's own colour chooser.
 */
export function colorGrid({ value, onChange, palette = COLOR_PALETTE, label = 'Colour' }) {
  const el = h('div', { class: 'color-grid', role: 'group', 'aria-label': label });
  const swatches = palette.map((hex) => h('button', {
    type: 'button',
    class: 'color-choice',
    style: { '--c': hex },
    'aria-pressed': hex.toUpperCase() === String(value).toUpperCase() ? 'true' : 'false',
    'aria-label': `Colour ${hex}`,
    dataset: { hex: hex.toUpperCase() },
    onClick: () => {
      el.set(hex);
      onChange(hex.toUpperCase());
    },
  }, icon('check')));

  const custom = h('input', { type: 'color', class: 'color-input', value: isHexColor(value) ? value.toLowerCase() : '#8e8e93', 'aria-label': 'Choose another colour' });
  const customWrap = h('label', { class: 'color-choice custom' }, icon('check'), custom);
  custom.addEventListener('input', () => {
    const hex = custom.value.toUpperCase();
    el.set(hex);
    onChange(hex);
  });

  el.set = (next) => {
    const wanted = String(next).toUpperCase();
    let matched = false;
    for (const swatch of swatches) {
      const on = swatch.dataset.hex === wanted;
      matched = matched || on;
      swatch.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const customOn = !matched && isHexColor(next);
    customWrap.classList.toggle('on', customOn);
    custom.setAttribute('aria-label', customOn ? 'Another colour, chosen. Tap to change it.' : 'Choose another colour');
    if (isHexColor(next)) {
      custom.value = next.toLowerCase();
      customWrap.style.setProperty('--c', next);
    }
  };
  el.append(...swatches, customWrap);
  el.set(value);
  return el;
}
