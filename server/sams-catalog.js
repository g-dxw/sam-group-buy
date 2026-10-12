import { randomUUID } from 'node:crypto';
import { DomainError } from './order-service.js';

const API_BASE = 'https://api-sams.walmartmobile.cn/api/v1/sams/';
const HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json, text/plain, */*',
  'User-Agent': 'SamClub/5.0.45 (iPhone; iOS 15.4; Scale/3.00)',
  'device-type': 'mini_program', rcs: '6', 'system-language': 'zh_CN',
  Origin: 'https://m-sams.walmartmobile.cn', Referer: 'https://m-sams.walmartmobile.cn/',
};
const KINDS = { 2: '会员店', 4: '极速达', 8: '全球购', 256: '电商配送' };
const SPU_ID = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_BODY = 5 * 1024 * 1024;
const SNAPSHOT_TTL = 30 * 60_000;
const RANK_ENTRY_ID = '3317885016381467926';
const RANK_ID = /^\d{1,30}$/;
const RANK_TTL = 3600_000;
const RANK_HEADERS = { latitude: '0', longitude: '0' };
function fail(message, status = 502, code = 'SAMS_UNAVAILABLE') { throw new DomainError(status, code, message); }
function imageUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? value : null; }
  catch { return null; }
}
function salesPrice(entries) {
  const entry = Array.isArray(entries) ? entries.find(value => value?.priceType === 1 || value?.priceType === '1') : null;
  if (!entry || !/^\d+$/.test(String(entry.price))) return null;
  const cents = Number(entry.price);
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : null;
}
function specification(title) {
  return title.match(/((?:约)?\d+(?:\.\d+)?\s*(?:kg|g|ml|l|千克|公斤|克|毫升|升)(?:.*))$/iu)?.[1] || '详见商品名称';
}

// Only fixed public, read-only endpoints are used. Selection resolves stored
// query results so a client cannot substitute a different price or product.
export class SamsCatalog {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, hasProduct = () => false } = {}) {
    this.fetchImpl = fetchImpl; this.now = now; this.hasProduct = hasProduct;
    this.cache = new Map(); this.inflight = new Map(); this.storeNames = new Map(); this.snapshots = new Map(); this.rankTables = new Map(); this.active = 0;
  }

  async upstream(path, body, ttl = 60_000, extraHeaders = {}) {
    const key = JSON.stringify([path, body]);
    const prior = this.cache.get(key);
    if (prior && this.now() - prior.at < ttl) return { ...prior, cached: true };
    if (this.inflight.has(key)) return this.inflight.get(key);
    if (this.active >= 3) fail('正在处理其他查询，请稍后重试。', 503);
    this.active += 1;
    const promise = (async () => {
      try {
        const response = await this.fetchImpl(API_BASE + path, {
          method: 'POST', headers: { ...HEADERS, ...extraHeaders }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) fail([403, 429].includes(response.status) ? '商品服务暂时限制访问，请稍后重试。' : '商品服务暂时不可用，请稍后重试。', 503);
        const reader = response.body.getReader();
        let length = 0; const chunks = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > MAX_BODY) { await reader.cancel(); fail('返回结果过大，请缩小查询范围。'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('商品服务返回了无法识别的数据。'); }
        if (!result || typeof result !== 'object' || result.code !== 'Success') {
          fail(result?.code === 'AUTH_FAIL' ? '此查询需要登录，目前无法匿名获取。' : '商品服务暂时无法完成查询，请稍后重试。');
        }
        const value = { result, at: this.now(), queried_at: new Date(this.now()).toISOString(), cached: false };
        if (this.cache.size >= 300) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, value);
        return value;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        fail('连接商品服务超时或失败，请稍后重试。', 504);
      } finally { this.active -= 1; }
    })();
    this.inflight.set(key, promise);
    try { return await promise; } finally { this.inflight.delete(key); }
  }

  async cities() {
    const { result, queried_at, cached } = await this.upstream('merchant/storeApi/allAddressList', {}, 3600_000);
    const rows = result.data?.list;
    if (!Array.isArray(rows)) fail('暂时无法读取城市列表。');
    const unique = new Map();
    for (const row of rows) {
      const code = String(row?.cityCode || '');
      if (/^\d{6}$/.test(code) && typeof row.cityName === 'string' && row.cityName.trim()) {
        unique.set(code, { city_code: code, city_name: row.cityName, province_name: row.provinceName || '', initial: row.cityInitial || '' });
      }
    }
    if (!unique.size) fail('暂时没有可选择的城市，请稍后重试。');
    return { cities: [...unique.values()].sort((a, b) => `${a.initial}${a.city_name}`.localeCompare(`${b.initial}${b.city_name}`, 'zh-CN')), default_city_code: '440300', queried_at, cached };
  }

  async stores(cityCode) {
    const city = (await this.cities()).cities.find(item => item.city_code === cityCode);
    if (!city) fail('请选择列表中的城市。', 400, 'INVALID_SAMS_CITY');
    const { result, queried_at, cached } = await this.upstream('merchant/storeApi/getStoreListByCityCodePlus', { cityCode }, 3600_000);
    if (!Array.isArray(result.data)) fail('暂时无法读取该城市的门店列表，请稍后重试。');
    const stores = [];
    for (const row of result.data) {
      const id = String(row?.storeId || ''); const type = Number(row?.storeType);
      if (!/^\d{1,12}$/.test(id) || !Object.hasOwn(KINDS, type)) continue;
      const store = { store_id: id, store_type: type, name: typeof row.storeName === 'string' && row.storeName.trim() ? row.storeName : `门店 ${id}`, kind: KINDS[type] };
      stores.push(store);
      this.storeNames.set(`${id}:${type}`, { ...store, cityCode, cityName: city.city_name });
    }
    stores.sort((a, b) => Number(b.store_id === '6505') - Number(a.store_id === '6505') || Number(b.store_type === 2) - Number(a.store_type === 2) || a.name.localeCompare(b.name, 'zh-CN'));
    return { city_code: cityCode, stores, warning: stores.length ? null : '该城市暂时没有返回可查询的门店，请尝试其他城市。', queried_at, cached };
  }

  async search(params) {
    const keyword = typeof params.keyword === 'string' ? params.keyword.trim() : '';
    const id = params.storeId; const type = Number(params.storeType ?? 2); const page = Number(params.page ?? 1);
    if (!keyword || keyword.length > 80) fail('请输入 1 至 80 个字符的商品关键词。', 400, 'INVALID_SAMS_QUERY');
    if (typeof id !== 'string' || !/^\d{1,12}$/.test(id) || !Object.hasOwn(KINDS, type) || !Number.isInteger(page) || page < 1 || page > 100) fail('门店类型、编号或页码无效。', 400, 'INVALID_SAMS_QUERY');
    if (params.cityCode) {
      const listing = await this.stores(params.cityCode);
      if (!listing.stores.some(store => store.store_id === id && store.store_type === type)) fail('所选门店不属于该城市，请重新选择。', 400, 'INVALID_SAMS_STORE');
    }
    const started = this.now();
    const { result, queried_at, cached } = await this.upstream('goods-portal/spu/search', {
      keyword, pageNum: page, pageSize: 20, storeInfoVOList: [{ storeType: type, storeId: id }],
    });
    const data = result.data; const rows = data?.dataList;
    const knownStore = this.storeNames.get(`${id}:${type}`);
    const store = { store_id: id, store_type: type, name: knownStore?.name || `门店 ${id}` };
    const products = this.normalizeProducts(rows, store, 20);
    const selectionId = this.selectionSnapshot({ products, store, knownStore, keyword, queried_at, method: 'search' });
    return { query: keyword, store, page, page_size: 20, total: Number.isSafeInteger(data.totalCount) && data.totalCount >= rows.length ? data.totalCount : rows.length,
      has_more: data.hasNextPage === true, queried_at, cached, elapsed_ms: this.now() - started, selectionId, products };
  }

  normalizeProducts(rows, store, pageSize) {
    if (!Array.isArray(rows) || rows.length > pageSize || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('商品服务返回了无法识别的数据。');
    if (rows.some(row => String(row.storeId) !== store.store_id || (row.storeType != null && Number(row.storeType) !== store.store_type))) fail('商品服务返回的门店与选择不一致，请重新选择门店。');
    const seen = new Set();
    const products = rows.map(row => {
      const spu = String(row.spuId || '');
      if (!SPU_ID.test(spu) || seen.has(spu)) fail('商品服务返回了重复或无效的商品编号。');
      seen.add(spu);
      const name = typeof row.title === 'string' ? row.title.trim() : '';
      const price = salesPrice(row.priceInfo); const image = imageUrl(row.image);
      return { spu_id: spu, productId: `sam_${spu}`, name: name || '未命名商品',
        description: typeof row.subTitle === 'string' ? row.subTitle.slice(0, 2000) : '',
        price_cny: price === null ? null : price / 100, price_cents: price, price_label: '销售价', image_url: image,
        images: Array.isArray(row.images) ? row.images.map(imageUrl).filter(Boolean).slice(0, 20) : [],
        spec: specification(name).slice(0, 200), available: typeof row.isAvailable === 'boolean' ? row.isAvailable : null,
        on_sale: typeof row.isPutOnSale === 'boolean' ? row.isPutOnSale : null,
        selectable: Boolean(name && name.length <= 200 && image && price !== null),
        inCatalog: this.hasProduct(`sam_${spu}`),
      };
    });
    return products;
  }

  selectionSnapshot(snapshot) {
    const selectionId = randomUUID();
    for (const [key, snapshot] of this.snapshots) if (this.now() - snapshot.at >= SNAPSHOT_TTL) this.snapshots.delete(key);
    if (this.snapshots.size >= 300) this.snapshots.delete(this.snapshots.keys().next().value);
    this.snapshots.set(selectionId, { at: this.now(), ...snapshot });
    return selectionId;
  }

  async rankStore(params) {
    const id = params.storeId; const type = Number(params.storeType ?? 2);
    if (typeof id !== 'string' || !/^\d{1,12}$/.test(id) || !Object.hasOwn(KINDS, type)) fail('门店类型或编号无效。', 400, 'INVALID_SAMS_QUERY');
    const cityCode = params.cityCode || this.storeNames.get(`${id}:${type}`)?.cityCode || '440300';
    if (typeof cityCode !== 'string' || !/^\d{6}$/.test(cityCode)) fail('请选择列表中的城市。', 400, 'INVALID_SAMS_CITY');
    const listing = await this.stores(cityCode);
    const store = listing.stores.find(item => item.store_id === id && item.store_type === type);
    if (!store) fail('所选门店不属于该城市，请重新选择。', 400, 'INVALID_SAMS_STORE');
    return { store: { store_id: id, store_type: type, name: store.name }, knownStore: this.storeNames.get(`${id}:${type}`), key: `${id}:${type}:${cityCode}` };
  }

  rankCategories(data, rankId) {
    if (data?.contentDetailId != null && String(data.contentDetailId) !== rankId) fail('榜单服务返回的榜单与选择不一致。');
    const rows = data?.contentData?.dataList;
    if (!Array.isArray(rows) || !rows.length || rows.length > 200) fail('此官方榜单暂时没有可浏览的标签。');
    const seen = new Set();
    return rows.map((row, index) => {
      const id = String(row?.categoryId ?? '');
      const title = typeof row?.categoryTitle === 'string' ? row.categoryTitle.trim() : null;
      if (!RANK_ID.test(id) || title === null || title.length > 200 || seen.has(id)) fail('榜单服务返回了无效或重复的标签。');
      seen.add(id);
      if (title) return { category_id: id, name: title };
      // Official single-category ranks, including the chicken rank, can leave
      // the tab title empty. Keep its real ID and use the rank title for display.
      const rankName = typeof data.titleName === 'string' ? data.titleName.trim() : '';
      if (!rankName || rankName.length > 200) fail('暂时无法读取官方榜单名称。');
      return { category_id: id, name: rows.length === 1 ? rankName : `${rankName.slice(0, 180)}（分组 ${index + 1}）`,
        name_source: 'rank_title', original_title: row.categoryTitle };
    });
  }

  async ranks(params) {
    const { store, key } = await this.rankStore(params);
    const prior = this.rankTables.get(key);
    if (prior && this.now() - prior.at < RANK_TTL) return { mode: 'rank', store, ranks: prior.ranks, queried_at: prior.queried_at, cached: true };
    const { result, queried_at, cached } = await this.upstream('channel/portal/homeRankDetail/homeRankDetailForVisitor', {
      contentDetailId: RANK_ENTRY_ID, storeInfoList: [{ storeType: store.store_type, storeId: store.store_id }],
    }, RANK_TTL, RANK_HEADERS);
    this.rankCategories(result.data, RANK_ENTRY_ID);
    const title = typeof result.data?.titleName === 'string' ? result.data.titleName.trim() : '';
    if (!title || title.length > 200) fail('暂时无法读取官方榜单名称。');
    const entries = new Map([[RANK_ENTRY_ID, { rank_id: RANK_ENTRY_ID, name: title }]]);
    for (const category of result.data.contentData.dataList) {
      if (category.relationRank == null) continue;
      if (!Array.isArray(category.relationRank) || category.relationRank.length > 200) fail('官方关联榜单资料无效。');
      for (const relation of category.relationRank) {
        const id = String(relation?.contentDetailId || ''); const name = typeof relation?.titleName === 'string' ? relation.titleName.trim() : '';
        if (RANK_ID.test(id) && name && name.length <= 200 && !entries.has(id) && entries.size < 200) entries.set(id, { rank_id: id, name });
      }
    }
    const ranks = [...entries.values()];
    if (this.rankTables.size >= 300) this.rankTables.delete(this.rankTables.keys().next().value);
    this.rankTables.set(key, { at: this.now(), ranks, queried_at });
    return { mode: 'rank', store, ranks, queried_at, cached };
  }

  excludedSpus(value) {
    if (value == null || value === '') return [];
    let values;
    if (Array.isArray(value)) values = value;
    else if (typeof value !== 'string' || value.length > 250_000) fail('已浏览商品编号无效，一次最多携带 2000 个编号。', 400, 'INVALID_SAMS_QUERY');
    try { if (!values) values = value.trim().startsWith('[') ? JSON.parse(value) : value.split(',').map(item => item.trim()); }
    catch { fail('已浏览商品编号格式无效。', 400, 'INVALID_SAMS_QUERY'); }
    if (!Array.isArray(values) || values.length > 2000 || values.some(id => typeof id !== 'string' || !SPU_ID.test(id))) fail('已浏览商品编号无效，一次最多携带 2000 个编号。', 400, 'INVALID_SAMS_QUERY');
    return [...new Set(values)];
  }

  async browse(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail('榜单查询资料无效。', 400, 'INVALID_SAMS_QUERY');
    const rankId = params.rankId;
    const page = Number(params.page ?? 1);
    const categoryId = params.categoryId;
    if (typeof rankId !== 'string' || !RANK_ID.test(rankId) || !Number.isInteger(page) || page < 1 || page > 100
      || (categoryId != null && (typeof categoryId !== 'string' || !RANK_ID.test(categoryId)))) fail('榜单、标签或页码无效。', 400, 'INVALID_SAMS_QUERY');
    const excludeSpuIds = this.excludedSpus(params.excludeSpuIds);
    const started = this.now();
    // Only the fixed public entry and relations actually returned for this store can be queried.
    const listing = await this.ranks(params);
    const trustedRank = listing.ranks.find(rank => rank.rank_id === rankId);
    if (!trustedRank) fail('请选择列表中的官方榜单。', 400, 'INVALID_SAMS_RANK');
    const store = listing.store;
    const { result: detail } = await this.upstream('channel/portal/homeRankDetail/homeRankDetailForVisitor', {
      contentDetailId: rankId, storeInfoList: [{ storeType: store.store_type, storeId: store.store_id }],
    }, 60_000, RANK_HEADERS);
    const categories = this.rankCategories(detail.data, rankId);
    const category = categoryId == null ? categories[0] : categories.find(item => item.category_id === categoryId);
    if (!category) fail('请选择此榜单返回的官方标签。', 400, 'INVALID_SAMS_CATEGORY');
    const name = typeof detail.data?.titleName === 'string' ? detail.data.titleName.trim() : '';
    if (!name || name.length > 200) fail('暂时无法读取官方榜单名称。');
    const rank = { rank_id: rankId, name };
    const { result, queried_at, cached } = await this.upstream('channel/portal/homeRankDetail/queryGoodsInfoPage', {
      categoryId: category.category_id, contentDetailId: rankId, pageNum: page, pageSize: 30,
      storeInfoList: [{ storeType: store.store_type, storeId: store.store_id }], excludeSpuIds, isVisitorRequest: true,
    }, 60_000, RANK_HEADERS);
    const data = result.data;
    // The official endpoint can leave pageNum at its default 0; pagination uses our validated request page.
    if (typeof data?.end !== 'boolean' || (data.pageNum != null && Number(data.pageNum) !== 0 && Number(data.pageNum) !== page)
      || (data.categoryId != null && String(data.categoryId) !== category.category_id)
      || (data.contentDetailId != null && String(data.contentDetailId) !== rankId)) fail('榜单服务返回的分页或标签与选择不一致。');
    const products = this.normalizeProducts(data.goodsInfoList, store, 30);
    const knownStore = this.storeNames.get(`${store.store_id}:${store.store_type}`);
    const selectionId = this.selectionSnapshot({ products, store, knownStore, keyword: '', queried_at, method: 'rank', rank, category });
    return { query: '', mode: 'rank', rank, categories, category, store, page, page_size: 30, total: null,
      has_more: !data.end && products.length > 0 && page < 100, queried_at, cached,
      elapsed_ms: this.now() - started, selectionId, products };
  }

  resolveSelections(body) {
    const groups = body?.selections;
    if (!Array.isArray(groups) || !groups.length || groups.length > 200) fail('请勾选要加入商品库的商品。', 400, 'INVALID_SAMS_SELECTION');
    let count = 0; const products = new Map();
    for (const group of groups) {
      if (!group || typeof group.selectionId !== 'string' || !Array.isArray(group.spuIds) || !group.spuIds.length || group.spuIds.some(id => typeof id !== 'string' || !SPU_ID.test(id)) || (count += group.spuIds.length) > 200) fail('一次最多选择 200 件商品，选择资料无效。', 400, 'INVALID_SAMS_SELECTION');
      const snapshot = this.snapshots.get(group.selectionId);
      if (!snapshot || this.now() - snapshot.at >= SNAPSHOT_TTL) fail('查询结果已过期，请重新查询后选择。', 409, 'SAMS_SELECTION_EXPIRED');
      for (const spuId of group.spuIds) {
        const product = snapshot.products.find(item => item.spu_id === spuId);
        if (!product?.selectable) fail('所选商品的图片、名称或价格不完整，请重新查询后选择。', 400, 'INVALID_SAMS_SELECTION');
        products.set(product.productId, { id: product.productId, name: product.name, spec: product.spec, unit: '件',
          priceCents: product.price_cents, category: '其他', onSale: false, sort: 0, imageUrl: product.image_url,
          source: { platform: 'samsclub_cn', spuId, storeId: snapshot.store.store_id, storeType: snapshot.store.store_type,
            storeName: snapshot.store.name, cityCode: snapshot.knownStore?.cityCode || null, cityName: snapshot.knownStore?.cityName || null,
            method: snapshot.method || 'search', keyword: snapshot.keyword, queriedAt: snapshot.queried_at, priceCents: product.price_cents,
            ...(snapshot.method === 'rank' ? { rankId: snapshot.rank.rank_id, rankName: snapshot.rank.name,
              rankCategoryId: snapshot.category.category_id, rankCategoryName: snapshot.category.name,
              ...(snapshot.category.name_source === 'rank_title' ? { rankCategoryNameSource: 'rank_title',
                rankCategoryOriginalTitle: snapshot.category.original_title } : {}) } : {}),
            description: product.description, images: product.images },
        });
      }
    }
    return [...products.values()];
  }
}
