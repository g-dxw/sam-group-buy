import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { SamsCatalog } from '../server/sams-catalog.js';
import { CustomerSelection } from '../server/customer-selection.js';
import { normalizePricing, sellingPrice } from '../server/product-pricing.js';

const source = { platform: 'samsclub_cn', spuId: '123', storeId: '6505', storeType: 2,
  priceCents: 10000, queriedAt: '2026-10-12T10:00:00Z', storeName: '深圳福田店', description: '原说明' };
const products = [
  { id: 'p1', name: '第一件商品', spec: '一包', unit: '包', priceCents: 10500, source, onSale: true },
  { id: 'p2', name: '第二件商品', spec: '一盒', unit: '盒', priceCents: 2200, source: { ...source, spuId: '124', priceCents: 2000 }, onSale: true },
];
function fixture(t, options = {}) {
  let clock = Date.parse('2026-10-13T10:00:00Z');
  const store = new LocalStore({ path: ':memory:' }); store.importProducts(options.products || products);
  const service = new LocalService({ store, now: () => new Date(clock), sams: options.sams });
  const batch = service.createBatch({ requestId: randomUUID(), communityName: '定价验收',
    samsStore: { cityCode: '440300', cityName: '深圳市', storeId: '6505', storeType: 2, name: '深圳福田店' } }).batch;
  t.after(() => store.close());
  return { store, service, batch, advance: ms => clock += ms };
}
function submit(f, id = 'p1') {
  const product = f.service.getCatalog(f.batch).products.find(product => product.id === id);
  f.service.submit(f.batch, { submissionId: randomUUID(), name: '顾客', phone: '13800138000',
    items: [{ productId: id, quantity: 2, version: product.version }] });
}

test('markup prices use exact integer cents, half-up rounding, zero percent and bounded integer rates', () => {
  assert.equal(sellingPrice(1, { mode: 'markup', markupBps: 5000 }), 2);
  assert.equal(sellingPrice(1999, { mode: 'markup', markupBps: 333 }), 2066);
  assert.equal(sellingPrice(12345, { mode: 'markup', markupBps: 0 }), 12345);
  assert.equal(sellingPrice(100, { mode: 'fixed', markupBps: null }, 123), 123);
  for (const value of [-1, 100001, 0.1, '100', NaN]) assert.throws(() => normalizePricing({ mode: 'markup', markupBps: value }), { code: 'INVALID_PRICING' });
  assert.throws(() => sellingPrice(null, { mode: 'markup', markupBps: 0 }), { code: 'ORIGINAL_PRICE_REQUIRED' });
  assert.throws(() => sellingPrice(100_000_000, { mode: 'markup', markupBps: 1 }), { code: 'SELLING_PRICE_TOO_LARGE' });
});

test('fixed amount means original plus exact cents, supports zero and rejects negative/mixed/over-limit rules', () => {
  const amount = { mode: 'amount', markupBps: null, amountCents: 123 };
  assert.deepEqual(normalizePricing(amount), amount);
  assert.equal(sellingPrice(10000, amount), 10123);
  assert.equal(sellingPrice(0, amount), 123);
  assert.equal(sellingPrice(10000, { mode: 'amount', markupBps: null, amountCents: 0 }), 10000);
  for (const value of [-1, 1.5, '100', null, undefined, NaN, 100_000_001]) {
    assert.throws(() => normalizePricing({ mode: 'amount', markupBps: null, amountCents: value }), { code: 'INVALID_PRICING' });
  }
  assert.throws(() => normalizePricing({ ...amount, markupBps: 100 }), { code: 'INVALID_PRICING' });
  assert.throws(() => normalizePricing({ mode: 'markup', markupBps: 100, amountCents: 0 }), { code: 'INVALID_PRICING' });
  assert.throws(() => normalizePricing({ mode: 'fixed', markupBps: null, amountCents: 100 }), { code: 'INVALID_PRICING' });
  assert.throws(() => sellingPrice(null, amount), { code: 'ORIGINAL_PRICE_REQUIRED' });
  assert.throws(() => sellingPrice(100_000_000, amount), { code: 'SELLING_PRICE_TOO_LARGE' });
});

