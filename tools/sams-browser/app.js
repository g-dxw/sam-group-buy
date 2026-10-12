'use strict';

(() => {
  const STORAGE_KEY = 'sams-product-browser-v1';
  const DEFAULT_CITY = '440300';
  const DEFAULT_STORE = '6505';
  const $ = (id) => document.getElementById(id);
  const ui = {
    city: $('city-select'), store: $('store-select'), keyword: $('keyword-input'),
    form: $('search-form'), search: $('search-button'), location: $('location-status'),
    retryCities: $('retry-cities'), retryStores: $('retry-stores'),
    title: $('results-title'), meta: $('result-meta'), resultStore: $('result-store'),
    grid: $('product-grid'), template: $('product-template'), empty: $('empty-state'),
    emptyTitle: $('empty-title'), emptyDescription: $('empty-description'),
    available: $('available-only'), sort: $('sort-select'), export: $('export-button'),
    more: $('load-more'), pageNote: $('pagination-note'), live: $('search-status'),
    error: $('query-error'), errorText: $('query-error-message'), retrySearch: $('retry-search'),
    manualForm: $('manual-form'), manualId: $('manual-store-id'), manualType: $('manual-store-type'),
    chips: Array.from(document.querySelectorAll('[data-keyword]')),
  };
  const state = {
    cities: [], stores: [], cityCode: DEFAULT_CITY, selectedStore: null, manual: false,
    products: [], query: '', page: 0, total: null, hasMore: false, pages: [], resultStore: null,
    loadingCities: false, loadingStores: false, loadingSearch: false, searched: false,
    queriedAt: null, cached: false, error: '', failedPage: 1,
  };
  let cityRequest = 0;
  let storeRequest = 0;
  let searchRequest = 0;
  let cityController;
  let storeController;
  let searchController;
  const preferences = readPreferences();
  ui.keyword.value = preferences.keyword || '牛肉卷';

  function readPreferences() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { /* storage may be unavailable */ }
    const params = new URLSearchParams(location.search);
    const value = (key) => params.has(key) ? params.get(key) : saved[key];
    return {
      keyword: String(value('keyword') || '牛肉卷').slice(0, 80),
      cityCode: /^\d{6}$/.test(String(value('cityCode'))) ? String(value('cityCode')) : DEFAULT_CITY,
      storeId: /^\d{1,12}$/.test(String(value('storeId'))) ? String(value('storeId')) : null,
      storeType: Number(value('storeType')) || 2,
      manual: String(value('manual')) === '1' || value('manual') === true,
    };
  }

  function persistPreferences(keyword = ui.keyword.value.trim()) {
    const selected = state.selectedStore;
    const data = {
      keyword, cityCode: state.cityCode,
      storeId: selected?.store_id || '', storeType: selected?.store_type || 2,
      manual: state.manual ? '1' : '0',
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* optional persistence */ }
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(data)) {
      if (value === '') url.searchParams.delete(key);
      else url.searchParams.set(key, String(value));
    }
    try { history.replaceState(null, '', url); } catch { /* page also works without history access */ }
  }

  async function fetchData(url, controller) {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 35000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      let data;
      try { data = await response.json(); } catch { throw new Error('暂时无法读取查询结果，请稍后重试。'); }
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '暂时无法完成查询，请稍后重试。');
      return data;
    } catch (error) {
      if (timedOut) throw new Error('请求超时，请稍后重试。');
      if (error.name === 'AbortError') throw error;
      if (error instanceof TypeError) throw new Error('暂时无法连接查询服务，请稍后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function option(value, label) {
    const node = document.createElement('option');
    node.value = String(value);
    node.textContent = label;
    return node;
  }

  function cityName() {
    return state.cities.find((city) => String(city.city_code) === state.cityCode)?.city_name || '所选城市';
  }

  function storeLabel(store) {
    if (!store) return '未选择门店';
    return store.name || `门店 ${store.store_id}`;
  }

  function locationMessage(message, isError = false) {
    ui.location.textContent = message;
    ui.location.parentElement.classList.toggle('is-error', isError);
  }

  function updateControls() {
    const ready = Boolean(state.selectedStore) && !state.loadingCities && !state.loadingStores;
    ui.city.disabled = state.loadingCities || !state.cities.length;
    ui.store.disabled = state.loadingStores || (!state.stores.length && !state.selectedStore);
    ui.search.disabled = !ready || state.loadingSearch;
    ui.search.textContent = state.loadingSearch ? '正在查询…' : '查询商品 →';
    for (const chip of ui.chips) {
      chip.disabled = !ready || state.loadingSearch;
      const active = chip.dataset.keyword === ui.keyword.value.trim();
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
    ui.export.disabled = !state.products.length || state.loadingSearch;
    ui.more.disabled = state.loadingSearch;
    ui.more.textContent = state.loadingSearch ? '正在加载…' : '加载更多商品 ↓';
  }

  function invalidateResults(message) {
    searchController?.abort();
    searchRequest += 1;
    Object.assign(state, {
      products: [], query: '', page: 0, total: null, hasMore: false, pages: [], resultStore: null,
      loadingSearch: false, searched: false, queriedAt: null, cached: false, error: '', failedPage: 1,
    });
    ui.live.textContent = message || '门店已切换，旧查询结果已清除。';
    renderResults(message);
  }

  async function loadCities() {
    cityController?.abort();
    const request = ++cityRequest;
    cityController = new AbortController();
    state.loadingCities = true;
    ui.retryCities.hidden = true;
    ui.city.replaceChildren(option('', '正在加载城市…'));
    locationMessage('正在加载可选城市…');
    updateControls();
    try {
      const data = await fetchData('/api/cities', cityController);
      if (request !== cityRequest) return false;
      if (!Array.isArray(data.cities) || !data.cities.length) throw new Error('暂时没有可选城市，请重新加载。');
      state.cities = data.cities.filter((city) => city?.city_code && city?.city_name);
      if (!state.cities.length) throw new Error('暂时没有可选城市，请重新加载。');
      const preferred = state.cities.find((city) => String(city.city_code) === preferences.cityCode);
      state.cityCode = String(preferred?.city_code || data.default_city_code || state.cities[0].city_code);
      if (!state.cities.some((city) => String(city.city_code) === state.cityCode)) state.cityCode = String(state.cities[0].city_code);
      ui.city.replaceChildren(...state.cities.map((city) => option(city.city_code, `${city.city_name}${city.province_name && city.province_name !== city.city_name ? ` · ${city.province_name}` : ''}`)));
      ui.city.value = state.cityCode;
      locationMessage('请选择具体门店，价格随门店变化。');
      return true;
    } catch (error) {
      if (request !== cityRequest || error.name === 'AbortError') return false;
      state.cities = [];
      ui.city.replaceChildren(option('', '城市加载失败'));
      ui.retryCities.hidden = false;
      locationMessage(error.message, true);
      return false;
    } finally {
      if (request === cityRequest) { state.loadingCities = false; updateControls(); }
    }
  }

  async function loadStores(preferredStore = null) {
    storeController?.abort();
    const request = ++storeRequest;
    const requestedCity = state.cityCode;
    storeController = new AbortController();
    state.loadingStores = true;
    state.stores = [];
    state.selectedStore = null;
    state.manual = false;
    ui.retryStores.hidden = true;
    ui.store.replaceChildren(option('', '正在加载门店…'));
    locationMessage(`正在加载${cityName()}的具体门店…`);
    updateControls();
    try {
      const params = new URLSearchParams({ cityCode: requestedCity });
      const data = await fetchData(`/api/stores?${params}`, storeController);
      if (request !== storeRequest || requestedCity !== state.cityCode) return false;
      if (!Array.isArray(data.stores)) throw new Error('门店列表暂时不可用，请重新加载或手动填写门店。');
      state.stores = data.stores.filter((store) => /^\d{1,12}$/.test(String(store?.store_id)) && Number(store.store_type) > 0)
        .map((store) => ({ ...store, store_id: String(store.store_id), store_type: Number(store.store_type) }));
      state.stores.sort((a, b) => Number(b.store_id === DEFAULT_STORE) - Number(a.store_id === DEFAULT_STORE));
      if (preferredStore?.manual && preferredStore.storeId && [2, 4, 8, 256].includes(preferredStore.storeType)) {
        setManualStore(preferredStore.storeId, preferredStore.storeType, false);
      } else {
        const preferred = state.stores.find((store) => store.store_id === preferredStore?.storeId && store.store_type === preferredStore.storeType);
        state.selectedStore = preferred || state.stores[0] || null;
        ui.store.replaceChildren(...(state.stores.length ? state.stores.map((store) => option(`${store.store_id}:${store.store_type}`, `${storeLabel(store)}${store.kind ? ` · ${store.kind}` : ''}`)) : [option('', '暂无可选门店')]));
        if (state.selectedStore) ui.store.value = `${state.selectedStore.store_id}:${state.selectedStore.store_type}`;
      }
      if (data.warning) locationMessage(String(data.warning), !state.selectedStore);
      else if (state.selectedStore) locationMessage(`当前门店：${storeLabel(state.selectedStore)}。价格与库存以此门店为准。`);
      else locationMessage('暂时没有发现此城市的具体门店，可重新加载或手动填写已确认的门店编号。', true);
      if (!state.stores.length) ui.retryStores.hidden = false;
      persistPreferences();
      return Boolean(state.selectedStore);
    } catch (error) {
      if (request !== storeRequest || error.name === 'AbortError') return false;
      ui.store.replaceChildren(option('', '门店加载失败'));
      ui.retryStores.hidden = false;
      locationMessage(error.message, true);
      return false;
    } finally {
      if (request === storeRequest) { state.loadingStores = false; updateControls(); }
    }
  }

  function setManualStore(storeId, storeType, persist = true) {
    storeController?.abort();
    storeRequest += 1;
    state.loadingStores = false;
    state.manual = true;
    const found = state.stores.find((store) => store.store_id === storeId && store.store_type === storeType);
    state.selectedStore = found || { store_id: storeId, store_type: storeType, name: `手动门店 ${storeId}`, kind: '手动选择' };
    const nodes = state.stores.map((store) => option(`${store.store_id}:${store.store_type}`, `${storeLabel(store)}${store.kind ? ` · ${store.kind}` : ''}`));
    if (!found) nodes.push(option(`${storeId}:${storeType}`, `手动门店 ${storeId}`));
    ui.store.replaceChildren(...nodes);
    ui.store.value = `${storeId}:${storeType}`;
    ui.store.disabled = false;
    ui.manualId.value = storeId;
    ui.manualType.value = String(storeType);
    locationMessage(`已选择${storeLabel(state.selectedStore)}，请确认编号与门店类型准确。`);
    if (persist) persistPreferences();
    updateControls();
  }

  async function searchProducts(page = 1) {
    if (!state.selectedStore || state.loadingCities || state.loadingStores || state.loadingSearch) return;
    const query = page === 1 ? ui.keyword.value.trim() : state.query;
    if (!query) { ui.keyword.setCustomValidity('请填写商品关键词。'); ui.keyword.focus(); ui.keyword.reportValidity(); return; }
    ui.keyword.setCustomValidity('');
    const requestedStore = { ...state.selectedStore };
    const context = `${state.cityCode}:${requestedStore.store_id}:${requestedStore.store_type}`;
    searchController?.abort();
    const request = ++searchRequest;
    searchController = new AbortController();
    if (page === 1) {
      state.products = [];
      state.page = 0;
      state.pages = [];
      state.total = null;
      state.hasMore = false;
      state.resultStore = requestedStore;
      state.query = query;
      state.searched = true;
      state.queriedAt = null;
      state.cached = false;
    }
    state.error = '';
    state.failedPage = page;
    state.loadingSearch = true;
    ui.live.textContent = `正在查询${storeLabel(requestedStore)}的“${query}”…`;
    persistPreferences(query);
    renderResults();
    try {
      const params = new URLSearchParams({ keyword: query, storeId: requestedStore.store_id, storeType: String(requestedStore.store_type), page: String(page) });
      const data = await fetchData(`/api/search?${params}`, searchController);
      if (request !== searchRequest || context !== `${state.cityCode}:${state.selectedStore?.store_id}:${state.selectedStore?.store_type}`) return;
      if (!Array.isArray(data.products)) throw new Error('商品结果暂时无法读取，请重新查询。');
      if (data.store && (String(data.store.store_id) !== requestedStore.store_id || Number(data.store.store_type) !== requestedStore.store_type)) throw new Error('返回结果的门店与所选门店不一致，请重新查询。');
      const known = new Set(state.products.map((product) => String(product.spu_id)));
      for (const product of data.products.slice(0, 20)) {
        if (!product || !product.spu_id || known.has(String(product.spu_id))) continue;
        state.products.push({ ...product, queried_at: data.queried_at || null });
        known.add(String(product.spu_id));
      }
      state.page = Number(data.page) || page;
      state.total = Number.isFinite(data.total) ? data.total : null;
      state.hasMore = data.has_more === true;
      state.queriedAt = data.queried_at || null;
      state.cached = data.cached === true;
      state.resultStore = { ...requestedStore, ...(data.store || {}) };
      state.pages.push({ page: state.page, queried_at: state.queriedAt, cached: state.cached });
      ui.live.textContent = `“${state.query}”已加载 ${state.products.length} 件商品。`;
    } catch (error) {
      if (request !== searchRequest || error.name === 'AbortError') return;
      state.error = error.message;
      ui.live.textContent = '商品查询失败，可重新查询。';
    } finally {
      if (request === searchRequest) { state.loadingSearch = false; renderResults(); }
    }
  }

  function validPrice(product) {
    return typeof product.price_cny === 'number' && Number.isFinite(product.price_cny) && product.price_cny >= 0;
  }

  function visibleProducts() {
    let products = state.products.slice();
    if (ui.available.checked) products = products.filter((product) => product.available === true && product.on_sale !== false);
    if (ui.sort.value !== 'default') {
      const direction = ui.sort.value === 'price-desc' ? -1 : 1;
      products.sort((a, b) => {
        if (!validPrice(a) && !validPrice(b)) return 0;
        if (!validPrice(a)) return 1;
        if (!validPrice(b)) return -1;
        return (a.price_cny - b.price_cny) * direction;
      });
    }
    return products;
  }

  function imageUrl(raw) {
    try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  }

  function productCard(product) {
    const card = ui.template.content.firstElementChild.cloneNode(true);
    const set = (selector, value) => { card.querySelector(selector).textContent = value; };
    const name = String(product.name || '未提供商品名称');
    set('.product-name', name);
    card.querySelector('.product-name').title = name;
    set('.product-description', product.description || '');
    set('.price-label', product.price_label || '销售价');
    set('.product-price', validPrice(product) ? `¥${product.price_cny.toFixed(2)}` : '价格未提供');
    card.querySelector('.product-price').classList.toggle('is-missing', !validPrice(product));
    set('.sale-status', product.on_sale === true ? '在售' : product.on_sale === false ? '已下架' : '上架状态未知');
    set('.product-id', `编号 ${product.spu_id}`);
    const badge = card.querySelector('.availability-badge');
    badge.textContent = product.available === true ? '可售' : product.available === false ? '暂不可售' : '可售状态未知';
    badge.classList.toggle('is-available', product.available === true);
    badge.classList.toggle('is-unavailable', product.available === false);
    const image = card.querySelector('.product-image');
    const placeholder = card.querySelector('.image-placeholder');
    const src = imageUrl(product.image_url);
    image.alt = name;
    if (src) {
      image.src = src;
      image.addEventListener('error', () => { image.hidden = true; placeholder.hidden = false; }, { once: true });
    } else { image.hidden = true; placeholder.hidden = false; }
    return card;
  }

  function skeletons() {
    return Array.from({ length: 4 }, () => {
      const card = document.createElement('div');
      card.className = 'skeleton-card';
      card.setAttribute('aria-hidden', 'true');
      const image = document.createElement('div');
      image.className = 'skeleton-image';
      const content = document.createElement('div');
      content.className = 'skeleton-content';
      for (let i = 0; i < 3; i += 1) {
        const line = document.createElement('div');
        line.className = 'skeleton-line';
        content.append(line);
      }
      card.append(image, content);
      return card;
    });
  }

  function formatTime(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function renderResults(emptyMessage = '') {
    updateControls();
    ui.error.hidden = !state.error;
    ui.errorText.textContent = state.error;
    ui.retrySearch.textContent = state.failedPage > 1 ? '重试加载更多' : '重新查询';
    ui.grid.setAttribute('aria-busy', String(state.loadingSearch));
    ui.resultStore.textContent = state.resultStore ? `${cityName()} · ${storeLabel(state.resultStore)}` : state.selectedStore ? `${cityName()} · ${storeLabel(state.selectedStore)}` : '所选门店的商品';
    ui.title.textContent = state.query ? `“${state.query}”的查询结果` : '找到想买的商品';
    const products = visibleProducts();
    const metadata = [];
    if (state.searched) {
      metadata.push(`已加载 ${state.products.length} 件`);
      if (state.total !== null) metadata.push(`匹配 ${state.total} 件`);
      if (ui.available.checked) metadata.push(`当前显示 ${products.length} 件可售商品`);
      if (state.queriedAt) metadata.push(`${formatTime(state.queriedAt)} 查询`);
      if (state.cached) metadata.push('1分钟内缓存');
    }
    ui.meta.textContent = metadata.length ? metadata.join(' · ') : '仅展示所选门店与当前关键词的结果。';
    if (state.loadingSearch && !state.products.length) ui.grid.replaceChildren(...skeletons());
    else ui.grid.replaceChildren(...products.map(productCard));
    ui.empty.hidden = (state.loadingSearch && !state.products.length) || products.length > 0;
    if (!state.searched) {
      ui.emptyTitle.textContent = state.selectedStore ? '门店已选好' : '从一个关键词开始';
      ui.emptyDescription.textContent = emptyMessage || '查询一个关键词，查看这个门店的商品与价格。';
    } else if (state.error && !state.products.length) {
      ui.emptyTitle.textContent = '这次查询暂未完成';
      ui.emptyDescription.textContent = '可以重新查询，或稍后再试。';
    } else if (state.products.length && ui.available.checked) {
      ui.emptyTitle.textContent = '已加载商品中没有可售结果';
      ui.emptyDescription.textContent = state.hasMore ? '可以加载更多商品，或取消“只看可售商品”。' : '取消“只看可售商品”可查看全部已加载结果。';
    } else {
      ui.emptyTitle.textContent = '没有找到匹配的商品';
      ui.emptyDescription.textContent = '试试更短的关键词，或选择另一个门店。';
    }
    ui.more.hidden = !state.hasMore;
    ui.pageNote.textContent = state.products.length ? state.hasMore ? '还有更多匹配商品，每次加载最多 20 件。' : '本次匹配结果已加载完毕。' : '';
  }

  function exportResults() {
    if (!state.products.length || state.loadingSearch) return;
    const data = {
      query: state.query, city: { city_code: state.cityCode, city_name: cityName() },
      store: state.resultStore, queried_at: state.queriedAt, exported_at: new Date().toISOString(),
      total: state.total, loaded_count: state.products.length, has_more: state.hasMore,
      pages: state.pages, products: state.products,
      note: '所选门店、当前关键词的已加载查询结果，非全品目录。价格与可售状态以下单时为准。',
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `山姆商品-${state.resultStore.store_id}-${state.query.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.live.textContent = `已导出本次加载的 ${state.products.length} 件商品。`;
  }

  ui.form.addEventListener('submit', (event) => { event.preventDefault(); searchProducts(); });
  ui.city.addEventListener('change', async () => {
    state.cityCode = ui.city.value;
    state.selectedStore = null;
    state.manual = false;
    invalidateResults('城市已切换，请选择具体门店后查询。');
    await loadStores();
    renderResults('门店已切换，查询以查看这个门店的商品与价格。');
  });
  ui.store.addEventListener('change', () => {
    const selected = state.stores.find((store) => `${store.store_id}:${store.store_type}` === ui.store.value);
    if (!selected) return;
    state.selectedStore = selected;
    state.manual = false;
    invalidateResults('门店已切换，查询以查看这个门店的商品与价格。');
    locationMessage(`当前门店：${storeLabel(selected)}。价格与库存以此门店为准。`);
    persistPreferences();
  });
  ui.keyword.addEventListener('input', () => { ui.keyword.setCustomValidity(''); updateControls(); });
  for (const chip of ui.chips) chip.addEventListener('click', () => { ui.keyword.value = chip.dataset.keyword; searchProducts(); });
  ui.available.addEventListener('change', () => renderResults());
  ui.sort.addEventListener('change', () => renderResults());
  ui.more.addEventListener('click', () => searchProducts(state.page + 1));
  ui.retrySearch.addEventListener('click', () => searchProducts(state.failedPage));
  ui.export.addEventListener('click', exportResults);
  ui.retryCities.addEventListener('click', async () => {
    invalidateResults('城市与门店正在重新加载，请稍后查询。');
    if (await loadCities()) await loadStores(preferences);
    renderResults();
  });
  ui.retryStores.addEventListener('click', async () => {
    invalidateResults('门店列表正在重新加载，请稍后查询。');
    await loadStores();
    renderResults();
  });
  ui.manualForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = ui.manualId.value.trim();
    const type = Number(ui.manualType.value);
    if (!/^\d{1,12}$/.test(id) || ![2, 4, 8, 256].includes(type)) return;
    if (id === state.cityCode) { ui.manualId.setCustomValidity('请填写具体门店编号，不能使用城市编号。'); ui.manualId.reportValidity(); return; }
    ui.manualId.setCustomValidity('');
    setManualStore(id, type);
    invalidateResults('手动门店已选好，请查询并核对返回门店。');
  });
  ui.manualId.addEventListener('input', () => ui.manualId.setCustomValidity(''));

  async function initialize() {
    updateControls();
    if (!await loadCities()) { renderResults(); return; }
    const ready = await loadStores(preferences);
    renderResults();
    if (ready) await searchProducts();
  }
  initialize();
})();
