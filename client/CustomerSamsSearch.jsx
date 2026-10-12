import { useEffect, useRef, useState } from 'react';

const emptyResults = () => ({ products: [], query: '', page: 0, has_more: false, queried_at: null });
const storeKey = store => store ? `${store.storeType ?? store.store_type}:${store.storeId ?? store.store_id}` : '';

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
  const alive = useRef(true);
  const currentResults = useRef(results);
  const currentStore = useRef(storeKey(store));
  currentStore.current = storeKey(store);

  function replaceResults(value) { currentResults.current = value; setResults(value); }

  useEffect(() => {
    alive.current = true; input.current?.focus();
    return () => { alive.current = false; generation.current += 1; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    controller.current?.abort(); generation.current += 1;
    replaceResults(emptyResults()); setLoading(false); setError(''); setExpired(false);
  }, [base, storeKey(store)]);

  useEffect(() => {
    setKeyword(initialKeyword);
    controller.current?.abort(); generation.current += 1;
    replaceResults(emptyResults()); setLoading(false); setError(''); setExpired(false);
  }, [initialKeyword]);

  function changeKeyword(value) {
    setKeyword(value); controller.current?.abort(); generation.current += 1;
    replaceResults(emptyResults()); setLoading(false); setError(''); setExpired(false);
  }

  async function search(page = 1) {
    if (!store || disabled || identityError || addingId) return;
    const query = String(page === 1 ? keyword : currentResults.current.query).trim();
    if (!query) { setError('请输入想买的商品名称。'); input.current?.focus(); return; }
    controller.current?.abort();
    const version = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    const targetStore = storeKey(store);
    if (page === 1) replaceResults({ ...emptyResults(), query });
    setLoading(true); setError(''); setExpired(false); setFailedPage(page);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 35000);
    try {
      const params = new URLSearchParams({ keyword: query, page: String(page) });
      const result = await api(`${base}/sams/search?${params}`, { signal: abort.signal });
      if (!alive.current || version !== generation.current || targetStore !== currentStore.current) return;
      if (!Array.isArray(result.products) || !result.selectionId) throw new Error('商品结果暂不可用，请重新查询。');
      if (result.store && storeKey(result.store) !== targetStore) throw new Error('本期采购门店已变化，请刷新页面后重新查询。');
      const seen = new Set(currentResults.current.products.map(product => product.id));
      const next = result.products.slice(0, 20).filter(product => {
        if (!product?.id || seen.has(product.id)) return false;
        seen.add(product.id); return true;
      }).map(product => ({ ...product, selectionId: result.selectionId }));
      replaceResults({ ...result, products: [...currentResults.current.products, ...next], query, page: Number(result.page) || page, has_more: result.has_more === true });
    } catch (error) {
      if (!alive.current || version !== generation.current || error.name === 'AbortError' && !timedOut) return;
      setError(timedOut ? '查询有些慢，请稍后重试。' : error.message || '暂时无法查询山姆商品，请重试。');
    } finally { clearTimeout(timer); if (alive.current && version === generation.current) setLoading(false); }
  }

  async function add(product) {
    if (disabled || identityError || addingId || expired) return;
    const version = generation.current;
    setError('');
    try { await onAdd(product, product.selectionId); }
    catch (error) {
      if (!alive.current || version !== generation.current) return;
      if (error.code?.includes('SELECTION_EXPIRED')) {
        setExpired(true); setFailedPage(1); setError('这次查询已过期，请重新查询后加入购物车。');
      } else setError(error.message || '暂未加入购物车，请重试。');
    }
  }

  return <section className="customer-sams-search" aria-labelledby="customer-sams-title">
    <div className="customer-sams-heading"><div><h2 id="customer-sams-title">搜索山姆商品</h2><p>{store ? `本期采购门店：${store.cityName ? `${store.cityName} · ` : ''}${store.name || '山姆门店'}。自选商品只加入你的清单。` : '本期尚未设置采购门店，请联系团长开通自选；推荐商品仍可正常购买。'}</p></div><button type="button" className="text-button" onClick={onClose} disabled={Boolean(addingId)}>收起搜索</button></div>
    <form className="customer-sams-form" onSubmit={event => { event.preventDefault(); if (!loading) search(); }}><label htmlFor="customer-sams-keyword">想买什么？</label><div><input id="customer-sams-keyword" ref={input} type="search" value={keyword} onChange={event => changeKeyword(event.target.value)} onInput={event => changeKeyword(event.currentTarget.value)} maxLength={80} placeholder="例如：牛肉卷、牛奶、麻薯" disabled={!store || Boolean(addingId)} /><button type="submit" className="button primary" disabled={!store || disabled || Boolean(identityError) || Boolean(addingId) || loading || !keyword.trim()}>{loading ? '查询中…' : '查询商品'}</button></div></form>
    {identityError && <p className="notice error" role="alert">{identityError}</p>}
    {error && <div className="notice error" role="alert"><span>{error}</span>{results.query && <button type="button" disabled={loading || disabled || Boolean(addingId) || Boolean(identityError)} onClick={() => search(expired ? 1 : failedPage)}>重新查询</button>}</div>}
    {!!results.products.length && <><p className="customer-sams-count" role="status">“{results.query}” · 已加载 {results.products.length} 件{results.queried_at ? ` · ${new Date(results.queried_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })} 查询` : ''}</p><div className="product-grid">{results.products.map(product => renderProduct(product, { key: product.id, disabled: disabled || expired || Boolean(identityError) || Boolean(addingId), adding: addingId === product.id, onAdd: () => add(product) }))}</div></>}
    {loading && <div className="customer-sams-loading" role="status"><span className="spinner" />正在查询山姆商品…</div>}
    {!loading && results.query && !results.products.length && !error && <div className="customer-sams-empty"><h3>暂未找到匹配的商品</h3><p>换个商品名称试试，或联系团长帮你找。</p></div>}
    {results.has_more && <div className="customer-sams-more"><button type="button" className="button secondary" disabled={loading || disabled || Boolean(addingId) || expired || Boolean(identityError)} onClick={() => search(results.page + 1)}>{loading ? '加载中…' : '加载更多商品'}</button></div>}
    <p className="customer-sams-help">已上架同款沿用后台售价；其他自选商品按山姆查询价格计算。属于本期推荐的商品使用推荐费率，其余使用自选费率，费用在结算时单独展示。价格和库存可能变化，提交时会再次核对。</p>
  </section>;
}
