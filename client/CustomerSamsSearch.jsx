import { useEffect, useRef, useState } from 'react';
import WindowedProductList from './WindowedProductList.jsx';
import './customer-product-list.css';

const emptyResults = () => ({ products: [], query: '', page: 0, has_more: false, queried_at: null });
const storeKey = store => store ? `${store.storeType ?? store.store_type}:${store.storeId ?? store.store_id}` : '';

function SamsMore({ automatic, disabled, loading, retry, requestKey, onMore }) {
  const sentinel = useRef(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !automatic || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) more.current(true);
    }, { rootMargin: '100px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [automatic, requestKey]);
  return <div className="customer-sams-more" ref={sentinel}><button type="button" className="button secondary" disabled={disabled} onClick={() => more.current(false)}>{loading ? '加载中…' : retry ? '重试加载更多' : '加载更多商品'}</button></div>;
}

export default function CustomerSamsSearch({ base, api, store, initialKeyword = '', disabled, identityError, addingId, renderProduct, onAdd, onClose }) {
  const [keyword, setKeyword] = useState(initialKeyword);
  const [results, setResults] = useState(emptyResults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [failedPage, setFailedPage] = useState(1);
  const input = useRef(null);
  const generation = useRef(0);
  const controller = useRef(null);
  const inFlight = useRef(null);
  const addition = useRef(false);
  const automaticPaused = useRef(false);
  const alive = useRef(true);
  const currentResults = useRef(results);
  const currentKeyword = useRef(initialKeyword);
  const queryStore = useRef('');
  const currentStore = useRef(storeKey(store));
  const storeIdentity = storeKey(store);
  currentStore.current = storeIdentity;

  function replaceResults(value) { currentResults.current = value; setResults(value); }
  function cancelSearch() {
    controller.current?.abort(); controller.current = null; generation.current += 1; inFlight.current = null;
    queryStore.current = ''; automaticPaused.current = false;
    replaceResults(emptyResults()); setLoading(false); setError(''); setExpired(false);
  }

  useEffect(() => {
    alive.current = true; input.current?.focus();
    return () => { alive.current = false; generation.current += 1; controller.current?.abort(); inFlight.current = null; };
  }, []);

  useEffect(() => { cancelSearch(); }, [base, storeIdentity]);

  useEffect(() => {
    currentKeyword.current = initialKeyword; setKeyword(initialKeyword); cancelSearch();
  }, [initialKeyword]);

  function changeKeyword(value) {
    if (value === currentKeyword.current) return;
    currentKeyword.current = value; setKeyword(value); cancelSearch();
  }

  async function search(page = 1, automatic = false) {
    if (!store || disabled || identityError || addingId || addition.current || inFlight.current) return;
    const previous = currentResults.current;
    if (page > 1 && (expired || queryStore.current !== currentStore.current || page !== previous.page + 1 || !previous.has_more)) return;
    if (automatic && (automaticPaused.current || error || expired || !previous.products.length || page === 1)) return;
    const query = String(page === 1 ? currentKeyword.current : previous.query).trim();
    if (!query) { automaticPaused.current = true; setError('请输入想买的商品名称。'); input.current?.focus(); return; }
    const version = ++generation.current;
    const abort = new AbortController();
    const targetStore = currentStore.current;
    const flight = { version, page, query, store: targetStore };
    inFlight.current = flight; controller.current = abort; queryStore.current = targetStore;
    automaticPaused.current = false;
    if (page === 1) replaceResults({ ...emptyResults(), query });
    setLoading(true); setError(''); setExpired(false); setFailedPage(page);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 35000);
    try {
      const params = new URLSearchParams({ keyword: query, page: String(page) });
      const result = await api(`${base}/sams/search?${params}`, { signal: abort.signal });
      if (!alive.current || version !== generation.current || targetStore !== currentStore.current) return;
      if (!Array.isArray(result.products) || !result.selectionId || Number(result.page) !== page) throw new Error('商品结果暂不可用，请重新查询。');
      if (result.store && storeKey(result.store) !== targetStore) throw new Error('本期采购门店已变化，请刷新页面后重新查询。');
      const seen = new Set(currentResults.current.products.map(product => product.id));
      const next = result.products.slice(0, 20).filter(product => {
        if (!product?.id || seen.has(product.id)) return false;
        seen.add(product.id); return true;
      }).map(product => ({ ...product, selectionId: result.selectionId }));
      replaceResults({ ...result, products: [...currentResults.current.products, ...next], query, page, has_more: result.has_more === true });
      if (!next.length && result.has_more === true) {
        automaticPaused.current = true; setFailedPage(page + 1); setError('本页没有新的商品，可以手动继续加载下一页。');
      }
    } catch (error) {
      if (!alive.current || version !== generation.current || error.name === 'AbortError' && !timedOut) return;
      automaticPaused.current = true;
      setError(timedOut ? '查询有些慢，请稍后重试。' : error.message || '暂时无法查询山姆商品，请重试。');
    } finally {
      clearTimeout(timer);
      if (inFlight.current === flight) inFlight.current = null;
      if (alive.current && version === generation.current) setLoading(false);
    }
  }

  async function add(product) {
    if (disabled || identityError || addingId || addition.current || expired) return;
    const version = generation.current;
    addition.current = true; setError('');
    try { await onAdd(product, product.selectionId); }
    catch (error) {
      if (!alive.current || version !== generation.current) return;
      automaticPaused.current = true;
      if (error.code?.includes('SELECTION_EXPIRED')) {
        setExpired(true); setFailedPage(1); setError('这次查询已过期，请重新查询后加入购物车。');
      } else setError(error.message || '暂未加入购物车，请重试。');
    } finally { addition.current = false; }
  }

  const moreDisabled = loading || disabled || Boolean(addingId) || expired || Boolean(identityError);
  const nextPage = results.page + 1;
  const renderMore = ({ allLoaded, visibleEndReached }) => results.has_more && allLoaded && visibleEndReached && <SamsMore automatic={!moreDisabled && !error && !automaticPaused.current} disabled={moreDisabled} loading={loading} retry={Boolean(error)} requestKey={`${results.query}:${storeIdentity}:${results.page}:${results.products.length}`} onMore={automatic => search(nextPage, automatic)} />;

  return <section className="customer-sams-search" aria-labelledby="customer-sams-title" data-product-image-focus-fallback tabIndex={-1}>
    <div className="customer-sams-heading"><div><h2 id="customer-sams-title">搜索山姆商品</h2><p>{store ? `本期采购门店：${store.cityName ? `${store.cityName} · ` : ''}${store.name || '山姆门店'}。自选商品只加入你的清单。` : '本期尚未设置采购门店，请联系团长开通自选；推荐商品仍可正常购买。'}</p></div><button type="button" className="text-button" onClick={onClose} disabled={Boolean(addingId)}>收起搜索</button></div>
    <form className="customer-sams-form" onSubmit={event => { event.preventDefault(); search(); }}><label htmlFor="customer-sams-keyword">想买什么？</label><div><input id="customer-sams-keyword" ref={input} data-product-image-focus-fallback type="search" value={keyword} onChange={event => changeKeyword(event.target.value)} onInput={event => changeKeyword(event.currentTarget.value)} maxLength={80} placeholder="例如：牛肉卷、牛奶、麻薯" disabled={!store || Boolean(addingId)} /><button type="submit" className="button primary" disabled={!store || disabled || Boolean(identityError) || Boolean(addingId) || loading || !keyword.trim()}>{loading ? '查询中…' : '查询商品'}</button></div></form>
    {identityError && <p className="notice error" role="alert">{identityError}</p>}
    {error && <div className="notice error" role="alert"><span>{error}</span>{results.query && <button type="button" disabled={loading || disabled || Boolean(addingId) || Boolean(identityError)} onClick={() => search(expired ? 1 : failedPage)}>重新查询</button>}</div>}
    {!!results.products.length && <><p className="customer-sams-count" role="status">“{results.query}” · 已加载 {results.products.length} 件{results.queried_at ? ` · ${new Date(results.queried_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })} 查询` : ''}</p><WindowedProductList className="customer-product-list" ariaLabel="山姆商品查询结果" items={results.products} getKey={product => product.id} resetKey={`${base}:${storeIdentity}:${results.query}`} footer={renderMore} renderItem={product => renderProduct(product, { key: product.id, disabled: disabled || expired || Boolean(identityError) || Boolean(addingId), adding: addingId === product.id, onAdd: () => add(product) })} /></>}
    {loading && <div className="customer-sams-loading" role="status"><span className="spinner" />正在查询山姆商品…</div>}
    {!loading && results.query && !results.products.length && !error && <div className="customer-sams-empty"><h3>暂未找到匹配的商品</h3><p>换个商品名称试试，或联系团长帮你找。</p></div>}
    {!results.products.length && results.has_more && renderMore({ allLoaded: true, visibleEndReached: true })}
    <p className="customer-sams-help">已上架同款沿用后台售价；标有“按份拼单”的商品按每份规格和价格报名，截单后确认成团。其他自选商品按山姆查询价格计算。属于本期推荐的商品使用推荐费率，其余使用自选费率，费用在结算时单独展示。价格可能变化，提交时会再次核对。</p>
  </section>;
}
