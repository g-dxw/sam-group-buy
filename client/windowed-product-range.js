export function responsiveProductColumns(width) {
  return width <= 580 ? 1 : width <= 800 ? 2 : 3;
}

export function nextProductCount(count, total, pageSize = 20) {
  return Math.min(total, Math.max(0, count) + Math.max(1, Math.floor(pageSize)));
}

export function groupProductRows(keys, columns) {
  const size = Math.max(1, Math.floor(columns));
  const rows = [];
  for (let start = 0; start < keys.length; start += size) {
    const rowKeys = keys.slice(start, start + size);
    rows.push({ key: JSON.stringify(rowKeys), keys: rowKeys, start, end: start + rowKeys.length });
  }
  return rows;
}

// The measured grid-row height already includes its tallest card and row gap.
export function productRowMetrics(rows, heights, estimatedHeight = 250) {
  const estimate = Number.isFinite(estimatedHeight) && estimatedHeight > 0 ? estimatedHeight : 250;
  const offsets = [0];
  for (const row of rows) {
    const height = heights.get(row.key);
    offsets.push(offsets.at(-1) + (Number.isFinite(height) && height > 0 ? height : estimate));
  }
  return { offsets, totalHeight: offsets.at(-1), rowCount: rows.length };
}

export function productRowAtOffset(metrics, offset) {
  if (!metrics.rowCount) return 0;
  const target = Math.max(0, offset);
  let low = 0;
  let high = metrics.rowCount;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (metrics.offsets[middle + 1] <= target) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, metrics.rowCount - 1);
}

export function productWindowRange(metrics, localTop, viewportHeight, overscan = 600) {
  if (!metrics.rowCount) return { start: 0, end: 0 };
  const padding = Math.max(0, overscan);
  const start = productRowAtOffset(metrics, localTop - padding);
  const end = Math.max(start + 1, productRowAtOffset(metrics, localTop + Math.max(0, viewportHeight) + padding) + 1);
  return { start, end: Math.min(end, metrics.rowCount) };
}

export function productRenderedRows(range, rowCount, retainedRows = []) {
  const indices = new Set();
  for (let index = range.start; index < Math.min(range.end, rowCount); index += 1) indices.add(index);
  for (const index of retainedRows) {
    if (Number.isInteger(index) && index >= 0 && index < rowCount) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}

// Keep the first visible product in place when measured heights or columns change.
export function productAnchorOffset(previousRows, previousMetrics, rows, metrics, localTop) {
  if (!previousRows.length || !rows.length || localTop < 0 || localTop >= previousMetrics.totalHeight) return null;
  const previousIndex = productRowAtOffset(previousMetrics, localTop);
  const key = previousRows[previousIndex].keys[0];
  const index = rows.findIndex(row => row.keys.includes(key));
  if (index < 0) return null;
  const withinRow = localTop - previousMetrics.offsets[previousIndex];
  const height = metrics.offsets[index + 1] - metrics.offsets[index];
  return metrics.offsets[index] + Math.min(withinRow, Math.max(0, height - 1));
}
