// The charts, drawn as SVG and plain HTML (no chart library, nothing loaded from anywhere).
//
// Rules every chart here follows:
//  - The exact amounts are always written as text next to the drawing (a readout, a legend row or a table), so colour is never the
//    only way to read a chart, and a screen reader gets the same figures.
//  - Touch comes first: tapping or dragging across a chart selects a point and shows its exact figures. Keyboard works too.
//  - Colours come from the theme (CSS variables) or from the person's own category colours, nudged only when a colour would
//    vanish into the background (see chart_math.js).
//
// Drawing positions are floating point because they only place shapes; every printed amount is made by the caller from exact money.

import { h, plural, svg } from './dom.js';
import {
  columnIndex, donutLayout, labelIndexes, nearestIndex, niceTicks, ringSegmentPath, visibleOn,
} from './chart_math.js';

const W = 340; // drawing width in viewBox units; the picture scales to the screen width

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** The chart background in the current theme (so a category colour can be checked against it). */
export function surfaceHex() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : '#FFFFFF';
}

export function seenColor(hex) {
  return visibleOn(hex, surfaceHex());
}

// ---------------------------------------------------------------- the line of text under a chart

/**
 * Where the exact figures of the selected point are written. `onOpen(point)` adds a button to see what the point is made of.
 * A point is { title, amountText, detail, count }.
 */
function makeReadout({ onOpen = null, openLabel = (point) => `View ${plural(point.count, 'transaction')}` } = {}) {
  const title = h('div', { class: 'readout-title' });
  const amount = h('div', { class: 'readout-amount num' });
  const detail = h('div', { class: 'readout-detail' });
  const open = onOpen ? h('button', { type: 'button', class: 'btn small secondary readout-open' }) : null;
  let current = null;
  if (open) open.addEventListener('click', () => { if (current) onOpen(current); });
  const el = h('div', { class: 'readout', 'aria-live': 'polite' }, h('div', { class: 'readout-text' }, title, amount, detail), open);
  return {
    el,
    set(point) {
      current = point;
      title.textContent = point ? point.title : '';
      amount.textContent = point ? point.amountText : '';
      detail.textContent = point && point.detail ? point.detail : '';
      if (open) {
        const can = Boolean(point && point.count > 0);
        open.hidden = !can;
        if (can) open.textContent = openLabel(point);
      }
    },
  };
}

/** The same numbers as a table, for people who prefer reading them (and for screen readers). */
export function tableTwin({ summary = 'Show as table', headers, rows, footer = null }) {
  const head = h('tr', null, headers.map((text, index) => h('th', { scope: 'col', class: index === 0 ? '' : 'r' }, text)));
  const body = rows.map((cells) => h('tr', null, cells.map((text, index) => h(index === 0 ? 'th' : 'td', { scope: index === 0 ? 'row' : null, class: index === 0 ? '' : 'r num' }, text))));
  const foot = footer ? h('tfoot', null, h('tr', null, footer.map((text, index) => h(index === 0 ? 'th' : 'td', { scope: index === 0 ? 'row' : null, class: index === 0 ? '' : 'r num' }, text)))) : null;
  return h('details', { class: 'table-twin' },
    h('summary', null, summary),
    h('div', { class: 'table-scroll' }, h('table', { class: 'twin' }, h('thead', null, head), h('tbody', null, body), foot)));
}

// ---------------------------------------------------------------- shared pieces of the axis charts

function drawAxes({ ticks, yOf, left, right, base, formatAxis }) {
  const parts = [];
  ticks.forEach((tick) => {
    const y = yOf(tick);
    if (tick > 0) parts.push(svg('line', { class: 'grid', x1: left, x2: right, y1: y, y2: y }));
    parts.push(svg('text', { class: 'tick', x: left - 6, y: y + 3.5, 'text-anchor': 'end' }, formatAxis(tick)));
  });
  parts.push(svg('line', { class: 'baseline', x1: left, x2: right, y1: base, y2: base }));
  return parts;
}

function drawXLabels({ labels, xOf, left, right, y, maxLabels }) {
  return labelIndexes(labels.length, maxLabels).map((index) => {
    const text = labels[index];
    const half = text.length * 2.8;
    return svg('text', { class: 'tick', x: clamp(xOf(index), left + half - 4, right - half + 4), y, 'text-anchor': 'middle' }, text);
  });
}

