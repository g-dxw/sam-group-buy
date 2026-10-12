import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from './order-service.js';
import { productVersion, payloadHash, samsStoreKey } from './local-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPU = /^[A-Za-z0-9_-]{1,120}$/;
const QUOTE_TTL = 30 * 60_000;
const blocked = (message, ids = []) => new DomainError(409, 'SELF_PRODUCT_CHANGED', message, { productIds: ids });
export function customerOwner(token, required = true) {
  if (!token && !required) return null;
  if (typeof token !== 'string' || !UUID.test(token)) throw new DomainError(400, 'CUSTOMER_TOKEN_REQUIRED', '请刷新本期页面后重新选择个人商品。');
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}
const draft = product => product.source?.customerSelected === true && product.revision === 1 && !product.onSale;
const sameSpu = (product, spuId, store) => product.source?.platform === 'samsclub_cn'
  && product.source.spuId === spuId && product.source.storeId === store.storeId && product.source.storeType === store.storeType;
const quoteVersion = product => createHash('sha256').update(JSON.stringify([
  product.localVersion || productVersion(product), product.id, product.onSale, product.quoteRevision,
])).digest('hex');

export class CustomerSelection {
  constructor({ store, service, sams, now = Date.now }) {
    this.store = store; this.service = service; this.sams = sams; this.now = now;
    this.submissions = new Map();
  }
  async validateStore(value) {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.cityCode !== 'string'
      || !/^\d{6}$/.test(value.cityCode) || typeof value.storeId !== 'string' || !/^\d{1,12}$/.test(value.storeId)
      || ![2, 4, 8, 256].includes(value.storeType)) throw new DomainError(400, 'INVALID_SAMS_STORE', '请选择有效的本期采购门店。');
    const listing = await this.sams.stores(value.cityCode);
    const match = listing.stores.find(row => row.store_id === value.storeId && row.store_type === value.storeType);
    const city = this.sams.storeNames.get(`${value.storeId}:${value.storeType}`);
    if (!match || !city?.cityName) throw new DomainError(400, 'INVALID_SAMS_STORE', '所选门店不属于该城市，请重新选择。');
    return { cityCode: value.cityCode, storeId: match.store_id, storeType: match.store_type, name: match.name, cityName: city.cityName };
  }
  async createBatch(input) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : input;
    const existing = body && typeof body.requestId === 'string' && UUID.test(body.requestId)
      ? this.store.getBatchByRequest(body.requestId.toLowerCase()) : null;
    if (body && Object.hasOwn(body, 'samsStore')) {
      if (existing) {
        const value = body.samsStore;
        if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value)
          || typeof value.cityCode !== 'string' || !/^\d{6}$/.test(value.cityCode)
          || typeof value.storeId !== 'string' || !/^\d{1,12}$/.test(value.storeId)
          || ![2, 4, 8, 256].includes(value.storeType))) {
          throw new DomainError(400, 'INVALID_SAMS_STORE', '请选择有效的本期采购门店。');
        }
        if (samsStoreKey(value) !== samsStoreKey(existing.samsStore)) {
          throw new DomainError(409, 'BATCH_REQUEST_CONFLICT', '该创建编号已用于另一份团购。');
        }
        // The original validated names are part of the saved request hash.
        // Replaying a completed create must not depend on the upstream being online.
        body.samsStore = existing.samsStore;
      } else body.samsStore = await this.validateStore(body.samsStore);
    }
    return this.service.createBatch(body);
  }
  current(batchInput, requireOpen = true) {
    const batch = this.service.getBatch(batchInput);
    if (requireOpen && !this.service.safeBatch(batch).collecting) throw new DomainError(409, 'COLLECTION_CLOSED', '本期已停止收集，仍可查询已提交订单。');
    if (!batch.samsStore) throw new DomainError(409, 'SAMS_STORE_NOT_CONFIGURED', '团长尚未设置本期采购门店，请先选购本期推荐商品。');
    return batch;
  }
  unchanged(batch, key) {
    const fresh = this.current(batch);
    if (samsStoreKey(fresh.samsStore) !== key) throw blocked('本期采购门店已调整，请重新搜索后选择。');
    return fresh;
  }
  matches(spuId, store) { return this.store.listProducts().filter(product => sameSpu(product, spuId, store)); }
  localMatch(spuId, batch) {
    const matches = this.matches(spuId, batch.samsStore);
    if (matches.some(product => !product.onSale && !draft(product))) return { stopped: true };
    return { product: matches.find(product => product.onSale && batch.productIds.includes(product.id))
      || matches.find(product => product.onSale) || null };
  }
  product(raw, batch, keyword, queriedAt, { id, quoteRevision = 1 } = {}) {
    const match = this.localMatch(raw.spu_id, batch);
    const local = match.product;
    const available = raw.selectable && raw.available === true && raw.on_sale === true && !match.stopped;
    let selfId = `self_${batch.samsStore.storeType}_${batch.samsStore.storeId}_${raw.spu_id}`;
    if (selfId.length > 128) selfId = `self_${batch.samsStore.storeType}_${batch.samsStore.storeId}_${createHash('sha256').update(raw.spu_id).digest('hex')}`;
    const recommended = Boolean(local && batch.productIds.includes(local.id));
    const result = { id: id || local?.id || selfId, name: local?.name || raw.name, spec: local?.spec || raw.spec,
      unit: local?.unit || '件', priceCents: local?.priceCents ?? raw.price_cents,
      category: local?.category || '其他', sort: local?.sort || 0,
      description: local?.source?.description || raw.description || '', imageUrl: local?.imageUrl || raw.image_url,
      onSale: Boolean(available), selectable: Boolean(available), selfSelected: !recommended,
      feeCategory: recommended ? 'recommended' : 'selfSelected', spuId: raw.spu_id,
      available: raw.available, on_sale: raw.on_sale, priceSource: local ? 'local' : 'sams',
      reusedProductId: local?.id || null, keyword, quotedAt: queriedAt,
      quoteRevision, localVersion: local ? productVersion(local) : null,
      expiresAt: new Date(this.now() + QUOTE_TTL).toISOString(),
      source: { ...(local?.source || {}), platform: 'samsclub_cn', spuId: raw.spu_id,
        storeId: batch.samsStore.storeId, storeType: batch.samsStore.storeType, storeName: batch.samsStore.name,
        cityCode: batch.samsStore.cityCode, cityName: batch.samsStore.cityName,
        method: 'search', keyword, queriedAt, priceCents: raw.price_cents,
        description: raw.description || '', images: raw.images || [], customerSelected: true },
    };
    // Local-price selections use the administrator's version, including when
    // their personal ID remains stable after a same-SPU local product appears.
    result.version = quoteVersion(result);
    if (this.service.splitRecommendation(batch, result)?.removedAt) return { ...result, onSale: false, selectable: false,
      selectionUnavailableReason: '本期拼份商品已移除，无法加购；请参与下一期。' };
    if (recommended && (!id || batch.splitRules?.[local.id])) return { ...this.service.getCatalog(batch).products.find(p => p.id === local.id),
      selfSelected: false, feeCategory: 'recommended', selectable: Boolean(available), spuId: raw.spu_id, priceSource: 'local', available: raw.available, on_sale: raw.on_sale };
    return result;
  }
  publicProduct(product, extra = {}) {
    const { source, keyword, reusedProductId, sort, localVersion, quoteRevision, ...publicFields } = product;
    return { ...publicFields, quoteExpired: Boolean(product.expiresAt && Date.parse(product.expiresAt) <= this.now()), ...extra };
  }
  async search(batchInput, token, params) {
    const ownerHash = customerOwner(token);
    if (!params || Object.keys(params).some(key => !['keyword', 'page'].includes(key))) throw new DomainError(400, 'INVALID_SAMS_QUERY', '顾客查询仅支持关键词和页码，本期门店由团长设置。');
    const keyword = typeof params.keyword === 'string' ? params.keyword.trim() : '';
    const page = Number(params.page ?? 1);
    if (!keyword || keyword.length > 80 || !Number.isInteger(page) || page < 1 || page > 100) throw new DomainError(400, 'INVALID_SAMS_QUERY', '请输入有效关键词和页码。');
    const batch = this.current(batchInput); const key = samsStoreKey(batch.samsStore);
    const { storeId, storeType } = batch.samsStore;
    const { result, queried_at, cached } = await this.sams.upstream('goods-portal/spu/search', {
      keyword, pageNum: page, pageSize: 20, storeInfoVOList: [{ storeType, storeId }],
    });
    const rows = this.sams.normalizeProducts(result.data?.dataList, { store_id: storeId, store_type: storeType }, 20);
    const fresh = this.unchanged(batch, key);
    const selectionId = randomUUID();
    this.store.saveCustomerSelection({ selectionId, batchCode: batch.code, ownerHash, storeKey: key,
      data: { rows, keyword, queriedAt: queried_at }, expiresAt: this.now() + QUOTE_TTL }, this.now());
    return { products: rows.map(raw => this.publicProduct(this.product(raw, fresh, keyword, queried_at))), selectionId,
      page, page_size: 20, has_more: result.data?.hasNextPage === true, queried_at, cached, store: fresh.samsStore };
  }
  async detail(spuId, store) {
    const { result, queried_at } = await this.sams.upstream('goods-portal/spuStoreModel/querySpuDetailToNFC', {
      spuIdList: [spuId], visitStoreId: store.storeId,
      storeInfoList: [{ storeType: store.storeType, storeId: store.storeId }], locationSwitch: false,
    }, 0);
    const row = result.data;
    if (!row || Array.isArray(row) || String(row.spuId) !== spuId || String(row.storeId) !== store.storeId
      || (row.storeType != null && Number(row.storeType) !== store.storeType)) throw blocked('商品详情与本期门店不一致，请重新查询。');
    const raw = this.sams.normalizeProducts([{ ...row, image: row.image || row.images?.[0] }],
      { store_id: store.storeId, store_type: store.storeType }, 1)[0];
    const quantity = row.stockInfo?.stockQuantity;
    raw.selectable = raw.selectable && row.isAvailable === true && row.isStoreAvailable === true
      && row.isPutOnSale === true && Number.isSafeInteger(quantity) && quantity > 0;
    if (!raw.selectable) raw.available = false;
    return { raw, queriedAt: queried_at };
  }
  async add(batchInput, token, body) {
    const ownerHash = customerOwner(token);
    if (!body || Object.keys(body).some(key => !['selectionId', 'spuId'].includes(key))
      || !UUID.test(body.selectionId || '') || typeof body.spuId !== 'string' || !SPU.test(body.spuId)) {
      throw new DomainError(400, 'INVALID_SAMS_SELECTION', '请从本期查询结果选择商品。');
    }
    const batch = this.current(batchInput); const key = samsStoreKey(batch.samsStore);
    const selection = this.store.getCustomerSelection(body.selectionId, batch.code, ownerHash);
    if (!selection || selection.expiresAt <= this.now() || selection.storeKey !== key) throw new DomainError(409, 'SAMS_SELECTION_EXPIRED', '查询结果已过期或采购门店已调整，请重新查询。');
    const original = selection.data.rows.find(row => row.spu_id === body.spuId);
    if (!original?.selectable || original.available !== true || original.on_sale !== true) throw new DomainError(400, 'INVALID_SAMS_SELECTION', '所选商品缺少有效价格或可售状态，请选择其他商品。');
    const { raw, queriedAt } = await this.detail(body.spuId, batch.samsStore);
    const fresh = this.unchanged(batch, key);
    const product = this.product(raw, fresh, selection.data.keyword, queriedAt);
    this.service.assertSplitAvailable(this.service.splitRecommendation(fresh, product), product.id);
    if (!product.selectable) throw blocked('商品已停售或库存不足，请选择其他商品。', [product.id]);
    if (product.selfSelected) {
      const previous = this.store.getCustomerProduct(batch.code, ownerHash, product.id);
      if (previous) { product.quoteRevision = (previous.product.quoteRevision || 1) + 1; product.version = quoteVersion(product); }
      this.store.saveCustomerProduct(batch.code, ownerHash, key, product, this.now());
    }
    return { product: this.publicProduct(product) };
  }
  list(batchInput, token) {
    const ownerHash = customerOwner(token); const batch = this.service.getBatch(batchInput);
    const key = samsStoreKey(batch.samsStore);
    return { products: this.store.listCustomerProducts(batch.code, ownerHash).map(({ storeKey, product: saved }) => {
      let product = saved;
      const storeChanged = !key || key !== storeKey;
      const closed = !this.service.safeBatch(batch).collecting;
      let changed = false;
      if (!storeChanged) {
        if (this.service.splitRecommendation(batch, product)?.removedAt) return this.publicProduct(product,
          { onSale: false, selectable: false, localChanged: true, selectionUnavailableReason: '本期拼份商品已移除，无法加购；请参与下一期。' });
        const match = this.localMatch(product.spuId, batch);
        if (match.product && batch.splitRules?.[match.product.id] && batch.productIds.includes(match.product.id)) {
          const recommended = this.service.getCatalog(batch).products.find(value => value.id === match.product.id);
          return this.publicProduct({ ...product, name: recommended.name, spec: recommended.spec, unit: recommended.unit,
            priceCents: recommended.priceCents, split: recommended.split, recommendedProductId: recommended.id,
            onSale: false, selectable: false }, { storeChanged: false, localChanged: true });
        }
        changed = Boolean(match.stopped || product.reusedProductId && !match.product);
        if (!changed && match.product && productVersion(match.product) !== product.localVersion) {
          product = { ...product, name: match.product.name, spec: match.product.spec, unit: match.product.unit,
            category: match.product.category, imageUrl: match.product.imageUrl || product.imageUrl,
            priceCents: match.product.priceCents, localVersion: productVersion(match.product),
            reusedProductId: match.product.id, priceSource: 'local', quoteRevision: product.quoteRevision || 1 };
          product.version = quoteVersion(product);
          this.store.saveCustomerProduct(batch.code, ownerHash, key, product, this.now());
        }
      }
      return this.publicProduct(product, { feeCategory: this.service.feeCategoryForProduct(batch, product), storeChanged, localChanged: changed,
        ...((storeChanged || closed || changed) ? { onSale: false, selectable: false } : {}) });
    }) };
  }
  async submit(batchInput, token, input) {
    const payload = this.service.normalizeOrder(input);
    const batch = this.service.getBatch(batchInput);
    const existing = this.store.getSubmission(batch.code, payload.submissionId);
    const ownerHash = customerOwner(token, false);
    // A completed UUID is independent of upstream availability, current store,
    // stock or cutoff. The service still checks its original body and owner.
    if (existing) return this.service.submit(batch, input, { ownerHash });
    const requestKey = JSON.stringify([batch.code, payload.submissionId]);
    const hash = payloadHash([payload, ownerHash]);
    const pending = this.submissions.get(requestKey);
    if (pending) {
      if (pending.hash !== hash) throw new DomainError(409, 'SUBMISSION_CONFLICT', '此提交编号正在处理另一份订单，请保持原提交内容。');
      return pending.promise;
    }
    const promise = this.submitFresh(batch, ownerHash, input, payload);
    this.submissions.set(requestKey, { hash, ownerHash, promise });
    try { return await promise; }
    finally { if (this.submissions.get(requestKey)?.promise === promise) this.submissions.delete(requestKey); }
  }
  async submitFresh(batch, ownerHash, input, payload) {
    const currentFees = this.service.getBatch(batch);
    this.service.validateFeePolicy(currentFees, payload, { ownerHash });
    this.service.requireFeeQuote(currentFees, payload, { ownerHash });
    const offered = new Set(this.service.getCatalog(batch).products.map(product => product.id));
    const personal = payload.items.filter(item => !offered.has(item.productId));
    if (!personal.length) return this.service.submit(batch, input, { ownerHash });
    if (!ownerHash) throw new DomainError(400, 'CUSTOMER_TOKEN_REQUIRED', '个人选品需要原浏览器的清单标识。');
    const current = this.current(batch); const key = samsStoreKey(current.samsStore);
    const prepared = new Map(); let changed = false;
    // Bounded concurrency shares the upstream adapter's three-request limit.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, personal.length) }, async () => {
      while (cursor < personal.length) {
        const item = personal[cursor++];
        const quote = this.store.getCustomerProduct(batch.code, ownerHash, item.productId);
        if (!quote || quote.storeKey !== key) throw blocked('个人商品不属于当前清单或采购门店已调整，请重新搜索。', [item.productId]);
        const recommendation = this.service.splitRecommendation(current, quote.product);
        this.service.assertSplitAvailable(recommendation, item.productId);
        if (recommendation) throw new DomainError(409, 'SPLIT_RECOMMENDATION_REQUIRED', '本期该商品按份拼单，请选择本期推荐中的同款分装商品。',
          { productIds: [item.productId], recommendedProductId: recommendation.id, catalog: this.service.getCatalog(current) });
        const expired = Date.parse(quote.product.expiresAt) <= this.now();
        const { raw, queriedAt } = await this.detail(quote.product.spuId, current.samsStore);
        const fresh = this.unchanged(batch, key);
        const product = this.product(raw, fresh, quote.product.keyword, queriedAt, { id: quote.product.id,
          quoteRevision: (quote.product.quoteRevision || 1) + Number(expired) });
        // Keep all personal selections private even if the product became a
        // recommendation after this request started; the service resolves that
        // race against the freshly loaded batch before committing.
        product.selfSelected = true;
        if (!Number.isSafeInteger(product.priceCents)) {
          product.priceCents = quote.product.priceCents;
          product.onSale = false; product.selectable = false; product.priceUnavailable = true;
          product.version = quoteVersion(product);
        }
        this.store.saveCustomerProduct(batch.code, ownerHash, key, product, this.now());
        if (expired || !product.selectable || item.version !== product.version) changed = true;
        prepared.set(item.productId, product);
      }
    });
    const outcomes = await Promise.allSettled(workers);
    const error = outcomes.find(outcome => outcome.status === 'rejected');
    if (error) throw error.reason;
    if (changed) throw blocked('个人商品报价或库存已更新，请刷新个人清单后重新确认。', personal.map(item => item.productId));
    return this.service.submit(batch, input, { customerProducts: prepared, ownerHash });
  }
  quote(batchInput, token, input) {
    const payload = this.service.normalizeOrder({ ...input, submissionId: '00000000-0000-4000-8000-000000000000',
      phone: input?.phone == null || input.phone === '' ? '13800138000' : input.phone, name: '报价' });
    const batch = this.service.getBatch(batchInput);
    const offered = new Set(this.service.getCatalog(batch).products.map(product => product.id));
    const personal = payload.items.filter(item => !offered.has(item.productId));
    const ownerHash = customerOwner(token, personal.length > 0);
    const products = new Map();
    for (const item of personal) {
      const saved = this.store.getCustomerProduct(batch.code, ownerHash, item.productId);
      if (!saved) throw blocked('个人商品不属于当前清单，请重新搜索后选择。', [item.productId]);
      products.set(item.productId, saved.product);
    }
    return this.service.quote(batch, input, { customerProducts: products, ownerHash });
  }
  receipt(batchInput, token, id) {
    if (typeof id !== 'string' || !UUID.test(id)) return this.service.getSubmission(batchInput, id);
    const batch = this.service.getBatch(batchInput); const saved = this.store.getSubmission(batch.code, id.toLowerCase());
    if (saved?.customerHash && saved.customerHash !== customerOwner(token, false)) throw new DomainError(403, 'CUSTOMER_TOKEN_MISMATCH', '请在原下单浏览器核对这次提交。');
    const pending = this.submissions.get(JSON.stringify([batch.code, id.toLowerCase()]));
    if (!saved && pending) {
      if (pending.ownerHash !== customerOwner(token, false)) throw new DomainError(403, 'CUSTOMER_TOKEN_MISMATCH', '请在原下单浏览器核对这次提交。');
      return { submissionId: id.toLowerCase(), status: 'processing' };
    }
    return this.service.getSubmission(batch, id);
  }
}