test('amount pricing keeps the fixed addition when base changes and preserves legacy fixed sale and old orders', t => {
  const f = fixture(t); submit(f);
  const amount = { mode: 'amount', markupBps: null, amountCents: 500 };
  f.service.updateProduct('p1', { pricing: amount, priceCents: 1 });
  assert.equal(f.store.getProduct('p1').priceCents, 10500);
  f.service.updateProduct('p1', { originalPriceCents: 12000 });
  assert.equal(f.store.getProduct('p1').priceCents, 12500);
  assert.deepEqual(f.store.getProduct('p1').pricing, amount);
  assert.equal(f.service.queryOrders(f.batch, '13800138000').totalCents, 21000);
  f.service.updateProduct('p2', { originalPriceCents: 2500 });
  assert.equal(f.store.getProduct('p2').priceCents, 2200);
  assert.deepEqual(f.store.getProduct('p2').pricing, { mode: 'fixed', markupBps: null });
  assert.throws(() => f.service.updateProduct('p1', { originalPriceCents: null }), { code: 'ORIGINAL_PRICE_REQUIRED' });
  assert.equal(f.store.getProduct('p1').originalPriceCents, 12000);
});

test('bulk amount pricing adds once to every original, supports unchanged/zero, atomic retry and both preview formats', t => {
  const f = fixture(t); const pricing = { mode: 'amount', markupBps: null, amountCents: 500 };
  const preview = f.service.previewProductPricing({ productIds: ['p1', 'p2'], pricing });
  assert.deepEqual(preview.pricing, pricing); assert.deepEqual(preview.rows.map(row => row.priceCents), [10500, 2500]);
  f.store.db.exec("CREATE TRIGGER fail_amount BEFORE UPDATE ON products WHEN NEW.product_id='p2' BEGIN SELECT RAISE(ABORT,'amount second product'); END");
  assert.throws(() => f.service.applyProductPricing({ previewId: preview.previewId }), /amount second product/);
  assert.deepEqual(f.store.listProducts().map(product => product.priceCents), [10500, 2200]);
  f.store.db.exec('DROP TRIGGER fail_amount');
  const applied = f.service.applyProductPricing({ previewId: preview.previewId });
  assert.deepEqual(applied.pricing, pricing); assert.equal(applied.updated, 2);
  assert.deepEqual(f.service.applyProductPricing({ previewId: preview.previewId }), applied);
  const unchanged = f.service.previewProductPricing({ productIds: ['p1', 'p2'], pricing });
  assert.equal(unchanged.updated, 0); assert.equal(unchanged.unchanged, 2);
  const markup = f.service.previewProductPricing({ productIds: ['p1', 'p2'], pricing: { mode: 'markup', markupBps: 500 } });
  assert.deepEqual(markup.rows.map(row => row.priceCents), [10500, 2100]);
  const zero = f.service.previewProductPricing({ productIds: ['p1', 'p2'], pricing: { mode: 'amount', markupBps: null, amountCents: 0 } });
  assert.deepEqual(zero.rows.map(row => row.priceCents), [10000, 2000]);
  f.service.updateProduct('p2', { originalPriceCents: null, pricing: { mode: 'fixed', markupBps: null } });
  assert.throws(() => f.service.previewProductPricing({ productIds: ['p1', 'p2'], pricing }), error => error.code === 'ORIGINAL_PRICE_REQUIRED' && error.details.productIds[0] === 'p2');
  assert.equal(f.store.getProduct('p1').priceCents, 10500);
  for (const input of [{ productIds: ['p1'], pricing, markupBps: 500 }, { productIds: ['p1'] },
    { productIds: ['p1'], pricing, priceCents: 1 }, { productIds: ['p1'], pricing: { mode: 'fixed', markupBps: null } }]) {
    assert.throws(() => f.service.previewProductPricing(input), error => ['INVALID_PRICING_PRODUCTS', 'INVALID_PRICING'].includes(error.code));
  }
  const legacy = f.service.previewProductPricing({ productIds: ['p1'], markupBps: 500 });
  assert.deepEqual(legacy.pricing, { mode: 'markup', markupBps: 500 });
});