/** Left/right arrow keys, Home and End move the selection; Enter opens it. */
function keyboardSelection(target, { count, get, set, open }) {
  target.addEventListener('keydown', (event) => {
    let next = get();
    if (event.key === 'ArrowLeft') next -= 1;
    else if (event.key === 'ArrowRight') next += 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      if (open) {
        event.preventDefault();
        open(get());
      }
      return;
    } else return;
    event.preventDefault();
    set(clamp(next, 0, count - 1));
  });
}

/** Pressing and dragging across the drawing selects the point under the finger without stealing vertical scrolling. */
function dragSelection(overlay, svgEl, { indexAt, set }) {
  let pressed = false;
  const select = (event) => {
    const box = svgEl.getBoundingClientRect();
    if (box.width === 0) return;
    set(indexAt(((event.clientX - box.left) / box.width) * W));
  };
  overlay.addEventListener('pointerdown', (event) => {
    pressed = true;
    try { overlay.setPointerCapture(event.pointerId); } catch { /* not every browser lets a pointer be captured */ }
    select(event);
  });
  overlay.addEventListener('pointermove', (event) => {
    if (pressed || event.pointerType === 'mouse') select(event);
  });
  const release = () => { pressed = false; };
  overlay.addEventListener('pointerup', release);
  overlay.addEventListener('pointercancel', release);
}

// ---------------------------------------------------------------- columns: one total per day, week or month

/**
 * @param points  [{ axisLabel, title, value (number, in major units), amountText, detail, count }]
 * @param formatAxis (number) => text for the vertical axis
 */
export function columnChart({
  points, ariaLabel, formatAxis, initialIndex = null, onOpen = null, openLabel, maxLabels = 5,
}) {
  const height = 176;
  const left = 40;
  const right = W - 6;
  const top = 10;
  const base = 150;
  const count = points.length;
  const maxValue = Math.max(0, ...points.map((p) => p.value));
  const ticks = niceTicks(maxValue, 3);
  const topTick = ticks[ticks.length - 1];
  const yOf = (value) => base - (value / topTick) * (base - top);
  const step = (right - left) / Math.max(1, count);
  const barWidth = clamp(step * 0.62, 2, 24);
  const xOf = (index) => left + step * (index + 0.5);

  const band = svg('rect', { class: 'band', y: top - 4, height: base - top + 4, width: step, rx: 3 });
  const bars = points.map((point, index) => {
    const barHeight = base - yOf(point.value);
    if (!(barHeight > 0)) return null;
    const x = xOf(index) - barWidth / 2;
    const y = yOf(point.value);
    const r = Math.min(4, barWidth / 2, barHeight);
    const d = `M${x.toFixed(2)} ${base}V${(y + r).toFixed(2)}Q${x.toFixed(2)} ${y.toFixed(2)} ${(x + r).toFixed(2)} ${y.toFixed(2)}H${(x + barWidth - r).toFixed(2)}Q${(x + barWidth).toFixed(2)} ${y.toFixed(2)} ${(x + barWidth).toFixed(2)} ${(y + r).toFixed(2)}V${base}Z`;
    return svg('path', { class: 'col', d });
  });
  const overlay = svg('rect', { class: 'hit', x: left, y: 0, width: right - left, height, fill: 'transparent' });
  const group = svg('g', {
    class: 'plot', tabindex: '0', role: 'group', 'aria-roledescription': 'bar chart',
    'aria-label': `${ariaLabel}. Use the left and right arrow keys to move between bars.`,
  }, ...drawAxes({ ticks, yOf, left, right, base, formatAxis }), band, ...bars,
  ...drawXLabels({ labels: points.map((p) => p.axisLabel), xOf, left, right, y: base + 16, maxLabels }), overlay);
  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'xMidYMid meet' }, group);
  const readout = makeReadout({ onOpen, openLabel });

  let selected = -1;
  function select(index) {
    if (count === 0) return;
    const next = clamp(index, 0, count - 1);
    if (next === selected) return;
    if (selected >= 0 && bars[selected]) bars[selected].classList.remove('sel');
    selected = next;
    if (bars[selected]) bars[selected].classList.add('sel');
    band.setAttribute('x', (left + step * selected).toFixed(2));
    band.classList.add('on');
    readout.set(points[selected]);
  }

  dragSelection(overlay, chart, { indexAt: (x) => columnIndex(x, count, left, right), set: select });
  keyboardSelection(group, { count, get: () => Math.max(0, selected), set: select, open: onOpen ? (index) => { if (points[index].count > 0) onOpen(points[index]); } : null });
  select(initialIndex === null ? count - 1 : initialIndex);

  return h('div', { class: 'chart-box' }, chart, readout.el);
}

