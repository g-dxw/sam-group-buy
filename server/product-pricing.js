import { randomUUID } from 'node:crypto';
import { DomainError } from './order-service.js';

const MAX_PRICE = 100_000_000;
const TTL = 15 * 60_000;
const PRODUCT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;
export const validPrice = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_PRICE;
export function originalPrice(value) {
  if (value === null) return null;
  if (!validPrice(value)) throw new DomainError(400, 'INVALID_ORIGINAL_PRICE', '原价需为有效金额，可留空；最多为 100 万元。');
  return value;
}
export function normalizePricing(value = { mode: 'fixed', markupBps: null }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['fixed', 'markup', 'amount'].includes(value.mode)
    || Object.keys(value).some(key => !(value.mode === 'amount' ? ['mode', 'markupBps', 'amountCents'] : ['mode', 'markupBps']).includes(key))
    || (value.mode === 'markup' ? !Number.isInteger(value.markupBps) || value.markupBps < 0 || value.markupBps > 100_000
      : value.markupBps !== null)
    || (value.mode === 'amount' && !validPrice(value.amountCents))) {
    throw new DomainError(400, 'INVALID_PRICING', '请选择有效加价规则：比例为 0% 至 1000%，固定加价金额不得为负数，金额最多 100 万元。');
  }
  if (value.mode === 'amount') return { mode: 'amount', markupBps: null, amountCents: value.amountCents };
  return { mode: value.mode, markupBps: value.mode === 'fixed' ? null : value.markupBps };
}
export function sellingPrice(base, pricing, fixed) {
  if (pricing.mode === 'fixed') {
    if (!validPrice(fixed)) throw new DomainError(400, 'INVALID_SELLING_PRICE', '请填写有效固定售价，最多为 100 万元。');
    return fixed;
  }
  if (!validPrice(base)) throw new DomainError(400, 'ORIGINAL_PRICE_REQUIRED', '按比例或固定金额加价前需要先补全商品原价。');
  const result = pricing.mode === 'amount' ? BigInt(base) + BigInt(pricing.amountCents)
    : (BigInt(base) * BigInt(10_000 + pricing.markupBps) + 5_000n) / 10_000n;
  if (result > BigInt(MAX_PRICE)) throw new DomainError(400, 'SELLING_PRICE_TOO_LARGE', '加价后的售价超过 100 万元，请降低加价金额或比例。');
  return Number(result);
}
export function productPricing(product) {
  const base = originalPrice(product.originalPriceCents === undefined
    ? validPrice(product.source?.priceCents) ? product.source.priceCents : null : product.originalPriceCents);
  const pricing = normalizePricing(product.pricing);
  return { originalPriceCents: base, pricing, priceCents: sellingPrice(base, pricing, product.priceCents) };
}
export function pricingChanged(a, b) {
  return a.priceCents !== b.priceCents || a.originalPriceCents !== b.originalPriceCents
    || JSON.stringify(a.pricing) !== JSON.stringify(b.pricing);
}