test('source price refresh preserves amount rule through read-only preview and confirmed original update', async t => {
  const f = fixture(t, { sams: { sourcePrice: async () => ({ priceCents: 12000, queriedAt: '2026-10-13T11:00:00Z' }) } });
  const pricing = { mode: 'amount', markupBps: null, amountCents: 500 };
  f.service.updateProduct('p1', { pricing });
  const before = f.store.getProduct('p1'); const preview = await f.service.sourceProductPrice('p1');
  assert.equal(preview.priceCents, 12500); assert.equal(preview.previousPriceCents, 10500);
  assert.deepEqual(f.store.getProduct('p1'), before);
  f.service.updateProduct('p1', { sourcePricePreviewId: preview.previewId, originalPriceCents: preview.originalPriceCents, expectedRevision: 2 });
  assert.equal(f.store.getProduct('p1').priceCents, 12500);
  assert.deepEqual(f.store.getProduct('p1').pricing, pricing);
  assert.equal(f.store.getProduct('p1').source.priceCents, 10000);
  assert.equal(f.store.getProduct('p1').source.latestPriceCents, 12000);
});

test('fixed price remains independent; markup uses original price and ignores supplied sale; explicit legacy sale edit selects fixed', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.getProduct('p1').pricing, { mode: 'fixed', markupBps: null });
  assert.equal(f.store.getProduct('p1').originalPriceCents, 10000);
  f.service.updateProduct('p1', { originalPriceCents: 11000 });
  assert.equal(f.store.getProduct('p1').priceCents, 10500);
  f.service.updateProduct('p1', { pricing: { mode: 'markup', markupBps: 500 }, priceCents: 1 });
  assert.equal(f.store.getProduct('p1').priceCents, 11550);
  f.service.updateProduct('p1', { originalPriceCents: 12000 });
  assert.equal(f.store.getProduct('p1').priceCents, 12600);
  f.service.updateProduct('p1', { priceCents: 13000 });
  assert.deepEqual(f.store.getProduct('p1').pricing, { mode: 'fixed', markupBps: null });
  assert.equal(f.store.getProduct('p1').source.priceCents, 10000);
});

test('clearing original price is respected even when source has price; markup requires a known original', t => {
  const f = fixture(t); f.service.updateProduct('p1', { originalPriceCents: null });
  assert.equal(f.store.getProduct('p1').originalPriceCents, null);
  assert.throws(() => f.service.updateProduct('p1', { pricing: { mode: 'markup', markupBps: 0 } }), { code: 'ORIGINAL_PRICE_REQUIRED' });
  assert.throws(() => f.service.previewProductPricing({ productIds: ['p1', 'p2'], markupBps: 0 }), error => error.code === 'ORIGINAL_PRICE_REQUIRED' && error.details.productIds[0] === 'p1');
  assert.equal(f.store.getProduct('p2').priceCents, 2200);
});

test('batch preview always uses each original, applies atomically, and duplicate apply has stable revisions', t => {
  const f = fixture(t); const before = f.store.listProducts();
  const preview = f.service.previewProductPricing({ productIds: ['p1', 'p2'], markupBps: 500 });
  assert.deepEqual(preview.rows.map(row => row.priceCents), [10500, 2100]);
  assert.equal(preview.updated, 2); assert.equal(preview.unchanged, 0);
  assert.deepEqual(f.store.listProducts(), before);
  const applied = f.service.applyProductPricing({ previewId: preview.previewId });
  assert.equal(applied.updated, 2); assert.equal(applied.products[0].revision, 2);
  assert.deepEqual(f.service.applyProductPricing({ previewId: preview.previewId }), applied);
  const again = f.service.previewProductPricing({ productIds: ['p1', 'p2'], markupBps: 500 });
  assert.equal(again.updated, 0); assert.equal(again.unchanged, 2);
  f.service.applyProductPricing({ previewId: again.previewId });
  assert.deepEqual(f.store.listProducts().map(product => product.revision), [2, 2]);
});

