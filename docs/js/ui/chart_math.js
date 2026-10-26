// The arithmetic behind the charts: where slices start and end, which axis numbers to print, which labels fit.
// Pure functions with no page access, so they are tested in Node. Floating point is fine here because these numbers only
// position drawings; every amount printed next to a drawing comes from exact whole-number money.

const TAU = Math.PI * 2;

/** A point on a circle. Angle 0 is 12 o'clock and angles grow clockwise. */
export function polar(cx, cy, radius, angle) {
  return [cx + radius * Math.sin(angle), cy - radius * Math.cos(angle)];
}

const fixed = (n) => Number(n.toFixed(2));

/** The outline of one ring segment (a slice of a donut) from `start` to `end` radians. */
export function ringSegmentPath(cx, cy, outer, inner, start, end) {
  const span = end - start;
  if (span >= TAU - 1e-6) {
    // A full ring cannot be drawn as one arc: use two halves.
    const [ox1, oy1] = polar(cx, cy, outer, start);
    const [ox2, oy2] = polar(cx, cy, outer, start + Math.PI);
    const [ix1, iy1] = polar(cx, cy, inner, start);
    const [ix2, iy2] = polar(cx, cy, inner, start + Math.PI);
    return `M${fixed(ox1)} ${fixed(oy1)}A${outer} ${outer} 0 1 1 ${fixed(ox2)} ${fixed(oy2)}A${outer} ${outer} 0 1 1 ${fixed(ox1)} ${fixed(oy1)}Z`
      + `M${fixed(ix1)} ${fixed(iy1)}A${inner} ${inner} 0 1 0 ${fixed(ix2)} ${fixed(iy2)}A${inner} ${inner} 0 1 0 ${fixed(ix1)} ${fixed(iy1)}Z`;
  }
  const large = span > Math.PI ? 1 : 0;
  const [ox1, oy1] = polar(cx, cy, outer, start);
  const [ox2, oy2] = polar(cx, cy, outer, end);
  const [ix2, iy2] = polar(cx, cy, inner, end);
  const [ix1, iy1] = polar(cx, cy, inner, start);
  return `M${fixed(ox1)} ${fixed(oy1)}A${outer} ${outer} 0 ${large} 1 ${fixed(ox2)} ${fixed(oy2)}L${fixed(ix2)} ${fixed(iy2)}A${inner} ${inner} 0 ${large} 0 ${fixed(ix1)} ${fixed(iy1)}Z`;
}

/**
 * Where each slice of a donut goes. `values` are non-negative numbers. Returns one { start, end, fraction } per value
 * (in order), leaving a small gap between neighbours. Slices that would vanish are kept at a minimum visible width.
 * Returns [] when everything is zero.
 */
export function donutLayout(values, gap = 0.03, minimum = 0.02) {
  const total = values.reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
  if (!(total > 0)) return [];
  const positive = values.filter((v) => v > 0).length;
  const useGap = positive > 1 ? gap : 0;
  let cursor = 0;
  return values.map((value) => {
    const fraction = value > 0 ? value / total : 0;
    const span = fraction * TAU;
    const start = cursor + useGap / 2;
    let end = cursor + span - useGap / 2;
    if (fraction > 0 && end - start < minimum) end = start + minimum;
    cursor += span;
    return { start, end: Math.max(end, start), fraction };
  });
}

/** Axis numbers: 0 and a few round values up to at least `max` (1, 2 or 5 times a power of ten). */
export function niceTicks(max, target = 4) {
  if (!(max > 0)) return [0, 1];
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  let step;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 5) step = 5;
  else step = 10;
  step *= magnitude;
  const ticks = [];
  for (let value = 0; value < max + step * 0.999; value += step) {
    ticks.push(Number(value.toPrecision(12)));
    if (ticks.length > 12) break;
  }
  return ticks;
}

/** Which of `count` positions get a printed label, at most `maxLabels`, always including the first and last. */
export function labelIndexes(count, maxLabels) {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const picks = new Set([0, count - 1]);
  const slots = Math.max(2, maxLabels);
  for (let i = 1; i < slots - 1; i += 1) picks.add(Math.round((i * (count - 1)) / (slots - 1)));
  return Array.from(picks).sort((a, b) => a - b);
}

/** The index of the point nearest to x, for points spread evenly between `left` and `right` (the first at left, the last at right). */
export function nearestIndex(x, count, left, right) {
  if (count <= 1) return 0;
  const t = (x - left) / (right - left);
  return Math.min(count - 1, Math.max(0, Math.round(t * (count - 1))));
}

/** The index of the column under x, for `count` equal columns that fill the space between `left` and `right`. */
export function columnIndex(x, count, left, right) {
  if (count <= 1) return 0;
  const t = (x - left) / (right - left);
  return Math.min(count - 1, Math.max(0, Math.floor(t * count)));
}

// ---------------------------------------------------------------- colours

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function parseHex(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb) {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function luminance(rgb) {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(rgb, target, amount) {
  return rgb.map((v, i) => v + (target[i] - v) * amount);
}

/**
 * A category colour that can be seen on the chart's background. Colours the person chose keep their hue; only one that
 * nearly disappears into the background (a near-black on the dark theme, a near-white on the light one) is moved
 * towards the opposite end until it can be told apart.
 */
export function visibleOn(hex, surfaceHex, minimumContrast = 1.8) {
  const color = parseHex(hex);
  const surface = parseHex(surfaceHex);
  if (!color || !surface) return hex;
  if (contrastRatio(color, surface) >= minimumContrast) return toHex(color);
  const target = luminance(surface) < 0.5 ? [255, 255, 255] : [0, 0, 0];
  let adjusted = color;
  for (let step = 1; step <= 20; step += 1) {
    adjusted = mix(color, target, step * 0.05);
    if (contrastRatio(adjusted, surface) >= minimumContrast) break;
  }
  return toHex(adjusted);
}

/** Black or white text, whichever reads better on a fill. */
export function inkFor(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return '#000000';
  return luminance(rgb) > 0.4 ? '#101418' : '#FFFFFF';
}