// Previews are held only by this service instance. Applying a preview validates
// every revision in one database transaction before any product is changed.
export class ProductPricing {
  constructor({ store, now = Date.now, sams }) { this.store = store; this.now = now; this.sams = sams; this.previews = new Map(); }
  keep(value) {
    for (const [id, row] of this.previews) if (row.expiresAt <= this.now()) this.previews.delete(id);
    if (this.previews.size >= 500) throw new DomainError(429, 'PRICING_PREVIEW_LIMIT', '待确认调价较多，请完成后再试。');
    const previewId = randomUUID(); const expiresAt = this.now() + TTL;
    this.previews.set(previewId, { ...structuredClone(value), expiresAt });
    return { previewId, expiresAt: new Date(expiresAt).toISOString() };
  }
  get(id, type) {
    const entry = typeof id === 'string' && this.previews.get(id);
    if (!entry || entry.type !== type || entry.expiresAt <= this.now()) {
      throw new DomainError(409, 'PRICING_PREVIEW_EXPIRED', '调价预览已过期，请重新预览后确认。');
    }
    return entry;
  }
  preview(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['productIds', 'markupBps', 'pricing'].includes(key))
      || Object.hasOwn(input, 'pricing') === Object.hasOwn(input, 'markupBps')
      || !Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 200
      || new Set(input.productIds).size !== input.productIds.length
      || input.productIds.some(id => typeof id !== 'string' || !PRODUCT_ID.test(id))) {
      throw new DomainError(400, 'INVALID_PRICING_PRODUCTS', '请选择 1 至 200 种不重复商品进行调价。');
    }
    const pricing = normalizePricing(Object.hasOwn(input, 'pricing') ? input.pricing : { mode: 'markup', markupBps: input.markupBps });
    if (pricing.mode === 'fixed') throw new DomainError(400, 'INVALID_PRICING', '批量调价需选择按比例或固定金额加价，历史固定售价不支持批量覆盖。');
    const products = input.productIds.map(id => this.store.getProduct(id));
    const missing = input.productIds.filter((id, i) => !products[i]);
    if (missing.length) throw new DomainError(404, 'PRODUCT_NOT_FOUND', '部分商品不存在，请刷新后重新选择。', { productIds: missing });
    const removed = products.filter(product => product.removedAt).map(product => product.id);
    if (removed.length) throw new DomainError(409, 'PRODUCT_REMOVED', '已移除商品不能参与调价，请先恢复。', { productIds: removed });
    const noBase = products.filter(product => !validPrice(product.originalPriceCents)).map(product => product.id);
    if (noBase.length) throw new DomainError(400, 'ORIGINAL_PRICE_REQUIRED', '所选商品缺少原价，请补全后再批量调价。', { productIds: noBase });
    const rows = products.map(product => ({ id: product.id, name: product.name,
      originalPriceCents: product.originalPriceCents, previousPriceCents: product.priceCents,
      priceCents: sellingPrice(product.originalPriceCents, pricing), revision: product.revision }));
    const updated = products.filter((product, i) => pricingChanged(product, { ...product, pricing, priceCents: rows[i].priceCents })).length;
    return { ...this.keep({ type: 'bulk', rows, pricing }), rows, pricing, updated, unchanged: rows.length - updated };
  }
  apply(input, timestamp = new Date(this.now()).toISOString()) {
    if (!input || Object.keys(input).some(key => key !== 'previewId')) throw new DomainError(400, 'INVALID_PRICING_PREVIEW', '请确认已生成的调价预览。');
    const entry = this.get(input.previewId, 'bulk');
    const removed = entry.rows.filter(row => this.store.getProduct(row.id)?.removedAt).map(row => row.id);
    if (removed.length) throw new DomainError(409, 'PRODUCT_REMOVED', '预览中的商品已移除，调价预览失效。', { productIds: removed });
    if (entry.result) {
      const changed = entry.result.products.filter(product => this.store.getProduct(product.id)?.revision !== product.revision).map(product => product.id);
      if (changed.length) throw new DomainError(409, 'PRODUCT_REVISION_CONFLICT', '商品已变化，请重新预览。', { productIds: changed });
      return structuredClone(entry.result);
    }
    const result = this.store.transaction(() => {
      const changed = entry.rows.filter(row => this.store.getProduct(row.id)?.revision !== row.revision).map(row => row.id);
      if (changed.length) throw new DomainError(409, 'PRODUCT_REVISION_CONFLICT', '商品在预览后已修改，请重新预览。', { productIds: changed });
      let updated = 0;
      const products = entry.rows.map(row => {
        const product = this.store.updateProduct(row.id, { pricing: entry.pricing }, { expectedRevision: row.revision, timestamp });
        if (product.revision !== row.revision) updated += 1;
        return product;
      });
      return { products, pricing: structuredClone(entry.pricing), updated, unchanged: products.length - updated };
    });
    entry.result = structuredClone(result);
    return result;
  }
  async sourcePrice(id) {
    const previous = this.store.getProduct(id);
    if (!previous) throw new DomainError(404, 'PRODUCT_NOT_FOUND', '未找到这个商品。');
    if (previous.removedAt) throw new DomainError(409, 'PRODUCT_REMOVED', '该商品已移除，请先恢复再刷新原价。', { productIds: [id] });
    if (!this.sams) throw new DomainError(503, 'SAMS_UNAVAILABLE', '暂时无法刷新山姆原价。');
    const { priceCents: base, queriedAt } = await this.sams.sourcePrice(previous.source);
    const current = this.store.getProduct(id);
    if (current?.removedAt) throw new DomainError(409, 'PRODUCT_REMOVED', '查询期间商品已移除，未更新原价。', { productIds: [id] });
    if (current?.revision !== previous.revision) throw new DomainError(409, 'PRODUCT_REVISION_CONFLICT', '查询期间商品已修改，请重新刷新原价。', { productIds: [id] });
    const priceCents = sellingPrice(base, previous.pricing, previous.priceCents);
    return { ...this.keep({ type: 'source', productId: id, revision: previous.revision, originalPriceCents: base, queriedAt }),
      originalPriceCents: base, priceCents, previousOriginalPriceCents: previous.originalPriceCents,
      previousPriceCents: previous.priceCents, queriedAt, storeName: previous.source.storeName };
  }
  sourceSnapshot(id, previewId, patch, expectedRevision) {
    const entry = this.get(previewId, 'source');
    if (entry.productId !== id || patch.originalPriceCents !== entry.originalPriceCents
      || expectedRevision !== entry.revision) throw new DomainError(409, 'SOURCE_PRICE_PREVIEW_MISMATCH', '原价预览与当前编辑不一致，请重新刷新。');
    return { priceCents: entry.originalPriceCents, queriedAt: entry.queriedAt };
  }
}