test('batch preview revision conflicts reject the entire group and expired preview requires regeneration', t => {
  const f = fixture(t); const preview = f.service.previewProductPricing({ productIds: ['p1', 'p2'], markupBps: 1000 });
  f.service.updateProduct('p2', { name: '另外编辑' });
  assert.throws(() => f.service.applyProductPricing({ previewId: preview.previewId }), error => error.code === 'PRODUCT_REVISION_CONFLICT' && error.details.productIds[0] === 'p2');
  assert.equal(f.store.getProduct('p1').revision, 1); assert.equal(f.store.getProduct('p1').priceCents, 10500);
  const fresh = f.service.previewProductPricing({ productIds: ['p1', 'p2'], markupBps: 0 });
  f.advance(15 * 60_000);
  assert.throws(() => f.service.applyProductPricing({ previewId: fresh.previewId }), { code: 'PRICING_PREVIEW_EXPIRED' });
  assert.throws(() => f.service.applyProductPricing({ previewId: randomUUID() }), { code: 'PRICING_PREVIEW_EXPIRED' });
});

test('a database failure during batch apply rolls every price back and the same preview can retry', t => {
  const f = fixture(t); const preview = f.service.previewProductPricing({ productIds: ['p1', 'p2'], markupBps: 1000 });
  f.store.db.exec("CREATE TRIGGER fail_price BEFORE UPDATE ON products WHEN NEW.product_id='p2' BEGIN SELECT RAISE(ABORT,'failed second product'); END");
  assert.throws(() => f.service.applyProductPricing({ previewId: preview.previewId }), /failed second product/);
  assert.deepEqual(f.store.listProducts().map(product => product.priceCents), [10500, 2200]);
  f.store.db.exec('DROP TRIGGER fail_price');
  assert.equal(f.service.applyProductPricing({ previewId: preview.previewId }).updated, 2);
});

test('individual revisions protect edits and pricing private fields cannot be supplied as source metadata', t => {
  const f = fixture(t); f.service.updateProduct('p1', { priceCents: 12000, expectedRevision: 1 });
  assert.throws(() => f.service.updateProduct('p1', { priceCents: 1, expectedRevision: 1 }), { code: 'PRODUCT_REVISION_CONFLICT' });
  assert.throws(() => f.service.updateProduct('p1', { source: { ...source, priceCents: 1 } }), { code: 'INVALID_PRODUCT_FIELDS' });
  assert.equal(f.store.getProduct('p1').priceCents, 12000);
});

test('original-price refresh is read-only, confirmed at bound revision, uses current rule and preserves original provenance', async t => {
  const calls = []; const sams = new SamsCatalog({ now: () => Date.parse('2026-10-13T11:00:00Z'), fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 'Success', data: { spuId: '123', storeId: '6505', storeType: 2,
      priceInfo: [{ priceType: 1, price: '12000' }] } }));
  } });
  const f = fixture(t, { sams }); const before = f.store.getProduct('p1');
  const preview = await f.service.sourceProductPrice('p1');
  assert.equal(preview.originalPriceCents, 12000); assert.equal(preview.priceCents, 10500);
  assert.deepEqual(f.store.getProduct('p1'), before);
  assert.deepEqual(calls[0].body.storeInfoList, [{ storeId: '6505', storeType: 2 }]);
  assert.deepEqual(calls[0].body.spuIdList, ['123']);
  assert.throws(() => f.service.updateProduct('p2', { originalPriceCents: 12000, expectedRevision: 1, sourcePricePreviewId: preview.previewId }), { code: 'SOURCE_PRICE_PREVIEW_MISMATCH' });
  assert.throws(() => f.service.updateProduct('p1', { originalPriceCents: 1, expectedRevision: 1, sourcePricePreviewId: preview.previewId }), { code: 'SOURCE_PRICE_PREVIEW_MISMATCH' });
  f.service.updateProduct('p1', { originalPriceCents: 12000, pricing: { mode: 'markup', markupBps: 500 },
    expectedRevision: 1, sourcePricePreviewId: preview.previewId });
  const after = f.store.getProduct('p1'); assert.equal(after.priceCents, 12600);
  assert.equal(after.source.priceCents, 10000); assert.equal(after.source.queriedAt, source.queriedAt);
  assert.equal(after.source.latestPriceCents, 12000); assert.equal(after.source.latestQueriedAt, preview.queriedAt);
  const stale = await f.service.sourceProductPrice('p1'); f.service.updateProduct('p1', { name: '已修改' });
  assert.throws(() => f.service.updateProduct('p1', { originalPriceCents: stale.originalPriceCents, expectedRevision: 2,
    sourcePricePreviewId: stale.previewId }), { code: 'PRODUCT_REVISION_CONFLICT' });
});

