import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  groupProductRows, nextProductCount, productAnchorOffset, productRenderedRows,
  productRowMetrics, productWindowRange, responsiveProductColumns,
} from './windowed-product-range.js';
import './windowed-product-list.css';

const itemKey = item => item.id;
const sameRange = (a, b) => a.start === b.start && a.end === b.end;

function useColumns(override) {
  const read = () => typeof window === 'undefined' ? 3 : responsiveProductColumns(window.innerWidth);
  const [responsive, setResponsive] = useState(read);
  useEffect(() => {
    const resize = () => setResponsive(read());
    // Column choice follows the viewport, including when this list is in a narrow panel.
    const queries = typeof window.matchMedia === 'function'
      ? [window.matchMedia('(max-width: 580px)'), window.matchMedia('(max-width: 800px)')]
      : [];
    queries.forEach(query => query.addEventListener ? query.addEventListener('change', resize) : query.addListener?.(resize));
    if (!queries.length) window.addEventListener('resize', resize);
    resize();
    return () => {
      queries.forEach(query => query.removeEventListener ? query.removeEventListener('change', resize) : query.removeListener?.(resize));
      if (!queries.length) window.removeEventListener('resize', resize);
    };
  }, []);
  return Number.isInteger(override) && override >= 1 && override <= 3 ? override : responsive;
}

function ProductRow({ row, register, children }) {
  const ref = useCallback(element => register(row.key, element), [register, row.key]);
  return <div className="windowed-products-row" role="presentation" ref={ref}>{children}</div>;
}

