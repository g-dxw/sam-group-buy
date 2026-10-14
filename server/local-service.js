import { DomainError, normalizePhone, completeGroup } from './order-service.js';
import { ORDER_STATUSES, productVersion, payloadHash, samsStoreKey } from './local-store.js';
import { addCents, billingSummary, feePolicyVersion, feeRate, incrementalBilling, normalizeFeePolicy } from './order-billing.js';
import { normalizeSplitRules, packSnapshot, splitVersion, splitProgress, allocateSplit, pendingSplitSummary, splitAmount } from './split-groups.js';
import { ProductPricing } from './product-pricing.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;
const EXCLUDED = new Set(['已取消', '缺货']);
const BATCH_FIELDS = ['title', 'description', 'productIds', 'collecting', 'cutoffAt', 'pickupLocation', 'pickupAt', 'contactNote', 'samsStore', 'feePolicy', 'splitRules'];

function trimmed(value, maximum, field, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.trim().length > maximum || (required && !value.trim())) {
    throw new DomainError(400, 'INVALID_INPUT', `${field}不能为空且长度需符合要求。`);
  }
  return value.trim();
}
function datetime(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    || !Number.isFinite(Date.parse(value))) throw new DomainError(400, 'INVALID_DATE', `${field}需要填写带时区的有效时间。`);
  return new Date(value).toISOString();
}
function receipt(id) { return { submissionId: id, status: 'completed', receipt: { submissionId: id } }; }
function imageUrl(batch, id, product) {
  if (product?.imageUrl) return product.imageUrl;
  const template = process.env.IMAGE_URL_TEMPLATE || batch.imageUrlTemplate || '/images/{id}/cover.svg';
  if (!template.includes('{id}') || (!/^https?:\/\//i.test(template)
    && (!template.startsWith('/') || template.startsWith('//')))) return '/images/placeholder.svg';
  return template.replaceAll('{id}', encodeURIComponent(id));
}
function productView(product, batch, admin = false, backup = {}) {
  return {
    id: product.id, name: product.name, spec: product.spec, unit: product.unit,
    description: productDescription(product),
    priceCents: product.priceCents, category: product.category, onSale: product.onSale, sort: product.sort,
    imageUrl: imageUrl(batch, product.id, product), version: productVersion(product),
    ...(admin ? { recordId: product.recordId, updatedAt: product.updatedAt, createdAt: product.createdAt,
      source: product.source, revision: product.revision, originalPriceCents: product.originalPriceCents,
      pricing: product.pricing, removedAt: product.removedAt || null, ...backup } : {}),
  };
}
function publicSplit(split) {
  const { packPriceCents: ignoredPrice, packPriceSource: ignoredSource, ...fields } = split;
  return fields;
}
function sameSourceProduct(left, right) {
  const a = left?.source; const b = right?.source;
  return a?.platform === 'samsclub_cn' && b?.platform === 'samsclub_cn' && typeof a.spuId === 'string' && a.spuId.length > 0
    && a.spuId === b.spuId && a.storeId === b.storeId && a.storeType === b.storeType;
}
function productDescription(product) {
  if (typeof product?.description === 'string' && product.description) return product.description;
  return typeof product?.source?.description === 'string' ? product.source.description : '';
}
function aggregateProducts(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!groups.has(line.productId)) groups.set(line.productId, {
      id: line.productId, name: line.productName, spec: line.spec, unit: line.unit,
      description: productDescription(line.product),
      imageUrl: line.imageUrl, priceCents: line.priceCents, quantity: 0, amountCents: 0,
      statuses: [], selfSelected: line.selfSelected, pendingGoodsCents: 0,
      ...(line.split ? { split: { ...publicSplit(line.split), requestedQuantity: 0, formedQuantity: 0, pendingQuantity: 0, unformedQuantity: 0 } } : {}),
      ...(line.priceCents === null ? { missing: true } : {}),
    });
    const product = groups.get(line.productId);
    if (product.priceCents !== line.priceCents) product.mixedPrices = true;
    product.selfSelected ||= line.selfSelected;
    product.quantity += line.quantity;
    if (line.split) {
      for (const field of ['requestedQuantity', 'formedQuantity', 'pendingQuantity', 'unformedQuantity']) product.split[field] += line.split[field];
      product.pendingGoodsCents = addCents([product.pendingGoodsCents, line.pendingGoodsCents || 0]);
    }
    const statusQuantity = line.split ? EXCLUDED.has(line.status) ? line.quantity : line.split.formedQuantity : line.quantity;
    if (statusQuantity > 0) {
      let status = product.statuses.find(value => value.status === line.status);
      if (!status) { status = { status: line.status, quantity: 0 }; product.statuses.push(status); }
      status.quantity += statusQuantity;
    }
    if (line.amountCents === null) product.amountCents = null;
    else if (product.amountCents !== null) product.amountCents = addCents([product.amountCents, line.amountCents]);
  }
  return [...groups.values()].map(product => ({ ...product, statuses: product.statuses.sort(
    (a, b) => ORDER_STATUSES.indexOf(a.status) - ORDER_STATUSES.indexOf(b.status),
  ) }));
}

export class LocalService {
  constructor({ store, now = () => new Date(), sams, batchMutationBusy = () => false, productMutationBusy = () => false }) {
    this.store = store; this.now = now;
    this.batchMutationBusy = batchMutationBusy;
    this.productMutationBusy = productMutationBusy;
    this.productPricing = new ProductPricing({ store, now: () => this.now().getTime(), sams });
  }

