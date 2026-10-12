import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupProductRows, nextProductCount, productAnchorOffset, productRenderedRows,
  productRowMetrics, productWindowRange, responsiveProductColumns,
} from '../client/windowed-product-range.js';

test('the existing desktop grid and small-screen row layout share responsive boundaries', () => {
  assert.deepEqual([390, 580, 581, 800, 801, 1440].map(responsiveProductColumns), [1, 1, 2, 2, 3, 3]);
});

test('revealed chunks stop at the final product and appended search pages continue loading', () => {
  assert.equal(nextProductCount(20, 28), 28);
  assert.equal(nextProductCount(28, 28), 28);
  assert.equal(nextProductCount(28, 48), 48);
  assert.equal(nextProductCount(0, 0), 0);
});

test('grid geometry counts measured rows, including partial rows, rather than individual cards', () => {
  const rows = groupProductRows(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3);
  assert.deepEqual(rows.map(row => [row.start, row.end]), [[0, 3], [3, 6], [6, 7]]);
  const heights = new Map([[rows[0].key, 440], [rows[1].key, 300]]);
  const metrics = productRowMetrics(rows, heights, 250);
  assert.deepEqual(metrics.offsets, [0, 440, 740, 990]);
  assert.equal(metrics.totalHeight, 990);
  assert.deepEqual(productWindowRange(metrics, 441, 250, 0), { start: 1, end: 2 });
});

test('a 10,000-product list keeps its mounted window bounded at the start, middle and end', () => {
  for (const columns of [1, 2, 3]) {
    const rows = groupProductRows(Array.from({ length: 10000 }, (_, index) => `sku-${index}`), columns);
    const metrics = productRowMetrics(rows, new Map(), 250);
    for (const top of [0, metrics.totalHeight / 2, metrics.totalHeight - 800, metrics.totalHeight + 1000]) {
      const range = productWindowRange(metrics, top, 800, 600);
      const mounted = productRenderedRows(range, rows.length);
      assert.ok(mounted.length <= 10, `${columns} columns at ${top}: ${mounted.length} rows`);
      assert.ok(mounted.length > 0);
      assert.ok(mounted.every(index => index >= 0 && index < rows.length));
    }
  }
});

test('keyboard focus retains only its own row without filling the entire gap to the visible range', () => {
  assert.deepEqual(productRenderedRows({ start: 400, end: 407 }, 1000, [2, 403, -1, 1000]), [2, 400, 401, 402, 403, 404, 405, 406]);
  assert.deepEqual(productWindowRange(productRowMetrics([], new Map()), 100, 800), { start: 0, end: 0 });
});

test('expanding descriptions above the viewport preserve the visible product and within-row position', () => {
  const rows = groupProductRows(['a', 'b', 'c', 'd', 'e'], 1);
  const before = productRowMetrics(rows, new Map(), 200);
  const after = productRowMetrics(rows, new Map([[rows[0].key, 350], [rows[1].key, 280]]), 200);
  assert.equal(productAnchorOffset(rows, before, rows, after, 470), 700);
  assert.equal(productAnchorOffset(rows, before, rows, after, -10), null);
});

test('changing column count anchors the same first visible product after regrouping', () => {
  const keys = Array.from({ length: 30 }, (_, index) => `sku-${index}`);
  const desktop = groupProductRows(keys, 3);
  const mobile = groupProductRows(keys, 1);
  const before = productRowMetrics(desktop, new Map(), 400);
  const after = productRowMetrics(mobile, new Map(), 150);
  // Desktop row 4 contains products 12..14; keep product 12 on mobile.
  assert.equal(productAnchorOffset(desktop, before, mobile, after, 1620), 1820);
});

test('appending an item invalidates a partial-row measurement while completed rows retain theirs', () => {
  const before = groupProductRows(['a', 'b', 'c', 'd'], 3);
  const after = groupProductRows(['a', 'b', 'c', 'd', 'e'], 3);
  const heights = new Map([[before[0].key, 420], [before[1].key, 100]]);
  assert.equal(before[0].key, after[0].key);
  assert.notEqual(before[1].key, after[1].key);
  assert.deepEqual(productRowMetrics(after, heights, 250).offsets, [0, 420, 670]);
});
