import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CatalogImage } from './ProductCatalog.jsx';
import ProductDescription from './ProductDescription.jsx';

const SETTINGS_KEY = 'admin-sams-selection-v1';
const emptyResults = () => ({ products: [], query: '', mode: '', store: null, page: 0, total: null, has_more: false, queried_at: null, cached: false });
const rowId = product => String(product.productId || `sam_${product.spu_id}`);
const storeKey = store => store ? `${store.store_id}:${store.store_type}` : '';
const knownPrice = product => Number.isSafeInteger(product.price_cents) && product.price_cents >= 0;
const canSelect = product => knownPrice(product) && product.selectable !== false && Boolean(product.image_url);
const salePrice = product => knownPrice(product) ? `¥${(product.price_cents / 100).toFixed(2)}` : '价格未提供';
const queriedTime = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

function preferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { cityCode: /^\d{6}$/.test(String(saved?.cityCode)) ? String(saved.cityCode) : '440300', storeId: String(saved?.storeId || '6505'), keyword: String(saved?.keyword || '牛肉卷').slice(0, 80), mode: saved?.mode === 'search' ? 'search' : 'rank', rankId: String(saved?.rankId || '') };
  } catch { return { cityCode: '440300', storeId: '6505', keyword: '牛肉卷', mode: 'rank', rankId: '' }; }
}

