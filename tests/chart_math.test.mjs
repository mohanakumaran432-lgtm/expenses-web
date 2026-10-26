import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnIndex, contrastRatio, donutLayout, inkFor, labelIndexes, nearestIndex, niceTicks, parseHex, polar, ringSegmentPath, toHex, visibleOn,
} from '../docs/js/ui/chart_math.js';

const TAU = Math.PI * 2;

test('polar: angle 0 is straight up and angles grow clockwise', () => {
  const [x0, y0] = polar(100, 100, 50, 0);
  assert.ok(Math.abs(x0 - 100) < 1e-9 && Math.abs(y0 - 50) < 1e-9);
  const [x1, y1] = polar(100, 100, 50, Math.PI / 2);
  assert.ok(Math.abs(x1 - 150) < 1e-9 && Math.abs(y1 - 100) < 1e-9);
});

test('donut slices cover the circle in proportion, with a gap between neighbours', () => {
  const layout = donutLayout([50, 30, 20], 0.04);
  assert.equal(layout.length, 3);
  assert.ok(Math.abs(layout[0].fraction - 0.5) < 1e-12);
  // Each slice is its share of the circle minus the gap.
  assert.ok(Math.abs((layout[0].end - layout[0].start) - (0.5 * TAU - 0.04)) < 1e-9);
  assert.ok(Math.abs((layout[2].end - layout[2].start) - (0.2 * TAU - 0.04)) < 1e-9);
  // Gaps: the end of one slice is before the start of the next.
  assert.ok(layout[1].start - layout[0].end > 0.039);
  // The last slice stops short of a full turn, by half a gap.
  assert.ok(Math.abs(layout[2].end - (TAU - 0.02)) < 1e-9);
});

test('a single slice is a full ring with no gap', () => {
  const [only] = donutLayout([123.45]);
  assert.ok(Math.abs((only.end - only.start) - TAU) < 1e-9);
});

test('zero and negative values take no room and an all-zero chart has no slices', () => {
  assert.deepEqual(donutLayout([0, 0]), []);
  const layout = donutLayout([10, 0, 10], 0);
  assert.equal(layout[1].fraction, 0);
  assert.equal(layout[1].end - layout[1].start, 0);
});

test('a tiny slice stays visible', () => {
  const layout = donutLayout([1000000, 1], 0.03, 0.02);
  assert.ok(layout[1].end - layout[1].start >= 0.02 - 1e-12);
});

test('ring segment paths are valid and the full ring is two closed loops', () => {
  const quarter = ringSegmentPath(100, 100, 80, 50, 0, Math.PI / 2);
  assert.match(quarter, /^M[-\d.]+ [-\d.]+A80 80 0 0 1 [-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+A50 50 0 0 0 [-\d.]+ [-\d.]+Z$/);
  const big = ringSegmentPath(100, 100, 80, 50, 0, Math.PI * 1.5);
  assert.match(big, /A80 80 0 1 1/);
  const full = ringSegmentPath(100, 100, 80, 50, 0, TAU);
  assert.equal((full.match(/Z/g) || []).length, 2);
});

test('axis ticks are round numbers that reach the largest value', () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(100, 4), [0, 50, 100]);
  assert.deepEqual(niceTicks(12, 4), [0, 5, 10, 15]);
  for (const max of [3, 7, 42, 180, 1234, 99999, 0.37]) {
    const ticks = niceTicks(max, 4);
    assert.equal(ticks[0], 0);
    assert.ok(ticks[ticks.length - 1] >= max, `ticks for ${max} reach it: ${ticks}`);
    assert.ok(ticks.length <= 8, `few ticks for ${max}: ${ticks.length}`);
    const step = ticks[1] - ticks[0];
    const magnitude = 10 ** Math.floor(Math.log10(step));
    assert.ok([1, 2, 5].includes(Math.round(step / magnitude)), `step ${step} is 1, 2 or 5 times a power of ten`);
  }
});

test('labels: all shown when they fit, otherwise evenly spread including both ends', () => {
  assert.deepEqual(labelIndexes(3, 5), [0, 1, 2]);
  const picks = labelIndexes(31, 5);
  assert.equal(picks[0], 0);
  assert.equal(picks[picks.length - 1], 30);
  assert.ok(picks.length <= 5);
  assert.deepEqual(labelIndexes(0, 5), []);
  assert.deepEqual(labelIndexes(1, 1), [0]);
});

test('the point nearest to a touch', () => {
  assert.equal(nearestIndex(0, 5, 0, 100), 0);
  assert.equal(nearestIndex(100, 5, 0, 100), 4);
  assert.equal(nearestIndex(49, 5, 0, 100), 2);
  assert.equal(nearestIndex(-50, 5, 0, 100), 0);
  assert.equal(nearestIndex(500, 5, 0, 100), 4);
  assert.equal(nearestIndex(10, 1, 0, 100), 0);
});

test('the column under a touch', () => {
  assert.equal(columnIndex(0, 4, 0, 100), 0);
  assert.equal(columnIndex(24.9, 4, 0, 100), 0);
  assert.equal(columnIndex(25, 4, 0, 100), 1);
  assert.equal(columnIndex(99.9, 4, 0, 100), 3);
  assert.equal(columnIndex(100, 4, 0, 100), 3);
  assert.equal(columnIndex(-30, 4, 0, 100), 0);
  assert.equal(columnIndex(300, 4, 0, 100), 3);
  assert.equal(columnIndex(50, 1, 0, 100), 0);
});

test('colours: contrast, parsing and moving a colour that disappears', () => {
  assert.equal(contrastRatio(parseHex('#000000'), parseHex('#FFFFFF')).toFixed(2), '21.00');
  assert.deepEqual(parseHex('#1B1B1F'), [27, 27, 31]);
  assert.equal(parseHex('nonsense'), null);
  assert.equal(toHex([255, 0, 128]), '#FF0080');

  // A near-black category on the dark chart background is moved lighter until it shows...
  const moved = visibleOn('#1B1B1F', '#14171C');
  assert.notEqual(moved, '#1B1B1F');
  assert.ok(contrastRatio(parseHex(moved), parseHex('#14171C')) >= 1.8);
  // ...but a colour that already shows is left exactly as chosen.
  assert.equal(visibleOn('#FF9500', '#14171C'), '#FF9500');
  assert.equal(visibleOn('#34C759', '#FFFFFF', 1.5), '#34C759');
  // A near-white colour on a white background moves darker.
  const darker = visibleOn('#F8F8F8', '#FFFFFF');
  assert.ok(contrastRatio(parseHex(darker), parseHex('#FFFFFF')) >= 1.8);
  // Unparseable input is returned untouched rather than breaking the chart.
  assert.equal(visibleOn('not a colour', '#FFFFFF'), 'not a colour');
});

test('ink colour is chosen for the fill', () => {
  assert.equal(inkFor('#FFFFFF'), '#101418');
  assert.equal(inkFor('#000000'), '#FFFFFF');
  assert.equal(inkFor('#007AFF'), '#FFFFFF');
});