  getBatch(input) {
    const code = typeof input === 'string' ? input : input?.code;
    const batch = code ? this.store.getBatch(code)
      : this.store.getBatch(this.store.getMeta('defaultBatch')) || this.store.listBatches()[0];
    if (!batch) throw new DomainError(404, 'BATCH_NOT_FOUND', '本期收集链接不存在。');
    return batch;
  }
  batchCollecting(batch) {
    return !batch.deletedAt && batch.collecting && (!batch.cutoffAt || Date.parse(batch.cutoffAt) > this.now().getTime());
  }
  listPublicBatches() {
    const products = this.store.listProducts();
    return { batches: this.store.listBatches().filter(batch => this.batchCollecting(batch)).map(batch => {
      const selected = new Set(batch.productIds);
      const offered = products.filter(product => selected.has(product.id) && product.onSale
        && !(batch.splitRules?.[product.id] && this.store.getSplitSettlement(batch.code, product.id)));
      return { code: batch.code, communityName: batch.communityName, title: batch.title,
        periodLabel: batch.periodLabel, periodNumber: batch.periodNumber, description: batch.description,
        cutoffAt: batch.cutoffAt, pickupAt: batch.pickupAt, pickupLocation: batch.pickupLocation,
        productCount: offered.length, coverImages: [...new Set(offered.map(product => productView(product, batch).imageUrl))].slice(0, 3) };
    }) };
  }
  safeBatch(batch) {
    const collecting = this.batchCollecting(batch);
    return {
      code: batch.code, title: batch.title, description: batch.description,
      communityId: batch.communityId, communityName: batch.communityName,
      periodNumber: batch.periodNumber, periodLabel: batch.periodLabel,
      collecting, collectionEnabled: batch.collecting,
      cutoffAt: batch.cutoffAt, productIds: batch.productIds,
      pickupLocation: batch.pickupLocation, pickupAt: batch.pickupAt, contactNote: batch.contactNote,
      createdAt: batch.createdAt, deletedAt: batch.deletedAt || null, managed: true, customerUrl: `/b/${batch.code}`,
      samsStore: batch.samsStore || null,
      feePolicy: normalizeFeePolicy(batch.feePolicy), feePolicyVersion: feePolicyVersion(batch),
      splitRules: normalizeSplitRules(batch.splitRules), splitLockedProductIds: this.splitLockedProductIds(batch),
      feishuUrl: this.store.getMeta('exportSource')?.feishuUrl || batch.feishuUrl || null,
    };
  }
  getCatalog(input, { allProducts = false } = {}) {
    const batch = this.getBatch(input);
    const selected = new Set(batch.productIds);
    const safe = this.safeBatch(batch);
    const { code, title, description, collecting, cutoffAt, contactNote,
      communityName, periodNumber, periodLabel, pickupLocation, pickupAt } = safe;
    return { batch: { code, title, description, collecting, cutoffAt, contactNote,
      communityName, periodNumber, periodLabel, pickupLocation, pickupAt, samsStore: safe.samsStore,
      feePolicy: safe.feePolicy, feePolicyVersion: safe.feePolicyVersion }, products: this.store.listProducts()
      .filter(product => allProducts || selected.has(product.id)).map(product => {
        const view = productView(product, batch);
        const rule = batch.splitRules?.[product.id];
        const purchaseIdentity = this.purchaseIdentity(product, rule ? 'portion' : 'whole');
        if (purchaseIdentity) view.purchaseIdentity = purchaseIdentity;
        if (!rule) return view;
        const settlement = this.store.getSplitSettlement(batch.code, product.id);
        const lines = this.store.listOrderLines(batch.code).filter(line => line.productId === product.id && line.snapshot?.split);
        return { ...view, spec: rule.portionSpec, unit: '份', priceCents: rule.priceCents,
          onSale: product.onSale && !settlement, version: splitVersion(view.version, rule, settlement),
          split: { ...publicSplit(packSnapshot(product, rule)), progress: splitProgress(rule, lines, settlement) } };
      }) };
  }
  purchaseIdentity(product, kind = 'whole') {
    const source = product?.source;
    const spuId = product?.spuId || source?.spuId;
    if (source?.platform !== 'samsclub_cn' || typeof spuId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(spuId)
      || typeof source.storeId !== 'string' || !/^\d{1,12}$/.test(source.storeId)
      || ![2, 4, 8, 256].includes(source.storeType) || !['whole', 'portion'].includes(kind)) return null;
    return { platform: 'samsclub_cn', storeType: source.storeType, storeId: source.storeId, spuId, kind };
  }
  isPortionProduct(batch, product) {
    // Personal quotes represent the upstream whole pack. A batch rule changes
    // the local offer's form, not every same-SPU product in that batch.
    if (product?.purchaseForm) return product.purchaseForm === 'portion';
    if (product?.expiresAt) return false;
    return Boolean(product?.split || batch.splitRules?.[product?.id]);
  }
  normalizeOrder(input) {
    if (!input || !UUID.test(input.submissionId ?? '')) throw new DomainError(400, 'INVALID_SUBMISSION_ID', '提交编号无效，请刷新页面后重试。');
    const phone = normalizePhone(input.phone);
    const name = trimmed(input.name, 40, '姓名或群昵称', true);
    const note = trimmed(input.note, 500, '备注');
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 200) {
      throw new DomainError(400, 'INVALID_ITEMS', '请选择商品，一次最多提交 200 种商品。');
    }
    const seen = new Set();
    const items = input.items.map(item => {
      if (!item || typeof item.productId !== 'string' || !PRODUCT_ID.test(item.productId) || seen.has(item.productId)) throw new DomainError(400, 'INVALID_ITEMS', '商品编号无效或重复。');
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) throw new DomainError(400, 'INVALID_QUANTITY', '商品数量必须为 1 至 999 的整数。');
      if (typeof item.version !== 'string' || !/^[0-9a-f]{64}$/.test(item.version)) throw new DomainError(400, 'INVALID_PRODUCT_VERSION', '请刷新商品信息后重新确认。');
      seen.add(item.productId);
      return { productId: item.productId, quantity: item.quantity, version: item.version };
    }).sort((a, b) => a.productId.localeCompare(b.productId));
    for (const field of ['feePolicyVersion', 'feeQuoteVersion']) {
      if (input[field] !== undefined && (typeof input[field] !== 'string' || !/^[0-9a-f]{64}$/.test(input[field]))) {
        throw new DomainError(400, 'INVALID_FEE_POLICY_VERSION', '收费规则或预计费用版本无效，请刷新后重新确认。');
      }
    }
    return { submissionId: input.submissionId.toLowerCase(), phone, name, note, items,
      ...(input.feePolicyVersion === undefined ? {} : { feePolicyVersion: input.feePolicyVersion }),
      ...(input.feeQuoteVersion === undefined ? {} : { feeQuoteVersion: input.feeQuoteVersion }) };
  }
  feeCategoryForProduct(batch, product) {
    const selected = new Set(batch.productIds);
    const portion = this.isPortionProduct(batch, product);
    if (selected.has(product.id) && portion === Boolean(batch.splitRules?.[product.id])
      && !this.store.getProduct(product.id)?.removedAt) return 'recommended';
    const spuId = product.spuId || product.source?.spuId;
    const source = product.source;
    if (spuId && batch.samsStore && source?.platform === 'samsclub_cn'
      && source.storeId === batch.samsStore.storeId && source.storeType === batch.samsStore.storeType
      && this.store.listProducts().some(local => selected.has(local.id) && local.onSale
        && portion === Boolean(batch.splitRules?.[local.id])
        && local.source?.platform === 'samsclub_cn' && local.source.spuId === spuId
        && local.source.storeId === batch.samsStore.storeId && local.source.storeType === batch.samsStore.storeType)) return 'recommended';
    return 'selfSelected';
  }
  splitLockedProductIds(batch) {
    const lines = this.store.listOrderLines(batch.code);
    const locked = new Set(lines.map(line => line.productId));
    for (const id of batch.productIds) if (this.store.getSplitSettlement(batch.code, id)) locked.add(id);
    for (const id of batch.productIds) {
      const product = this.store.getProduct(id);
      if (lines.some(line => sameSourceProduct(product, line.snapshot || this.store.getProduct(line.productId)))) locked.add(id);
    }
    return [...locked].filter(id => batch.productIds.includes(id)).sort();
  }
  splitRecommendation(batch, product) {
    if (!this.isPortionProduct(batch, product)) return null;
    return this.store.listProducts({ includeRemoved: true }).find(local => batch.productIds.includes(local.id) && batch.splitRules?.[local.id]
      && (local.id === product?.id || sameSourceProduct(local, product)));
  }
  assertSplitAvailable(recommendation, id) {
    if (recommendation?.removedAt) throw new DomainError(409, 'SPLIT_PRODUCT_REMOVED', '本期拼份商品已移除，无法加购；请参与下一期。', { productIds: [id] });
  }
  orderProduct(batch, item, options = {}) {
    // A public offer can share an ID with an old private quote. Its current
    // catalog version is checked in prepareOrder; private metadata must never
    // change that explicit public offer's fee or portion classification.
    return (batch.productIds.includes(item.productId) && this.store.getProduct(item.productId))
      || options.customerProducts?.get(item.productId)
      || (options.ownerHash && this.store.getCustomerProduct(batch.code, options.ownerHash, item.productId)?.product)
      || this.store.getProduct(item.productId) || { id: item.productId };
  }
  orderHasSplit(batch, payload, options = {}) {
    return payload.items.some(item => this.splitRecommendation(batch, this.orderProduct(batch, item, options)));
  }
  orderHasFees(batch, payload, { customerProducts = new Map(), ownerHash = null } = {}) {
    return payload.items.some(item => {
      const product = this.orderProduct(batch, item, { customerProducts, ownerHash });
      return feeRate(batch, this.feeCategoryForProduct(batch, product)) > 0;
    });
  }
  requireFeeQuote(batch, payload, options = {}) {
    for (const item of payload.items) this.assertSplitAvailable(this.splitRecommendation(batch,
      this.orderProduct(batch, item, options)), item.productId);
    if ((this.orderHasFees(batch, payload, options) || this.orderHasSplit(batch, payload, options)) && !payload.feeQuoteVersion) {
      throw new DomainError(409, 'FEE_QUOTE_CHANGED', '请先核对本次商品与代购费用，再确认提交。');
    }
  }
  validateFeePolicy(batch, payload, options = {}) {
    const version = feePolicyVersion(batch);
    const charged = this.orderHasFees(batch, payload, options);
    if ((payload.feePolicyVersion !== undefined && payload.feePolicyVersion !== version) || (charged && !payload.feePolicyVersion)) {
      throw new DomainError(409, 'FEE_POLICY_CHANGED', '本期代购比例或推荐商品已变化，请核对费用后重新确认。', { catalog: this.getCatalog(batch) });
    }
    return version;
  }
  prepareOrder(batch, payload, { customerProducts = new Map(), ownerHash = null } = {}) {
    const catalog = this.getCatalog(batch);
    if (!catalog.batch.collecting) throw new DomainError(409, 'COLLECTION_CLOSED', '本期已停止收集，仍可查询已提交订单。');
    this.validateFeePolicy(batch, payload, { customerProducts, ownerHash });
    const products = new Map(catalog.products.map(product => [product.id, product]));
    const personalIds = payload.items.filter(item => !products.has(item.productId) && customerProducts.has(item.productId)).map(item => item.productId);
    for (const id of personalIds) {
      const prepared = customerProducts.get(id);
      const recommendation = this.splitRecommendation(batch, prepared);
      this.assertSplitAvailable(recommendation, id);
      if (recommendation) throw new DomainError(409, 'SPLIT_RECOMMENDATION_REQUIRED', '本期该商品按份拼单，请选择本期推荐中的同款分装商品。',
        { productIds: [id], recommendedProductId: recommendation.id, catalog });
      const saved = ownerHash && this.store.getCustomerProduct(batch.code, ownerHash, id);
      if (!prepared?.selectable || !saved || saved.storeKey !== samsStoreKey(batch.samsStore)
        || saved.product.version !== prepared.version || prepared.needsWholeQuote) {
        throw new DomainError(409, 'SELF_PRODUCT_CHANGED', '个人商品报价已失效，请刷新清单后重新确认。', { productIds: [id] });
      }
      const local = prepared.reusedProductId ? this.store.getProduct(prepared.reusedProductId) : null;
      const matches = this.store.listProducts().filter(product => product.source?.platform === 'samsclub_cn'
        && !batch.splitRules?.[product.id]
        && product.source.spuId === prepared.spuId && product.source.storeId === batch.samsStore.storeId
        && product.source.storeType === batch.samsStore.storeType);
      if (matches.some(product => !product.onSale && !(product.source.customerSelected === true && product.revision === 1))
        || !prepared.reusedProductId && matches.some(product => product.onSale)) {
        throw new DomainError(409, 'SELF_PRODUCT_CHANGED', '团长已调整商品在售状态或售价，请重新确认。', { productIds: [id] });
      }
      if (prepared.reusedProductId && (!local?.onSale || batch.splitRules?.[local.id] || productVersion(local) !== prepared.localVersion)) {
        throw new DomainError(409, 'SELF_PRODUCT_CHANGED', '商品售价或在售状态已变化，请重新确认。', { productIds: [id] });
      }
      products.set(id, prepared);
    }
    for (const item of payload.items) {
      const recommendation = this.splitRecommendation(batch, products.get(item.productId) || this.store.getProduct(item.productId));
      this.assertSplitAvailable(recommendation, item.productId);
      if (recommendation && recommendation.id !== item.productId) throw new DomainError(409, 'SPLIT_RECOMMENDATION_REQUIRED',
        '本期该商品按份拼单，请选择本期推荐中的同款分装商品。', { productIds: [item.productId], recommendedProductId: recommendation.id, catalog });
      if (!personalIds.includes(item.productId) && batch.splitRules?.[item.productId] && this.store.getSplitSettlement(batch.code, item.productId)) {
        throw new DomainError(409, 'SPLIT_SETTLED', '该商品已确认拼份采购，不能继续追加；请参与下一期。', { productIds: [item.productId], catalog });
      }
    }
    const changed = payload.items.filter(item => !products.get(item.productId)?.onSale || products.get(item.productId)?.version !== item.version);
    if (changed.length) throw new DomainError(409, 'PRODUCT_CHANGED', '商品价格、规格或在售状态已变化，请重新确认。', {
      productIds: changed.map(item => item.productId), catalog,
    });
    return { products, personalIds };
  }
  snapshotProduct(batch, product, personal) {
    const original = personal ? product : this.store.getProduct(product.id);
    const feeCategory = this.feeCategoryForProduct(batch, original);
    return { id: product.id, name: product.name, spec: product.spec, unit: product.unit,
      purchaseForm: personal ? 'whole' : batch.splitRules?.[product.id] ? 'portion' : 'whole',
      priceCents: product.priceCents, category: product.category, imageUrl: product.imageUrl,
      description: productDescription(original), source: original.source, onSale: true,
      selfSelected: personal, feeCategory, feeRateBps: feeRate(batch, feeCategory), quotedAt: product.quotedAt,
      ...(!personal && batch.splitRules?.[product.id] ? { split: packSnapshot(original, batch.splitRules[product.id]) } : {}) };
  }
  quote(inputBatch, input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['items', 'phone', 'feePolicyVersion'].includes(key))) {
      throw new DomainError(400, 'INVALID_QUOTE', '预计金额请求无效。');
    }
    const phone = input.phone == null || input.phone === '' ? '' : normalizePhone(input.phone);
    const payload = this.normalizeOrder({ ...input, phone: phone || '13800138000', submissionId: '00000000-0000-4000-8000-000000000000', name: '报价' });
    const batch = this.getBatch(inputBatch);
    const { products, personalIds } = this.prepareOrder(batch, payload, options);
    const additions = payload.items.map(item => ({ ...item, lineId: `quote:${item.productId}`, batchCode: batch.code, phone,
      amountCents: addCents([products.get(item.productId).priceCents * item.quantity]),
      snapshot: this.snapshotProduct(batch, products.get(item.productId), personalIds.includes(item.productId)) }));
    const existing = phone ? this.completedLines(this.enrichedLines(batch).filter(line => line.phone === phone)).complete : [];
    const quoteVersion = payloadHash([batch.code, phone, feePolicyVersion(batch),
      additions.map(line => [line.productId, line.version, line.quantity, line.amountCents, line.snapshot.feeCategory, line.snapshot.feeRateBps]),
      existing.map(line => [line.lineId, line.quantity, line.status, line.amountCents, line.feeCategory, line.feeRateBps, line.split || null])
        .sort((a, b) => a[0].localeCompare(b[0]))]);
    return { ...incrementalBilling(existing, additions, { feePolicy: batch.feePolicy }), feePolicyVersion: feePolicyVersion(batch), feeQuoteVersion: quoteVersion,
      quoteExpired: false,
      pendingSplit: additions.some(line => line.snapshot.split),
      pendingGoodsCents: addCents(additions.filter(line => line.snapshot.split).map(line => line.amountCents)),
      pendingQuantity: additions.filter(line => line.snapshot.split).reduce((sum, line) => sum + line.quantity, 0) };
  }
  submit(inputBatch, input, { customerProducts = new Map(), ownerHash = null } = {}) {
    const payload = this.normalizeOrder(input);
    const hash = payloadHash(payload);
    return this.store.transaction(() => {
      const batch = this.getBatch(inputBatch);
      const existing = this.store.getSubmission(batch.code, payload.submissionId);
      if (existing) {
        if (existing.customerHash && existing.customerHash !== ownerHash) throw new DomainError(403, 'CUSTOMER_TOKEN_MISMATCH', '请在原下单浏览器核对这次提交。');
        const withoutFeeVersion = value => { const { feePolicyVersion: ignored, feeQuoteVersion: ignoredQuote, ...business } = value; return business; };
        if (existing.payload ? payloadHash(withoutFeeVersion(existing.payload)) !== payloadHash(withoutFeeVersion(payload)) : existing.payloadHash !== hash) {
          throw new DomainError(409, 'SUBMISSION_CONFLICT', '此提交编号已用于另一份订单，请重新确认后提交。');
        }
        return receipt(payload.submissionId);
      }
      const { products, personalIds } = this.prepareOrder(batch, payload, { customerProducts, ownerHash });
      this.requireFeeQuote(batch, payload, { customerProducts, ownerHash });
      if (payload.feeQuoteVersion) {
        const expected = this.quote(batch, { items: payload.items, phone: payload.phone,
          ...(payload.feePolicyVersion ? { feePolicyVersion: payload.feePolicyVersion } : {}) }, { customerProducts, ownerHash });
        if (expected.feeQuoteVersion !== payload.feeQuoteVersion) throw new DomainError(409, 'FEE_QUOTE_CHANGED', '本期订单或预计费用已变化，请重新核对金额后提交。');
      }
      const submittedAt = this.now().toISOString();
      const lines = payload.items.map(item => {
        const personal = personalIds.includes(item.productId);
        const product = products.get(item.productId);
        if (personal && !this.store.getProduct(product.id)) this.store.addCustomerCatalogProduct(product, submittedAt);
        return { ...item, snapshot: this.snapshotProduct(batch, product, personal) };
      });
      this.store.saveSubmission(batch.code, payload, { hash, submittedAt, lines, customerHash: personalIds.length ? ownerHash : null });
      return receipt(payload.submissionId);
    });
  }
  getSubmission(inputBatch, id) {
    if (!UUID.test(id ?? '')) throw new DomainError(400, 'INVALID_SUBMISSION_ID', '提交编号无效。');
    const batch = this.getBatch(inputBatch);
    const submission = this.store.getSubmission(batch.code, id.toLowerCase());
    if (!submission) throw new DomainError(404, 'SUBMISSION_NOT_FOUND', '未找到这次提交。');
    return receipt(submission.submissionId);
  }
  enrichedLines(batch) {
    return this.store.listExportLines(batch.code).map(line => ({ ...line, imageUrl: imageUrl(batch, line.productId, line.product) }));
  }
  completedLines(lines) {
    const groups = new Map();
    for (const line of lines) {
      if (!groups.has(line.submissionId)) groups.set(line.submissionId, []);
      groups.get(line.submissionId).push(line);
    }
    return { complete: [...groups.values()].filter(completeGroup).flat(),
      pending: [...groups.values()].filter(group => !completeGroup(group)).length,
      count: [...groups.values()].filter(completeGroup).length };
  }
  queryOrders(inputBatch, inputPhone) {
    const batch = this.getBatch(inputBatch);
    const phone = normalizePhone(inputPhone);
    const result = this.completedLines(this.enrichedLines(batch).filter(line => line.phone === phone));
    const products = aggregateProducts(result.complete);
    return { phone, products, ...billingSummary(result.complete), ...pendingSplitSummary(result.complete), feePolicyVersion: feePolicyVersion(batch), pendingCount: result.pending,
      hasOrders: products.length > 0, contactNote: batch.contactNote };
  }
  overview() {
    const source = this.store.getMeta('exportSource');
    const batches = this.store.listBatches();
    const products = this.store.listProducts();
    const retainedProducts = this.store.listProducts({ includeRemoved: true });
    const removedProducts = retainedProducts.filter(product => product.removedAt);
    const backup = this.productBackup();
    const backedUp = retainedProducts.filter(product => this.productBackupStatus(product, backup).backupStatus === 'backed_up').length;
    const counts = { total: retainedProducts.length, onSale: products.filter(product => product.onSale).length,
      offSale: retainedProducts.filter(product => !product.onSale).length, backedUp, pending: retainedProducts.length - backedUp,
      removed: removedProducts.length, removedPending: removedProducts.filter(product => this.productBackupStatus(product, backup).backupStatus !== 'backed_up').length,
      retained: products.length + removedProducts.length };
    const productSync = {
      mode: 'local', lastSyncedAt: backup.meta?.lastSyncedAt || null,
      status: backup.meta?.status || 'never', counts, pending: counts.pending,
      error: backup.meta?.error || null, result: { ...counts },
      backup: { configured: backup.configured, status: backup.meta?.status || 'never',
        lastSyncedAt: backup.meta?.lastSyncedAt || null, counts: backup.meta?.counts || null,
        error: backup.meta?.error || null, pending: counts.pending },
    };
    const ordersSync = Object.fromEntries(batches.map(batch => {
      const meta = this.store.getMeta(`feishu-export:${batch.code}`);
      const binding = source?.baseToken && this.store.getCommunityOrderTable(source.baseToken, batch.communityId);
      const configured = Boolean(source?.baseToken && source.productTableId && source.orderTableId);
      const status = !configured ? 'unconfigured' : binding?.status === 'ready' && binding.tableId ? 'ready'
        : ['pending', 'error'].includes(binding?.status) ? binding.status : 'pending';
      let tableUrl = null;
      if (binding?.tableId && source?.feishuUrl) {
        try { const url = new URL(source.feishuUrl); url.searchParams.set('table', binding.tableId); url.searchParams.delete('view'); tableUrl = url.toString(); } catch {}
      }
      const groupTable = { status, tableId: binding?.tableId || null, tableName: binding?.tableName || null, url: tableUrl,
        ...(binding?.error ? { error: binding.error } : {}) };
      const current = status === 'ready' && meta?.scope === 'community'
        && meta.destination?.baseToken === source?.baseToken && meta.destination?.orderTableId === binding.tableId;
      return [batch.code, {
        lastSyncedAt: meta?.lastSyncedAt || null, status: meta?.status || 'never',
        counts: meta?.counts || null, error: meta?.error || null,
        viewUrl: current ? meta?.viewUrl || null : null,
        legacyViewUrl: meta?.legacyViewUrl || (!current ? meta?.viewUrl || null : null), groupTable,
        pending: this.store.listExportLines(batch.code, { onlyDirty: true }).length,
      }];
    }));
    return {
      defaultBatch: batches.some(batch => batch.code === this.store.getMeta('defaultBatch')) ? this.store.getMeta('defaultBatch') : batches[0]?.code || null,
      feishuUrl: source?.feishuUrl || batches[0]?.feishuUrl || null,
      productCount: products.length, removedProductCount: removedProducts.length, communities: this.store.listCommunities(),
      batches: batches.map(batch => this.safeBatch(batch)),
      deletedBatches: this.store.listBatches({ includeDeleted: true }).filter(batch => batch.deletedAt).map(batch => this.safeBatch(batch)),
      productSync, ordersSync, lastProductSyncAt: productSync.lastSyncedAt,
      dirtyCount: batches.reduce((sum, batch) => sum + this.store.listExportLines(batch.code, { onlyDirty: true }).length, 0),
    };
  }
  listProducts() {
    const batch = this.store.listBatches()[0] || { imageUrlTemplate: '/images/{id}/cover.svg' };
    const backup = this.productBackup();
    const products = this.store.listProducts({ includeRemoved: true });
    const view = product => productView(product, batch, true, this.productBackupStatus(product, backup));
    return { products: products.filter(product => !product.removedAt).map(view), removedProducts: products.filter(product => product.removedAt).map(view) };
  }
  productBackup() {
    const source = this.store.getMeta('exportSource');
    const configured = Boolean(source?.baseToken && source.productTableId);
    const destination = configured ? `${source.baseToken}:${source.productTableId}` : null;
    const stored = this.store.getMeta('feishu-product-backup');
    return { configured, meta: destination && stored?.destination === destination ? stored : null };
  }
  productBackupStatus(product, backup = this.productBackup()) {
    const record = backup.meta?.records?.[product.id];
    return { backupStatus: record?.revision === product.revision && !record.pendingCreate ? 'backed_up' : 'pending',
      lastBackedUpAt: record?.lastBackedUpAt || null };
  }
  adminProductView(product) {
    const batch = this.store.listBatches()[0] || { imageUrlTemplate: '/images/{id}/cover.svg' };
    return productView(product, batch, true, this.productBackupStatus(product));
  }
  selectProducts(products) {
    const result = this.store.selectProducts(products, { timestamp: this.now().toISOString() });
    return { ...result, products: result.products.map(product => this.adminProductView(product)) };
  }
  updateProduct(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError(400, 'INVALID_PRODUCT_FIELDS', '请填写有效商品资料。');
    const { expectedRevision, sourcePricePreviewId, ...patch } = input;
    const sourcePriceSnapshot = sourcePricePreviewId === undefined ? undefined
      : this.productPricing.sourceSnapshot(id, sourcePricePreviewId, patch, expectedRevision);
    return { product: this.adminProductView(this.store.updateProduct(id, patch,
      { timestamp: this.now().toISOString(), expectedRevision, sourcePriceSnapshot })) };
  }
  previewProductPricing(input) { return this.productPricing.preview(input); }
  applyProductPricing(input) {
    const result = this.productPricing.apply(input, this.now().toISOString());
    return { ...result, products: result.products.map(product => this.adminProductView(product)) };
  }
  sourceProductPrice(id) { return this.productPricing.sourcePrice(id); }
  updateProductStatus(input) {
    const result = this.store.updateProductStatus(input, { timestamp: this.now().toISOString() });
    return { ...result, products: result.products.map(product => this.adminProductView(product)) };
  }
  mutateProductVisibility(work) {
    return this.store.transaction(() => {
      if (this.productMutationBusy()) throw new DomainError(409, 'PRODUCT_BACKUP_BUSY', '正在备份商品或保存飞书配置，请完成后再移除或恢复。');
      return work();
    });
  }
  removeProducts(input) {
    return this.mutateProductVisibility(() => {
      const result = this.store.removeProducts(input, { timestamp: this.now().toISOString() });
      return { ...result, products: result.products.map(product => this.adminProductView(product)) };
    });
  }
  removeProduct(id, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new DomainError(400, 'INVALID_PRODUCT_REMOVE', '移除商品无需填写其他资料。');
    const result = this.removeProducts({ productIds: [id] });
    return { product: result.products[0], removed: true };
  }
  restoreProduct(id, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new DomainError(400, 'INVALID_PRODUCT_REMOVE', '恢复商品无需填写其他资料。');
    return this.mutateProductVisibility(() => ({ product: this.adminProductView(this.store.restoreProduct(id,
      { timestamp: this.now().toISOString() })), restored: true }));
  }
  createCommunity(input) {
    return { community: this.store.createCommunity({ name: input?.name, createdAt: this.now().toISOString() }) };
  }
  normalizeBatchFields(input, partial = false) {
    const output = {};
    if (!partial || Object.hasOwn(input, 'feePolicy')) output.feePolicy = normalizeFeePolicy(input.feePolicy);
    if (!partial || Object.hasOwn(input, 'splitRules')) output.splitRules = normalizeSplitRules(input.splitRules);
    const strings = { title: [120, '标题'], description: [1000, '说明'], pickupLocation: [200, '取货地点'], contactNote: [500, '联系说明'] };
    for (const [key, [limit, label]] of Object.entries(strings)) {
      if (!partial || Object.hasOwn(input, key)) output[key] = trimmed(input[key], limit, label);
    }
    for (const [key, label] of [['cutoffAt', '截单时间'], ['pickupAt', '取货时间']]) {
      if (!partial || Object.hasOwn(input, key)) output[key] = datetime(input[key], label);
    }
    if (!partial || Object.hasOwn(input, 'collecting')) {
      if (input.collecting !== undefined && typeof input.collecting !== 'boolean') throw new DomainError(400, 'INVALID_COLLECTING', '收集开关必须为布尔值。');
      output.collecting = input.collecting ?? true;
    }
    if (Object.hasOwn(input, 'productIds')) {
      if (!Array.isArray(input.productIds) || input.productIds.length > 200 || new Set(input.productIds).size !== input.productIds.length
        || input.productIds.some(id => typeof id !== 'string' || !PRODUCT_ID.test(id))) throw new DomainError(400, 'INVALID_PRODUCTS', '本期商品编号列表无效或重复。');
      output.productIds = [...input.productIds].sort();
    }
    if (Object.hasOwn(input, 'samsStore')) {
      const value = input.samsStore;
      if (value === null) output.samsStore = null;
      else {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !/^\d{6}$/.test(value.cityCode)
          || typeof value.storeId !== 'string' || !/^\d{1,12}$/.test(value.storeId) || ![2, 4, 8, 256].includes(value.storeType)
          || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200
          || typeof value.cityName !== 'string' || !value.cityName.trim() || value.cityName.length > 100) {
          throw new DomainError(400, 'INVALID_SAMS_STORE', '请选择有效的本期采购门店。');
        }
        output.samsStore = { cityCode: value.cityCode, storeId: value.storeId, storeType: value.storeType,
          name: value.name.trim(), cityName: value.cityName.trim() };
      }
    }
    return output;
  }
  createBatch(input) {
    if (!input || !UUID.test(input.requestId ?? '')) throw new DomainError(400, 'INVALID_REQUEST_ID', '创建请求编号无效。');
    const allowed = [...BATCH_FIELDS, 'requestId', 'communityId', 'communityName'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new DomainError(400, 'INVALID_BATCH_FIELDS', '期数由系统自动生成。');
    const fields = this.normalizeBatchFields(input);
    const communityName = input.communityName == null ? '' : trimmed(input.communityName, 80, '小区或群名称', true).replace(/\s+/g, ' ');
    const communityId = input.communityId == null ? null : trimmed(input.communityId, 100, '小区编号', true);
    if (!communityId && !communityName) throw new DomainError(400, 'INVALID_COMMUNITY', '请选择或填写小区、群名称。');
    const requestId = input.requestId.toLowerCase();
    const hash = payloadHash({ communityId, communityName, ...fields });
    return this.store.transaction(() => {
      const existing = this.store.getBatchByRequest(requestId);
      if (existing) {
        if (existing.deletedAt) throw new DomainError(409, 'BATCH_REQUEST_DELETED', '该期次已删除，请从已删除期次恢复，不能重复创建。');
        const { splitRules: ignoredSplitRules, ...beforeSplitFields } = fields;
        const beforeSplitHash = payloadHash({ communityId, communityName, ...beforeSplitFields });
        const { feePolicy: ignoredFeePolicy, ...legacyFields } = beforeSplitFields;
        const legacyHash = payloadHash({ communityId, communityName, ...legacyFields });
        const free = fields.feePolicy.recommendedRateBps === 0 && (fields.feePolicy.selfSelectedRateBps ?? 0) === 0;
        if (existing.requestHash !== hash && !(Object.keys(fields.splitRules).length === 0 &&
          (existing.requestHash === beforeSplitHash || free && existing.requestHash === legacyHash))) throw new DomainError(409, 'BATCH_REQUEST_CONFLICT', '该创建编号已用于另一份团购。');
        return { batch: this.safeBatch(existing) };
      }
      const community = communityId ? this.store.getCommunity(communityId) : this.store.createCommunity({ name: communityName, createdAt: this.now().toISOString() });
      if (!community || (communityName && community.name !== communityName)) throw new DomainError(404, 'COMMUNITY_NOT_FOUND', '未找到这个小区或群。');
      const products = this.store.listProducts();
      const selected = fields.productIds ?? products.filter(product => product.onSale).map(product => product.id);
      if (selected.some(id => !products.some(product => product.id === id))) throw new DomainError(400, 'INVALID_PRODUCTS', '本期选择了商品库中不存在的商品。');
      if (selected.length > 200) throw new DomainError(400, 'TOO_MANY_PRODUCTS', '一期最多选择 200 种商品。');
      this.validateSplitRulesForBatch({ productIds: selected, splitRules: fields.splitRules });
      if (!selected.length) throw new DomainError(400, 'NO_PRODUCTS', '商品库没有可售商品，请先从山姆查询选品入库，核对后上架。');
      const source = this.store.getMeta('exportSource');
      const batch = this.store.createBatch({ ...fields, productIds: selected, communityId: community.id,
        requestId, requestHash: hash, createdAt: this.now().toISOString(),
        imageUrlTemplate: source?.imageUrlTemplate, feishuUrl: source?.feishuUrl,
      });
      return { batch: this.safeBatch(batch) };
    });
  }
  validateSplitRulesForBatch(batch, previous = null) {
    const rules = normalizeSplitRules(batch.splitRules);
    if (Object.keys(rules).some(id => !batch.productIds.includes(id) || !this.store.getProduct(id))) {
      throw new DomainError(400, 'INVALID_SPLIT_RULES', '拼份商品必须属于本期选品。');
    }
    for (const id of Object.keys(rules)) {
      const product = this.store.getProduct(id);
      if (batch.productIds.some(otherId => otherId !== id && sameSourceProduct(product, this.store.getProduct(otherId)))) {
        throw new DomainError(400, 'INVALID_SPLIT_RULES', '本期同门店同款拼份商品只能保留一个商品编号，请取消重复选品。');
      }
    }
    if (previous) {
      for (const id of this.splitLockedProductIds({ ...previous, productIds: [...new Set([...previous.productIds, ...batch.productIds])] })) {
        const old = previous.splitRules?.[id]; const next = rules[id];
        if (Boolean(old) !== Boolean(next) || old && (old.partsPerPack !== next.partsPerPack || old.portionSpec !== next.portionSpec)) {
          throw new DomainError(409, 'SPLIT_RULE_LOCKED', '该商品已有订单，不能切换整包与拼份、拆分份数或每份规格。');
        }
      }
    }
  }
  updateBatch(code, input) {
    if (!input || Object.keys(input).some(key => !BATCH_FIELDS.includes(key))) throw new DomainError(400, 'INVALID_BATCH_FIELDS', '小区归属和期数不能修改。');
    const patch = this.normalizeBatchFields(input, true);
    if (patch.title === '') throw new DomainError(400, 'INVALID_TITLE', '团购标题不能为空。');
    return this.store.transaction(() => {
      const previous = this.getBatch(code);
      this.validateSplitRulesForBatch({ ...previous, ...patch }, previous);
      if (patch.productIds?.some(id => !this.store.getProduct(id) || this.store.getProduct(id).removedAt && !previous.productIds.includes(id))) {
        throw new DomainError(400, 'INVALID_PRODUCTS', '本期不能新增已移除或不存在的商品，原有历史关联可保留。');
      }
      return { batch: this.safeBatch(this.store.updateBatch(code, patch)) };
    });
  }
  mutateBatchVisibility(code, input, restore = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
      throw new DomainError(400, 'INVALID_BATCH_DELETE', '删除或恢复期次无需填写其他资料。');
    }
    return this.store.transaction(() => {
      if (this.batchMutationBusy(code)) throw new DomainError(409, 'BATCH_SYNC_BUSY', '本期订单正在同步或飞书配置正在保存，请完成后再删除或恢复。');
      const now = this.now();
      const batch = restore ? this.store.restoreBatch(code)
        : this.store.deleteBatch(code, { now: now.getTime(), timestamp: now.toISOString() });
      return { batch: this.safeBatch(batch), ...(restore ? { restored: true } : { deleted: true }) };
    });
  }
  deleteBatch(code, input = {}) { return this.mutateBatchVisibility(code, input); }
  restoreBatch(code, input = {}) { return this.mutateBatchVisibility(code, input, true); }
  orderView(line) {
    return {
      recordId: line.recordId, batchCode: line.batchCode, communityName: line.communityName,
      periodNumber: line.periodNumber, periodLabel: line.periodLabel,
      submissionId: line.submissionId, lineId: line.lineId, phone: line.phone, name: line.name,
      productId: line.productId, productName: line.productName, spec: line.spec, unit: line.unit,
      imageUrl: line.imageUrl, quantity: line.quantity, status: line.status, priceCents: line.priceCents,
      amountCents: line.amountCents, submittedAt: line.submittedAt, note: line.note,
      revision: line.revision, syncedRevision: line.syncedRevision, remoteRecordId: line.remoteRecordId, syncError: line.syncError,
      selfSelected: line.selfSelected, feeCategory: line.feeCategory, feeRateBps: line.feeRateBps,
      feeCents: line.feeCents, payableCents: line.payableCents,
      ...(line.split ? { split: line.split, pendingGoodsCents: line.pendingGoodsCents, pendingQuantity: line.pendingQuantity } : {}),
    };
  }
  getStats(codes = []) {
    if (!Array.isArray(codes) || codes.some(code => typeof code !== 'string')) throw new DomainError(400, 'INVALID_BATCH_CODES', '团购编号列表无效。');
    const selected = codes.length ? [...new Set(codes)].map(code => this.getBatch(code)) : this.store.listBatches();
    const all = selected.map(batch => ({ batch, lines: this.enrichedLines(batch) }));
    const complete = all.map(({ batch, lines }) => ({ batch, ...this.completedLines(lines) }));
    const orders = complete.flatMap(group => group.complete);
    const purchase = new Map();
    const customers = new Map();
    for (const line of orders) {
      if (!line.split && !EXCLUDED.has(line.status) && line.quantity > 0) {
        if (!purchase.has(line.productId)) purchase.set(line.productId, {
          id: line.productId, name: line.productName, spec: line.spec, unit: line.unit,
          description: productDescription(line.product),
          priceCents: line.priceCents, priceSource: 'sale_fallback', imageUrl: line.imageUrl, quantity: 0, amountCents: 0, byBatch: [], selfSelected: line.selfSelected,
        });
        const product = purchase.get(line.productId);
        if (product.priceCents !== line.priceCents) product.mixedPrices = true;
        product.selfSelected ||= line.selfSelected;
        product.quantity += line.quantity;
        product.amountCents = addCents([product.amountCents, line.amountCents]);
        let part = product.byBatch.find(value => value.code === line.batchCode);
        if (!part) { part = { code: line.batchCode, communityName: line.communityName, periodLabel: line.periodLabel, quantity: 0 }; product.byBatch.push(part); }
        part.quantity += line.quantity;
      }
      const key = JSON.stringify([line.batchCode, line.phone]);
      if (!customers.has(key)) customers.set(key, { key, phone: line.phone, name: line.name,
        communityName: line.communityName, batchCodes: [], periodLabels: [], lines: [] });
      const customer = customers.get(key);
      if (!customer.batchCodes.includes(line.batchCode)) customer.batchCodes.push(line.batchCode);
      if (!customer.periodLabels.includes(line.periodLabel)) customer.periodLabels.push(line.periodLabel);
      customer.lines.push(line);
    }
    const splitGroups = selected.flatMap(batch => this.getSplitGroups(batch));
    for (const group of splitGroups.filter(group => group.progress.purchasedPacks > 0)) {
      if (!purchase.has(group.productId)) purchase.set(group.productId, {
        id: group.productId, name: group.productName, spec: group.packSpec, unit: group.packUnit,
        priceCents: group.packPriceCents, priceSource: group.packPriceSource || 'sale_fallback', imageUrl: group.imageUrl, quantity: 0, amountCents: 0, byBatch: [], selfSelected: false,
      });
      const product = purchase.get(group.productId);
      product.split = true;
      if (product.priceSource !== (group.packPriceSource || 'sale_fallback')) product.priceSource = 'sale_fallback';
      if (product.priceCents !== group.packPriceCents) product.mixedPrices = true;
      product.quantity += group.progress.purchasedPacks;
      product.amountCents = addCents([product.amountCents, splitAmount(group.packPriceCents, group.progress.purchasedPacks)]);
      product.procurementReferenceCents = product.amountCents;
      product.byBatch.push({ code: group.batchCode, communityName: group.communityName, periodLabel: group.periodLabel,
        quantity: group.progress.purchasedPacks, split: true });
    }
    const products = [...purchase.values()];
    return {
      batches: selected.map(batch => this.safeBatch(batch)), products,
      customers: [...customers.values()].map(({ lines, ...customer }) => {
        const items = aggregateProducts(lines);
        return { ...customer, products: items, ...billingSummary(lines), ...pendingSplitSummary(lines) };
      }),
      orders: orders.map(line => this.orderView(line)), ...billingSummary(orders), ...pendingSplitSummary(orders), splitGroups,
      pendingSubmissions: complete.reduce((sum, group) => sum + group.pending, 0),
      orderCount: complete.reduce((sum, group) => sum + group.count, 0),
      dirtyCount: selected.reduce((sum, batch) => sum + this.store.listExportLines(batch.code, { onlyDirty: true }).length, 0),
    };
  }
  getSplitGroups(inputBatch) {
    const batch = this.getBatch(inputBatch);
    const allLines = this.enrichedLines(batch);
    return Object.entries(batch.splitRules || {}).map(([productId, rule]) => {
      const lines = allLines.filter(line => line.productId === productId && line.split).sort((a, b) =>
        a.submittedAt.localeCompare(b.submittedAt) || a.lineId.localeCompare(b.lineId));
      const original = this.store.getProduct(productId);
      const pack = lines[0]?.snapshot.split || packSnapshot(original, rule);
      const settlement = this.store.getSplitSettlement(batch.code, productId);
      return { batchCode: batch.code, communityName: batch.communityName, periodLabel: batch.periodLabel,
        productId, productName: pack.packProductName, imageUrl: imageUrl(batch, productId, original),
        ...pack, priceCents: rule.priceCents, progress: splitProgress(rule, lines, settlement),
        canConfirm: !settlement && !this.safeBatch(batch).collecting,
        settledAt: settlement?.settledAt || null, remainderPolicy: settlement?.remainderPolicy || null,
        customers: lines.map(line => ({ lineId: line.lineId, recordId: line.recordId, phone: line.phone, name: line.name,
          quantity: line.quantity, status: line.status, priceCents: line.priceCents, amountCents: line.amountCents,
          feeCents: line.feeCents, payableCents: line.payableCents, pendingGoodsCents: line.pendingGoodsCents,
          formedQuantity: line.split.formedQuantity, pendingQuantity: line.split.pendingQuantity, unformedQuantity: line.split.unformedQuantity })) };
    });
  }
  confirmSplit(code, productId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'remainderPolicy')
      || !['cancel', 'topUp'].includes(input.remainderPolicy)) throw new DomainError(400, 'INVALID_SPLIT_CONFIRM', '请选择余份未成团或由团长补齐。');
    return this.store.transaction(() => {
      const batch = this.getBatch(code);
      const rule = batch.splitRules?.[productId];
      if (!rule) throw new DomainError(404, 'SPLIT_NOT_FOUND', '本期未找到该拼份商品。');
      const settled = this.store.getSplitSettlement(code, productId);
      if (settled) {
        if (settled.remainderPolicy !== input.remainderPolicy) throw new DomainError(409, 'SPLIT_ALREADY_CONFIRMED', '该商品已确认采购，不能更改成团处理。');
        return { group: this.getSplitGroups(batch).find(group => group.productId === productId) };
      }
      if (this.safeBatch(batch).collecting) throw new DomainError(409, 'SPLIT_CONFIRM_OPEN', '请先结束本期收集，再确认拼份采购。');
      const lines = this.store.listOrderLines(code).filter(line => line.productId === productId && line.snapshot?.split);
      const complete = this.completedLines(this.store.listOrderLines(code)).complete;
      if (lines.some(line => !complete.some(valid => valid.lineId === line.lineId))) throw new DomainError(409, 'ORDER_INCOMPLETE', '本期存在不完整订单，请核对后确认拼份。');
      this.store.saveSplitSettlement(code, productId, allocateSplit(lines, rule.partsPerPack, input.remainderPolicy, this.now().toISOString()));
      return { group: this.getSplitGroups(batch).find(group => group.productId === productId) };
    });
  }
  updateOrder(code, id, input) {
    if (!input || !Object.keys(input).length || Object.keys(input).some(key => !['quantity', 'status'].includes(key))) {
      throw new DomainError(400, 'INVALID_ORDER_UPDATE', '只能修改数量或处理状态。');
    }
    return this.store.transaction(() => {
      const batch = this.getBatch(code);
      const target = this.enrichedLines(batch).find(line => line.recordId === String(id) || line.lineId === id);
      if (!target) throw new DomainError(404, 'ORDER_NOT_FOUND', '本期未找到该订单明细。');
      const group = this.store.listOrderLines(code, { submissionId: target.submissionId });
      if (!completeGroup(group)) throw new DomainError(409, 'ORDER_INCOMPLETE', '整单明细不完整，暂时不能修改。');
      this.store.updateOrder(code, target.recordId, input);
      return { order: this.orderView(this.enrichedLines(batch).find(line => line.recordId === target.recordId)) };
    });
  }
}
