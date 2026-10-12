import { DomainError, normalizePhone, completeGroup } from './order-service.js';
import { ORDER_STATUSES, productVersion, payloadHash } from './local-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;
const EXCLUDED = new Set(['已取消', '缺货']);
const BATCH_FIELDS = ['title', 'description', 'productIds', 'collecting', 'cutoffAt', 'pickupLocation', 'pickupAt', 'contactNote'];

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
function imageUrl(batch, id) {
  const template = process.env.IMAGE_URL_TEMPLATE || batch.imageUrlTemplate || '/images/{id}/cover.svg';
  if (!template.includes('{id}') || (!/^https?:\/\//i.test(template)
    && (!template.startsWith('/') || template.startsWith('//')))) return '/images/placeholder.svg';
  return template.replaceAll('{id}', encodeURIComponent(id));
}
function productView(product, batch, admin = false) {
  return {
    id: product.id, name: product.name, spec: product.spec, unit: product.unit,
    priceCents: product.priceCents, category: product.category, onSale: product.onSale, sort: product.sort,
    imageUrl: imageUrl(batch, product.id), version: productVersion(product),
    ...(admin ? { recordId: product.recordId, updatedAt: product.updatedAt } : {}),
  };
}
function sumAmount(items) {
  return items.some(item => item.amountCents === null) ? null : items.reduce((sum, item) => sum + item.amountCents, 0);
}
function aggregateProducts(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!groups.has(line.productId)) groups.set(line.productId, {
      id: line.productId, name: line.productName, spec: line.spec, unit: line.unit,
      imageUrl: line.imageUrl, priceCents: line.priceCents, quantity: 0, amountCents: 0,
      statuses: [], ...(line.priceCents === null ? { missing: true } : {}),
    });
    const product = groups.get(line.productId);
    product.quantity += line.quantity;
    let status = product.statuses.find(value => value.status === line.status);
    if (!status) { status = { status: line.status, quantity: 0 }; product.statuses.push(status); }
    status.quantity += line.quantity;
    if (line.amountCents === null) product.amountCents = null;
    else if (product.amountCents !== null) product.amountCents += line.amountCents;
  }
  return [...groups.values()].map(product => ({ ...product, statuses: product.statuses.sort(
    (a, b) => ORDER_STATUSES.indexOf(a.status) - ORDER_STATUSES.indexOf(b.status),
  ) }));
}

export class LocalService {
  constructor({ store, now = () => new Date() }) { this.store = store; this.now = now; }

