import { useEffect, useId, useRef, useState } from 'react';

const storeKey = store => store ? `${store.storeId}:${store.storeType}` : '';
const sourceStoreKey = store => `${store.store_id}:${store.store_type}`;

export default function BatchSamsStore({ api, value = null }) {
  const id = useId();
  const [cityCode, setCityCode] = useState(String(value?.cityCode || ''));
  const [selected, setSelected] = useState(value);
  const [cities, setCities] = useState([]);
  const [stores, setStores] = useState([]);
  const [citiesLoading, setCitiesLoading] = useState(true);
  const [storesLoading, setStoresLoading] = useState(Boolean(value?.cityCode));
  const [citiesError, setCitiesError] = useState('');
  const [storesError, setStoresError] = useState('');
  const [warning, setWarning] = useState('');
  const [citiesRetry, setCitiesRetry] = useState(0);
  const [storesRetry, setStoresRetry] = useState(0);
  const storesController = useRef(null);
  const storesGeneration = useRef(0);
  const city = cities.find(item => String(item.city_code) === cityCode);
  const configuredCityName = selected?.cityCode === cityCode ? selected.cityName : value?.cityCode === cityCode ? value.cityName : '';
  const cityName = city?.city_name || configuredCityName || '';
  const hasListedSelection = stores.some(store => sourceStoreKey(store) === storeKey(selected));

  useEffect(() => {
    let live = true;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 35000);
    setCitiesLoading(true); setCitiesError('');
    api('/sams/cities', { signal: controller.signal }).then(result => {
      if (!live) return;
      const list = (Array.isArray(result.cities) ? result.cities : []).filter(item => item?.city_code && item?.city_name);
      if (!list.length) throw new Error('城市列表暂时不可用，请重新加载。');
      setCities(list);
    }).catch(error => {
      if (!live || (error.name === 'AbortError' && !timedOut)) return;
      setCitiesError(timedOut ? '城市查询超时，请重新加载。' : error.message || '城市加载失败，请重新加载。');
    }).finally(() => {
      clearTimeout(timer);
      if (live) setCitiesLoading(false);
    });
    return () => { live = false; clearTimeout(timer); controller.abort(); };
  }, [api, citiesRetry]);

  useEffect(() => {
    if (!cityCode) {
      setStores([]); setStoresLoading(false); setStoresError(''); setWarning('');
      return;
    }
    let live = true;
    let timedOut = false;
    const generation = ++storesGeneration.current;
    const controller = new AbortController();
    storesController.current = controller;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 35000);
    setStores([]); setStoresLoading(true); setStoresError(''); setWarning('');
    api(`/sams/stores?${new URLSearchParams({ cityCode })}`, { signal: controller.signal }).then(result => {
      if (!live || generation !== storesGeneration.current) return;
      const list = (Array.isArray(result.stores) ? result.stores : [])
        .filter(store => /^\d{1,12}$/.test(String(store?.store_id)) && Number(store.store_type) > 0)
        .map(store => ({ ...store, store_id: String(store.store_id), store_type: Number(store.store_type) }));
      setStores(list); setWarning(result.warning || '');
      if (!list.length) setStoresError('此城市暂时没有可选门店，请重新加载或选择其他城市。');
    }).catch(error => {
      if (!live || generation !== storesGeneration.current || (error.name === 'AbortError' && !timedOut)) return;
      setStoresError(timedOut ? '门店查询超时，请重新加载。' : error.message || '门店加载失败，请重新加载。');
    }).finally(() => {
      clearTimeout(timer);
      if (live && generation === storesGeneration.current) setStoresLoading(false);
    });
    return () => { live = false; clearTimeout(timer); controller.abort(); };
  }, [api, cityCode, storesRetry]);

  function chooseCity(nextCityCode) {
    storesGeneration.current += 1;
    storesController.current?.abort();
    setCityCode(nextCityCode); setSelected(null); setStores([]);
    setStoresError(''); setWarning(''); setStoresLoading(Boolean(nextCityCode));
  }

  function chooseStore(key) {
    const store = stores.find(item => sourceStoreKey(item) === key);
    setSelected(store ? { cityCode, cityName, storeId: store.store_id, storeType: store.store_type, name: store.name } : null);
  }

  return <div className="admin-batch-store">
    <input type="hidden" name="samsStore" value={JSON.stringify(selected)} />
    <div className="admin-batch-store-heading"><h3>本期采购门店</h3><button type="button" className="admin-link" disabled={!selected} onClick={() => setSelected(null)}>清空门店</button></div>
    <p className="admin-help" id={`${id}-help`}>每期固定采购门店。新自选商品按山姆查询价，代购费由本期费率单独计算。</p>
    <div className="admin-form-grid">
      <label className="admin-field">城市<select value={cityCode} disabled={citiesLoading || !cities.length} onChange={event => chooseCity(event.target.value)} aria-describedby={`${id}-help ${id}-cities`} aria-invalid={Boolean(citiesError)}><option value="">请选择城市</option>{cityCode && !city && <option value={cityCode}>{cityName || cityCode} · 当前设置</option>}{cities.map(item => <option key={item.city_code} value={String(item.city_code)}>{item.city_name}{item.province_name && item.province_name !== item.city_name ? ` · ${item.province_name}` : ''}</option>)}</select></label>
      <label className="admin-field">具体门店<select value={storeKey(selected)} disabled={!cityCode || storesLoading || !stores.length} onChange={event => chooseStore(event.target.value)} aria-describedby={`${id}-help ${id}-stores`} aria-invalid={Boolean(storesError)}><option value="">请选择门店，开启顾客自选</option>{selected && !hasListedSelection && <option value={storeKey(selected)}>{selected.name} · 当前设置</option>}{stores.map(store => <option key={sourceStoreKey(store)} value={sourceStoreKey(store)}>{store.name}{store.kind ? ` · ${store.kind}` : ''}</option>)}</select></label>
    </div>
    <div className="admin-batch-store-feedback" id={`${id}-cities`} role={citiesError ? 'alert' : 'status'}>{citiesLoading ? '正在加载城市…' : citiesError && <><span className="admin-inline-error">{citiesError}</span><button type="button" className="admin-link" onClick={() => setCitiesRetry(previous => previous + 1)}>重新加载城市</button></>}</div>
    <div className="admin-batch-store-feedback" id={`${id}-stores`} role={storesError ? 'alert' : 'status'}>{storesLoading ? '正在加载具体门店…' : storesError ? <><span className="admin-inline-error">{storesError}</span><button type="button" className="admin-link" onClick={() => setStoresRetry(previous => previous + 1)}>重新加载门店</button></> : selected && !hasListedSelection ? <span>已配置门店未出现在当前列表中，保存时会再次核验。可重新选店或清空门店。</span> : warning || null}</div>
    <p className={`admin-batch-store-summary ${selected ? 'is-enabled' : ''}`} role="status">{selected ? `保存后开启顾客自选 · ${cityName || selected.cityName} · ${selected.name}` : '未设置门店，保存后关闭顾客自选；本期推荐商品仍可下单。'}</p>
  </div>;
}