test('source refresh rejects foreign store/SKU and absent prices without changing local data', async t => {
  for (const row of [{ spuId: 'other', storeId: '6505' }, { spuId: '123', storeId: '9999' },
    { spuId: '123', storeId: '6505', storeType: 4 }, { spuId: '123', storeId: '6505', priceInfo: [] }]) {
    const sams = new SamsCatalog({ fetchImpl: async () => new Response(JSON.stringify({ code: 'Success', data: row })) });
    const f = fixture(t, { sams }); const before = f.store.getProduct('p1');
    await assert.rejects(f.service.sourceProductPrice('p1'), error => ['SAMS_SOURCE_MISMATCH', 'SAMS_PRICE_UNAVAILABLE'].includes(error.code));
    assert.deepEqual(f.store.getProduct('p1'), before);
  }
});

test('schema migration freezes NULL-snapshot legacy price, preserves old totals and never invents missing SKU prices', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-price-migration-')); const path = join(dir, 'orders.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldStore = new LocalStore({ path }); oldStore.importProducts(products);
  const oldService = new LocalService({ store: oldStore });
  const batch = oldService.createBatch({ requestId: randomUUID(), communityName: '旧单验收' }).batch;
  submit({ store: oldStore, service: oldService, batch });
  oldStore.db.exec('UPDATE order_lines SET snapshot_json=NULL');
  oldStore.db.exec("INSERT INTO order_lines(batch_code,submission_id,line_id,product_id,quantity,status) SELECT batch_code,submission_id,submission_id || ':missing-product','missing-product',1,'待采购' FROM order_lines LIMIT 1");
  oldStore.db.exec('UPDATE submissions SET expected_lines=2');
  assert.equal(oldStore.listExportLines(batch.code)[1].amountCents, null);
  assert.equal(oldService.queryOrders(batch.code, '13800138000').totalCents, null);
  oldStore.close();
  const db = new DatabaseSync(path); db.exec('ALTER TABLE products DROP COLUMN original_price_cents; ALTER TABLE products DROP COLUMN pricing_json'); db.close();
  const store = new LocalStore({ path }); t.after(() => store.close());
  const service = new LocalService({ store });
  assert.equal(store.getProduct('p1').originalPriceCents, 10000);
  assert.deepEqual(store.getProduct('p1').pricing, { mode: 'fixed', markupBps: null });
  assert.equal(store.listOrderLines(batch.code)[0].snapshot.priceCents, 10500);
  assert.equal(store.listOrderLines(batch.code)[1].snapshot.missing, true);
  assert.equal(store.listOrderLines(batch.code)[1].snapshot.priceCents, null);
  service.updateProduct('p1', { pricing: { mode: 'markup', markupBps: 1000 } });
  const line = store.listExportLines(batch.code)[0]; assert.equal(line.amountCents, 21000);
  assert.equal(line.feeRateBps, 0); assert.equal(line.revision, 1);
  assert.equal(store.listExportLines(batch.code)[1].amountCents, null);
  store.importProducts([...store.listProducts(), { id: 'missing-product', name: '新入库同编号', spec: '新一包', unit: '包',
    priceCents: 1000, originalPriceCents: 900, pricing: { mode: 'fixed', markupBps: null }, onSale: true }]);
  const legacy = store.listExportLines(batch.code).find(line => line.productId === 'missing-product');
  assert.equal(legacy.priceCents, null); assert.equal(legacy.amountCents, null); assert.equal(legacy.payableCents, null);
  const missingQuery = service.queryOrders(batch.code, '13800138000');
  assert.equal(missingQuery.totalCents, null);
  assert.equal(missingQuery.products.find(product => product.id === 'missing-product').missing, true);
  assert.equal(missingQuery.products.find(product => product.id === 'missing-product').priceCents, null);
  service.updateBatch(batch.code, { productIds: [...store.getBatch(batch.code).productIds, 'missing-product'] });
  const fresh = service.getCatalog(batch.code).products.find(product => product.id === 'missing-product');
  service.submit(batch.code, { submissionId: randomUUID(), name: '新顾客', phone: '13900139000',
    items: [{ productId: fresh.id, quantity: 1, version: fresh.version }] });
  const freshQuery = service.queryOrders(batch.code, '13900139000');
  assert.equal(freshQuery.totalCents, 1000); assert.equal(freshQuery.products[0].missing, undefined);
  assert.equal(JSON.stringify(freshQuery).includes('originalPriceCents'), false);
  assert.equal(JSON.stringify(freshQuery).includes('markupBps'), false);
  service.updateOrder(batch.code, legacy.recordId, { status: '已取消' });
  assert.equal(store.listExportLines(batch.code).find(line => line.lineId === legacy.lineId).amountCents, 0);
  service.updateOrder(batch.code, legacy.recordId, { status: '待采购' });
  assert.equal(store.listExportLines(batch.code).find(line => line.lineId === legacy.lineId).amountCents, null);
});

