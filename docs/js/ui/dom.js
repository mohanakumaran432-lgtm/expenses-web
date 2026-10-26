// A very small way to build screens from code. Text is always added as TEXT, never as HTML, so a merchant name or a note
// can never turn into markup (this file is the reason the app never needs innerHTML).
//
// Styles are only ever set through the element's style object (CSS custom properties such as --c), because the page's
// Content-Security-Policy does not allow inline style attributes.

const SVG_NS = 'http://www.w3.org/2000/svg';

const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'multiple', 'indeterminate']);

function addChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      addChildren(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

function setStyle(el, style) {
  for (const [name, value] of Object.entries(style)) {
    if (value === null || value === undefined) continue;
    if (name.startsWith('--')) el.style.setProperty(name, String(value));
    else el.style[name] = value;
  }
}

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      if (value === false && !isSvg && PROPERTY_KEYS.has(key)) el[key] = false;
      continue;
    }
    if (key === 'class' || key === 'className') {
      const text = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      if (text !== '') el.setAttribute('class', text);
    } else if (key === 'style') {
      setStyle(el, value);
    } else if (key === 'dataset') {
      for (const [name, item] of Object.entries(value)) {
        if (item !== null && item !== undefined) el.dataset[name] = String(item);
      }
    } else if (key === 'on') {
      for (const [name, handler] of Object.entries(value)) el.addEventListener(name, handler);
    } else if (key.length > 2 && key.startsWith('on') && key[2] === key[2].toUpperCase() && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (!isSvg && PROPERTY_KEYS.has(key)) {
      el[key] = value;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

/** h('button', { class: 'btn', onClick: save }, 'Save') */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props, false);
  addChildren(el, children);
  return el;
}

/** The same for SVG (charts and icons). */
export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  addChildren(el, children);
  return el;
}

export function frag(...children) {
  const fragment = document.createDocumentFragment();
  addChildren(fragment, children);
  return fragment;
}

/** Empties an element and puts new children in it. */
export function fill(el, ...children) {
  el.replaceChildren();
  addChildren(el, children);
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** Runs `handler` for a click, and also when the person presses Enter or Space on a non-button element that was made clickable. */
export function activate(el, handler) {
  el.addEventListener('click', handler);
  if (!['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(el.tagName)) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handler(event);
      }
    });
  }
  return el;
}

/** Calls `fn` at most once per animation frame (for scroll handlers). */
export function perFrame(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

/** Waits for the typing to pause before running `fn` (search boxes). */
export function debounced(fn, ms = 150) {
  let timer = null;
  const wrapper = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapper.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  wrapper.flush = (...args) => {
    wrapper.cancel();
    fn(...args);
  };
  return wrapper;
}

/** A word with the right ending: plural(1, 'transaction') is "1 transaction", plural(2, 'transaction') is "2 transactions". */
export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Small ids for label/input pairs. */
let nextId = 0;
export function uid(prefix = 'f') {
  nextId += 1;
  return `${prefix}${nextId}`;
}
