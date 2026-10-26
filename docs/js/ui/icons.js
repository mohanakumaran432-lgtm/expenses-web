// Drawn icons for buttons and tabs, and the picture shown for each category / payment-method icon name.
//
// Categories and payment methods keep the iPhone app's icon names (SF Symbol names such as "fork.knife") so a backup moves
// between the apps unchanged. This app has no access to Apple's symbols, so each name is shown as an emoji instead.

import { svg } from './dom.js';

const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

const PATHS = {
  home: ['M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-8z'],
  list: ['M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01'],
  chart: ['M5 20V11M12 20V4M19 20v-6'],
  wallet: ['M4 7a2 2 0 0 1 2-2h11v3', 'M4 7v11a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2z', 'M16 14.5h.01'],
  sliders: ['M4 7h9M17 7h3M4 17h3M11 17h9'],
  plus: ['M12 5v14M5 12h14'],
  chevronRight: ['M9 5l7 7-7 7'],
  chevronLeft: ['M15 5l-7 7 7 7'],
  chevronDown: ['M5 9l7 7 7-7'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12M18 6L6 18'],
  search: ['M20 20l-4.2-4.2'],
  filter: ['M4 6h16M7 12h10M10 18h4'],
  sort: ['M7 4v16m0 0l-3-3m3 3l3-3M17 20V4m0 0l-3 3m3-3l3 3'],
  more: [],
  trash: ['M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3'],
  share: ['M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1'],
  lock: ['M8 11V8a4 4 0 0 1 8 0v3'],
  calendar: ['M4 10h16M8 3v4M16 3v4'],
  repeat: ['M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4'],
  edit: ['M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3zM14 7l3 3'],
  backspace: ['M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7 6-7z', 'M12.5 10l5 4M17.5 10l-5 4'],
  info: ['M12 11v5M12 8v.01'],
  warning: ['M12 4l9 16H3L12 4zM12 10v4M12 17v.01'],
  download: ['M12 4v11M8 11l4 4 4-4M5 20h14'],
  upload: ['M12 16V5M8 9l4-4 4 4M5 20h14'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z', 'M8.5 12l2.5 2.5 4.5-4.5'],
  tag: ['M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z', 'M7.5 7.5h.01'],
  archive: ['M4 6h16v4H4zM6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9M10 14h4'],
  merge: ['M6 4v5a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v3M18 4v5M6 20v-1'],
  drag: ['M5 9h14M5 15h14'],
  pause: ['M9 5v14M15 5v14'],
  play: ['M8 5l11 7-11 7V5z'],
  doc: ['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5M9 13h6M9 17h6'],
  eraser: ['M8 20h12M5 15l9-9a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3l-7 7H8l-3-3z'],
  clock: ['M12 7v5l3 2'],
};

/** Every drawn icon name. A name that is not here draws nothing, so tests check each name used against this list. */
export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

/** Shapes drawn in addition to the path list (circles and rectangles). */
const EXTRA = {
  search: () => [svg('circle', { cx: 11, cy: 11, r: 6.5 })],
  more: () => [svg('circle', { cx: 5, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }), svg('circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }), svg('circle', { cx: 19, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' })],
  lock: () => [svg('rect', { x: 5, y: 11, width: 14, height: 9.5, rx: 2 })],
  calendar: () => [svg('rect', { x: 4, y: 5, width: 16, height: 15, rx: 2 })],
  info: () => [svg('circle', { cx: 12, cy: 12, r: 9 })],
  sliders: () => [svg('circle', { cx: 15, cy: 7, r: 2.3 }), svg('circle', { cx: 9, cy: 17, r: 2.3 })],
  clock: () => [svg('circle', { cx: 12, cy: 12, r: 9 })],
};

/** An icon as an SVG element. It takes the colour of the text around it. */
export function icon(name, { size = null, label = null, className = null } = {}) {
  const props = { viewBox: '0 0 24 24', ...STROKE };
  if (className) props.class = className;
  if (size) {
    props.width = size;
    props.height = size;
  }
  if (label) {
    props.role = 'img';
    props['aria-label'] = label;
  } else {
    props['aria-hidden'] = 'true';
    props.focusable = 'false';
  }
  const extra = EXTRA[name] ? EXTRA[name]() : [];
  const paths = (PATHS[name] || []).map((d) => svg('path', { d }));
  return svg('svg', props, ...extra, ...paths);
}

// ---------------------------------------------------------------- category and payment-method pictures

const GLYPHS = {
  'fork.knife': '🍽️',
  cart: '🛒',
  'cup.and.saucer': '☕',
  bus: '🚌',
  fuelpump: '⛽',
  car: '🚕',
  bag: '🛍️',
  tshirt: '👕',
  bolt: '⚡',
  house: '🏠',
  'cross.case': '🏥',
  'figure.run': '🏃',
  film: '🎬',
  airplane: '✈️',
  book: '📚',
  sparkles: '✨',
  'person.2': '👨‍👩‍👧',
  gift: '🎁',
  repeat: '🔁',
  shield: '🛡️',
  'building.columns': '🏦',
  briefcase: '💼',
  'ellipsis.circle': '🧾',
  creditcard: '💳',
  banknote: '💵',
  iphone: '📱',
  'arrow.left.arrow.right': '🔄',
  tag: '🏷️',
  laptopcomputer: '💻',
  gamecontroller: '🎮',
  pawprint: '🐾',
  leaf: '🍃',
  drop: '💧',
  flame: '🔥',
  wifi: '📶',
  phone: '📞',
  'wrench.and.screwdriver': '🔧',
  hammer: '🔨',
  stethoscope: '🩺',
  pills: '💊',
  graduationcap: '🎓',
  'music.note': '🎵',
  camera: '📷',
  heart: '❤️',
  star: '⭐',
  tram: '🚊',
  bicycle: '🚲',
  ferry: '⛴️',
  'bed.double': '🛏️',
  scissors: '✂️',
  basket: '🧺',
  'takeoutbag.and.cup.and.straw': '🥡',
  'questionmark.circle': '❔',
  'minus.circle': '➖',
};

export function glyphFor(symbolName) {
  return GLYPHS[symbolName] || '🏷️';
}

/** Spoken names for the icon choices (screen readers cannot say "fork.knife"). */
const LABELS = {
  tag: 'Tag', 'fork.knife': 'Fork and knife', cart: 'Shopping cart', 'cup.and.saucer': 'Cup', bus: 'Bus', fuelpump: 'Fuel pump',
  car: 'Car', bag: 'Shopping bag', tshirt: 'T-shirt', bolt: 'Lightning bolt', house: 'House', 'cross.case': 'Medical case',
  'figure.run': 'Running figure', film: 'Film', airplane: 'Airplane', book: 'Book', sparkles: 'Sparkles', 'person.2': 'Family',
  gift: 'Gift', repeat: 'Repeat', shield: 'Shield', 'building.columns': 'Bank building', briefcase: 'Briefcase',
  'ellipsis.circle': 'Receipt', creditcard: 'Card', banknote: 'Banknote', iphone: 'Phone', 'arrow.left.arrow.right': 'Transfer',
  laptopcomputer: 'Laptop', gamecontroller: 'Game controller', pawprint: 'Paw print', leaf: 'Leaf', drop: 'Water drop',
  flame: 'Flame', wifi: 'Wi-Fi', phone: 'Telephone', 'wrench.and.screwdriver': 'Tools', hammer: 'Hammer', stethoscope: 'Stethoscope',
  pills: 'Pills', graduationcap: 'Graduation cap', 'music.note': 'Music note', camera: 'Camera', heart: 'Heart', star: 'Star',
  tram: 'Tram', bicycle: 'Bicycle', ferry: 'Ferry', 'bed.double': 'Bed', scissors: 'Scissors', basket: 'Basket',
  'takeoutbag.and.cup.and.straw': 'Takeaway', 'questionmark.circle': 'Unknown', 'minus.circle': 'None',
};

export function iconLabel(symbolName) {
  return LABELS[symbolName] || 'Icon';
}