test('current orders stay at old retail price; public catalog, order query and customer views do not expose costs or rules', t => {
  const f = fixture(t); submit(f);
  f.service.updateProduct('p1', { pricing: { mode: 'markup', markupBps: 1000 } });
  assert.equal(f.service.queryOrders(f.batch, '13800138000').totalCents, 21000);
  assert.equal(f.service.getCatalog(f.batch).products.find(p => p.id === 'p1').priceCents, 11000);
  const publicResults = [f.service.getCatalog(f.batch), f.service.queryOrders(f.batch, '13800138000')];
  const selection = new CustomerSelection({ store: f.store, service: f.service, sams: {} });
  publicResults.push(selection.publicProduct(selection.product({ spu_id: '123', name: '商品', spec: '一包', price_cents: 10000,
    image_url: 'https://example.com/p.jpg', available: true, on_sale: true, selectable: true }, f.store.getBatch(f.batch.code), '商品', source.queriedAt)));
  f.service.updateBatch(f.batch.code, { productIds: ['p2'], splitRules: { p2: { partsPerPack: 2, portionSpec: '半盒', priceCents: 1500 } } });
  const catalog = f.service.getCatalog(f.batch); publicResults.push(catalog);
  const splitProduct = catalog.products[0]; const item = { productId: 'p2', quantity: 1, version: splitProduct.version };
  const quote = f.service.quote(f.batch, { items: [item], phone: '13800138000' });
  f.service.submit(f.batch, { submissionId: randomUUID(), phone: '13800138000', name: '顾客', items: [item], feeQuoteVersion: quote.feeQuoteVersion });
  publicResults.push(f.service.queryOrders(f.batch, '13800138000'));
  for (const result of publicResults) for (const field of ['originalPriceCents', 'markupBps', 'packPriceCents', 'packPriceSource', 'latestPriceCents']) {
    assert.equal(JSON.stringify(result).includes(`"${field}"`), false, field);
  }
  assert.equal(f.service.getStats([f.batch.code]).splitGroups[0].packPriceCents, 2000);
});