export default function SamsSelection({ api, products, onAdded, notify, onCatalog }) {
  const initial = useRef(null);
  if (!initial.current) initial.current = preferences();
  const [cities, setCities] = useState([]);
  const [cityCode, setCityCode] = useState(initial.current.cityCode);
  const [stores, setStores] = useState([]);
  const [chosenStore, setChosenStore] = useState(null);
  const [keyword, setKeyword] = useState(initial.current.keyword);
  const [mode, setMode] = useState(initial.current.mode);
  const [ranks, setRanks] = useState([]);
  const [chosenRank, setChosenRank] = useState(null);
  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState('');
  const [rankLoading, setRankLoading] = useState(false);
  const [rankError, setRankError] = useState('');
  const [locationLoading, setLocationLoading] = useState('cities');
  const [locationError, setLocationError] = useState('');
  const [locationWarning, setLocationWarning] = useState('');
  const [retryLocation, setRetryLocation] = useState('');
  const [results, setResults] = useState(emptyResults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [failedPage, setFailedPage] = useState(1);
  const [selected, setSelected] = useState(new Map());
  const [addedIds, setAddedIds] = useState(new Set());
  const [selecting, setSelecting] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState('');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [sort, setSort] = useState('default');
  const alive = useRef(true);
  const controllers = useRef(new Set());
  const locationController = useRef(null);
  const searchController = useRef(null);
  const rankController = useRef(null);
  const locationGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const rankGeneration = useRef(0);
  const context = useRef({ cityCode: initial.current.cityCode, store: null });
  const currentResults = useRef(results);
  const currentKeyword = useRef(keyword);
  const currentMode = useRef(initial.current.mode);
  const currentRank = useRef(null);
  const currentCategory = useRef('');
  currentKeyword.current = keyword;
  const catalogIds = useMemo(() => new Set([...products.map(product => product.id), ...addedIds]), [products, addedIds]);
  const inCatalog = product => product.inCatalog || catalogIds.has(rowId(product));
  const activeSelected = [...selected.values()].filter(product => !inCatalog(product));
  const city = cities.find(item => String(item.city_code) === cityCode);

  const bounded = useCallback(async (path, controller, options = {}) => {
    controllers.current.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 35000);
    try { return await api(path, { ...options, signal: controller.signal }); }
    catch (error) { if (timedOut) throw new Error('查询超时，请稍后重试。'); throw error; }
    finally { clearTimeout(timer); controllers.current.delete(controller); }
  }, [api]);

  function replaceResults(value) { currentResults.current = value; setResults(value); }

  function clearSearch() {
    searchController.current?.abort();
    searchGeneration.current += 1;
    setLoading(false); setError(''); setSelected(new Map()); setSelectionNotice('');
    replaceResults(emptyResults());
  }

  function clearRanks() {
    rankController.current?.abort(); rankGeneration.current += 1;
    setRanks([]); setChosenRank(null); setCategories([]); setCategoryId(''); setRankLoading(false); setRankError('');
    currentRank.current = null; currentCategory.current = '';
  }

  function saveSettings(targetStore = context.current.store, query = currentKeyword.current) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ cityCode: context.current.cityCode, storeId: targetStore?.store_id || '', keyword: query, mode: currentMode.current, rankId: currentRank.current?.rank_id || '' })); } catch { /* persistence is optional */ }
  }

  function appendProducts(result, previous, limit) {
    const seen = new Set(previous.map(product => String(product.spu_id)));
    const next = [];
    for (const product of result.products.slice(0, limit)) {
      const id = String(product?.spu_id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id); next.push({ ...product, selectionId: result.selectionId });
    }
    return [...previous, ...next];
  }

  function validResults(result, targetStore) {
    if (!Array.isArray(result.products) || !result.selectionId) throw new Error('查询结果暂时无法用于选品，请重新查询。');
    if (String(result.store?.store_id) !== targetStore.store_id || Number(result.store?.store_type) !== targetStore.store_type) throw new Error('返回门店与所选门店不一致，请重新查询。');
  }

  async function browse(page = 1, rankOverride, categoryOverride, storeOverride) {
    if (selecting) return;
    const targetStore = storeOverride || context.current.store;
    const targetRank = rankOverride || currentRank.current;
    const targetCategory = String(categoryOverride ?? currentCategory.current);
    if (!targetStore || !targetRank) return;
    searchController.current?.abort();
    const generation = ++searchGeneration.current;
    const controller = new AbortController();
    searchController.current = controller;
    const targetContext = `${context.current.cityCode}:${storeKey(targetStore)}`;
    if (page === 1) {
      setSelected(new Map()); setSelectionNotice('');
      replaceResults({ ...emptyResults(), mode: 'rank', rank: targetRank, store: targetStore });
    }
    setLoading(true); setError(''); setFailedPage(page); saveSettings(targetStore);
    try {
      const payload = { rankId: targetRank.rank_id, cityCode: context.current.cityCode, storeId: targetStore.store_id, storeType: targetStore.store_type, page };
      if (targetCategory) payload.categoryId = targetCategory;
      if (page > 1) payload.excludeSpuIds = currentResults.current.products.map(product => String(product.spu_id)).slice(-2000);
      const result = await bounded('/sams/browse', controller, { method: 'POST', body: JSON.stringify(payload) });
      if (!alive.current || generation !== searchGeneration.current || currentMode.current !== 'rank' || targetContext !== `${context.current.cityCode}:${storeKey(context.current.store)}` || currentRank.current?.rank_id !== targetRank.rank_id || currentCategory.current !== targetCategory) return;
      validResults(result, targetStore);
      if (String(result.rank?.rank_id) !== targetRank.rank_id || targetCategory && String(result.category?.category_id) !== targetCategory) throw new Error('返回榜单与所选榜单不一致，请重新查询。');
      const list = (Array.isArray(result.categories) ? result.categories : []).filter(item => item?.category_id != null && item?.name).map(item => ({ ...item, category_id: String(item.category_id) }));
      const nextCategory = String(result.category?.category_id || '');
      setCategories(list); setCategoryId(nextCategory); currentCategory.current = nextCategory;
      replaceResults({ ...result, products: appendProducts(result, currentResults.current.products, 30), mode: 'rank', store: result.store, page: Number(result.page) || page, has_more: result.has_more === true });
    } catch (error) {
      if (!alive.current || generation !== searchGeneration.current || error.name === 'AbortError') return;
      setError(error.message || '榜单商品加载失败，请重试。');
    } finally { if (alive.current && generation === searchGeneration.current) setLoading(false); }
  }

  async function loadRanks(targetStore = context.current.store, preferredId = initial.current.rankId) {
    if (!targetStore || currentMode.current !== 'rank') return;
    rankController.current?.abort();
    const generation = ++rankGeneration.current;
    const controller = new AbortController();
    rankController.current = controller;
    const targetContext = `${context.current.cityCode}:${storeKey(targetStore)}`;
    setRankLoading(true); setRankError(''); setRanks([]); setChosenRank(null); setCategories([]); setCategoryId('');
    currentRank.current = null; currentCategory.current = '';
    try {
      const params = new URLSearchParams({ cityCode: context.current.cityCode, storeId: targetStore.store_id, storeType: String(targetStore.store_type) });
      const result = await bounded(`/sams/ranks?${params}`, controller);
      if (!alive.current || generation !== rankGeneration.current || currentMode.current !== 'rank' || targetContext !== `${context.current.cityCode}:${storeKey(context.current.store)}`) return;
      if (String(result.store?.store_id) !== targetStore.store_id || Number(result.store?.store_type) !== targetStore.store_type) throw new Error('返回门店与所选门店不一致，请重新加载榜单。');
      const list = (Array.isArray(result.ranks) ? result.ranks : []).filter(item => item?.rank_id != null && item?.name).map(item => ({ ...item, rank_id: String(item.rank_id) }));
      if (!list.length) throw new Error('此门店暂未提供可浏览的榜单，可以切换门店或搜索商品。');
      const next = list.find(item => item.rank_id === preferredId) || list[0];
      setRanks(list); setChosenRank(next); currentRank.current = next; saveSettings(targetStore);
      setRankLoading(false);
      await browse(1, next, '', targetStore);
    } catch (error) {
      if (!alive.current || generation !== rankGeneration.current || error.name === 'AbortError') return;
      setRankError(error.message || '榜单加载失败，请重试。');
    } finally { if (alive.current && generation === rankGeneration.current) setRankLoading(false); }
  }

  async function loadProductsForStore(targetStore) {
    if (!targetStore) return;
    if (currentMode.current === 'rank') await loadRanks(targetStore);
    else await search(1, currentKeyword.current, targetStore);
  }

  async function loadStores(targetCity, preferredId = '') {
    locationController.current?.abort();
    const generation = ++locationGeneration.current;
    const controller = new AbortController();
    locationController.current = controller;
    context.current = { cityCode: targetCity, store: null };
    setStores([]); setChosenStore(null); setLocationLoading('stores'); setLocationError(''); setLocationWarning(''); setRetryLocation('');
    try {
      const result = await bounded(`/sams/stores?${new URLSearchParams({ cityCode: targetCity })}`, controller);
      if (!alive.current || generation !== locationGeneration.current) return null;
      const list = (Array.isArray(result.stores) ? result.stores : [])
        .filter(store => /^\d{1,12}$/.test(String(store?.store_id)) && Number(store.store_type) > 0)
        .map(store => ({ ...store, store_id: String(store.store_id), store_type: Number(store.store_type) }));
      list.sort((a, b) => Number(b.store_id === '6505') - Number(a.store_id === '6505'));
      const selectedStore = list.find(store => store.store_id === preferredId) || list[0] || null;
      setStores(list); setChosenStore(selectedStore);
      context.current = { cityCode: targetCity, store: selectedStore };
      setLocationWarning(result.warning || '');
      if (!selectedStore) { setLocationError('暂时没有发现此城市的具体门店，请重新加载或选择其他城市。'); setRetryLocation('stores'); }
      saveSettings(selectedStore);
      return selectedStore;
    } catch (error) {
      if (!alive.current || generation !== locationGeneration.current || error.name === 'AbortError') return null;
      setLocationError(error.message || '门店加载失败，请重试。'); setRetryLocation('stores');
      return null;
    } finally { if (alive.current && generation === locationGeneration.current) setLocationLoading(''); }
  }

  async function search(page = 1, queryOverride, storeOverride) {
    if (selecting) return;
    const targetStore = storeOverride || context.current.store;
    const query = String(page === 1 ? queryOverride ?? currentKeyword.current : currentResults.current.query).trim();
    if (!targetStore || !query) { setError(!query ? '请填写商品关键词。' : '请选择具体门店后再查询。'); return; }
    searchController.current?.abort();
    const generation = ++searchGeneration.current;
    const controller = new AbortController();
    searchController.current = controller;
    const targetContext = `${context.current.cityCode}:${storeKey(targetStore)}`;
    if (page === 1) {
      setSelected(new Map()); setSelectionNotice('');
      replaceResults({ ...emptyResults(), mode: 'search', query, store: targetStore });
    }
    setLoading(true); setError(''); setFailedPage(page);
    saveSettings(targetStore, query);
    try {
      const params = new URLSearchParams({ keyword: query, cityCode: context.current.cityCode, storeId: targetStore.store_id, storeType: String(targetStore.store_type), page: String(page) });
      const result = await bounded(`/sams/search?${params}`, controller);
      if (!alive.current || generation !== searchGeneration.current || currentMode.current !== 'search' || targetContext !== `${context.current.cityCode}:${storeKey(context.current.store)}`) return;
      validResults(result, targetStore);
      replaceResults({ ...result, products: appendProducts(result, currentResults.current.products, 20), mode: 'search', query, store: result.store, page: Number(result.page) || page, has_more: result.has_more === true });
    } catch (error) {
      if (!alive.current || generation !== searchGeneration.current || error.name === 'AbortError') return;
      setError(error.message || '商品查询失败，请重试。');
    } finally { if (alive.current && generation === searchGeneration.current) setLoading(false); }
  }

  async function loadCities(autoSearch = false) {
    locationController.current?.abort();
    const generation = ++locationGeneration.current;
    const controller = new AbortController();
    locationController.current = controller;
    setLocationLoading('cities'); setLocationError(''); setRetryLocation('');
    try {
      const result = await bounded('/sams/cities', controller);
      if (!alive.current || generation !== locationGeneration.current) return;
      const list = (Array.isArray(result.cities) ? result.cities : []).filter(item => item?.city_code && item?.city_name);
      if (!list.length) throw new Error('城市列表暂时不可用，请重新加载。');
      const targetCity = String(list.find(item => String(item.city_code) === initial.current.cityCode)?.city_code || result.default_city_code || list[0].city_code);
      setCities(list); setCityCode(targetCity);
      const selectedStore = await loadStores(targetCity, initial.current.storeId);
      if (alive.current && selectedStore && autoSearch) await loadProductsForStore(selectedStore);
    } catch (error) {
      if (!alive.current || generation !== locationGeneration.current || error.name === 'AbortError') return;
      setLocationError(error.message || '城市加载失败，请重试。'); setRetryLocation('cities'); setLocationLoading('');
    }
  }

  useEffect(() => {
    alive.current = true;
    loadCities(true);
    return () => {
      alive.current = false; locationGeneration.current += 1; searchGeneration.current += 1; rankGeneration.current += 1;
      for (const controller of controllers.current) controller.abort();
    };
  }, [bounded]);

  async function chooseCity(value) {
    clearSearch(); clearRanks(); setCityCode(value);
    const next = await loadStores(value);
    if (alive.current && next) await loadProductsForStore(next);
  }
  function chooseStore(value) {
    const next = stores.find(store => storeKey(store) === value);
    if (!next) return;
    clearSearch(); clearRanks(); setChosenStore(next); context.current.store = next; saveSettings(next);
    loadProductsForStore(next);
  }
  function chooseMode(value) {
    if (value === currentMode.current || selecting) return;
    clearSearch(); clearRanks(); setMode(value); currentMode.current = value; saveSettings();
    if (context.current.store) loadProductsForStore(context.current.store);
  }
  function chooseRank(rank) {
    if (selecting || currentRank.current?.rank_id === rank.rank_id) return;
    clearSearch(); setChosenRank(rank); currentRank.current = rank;
    setCategories([]); setCategoryId(''); currentCategory.current = '';
    browse(1, rank, '');
  }
  function chooseCategory(value) {
    if (selecting || value === currentCategory.current) return;
    clearSearch(); setCategoryId(value); currentCategory.current = value;
    browse(1, undefined, value);
  }
  function queryPage(page = 1) {
    if (currentMode.current === 'rank') browse(page);
    else search(page);
  }
  function changeKeyword(value) {
    currentKeyword.current = value; setKeyword(value); clearSearch();
  }
  function toggle(product, checked) {
    if (inCatalog(product) || !canSelect(product) || selecting) return;
    setSelected(previous => {
      const next = new Map(previous);
      if (checked && !next.has(String(product.spu_id)) && next.size >= 200) { setError('一次最多选择 200 件商品，请先加入商品库。'); return previous; }
      if (checked) next.set(String(product.spu_id), product); else next.delete(String(product.spu_id));
      return next;
    });
  }

  async function addSelected() {
    if (selecting || !activeSelected.length) return;
    if (activeSelected.length > 200) { setError('一次最多加入 200 件商品，请减少勾选。'); return; }
    const chosen = activeSelected.slice();
    const groups = new Map();
    for (const product of chosen) {
      const ids = groups.get(product.selectionId) || [];
      ids.push(String(product.spu_id)); groups.set(product.selectionId, ids);
    }
    setSelecting(true); setError(''); setSelectionNotice('');
    try {
      const result = await api('/products/select', { method: 'POST', body: JSON.stringify({ selections: [...groups].map(([selectionId, spuIds]) => ({ selectionId, spuIds })) }) });
      await onAdded(result);
      if (!alive.current) return;
      setAddedIds(previous => new Set([...previous, ...chosen.map(rowId)]));
      const added = Number(result.added) || 0;
      const skipped = Number(result.skipped) || 0;
      const message = `已加入 ${added} 件${skipped ? `，跳过已有 ${skipped} 件` : ''}。新商品待上架，请到商品库核对售价。`;
      setSelectionNotice(message); notify(message);
    } catch (error) {
      if (alive.current) {
        if (error.code === 'SAMS_SELECTION_EXPIRED') { setFailedPage(1); setSelected(new Map()); }
        setError(error.message || '入库暂未完成，请重试。');
      }
    }
    finally { if (alive.current) setSelecting(false); }
  }

  const visible = useMemo(() => {
    const list = results.products.filter(product => !availableOnly || product.available === true && product.on_sale !== false);
    if (sort !== 'default') list.sort((a, b) => !knownPrice(a) ? !knownPrice(b) ? 0 : 1 : !knownPrice(b) ? -1 : (a.price_cents - b.price_cents) * (sort === 'desc' ? -1 : 1));
    return list;
  }, [results.products, availableOnly, sort]);
  const eligible = visible.filter(product => !inCatalog(product) && canSelect(product));
  const ready = chosenStore && !locationLoading;
  const resultTitle = mode === 'rank'
    ? results.rank ? `${results.rank.name}${results.category?.name && results.category.name !== results.rank.name ? ` · ${results.category.name}` : ''}` : chosenRank?.name || '浏览山姆官方榜单'
    : results.query ? `“${results.query}”的商品` : '选择要加入商品库的商品';

  return <div className="sams-selection-page">
    <section className="admin-card sams-search-panel"><form onSubmit={event => { event.preventDefault(); if (!loading && mode === 'search') search(); }}>
      <div className="sams-mode-switch" role="group" aria-label="商品查找方式"><button type="button" aria-pressed={mode === 'rank'} className={mode === 'rank' ? 'selected' : ''} disabled={selecting} onClick={() => chooseMode('rank')}>浏览榜单</button><button type="button" aria-pressed={mode === 'search'} className={mode === 'search' ? 'selected' : ''} disabled={selecting} onClick={() => chooseMode('search')}>搜索商品</button></div>
      <div className="sams-location-grid"><label className="admin-field">城市<select value={cityCode} disabled={locationLoading === 'cities' || selecting || !cities.length} onChange={event => chooseCity(event.target.value)}>{!cities.length && <option value={cityCode}>正在加载城市…</option>}{cities.map(item => <option key={item.city_code} value={item.city_code}>{item.city_name}{item.province_name && item.province_name !== item.city_name ? ` · ${item.province_name}` : ''}</option>)}</select></label><label className="admin-field">具体门店<select value={storeKey(chosenStore)} disabled={Boolean(locationLoading) || selecting || !stores.length} onChange={event => chooseStore(event.target.value)}>{!stores.length && <option value="">{locationLoading === 'stores' ? '正在加载门店…' : '暂无可选门店'}</option>}{stores.map(store => <option key={storeKey(store)} value={storeKey(store)}>{store.name}{store.kind ? ` · ${store.kind}` : ''}</option>)}</select></label></div>
      <div className="sams-location-feedback" role="status">{locationLoading ? <span>正在加载{locationLoading === 'cities' ? '城市' : '具体门店'}…</span> : locationError ? <><span className="admin-inline-error">{locationError}</span><button type="button" className="admin-link" disabled={selecting} onClick={async () => { clearSearch(); clearRanks(); if (retryLocation === 'cities') await loadCities(true); else { const next = await loadStores(cityCode); if (alive.current && next) await loadProductsForStore(next); } }}>重新加载</button></> : <span>{locationWarning || `价格与可售状态以${chosenStore?.name || '所选门店'}为准。`}</span>}</div>
      {mode === 'search' ? <>
        <div className="sams-keyword-row"><label className="admin-field">商品关键词<input type="search" value={keyword} onChange={event => changeKeyword(event.target.value)} placeholder="例如：牛肉卷、牛奶、瑞士卷" maxLength={80} required disabled={selecting} /></label><button className="admin-btn primary" disabled={!ready || loading || selecting || !keyword.trim()}>{loading ? '查询中…' : '查询山姆商品'}</button></div>
        <div className="sams-quick-keywords"><span>快捷查找</span>{['牛肉卷', '牛奶', '鸡蛋', '麻薯', '瑞士卷', '牛排'].map(value => <button type="button" className={keyword === value ? 'selected' : ''} key={value} disabled={!ready || loading || selecting} onClick={() => { changeKeyword(value); search(1, value); }}>{value}</button>)}</div>
      </> : <div className="sams-rank-browser">
        <p className="sams-rank-hint">选择榜单即可浏览商品，无需输入关键词。官方榜单展示部分商品，并非门店完整目录。</p>
        {rankLoading && <p className="sams-rank-feedback" role="status">正在加载门店榜单…</p>}
        {rankError && <div className="sams-rank-feedback" role="alert"><span className="admin-inline-error">{rankError}</span><button type="button" className="admin-link" disabled={!ready || selecting || rankLoading} onClick={() => { clearSearch(); loadRanks(); }}>重新加载榜单</button></div>}
        {!!ranks.length && <div className="sams-browse-choices" role="group" aria-label="官方榜单"><span className="sams-choice-label">官方榜单</span>{ranks.map(rank => <button type="button" key={rank.rank_id} aria-pressed={chosenRank?.rank_id === rank.rank_id} className={chosenRank?.rank_id === rank.rank_id ? 'selected' : ''} disabled={!ready || selecting || rankLoading} onClick={() => chooseRank(rank)}>{rank.name}</button>)}</div>}
        {categories.length > 1 && <div className="sams-browse-choices sams-rank-categories" role="group" aria-label="榜单分类"><span className="sams-choice-label">榜单分类</span>{categories.map(category => <button type="button" key={category.category_id} aria-pressed={categoryId === category.category_id} className={categoryId === category.category_id ? 'selected' : ''} disabled={!ready || selecting || rankLoading} onClick={() => chooseCategory(category.category_id)}>{category.name}</button>)}</div>}
      </div>}
    </form></section>
    <div className="admin-section-heading"><div><h2>{resultTitle}<span>{results.products.length} 件已加载{Number.isFinite(results.total) ? ` · 共 ${results.total} 件匹配` : ''}</span></h2><p>{results.store ? `${city?.city_name || ''} · ${results.store.name}${results.queried_at ? ` · ${queriedTime(results.queried_at)}` : ''}${results.cached ? ' · 缓存结果' : ''}` : mode === 'rank' ? '选择门店与榜单，勾选后加入本地商品库。' : '查询后勾选商品，加入本地商品库。'}</p></div><button className="admin-btn" type="button" onClick={onCatalog}>查看商品库</button></div>
    <div className="sams-result-toolbar"><label className="admin-checkbox"><input type="checkbox" checked={availableOnly} onChange={event => setAvailableOnly(event.target.checked)} /><span>只看可售</span></label><label className="sams-sort-control">排序<select value={sort} onChange={event => setSort(event.target.value)}><option value="default">默认顺序</option><option value="asc">价格从低到高</option><option value="desc">价格从高到低</option></select></label><button type="button" className="admin-link" disabled={selecting || !eligible.length} onClick={() => {
      const allSelected = eligible.every(product => selected.has(String(product.spu_id)));
      if (allSelected) setSelected(previous => { const next = new Map(previous); for (const product of eligible) next.delete(String(product.spu_id)); return next; });
      else setSelected(previous => { const next = new Map(previous); for (const product of eligible) { if (next.size >= 200) break; next.set(String(product.spu_id), product); } return next; });
    }}>{eligible.length && eligible.every(product => selected.has(String(product.spu_id))) ? '取消当前勾选' : '选择当前显示'}</button></div>
    {error && <div className="admin-alert error" role="alert"><span>{error}</span>{!selecting && (results.query || chosenRank) && <button type="button" className="admin-link" disabled={loading} onClick={() => queryPage(failedPage)}>重新查询</button>}</div>}
    {selectionNotice && <div className="admin-alert success" role="status">{selectionNotice}</div>}
    <div className="sams-selection-bar"><div><strong>已选 {activeSelected.length} 件</strong><p>加入后默认待上架；重复商品跳过，已有售价与资料保留。</p></div><div className="admin-actions"><button type="button" className="admin-link" disabled={selecting || !selected.size} onClick={() => setSelected(new Map())}>清空勾选</button><button type="button" className="admin-btn primary" disabled={selecting || !activeSelected.length || loading} onClick={addSelected}>{selecting ? '加入中…' : `加入商品库 (${activeSelected.length})`}</button></div></div>
    <div className="sams-product-grid" aria-busy={loading}>{visible.map(product => {
      const added = inCatalog(product);
      const checked = selected.has(String(product.spu_id));
      const summary = product.description?.trim() || (product.spec !== '详见商品名称' ? product.spec?.trim() : '');
      return <article className={`sams-product-card ${checked ? 'is-selected' : ''}`} key={product.spu_id}>
        <label className="sams-card-select"><input type="checkbox" checked={checked} disabled={added || !canSelect(product) || selecting} onChange={event => toggle(product, event.target.checked)} /><span>{added ? '已入库' : checked ? '已选择' : !canSelect(product) ? '暂不可选' : '选入商品库'}</span></label>
        <div className="sams-card-image"><CatalogImage src={product.image_url} name={product.name} /></div>
        <div className="sams-card-content"><h3>{product.name}</h3><ProductDescription text={summary} className="sams-card-description" name={product.name} /><div className="sams-card-price"><span>{product.price_label || '销售价'}</span><strong>{salePrice(product)}</strong></div><div className="sams-card-status"><span className={`admin-pill ${product.available === true ? '' : 'neutral'}`}>{product.available === true ? '可售' : product.available === false ? '暂不可售' : '可售待核对'}</span><span>{product.on_sale === true ? '在售' : product.on_sale === false ? '已下架' : '上架状态未知'}</span></div></div>
      </article>;
    })}</div>
    {loading && <div className="admin-loading" role="status"><span className="admin-spinner" />正在加载山姆商品…</div>}
    {!loading && !rankLoading && !visible.length && <div className="admin-empty"><h3>{results.products.length ? '已加载结果中没有可售商品' : error ? '查询暂未完成' : mode === 'rank' ? chosenRank ? '此榜单暂未返回商品' : '选择门店与榜单' : results.query ? '没有找到匹配的商品' : '选好门店，再找商品'}</h3><p>{results.products.length ? '可以取消可售筛选，或加载更多结果。' : mode === 'rank' ? '可以切换榜单分类、具体门店，或使用搜索商品。' : '试试一个商品关键词，或切换具体门店。'}</p></div>}
    {results.has_more && <div className="sams-load-more"><button type="button" className="admin-btn" disabled={loading || selecting} onClick={() => queryPage(results.page + 1)}>{loading ? '加载中…' : '加载更多商品'}</button></div>}
    <p className="admin-help sams-results-note">{mode === 'rank' ? '官方榜单展示部分商品，榜单分类并非完整商品分类；每页最多 30 件。' : '查询结果仅覆盖当前关键词与所选门店，每页最多 20 件。'}排序和筛选应用于已加载商品。下单前请在山姆 App 或小程序核对价格与库存。</p>

  </div>;
}