function ProductWindow({
  items, getKey = itemKey, renderItem, pageSize = 20, estimatedHeight = 250,
  columns: columnOverride, overscan = 600, className = '', ariaLabel = '商品列表',
  emptyContent = null, footer = null, scrollToStartOnMount = false,
}) {
  const columns = useColumns(columnOverride);
  const chunkSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 20;
  const [loadedCount, setLoadedCount] = useState(() => Math.min(chunkSize, items.length));
  const count = Math.min(loadedCount, items.length);
  const keys = useMemo(() => items.slice(0, count).map((item, index) => String(getKey(item, index))), [items, count, getKey]);
  const rows = useMemo(() => groupProductRows(keys, columns), [keys, columns]);
  const heights = useRef(new Map());
  const [measurement, setMeasurement] = useState(0);
  const metrics = useMemo(() => productRowMetrics(rows, heights.current, estimatedHeight), [rows, estimatedHeight, measurement]);
  const [range, setRange] = useState(() => productWindowRange(metrics, 0, 800, overscan));
  const [focusedKey, setFocusedKey] = useState(null);
  const pendingFocus = useRef(null);
  const root = useRef(null);
  const sentinel = useRef(null);
  const nodes = useRef(new Map());
  const observer = useRef(null);
  const frame = useRef(null);
  const alive = useRef(false);
  const measureAll = useRef(true);
  const autoLoad = useRef(false);
  const width = useRef(null);
  const previousGeometry = useRef(null);
  const current = useRef(null);
  current.current = { rows, metrics, count, total: items.length, chunkSize, overscan };

  const schedule = useCallback(() => {
    if (!alive.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const element = root.current;
      if (!alive.current || !element) return;
      const data = current.current;
      const bounds = element.getBoundingClientRect();
      let changed = false;
      if (width.current !== null && Math.abs(width.current - bounds.width) > 1) {
        heights.current.clear();
        measureAll.current = true;
        changed = true;
      }
      width.current = bounds.width;
      if (measureAll.current) {
        measureAll.current = false;
        // Read every mounted row before requesting a render; no per-row render loop.
        for (const [key, node] of nodes.current) {
          const height = node.getBoundingClientRect().height;
          if (height > 0 && Math.abs(height - (heights.current.get(key) ?? 0)) > 0.5) {
            heights.current.set(key, height);
            changed = true;
          }
        }
      }
      if (changed) setMeasurement(value => value + 1);
      else {
        const next = productWindowRange(data.metrics, -bounds.top, window.innerHeight, data.overscan);
        setRange(value => sameRange(value, next) ? value : next);
      }
      if (autoLoad.current) {
        autoLoad.current = false;
        const end = sentinel.current?.getBoundingClientRect();
        if (end && end.top <= window.innerHeight + 400 && end.bottom >= -400 && data.count < data.total) {
          setLoadedCount(value => nextProductCount(value, data.total, data.chunkSize));
        }
      }
    });
  }, []);

  const register = useCallback((key, element) => {
    const old = nodes.current.get(key);
    if (old && old !== element) observer.current?.unobserve(old);
    if (!element) nodes.current.delete(key);
    else {
      nodes.current.set(key, element);
      if (old !== element) observer.current?.observe(element);
      measureAll.current = true;
      schedule();
    }
  }, [schedule]);

  useLayoutEffect(() => {
    alive.current = true;
    if (typeof ResizeObserver === 'function') {
      observer.current = new ResizeObserver(() => { measureAll.current = true; schedule(); });
      observer.current.observe(root.current);
      nodes.current.forEach(node => observer.current.observe(node));
    }
    const scroll = () => {
      if (!observer.current) measureAll.current = true;
      schedule();
    };
    const resize = () => { measureAll.current = true; schedule(); };
    window.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('resize', resize);
    if (scrollToStartOnMount && root.current.getBoundingClientRect().top < 0) {
      window.scrollBy(0, root.current.getBoundingClientRect().top);
    }
    schedule();
    return () => {
      alive.current = false;
      observer.current?.disconnect();
      observer.current = null;
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('resize', resize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [schedule, scrollToStartOnMount]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    if (loadedCount === 0 && items.length > 0) setLoadedCount(Math.min(chunkSize, items.length));
    const bounds = element.getBoundingClientRect();
    const previous = previousGeometry.current;
    if (previous && previous.metrics !== metrics && bounds.top <= 0 && bounds.bottom > 0) {
      // Another list or panel above us can move this root. Anchor only this list's
      // current viewport; a remembered document position could pull the user away.
      const localTop = -bounds.top;
      const anchor = productAnchorOffset(previous.rows, previous.metrics, rows, metrics, localTop);
      if (anchor !== null) {
        const delta = anchor - localTop;
        if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
      }
    }
    previousGeometry.current = { rows, metrics };
    const next = productWindowRange(metrics, -element.getBoundingClientRect().top, window.innerHeight, overscan);
    setRange(value => sameRange(value, next) ? value : next);
    if (pendingFocus.current !== null) {
      const cell = element.querySelector(`[data-windowed-index="${pendingFocus.current}"]`);
      if (cell) {
        pendingFocus.current = null;
        cell.focus({ preventScroll: true });
        cell.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      }
    }
    if (!observer.current) measureAll.current = true;
    schedule();
  }, [rows, metrics, overscan, schedule, loadedCount, items.length, chunkSize]);

  useEffect(() => {
    if (typeof IntersectionObserver !== 'function' || count >= items.length || !sentinel.current) return;
    const intersection = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { autoLoad.current = true; schedule(); }
    }, { rootMargin: '400px 0px' });
    intersection.observe(sentinel.current);
    // Re-observe after each chunk, so an end still in view keeps loading short pages.
    return () => intersection.disconnect();
  }, [count, items.length, schedule]);

  const focusRow = focusedKey === null ? -1 : rows.findIndex(row => row.keys.includes(focusedKey));
  const requestedRow = pendingFocus.current === null ? -1 : Math.floor(pendingFocus.current / columns);
  const rendered = productRenderedRows(range, rows.length, [focusRow, requestedRow]);
  const allLoaded = count === items.length;
  const visibleEndReached = rows.length === 0 || range.end >= rows.length;
  const footerState = { allLoaded, visibleEndReached, loadedCount: count, totalCount: items.length };
  const endContent = allLoaded && visibleEndReached ? (typeof footer === 'function' ? footer(footerState) : footer) : null;
  let previousEnd = 0;

  return <div className={`windowed-products ${className}`} ref={root} style={{ '--windowed-columns': columns }}
    onLoadCapture={() => { measureAll.current = true; schedule(); }}
    onClickCapture={() => { if (!observer.current) { measureAll.current = true; schedule(); } }}>
    <div className="windowed-products-items" role="list" aria-label={ariaLabel}>
      {rendered.map(rowIndex => {
        const row = rows[rowIndex];
        const gap = metrics.offsets[rowIndex] - previousEnd;
        previousEnd = metrics.offsets[rowIndex + 1];
        return <Fragment key={row.key}>
          {gap > 0 && <div className="windowed-products-spacer" aria-hidden="true" style={{ height: gap }} />}
          <ProductRow row={row} register={register}>
            {items.slice(row.start, row.end).map((item, offset) => {
              const index = row.start + offset;
              const key = keys[index];
              return <div key={key} className="windowed-products-cell" role="listitem" tabIndex={-1}
                aria-setsize={items.length} aria-posinset={index + 1} data-windowed-index={index}
                onFocusCapture={() => setFocusedKey(key)}
                onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null); }}>
                {renderItem(item, index)}
              </div>;
            })}
          </ProductRow>
        </Fragment>;
      })}
      {metrics.totalHeight > previousEnd && <div className="windowed-products-spacer" aria-hidden="true" style={{ height: metrics.totalHeight - previousEnd }} />}
    </div>
    {!items.length && emptyContent}
    {items.length > 0 && <div className="windowed-products-controls">
      <span role="status" aria-live="polite">已显示 {count} / {items.length} 件商品</span>
      {!allLoaded && <button className="windowed-products-more" type="button" onClick={() => {
        pendingFocus.current = count;
        setLoadedCount(value => nextProductCount(value, items.length, chunkSize));
      }}>加载更多</button>}
    </div>}
    {!allLoaded && <div ref={sentinel} className="windowed-products-sentinel" aria-hidden="true" />}
    {endContent && <div className="windowed-products-end">{endContent}</div>}
  </div>;
}

/** Product metadata and cart state remain outside this page-scroll window. */
export default function WindowedProductList({ resetKey = '', ...props }) {
  const previous = useRef(resetKey);
  const changed = previous.current !== resetKey;
  useLayoutEffect(() => { previous.current = resetKey; }, [resetKey]);
  return <ProductWindow key={String(resetKey)} {...props} scrollToStartOnMount={changed} />;
}