// ---------------------------------------------------------------- lines: a running total, or two periods side by side

/**
 * @param series  [{ name, values: [number | null], dashed: boolean }]  (the first is the main one)
 * @param labels  [{ axisLabel, title }] one per position
 * @param describe (index) => { title, amountText, detail, count } for the readout
 */
export function lineChart({
  series, labels, ariaLabel, formatAxis, describe, initialIndex = null, maxLabels = 5, onOpen = null, openLabel,
}) {
  const height = 176;
  const left = 40;
  const right = W - 12;
  const top = 10;
  const base = 150;
  const count = labels.length;
  const all = series.flatMap((s) => s.values.filter((v) => v !== null));
  const maxValue = Math.max(0, ...all);
  const ticks = niceTicks(maxValue, 3);
  const topTick = ticks[ticks.length - 1];
  const yOf = (value) => base - (value / topTick) * (base - top);
  const xOf = (index) => (count <= 1 ? (left + right) / 2 : left + (index * (right - left)) / (count - 1));

  const lines = series.map((s, position) => {
    let d = '';
    let pen = false;
    s.values.forEach((value, index) => {
      if (value === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xOf(index).toFixed(2)} ${yOf(value).toFixed(2)}`;
      pen = true;
    });
    return svg('path', { class: ['line', position === 0 ? 'main' : 'other', s.dashed ? 'dashed' : ''], d });
  });
  const dotsOnEveryPoint = count <= 14;
  const dots = dotsOnEveryPoint ? series.flatMap((s, position) => s.values.map((value, index) => (value === null ? null
    : svg('circle', { class: ['dot', position === 0 ? 'main' : 'other'], cx: xOf(index).toFixed(2), cy: yOf(value).toFixed(2), r: 2.6 })))) : [];
  const cross = svg('line', { class: 'cross', y1: top - 4, y2: base });
  const markers = series.map((_, position) => svg('circle', { class: ['marker', position === 0 ? 'main' : 'other'], r: 4.6 }));
  const overlay = svg('rect', { class: 'hit', x: left - 8, y: 0, width: right - left + 16, height, fill: 'transparent' });
  const group = svg('g', {
    class: 'plot', tabindex: '0', role: 'group', 'aria-roledescription': 'line chart',
    'aria-label': `${ariaLabel}. Use the left and right arrow keys to move along the line.`,
  }, ...drawAxes({ ticks, yOf, left, right, base, formatAxis }), cross, ...lines, ...dots, ...markers,
  ...drawXLabels({ labels: labels.map((l) => l.axisLabel), xOf, left, right, y: base + 16, maxLabels }), overlay);
  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'xMidYMid meet' }, group);
  const readout = makeReadout({ onOpen, openLabel });

  let selected = -1;
  function select(index) {
    if (count === 0) return;
    const next = clamp(index, 0, count - 1);
    if (next === selected) return;
    selected = next;
    const x = xOf(selected);
    cross.setAttribute('x1', x.toFixed(2));
    cross.setAttribute('x2', x.toFixed(2));
    cross.classList.add('on');
    series.forEach((s, position) => {
      const value = s.values[selected];
      const marker = markers[position];
      if (value === null || value === undefined) {
        marker.classList.remove('on');
      } else {
        marker.setAttribute('cx', x.toFixed(2));
        marker.setAttribute('cy', yOf(value).toFixed(2));
        marker.classList.add('on');
      }
    });
    readout.set(describe(selected));
  }

  dragSelection(overlay, chart, { indexAt: (x) => nearestIndex(x, count, left, right), set: select });
  keyboardSelection(group, { count, get: () => Math.max(0, selected), set: select, open: null });
  select(initialIndex === null ? count - 1 : initialIndex);

  return h('div', { class: 'chart-box' }, chart, readout.el);
}

// ---------------------------------------------------------------- donut: shares of a whole

/**
 * @param slices  [{ name, value (number), color, amountText, percentText, count }] biggest first
 * @param center  { label, value } what the middle says when nothing is pointed at
 * @param onOpen  (slice) => void, called when a slice is tapped (or Enter is pressed on it)
 */
export function donutChart({ slices, center, onOpen, ariaLabel }) {
  const c = 100;
  const outer = 96;
  const inner = 66;
  const surface = surfaceHex();
  const layout = donutLayout(slices.map((s) => s.value));
  const centerLabel = h('div', { class: 'donut-label' }, center.label);
  const centerValue = h('div', { class: 'donut-value num' });
  const centerNote = h('div', { class: 'donut-note' });
  const setValue = (text) => {
    centerValue.textContent = text;
    centerValue.classList.toggle('long', text.length > 12);
  };
  setValue(center.value);

  const paths = slices.map((slice, index) => {
    const place = layout[index];
    const path = svg('path', {
      class: 'donut-seg',
      d: ringSegmentPath(c, c, outer, inner, place.start, place.end),
      fill: visibleOn(slice.color, surface),
      'fill-rule': 'evenodd',
      tabindex: '0',
      role: 'button',
      'aria-label': `${slice.name}, ${slice.amountText}, ${slice.percentText}. View transactions.`,
    });
    const show = () => {
      centerLabel.textContent = slice.name;
      setValue(slice.amountText);
      centerNote.textContent = slice.percentText;
    };
    const reset = () => {
      centerLabel.textContent = center.label;
      setValue(center.value);
      centerNote.textContent = '';
    };
    path.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') show(); });
    path.addEventListener('pointerleave', reset);
    path.addEventListener('focus', show);
    path.addEventListener('blur', reset);
    path.addEventListener('click', () => onOpen(slice));
    path.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen(slice);
      }
    });
    return path;
  });

  const chart = svg('svg', { class: 'donut-svg', viewBox: '0 0 200 200', role: 'group', 'aria-label': ariaLabel }, ...paths);
  return h('div', { class: 'donut' }, chart, h('div', { class: 'donut-center', 'aria-hidden': 'true' }, centerLabel, centerValue, centerNote));
}

// ---------------------------------------------------------------- ranking bars and one stacked bar (HTML, so text wraps and zooms)

/**
 * Horizontal bars, longest first, each with its exact figure. rows: [{ name, color, amountText, subText, share (0-1 of the biggest) }]
 */
export function rankingList(rows, { onOpen = null } = {}) {
  const surface = surfaceHex();
  const items = rows.map((row) => {
    const fill = h('span', { class: 'rank-fill', style: { '--w': `${Math.max(2, Math.round(row.share * 1000) / 10)}%`, '--c': row.color ? visibleOn(row.color, surface) : null } });
    const inside = [
      h('span', { class: 'rank-top' }, h('span', { class: 'rank-name' }, row.name), h('span', { class: 'rank-amount num' }, row.amountText)),
      h('span', { class: 'rank-track', 'aria-hidden': 'true' }, fill),
      h('span', { class: 'rank-sub' }, row.subText),
    ];
    return onOpen
      ? h('li', null, h('button', { type: 'button', class: 'rank-row', onClick: () => onOpen(row) }, inside))
      : h('li', null, h('div', { class: 'rank-row' }, inside));
  });
  return h('ol', { class: 'rank' }, items);
}

/** One bar split into segments (for a share of a whole), with the exact figures written in `legend` by the caller. */
export function stackedBar(segments, ariaLabel) {
  const surface = surfaceHex();
  return h('div', { class: 'stack-bar', role: 'img', 'aria-label': ariaLabel },
    segments.filter((s) => s.value > 0).map((s) => h('span', { class: 'stack-seg', style: { flex: `${s.value} 1 0`, '--c': visibleOn(s.color, surface) } })));
}

// ---------------------------------------------------------------- the ruler on the Home card

/**
 * A row of upright ticks, one per day (or week, or month) of the chosen period: taller where more was spent, dim for days that
 * have not come yet, with today marked. It only decorates; the same figures are in the trend chart and its table.
 * ticks: [{ value (number), future: boolean, today: boolean }]
 */
export function heroRuler(ticks) {
  const count = ticks.length;
  const max = Math.max(0, ...ticks.map((t) => t.value));
  const height = 34;
  const gap = count > 40 ? 1 : 2;
  const barWidth = Math.max(1.5, (W - gap * (count - 1)) / count);
  const shapes = ticks.map((tick, index) => {
    const x = index * (barWidth + gap);
    const bar = max > 0 && tick.value > 0 ? Math.max(5, (tick.value / max) * (height - 4)) : 0;
    const kind = tick.future ? 'future' : tick.value > 0 ? 'spent' : 'none';
    const tall = bar > 0 ? bar : (tick.future ? 6 : 3);
    return svg('rect', { class: ['rtick', kind, tick.today ? 'today' : ''], x: x.toFixed(2), y: (height - tall).toFixed(2), width: barWidth.toFixed(2), height: tall.toFixed(2), rx: Math.min(1.5, barWidth / 2) });
  });
  return svg('svg', { class: 'ruler', viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, ...shapes);
}