  getBatch(input) {
    const code = typeof input === 'string' ? input : input?.code;
    const batch = this.store.getBatch(code || this.store.getMeta('defaultBatch'));
    if (!batch) throw new DomainError(404, 'BATCH_NOT_FOUND', '本期收集链接不存在。');
    return batch;
  }
  safeBatch(batch) {
    const collecting = batch.collecting && (!batch.cutoffAt || Date.parse(batch.cutoffAt) > this.now().getTime());
    return {
      code: batch.code, title: batch.title, description: batch.description,
      communityId: batch.communityId, communityName: batch.communityName,
      periodNumber: batch.periodNumber, periodLabel: batch.periodLabel,
      collecting, collectionEnabled: batch.collecting,
      cutoffAt: batch.cutoffAt, productIds: batch.productIds,
      pickupLocation: batch.pickupLocation, pickupAt: batch.pickupAt, contactNote: batch.contactNote,
      createdAt: batch.createdAt, managed: true, customerUrl: `/b/${batch.code}`,
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
      communityName, periodNumber, periodLabel, pickupLocation, pickupAt }, products: this.store.listProducts()
      .filter(product => allProducts || selected.has(product.id)).map(product => productView(product, batch)) };
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
    return { submissionId: input.submissionId.toLowerCase(), phone, name, note, items };
  }
  submit(inputBatch, input) {
    const payload = this.normalizeOrder(input);
    const hash = payloadHash(payload);
    return this.store.transaction(() => {
      const batch = this.getBatch(inputBatch);
      const existing = this.store.getSubmission(batch.code, payload.submissionId);
      if (existing) {
        if (existing.payloadHash !== hash) throw new DomainError(409, 'SUBMISSION_CONFLICT', '此提交编号已用于另一份订单，请重新确认后提交。');
        return receipt(payload.submissionId);
      }
      const catalog = this.getCatalog(batch);
      if (!catalog.batch.collecting) throw new DomainError(409, 'COLLECTION_CLOSED', '本期已停止收集，仍可查询已提交订单。');
      const products = new Map(catalog.products.map(product => [product.id, product]));
      const changed = payload.items.filter(item => !products.get(item.productId)?.onSale || products.get(item.productId)?.version !== item.version);
      if (changed.length) throw new DomainError(409, 'PRODUCT_CHANGED', '商品价格、规格或在售状态已变化，请重新确认。', {
        productIds: changed.map(item => item.productId), catalog,
      });
      this.store.saveSubmission(batch.code, payload, { hash, submittedAt: this.now().toISOString() });
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
    return this.store.listExportLines(batch.code).map(line => ({ ...line, imageUrl: imageUrl(batch, line.productId) }));
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
    return { phone, products, totalCents: sumAmount(products), pendingCount: result.pending,
      hasOrders: products.length > 0, contactNote: batch.contactNote };
  }
  overview() {
    const source = this.store.getMeta('exportSource');
    const batches = this.store.listBatches();
    const imported = this.store.getMeta('productSync');
    const productMeta = this.store.getMeta('feishu-products') || imported;
    const counts = productMeta?.counts || (imported ? { total: imported.total,
      added: imported.added, updated: imported.updated, offSale: imported.offSale } : null);
    const productSync = {
      lastSyncedAt: productMeta?.lastSyncedAt || null,
      status: productMeta?.status === 'error' ? 'failed' : productMeta?.status || (imported ? 'success' : 'never'),
      counts, error: productMeta?.error || null,
      result: counts ? { ...counts, created: counts.added } : null,
    };
    const ordersSync = Object.fromEntries(batches.map(batch => {
      const meta = this.store.getMeta(`feishu-export:${batch.code}`);
      return [batch.code, {
        lastSyncedAt: meta?.lastSyncedAt || null, status: meta?.status || 'never',
        counts: meta?.counts || null, error: meta?.error || null, viewUrl: meta?.viewUrl || null,
        pending: this.store.listExportLines(batch.code, { onlyDirty: true }).length,
      }];
    }));
    return {
      defaultBatch: this.store.getMeta('defaultBatch'), feishuUrl: source?.feishuUrl || batches[0]?.feishuUrl || null,
      productCount: this.store.listProducts().length, communities: this.store.listCommunities(),
      batches: batches.map(batch => this.safeBatch(batch)),
      productSync, ordersSync, lastProductSyncAt: productSync.lastSyncedAt,
      dirtyCount: batches.reduce((sum, batch) => sum + this.store.listExportLines(batch.code, { onlyDirty: true }).length, 0),
    };
  }
  listProducts() {
    const batch = this.store.listBatches()[0] || { imageUrlTemplate: '/images/{id}/cover.svg' };
    return { products: this.store.listProducts().map(product => productView(product, batch, true)) };
  }
  createCommunity(input) {
    return { community: this.store.createCommunity({ name: input?.name, createdAt: this.now().toISOString() }) };
  }
  normalizeBatchFields(input, partial = false) {
    const output = {};
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
        if (existing.requestHash !== hash) throw new DomainError(409, 'BATCH_REQUEST_CONFLICT', '该创建编号已用于另一份团购。');
        return { batch: this.safeBatch(existing) };
      }
      const community = communityId ? this.store.getCommunity(communityId) : this.store.createCommunity({ name: communityName, createdAt: this.now().toISOString() });
      if (!community || (communityName && community.name !== communityName)) throw new DomainError(404, 'COMMUNITY_NOT_FOUND', '未找到这个小区或群。');
      const products = this.store.listProducts();
      const selected = fields.productIds ?? products.filter(product => product.onSale).map(product => product.id);
      if (selected.some(id => !products.some(product => product.id === id))) throw new DomainError(400, 'INVALID_PRODUCTS', '本期选择了商品库中不存在的商品。');
      if (selected.length > 200) throw new DomainError(400, 'TOO_MANY_PRODUCTS', '一期最多选择 200 种商品。');
      if (!selected.length) throw new DomainError(400, 'NO_PRODUCTS', '商品库没有可售商品，请先从飞书同步商品。');
      const source = this.store.getMeta('exportSource');
      const batch = this.store.createBatch({ ...fields, productIds: selected, communityId: community.id,
        requestId, requestHash: hash, createdAt: this.now().toISOString(),
        imageUrlTemplate: source?.imageUrlTemplate, feishuUrl: source?.feishuUrl,
      });
      return { batch: this.safeBatch(batch) };
    });
  }
  updateBatch(code, input) {
    if (!input || Object.keys(input).some(key => !BATCH_FIELDS.includes(key))) throw new DomainError(400, 'INVALID_BATCH_FIELDS', '小区归属和期数不能修改。');
    const patch = this.normalizeBatchFields(input, true);
    if (patch.title === '') throw new DomainError(400, 'INVALID_TITLE', '团购标题不能为空。');
    return this.store.transaction(() => {
      this.getBatch(code);
      if (patch.productIds?.some(id => !this.store.getProduct(id))) throw new DomainError(400, 'INVALID_PRODUCTS', '本期选择了商品库中不存在的商品。');
      return { batch: this.safeBatch(this.store.updateBatch(code, patch)) };
    });
  }
  orderView(line) {
    return {
      recordId: line.recordId, batchCode: line.batchCode, communityName: line.communityName,
      periodNumber: line.periodNumber, periodLabel: line.periodLabel,
      submissionId: line.submissionId, lineId: line.lineId, phone: line.phone, name: line.name,
      productId: line.productId, productName: line.productName, spec: line.spec, unit: line.unit,
      imageUrl: line.imageUrl, quantity: line.quantity, status: line.status, priceCents: line.priceCents,
      amountCents: line.amountCents, submittedAt: line.submittedAt, note: line.note,
      revision: line.revision, syncedRevision: line.syncedRevision, remoteRecordId: line.remoteRecordId, syncError: line.syncError,
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
      if (!EXCLUDED.has(line.status) && line.quantity > 0) {
        if (!purchase.has(line.productId)) purchase.set(line.productId, {
          id: line.productId, name: line.productName, spec: line.spec, unit: line.unit,
          priceCents: line.priceCents, imageUrl: line.imageUrl, quantity: 0, amountCents: 0, byBatch: [],
        });
        const product = purchase.get(line.productId);
        product.quantity += line.quantity;
        product.amountCents = product.amountCents === null || line.amountCents === null ? null : product.amountCents + line.amountCents;
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
    const products = [...purchase.values()];
    return {
      batches: selected.map(batch => this.safeBatch(batch)), products,
      customers: [...customers.values()].map(({ lines, ...customer }) => {
        const items = aggregateProducts(lines);
        return { ...customer, products: items, totalCents: sumAmount(items) };
      }),
      orders: orders.map(line => this.orderView(line)), totalCents: sumAmount(products),
      pendingSubmissions: complete.reduce((sum, group) => sum + group.pending, 0),
      orderCount: complete.reduce((sum, group) => sum + group.count, 0),
      dirtyCount: all.reduce((sum, group) => sum + group.lines.filter(line => line.revision !== line.syncedRevision).length, 0),
    };
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
