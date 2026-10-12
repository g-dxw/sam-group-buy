import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { SamsCatalog } from '../server/sams-catalog.js';
import { CustomerSelection } from '../server/customer-selection.js';
import { SyncJobs } from '../server/sync-jobs.js';

const start = Date.parse('2026-10-13T10:00:00Z');
const location = { cityCode: '440300', storeId: '6505', storeType: 2, name: '测试门店', cityName: '深圳市' };
const source = { platform: 'samsclub_cn', spuId: '111', storeId: '6505', storeType: 2, storeName: location.name,
  method: 'search', keyword: '商品', priceCents: 10000, queriedAt: new Date(start).toISOString() };
const products = [
  { id: 'sam_111', name: '可移除商品', spec: '一箱', unit: '箱', priceCents: 11000, imageUrl: 'https://images.test/111.jpg', source, onSale: true },
  { id: 'p2', name: '保留商品', spec: '一盒', unit: '盒', priceCents: 2200, source: { ...source, spuId: '222', priceCents: 2000 }, onSale: true },
];
const raw = { spuId: '111', storeId: '6505', storeType: 2, title: '查询商品一箱', image: 'https://images.test/111.jpg',
  images: ['https://images.test/111.jpg'], subTitle: '官方说明', priceInfo: [{ priceType: 1, price: '12000' }],
  isAvailable: true, isStoreAvailable: true, isPutOnSale: true, stockInfo: { stockQuantity: 5 } };
function fixture(t, options = {}) {
  let clock = start;
  const store = new LocalStore({ path: options.path || ':memory:' }); store.importProducts(options.products || products);
  const service = new LocalService({ store, now: () => new Date(clock), sams: options.sams, productMutationBusy: options.productMutationBusy });
  const batch = service.createBatch({ requestId: randomUUID(), communityName: '商品移除验收', samsStore: location, ...options.batch }).batch;
  t.after(() => { try { store.close(); } catch {} });
  const sams = options.sams || new SamsCatalog({ hasProduct: id => Boolean(store.getProduct(id)), now: () => clock,
    fetchImpl: async url => new Response(JSON.stringify({ code: 'Success',
      data: url.endsWith('querySpuDetailToNFC') ? raw : { dataList: [raw], hasNextPage: false } })) });
  const customer = new CustomerSelection({ store, service, sams, now: () => clock });
  return { store, service, batch, sams, customer, advance: ms => clock += ms };
}
function payload(f, product, phone = '13800138000', quantity = 1) {
  const items = [{ productId: product.id, quantity, version: product.version }];
  const quote = f.service.quote(f.batch, { phone, items });
  return { submissionId: randomUUID(), name: '顾客', phone, items,
    feePolicyVersion: quote.feePolicyVersion, feeQuoteVersion: quote.feeQuoteVersion };
}
async function add(f, token) {
  const search = await f.customer.search(f.batch, token, { keyword: '商品' });
  return (await f.customer.add(f.batch, token, { selectionId: search.selectionId, spuId: '111' })).product;
}
const rawHistory = store => Object.fromEntries(['submissions', 'order_lines', 'customer_selections', 'customer_products', 'split_settlements']
  .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test('remove and restore keep historical products, remain idempotent, hide public scope and leave restored products off sale', t => {
  const f = fixture(t); const original = f.store.getProduct('sam_111');
  const catalogProduct = f.service.getCatalog(f.batch).products.find(p => p.id === original.id);
  const order = payload(f, catalogProduct, '13800138000', 2); f.service.submit(f.batch, order);
  f.store.setMeta('exportSource', { baseToken: 'test', productTableId: 'products' });
  f.store.setMeta('feishu-product-backup', { destination: 'test:products', records: {
    sam_111: { revision: 1, recordId: 'rec-111' }, p2: { revision: 1, recordId: 'rec-222' } } });
  const beforeHistory = rawHistory(f.store); const beforeBackup = f.store.getMeta('feishu-product-backup');
  const removed = f.service.removeProduct(original.id);
  assert.equal(removed.removed, true); assert.equal(removed.product.onSale, false); assert.equal(removed.product.revision, 2);
  assert.equal(removed.product.removedAt, new Date(start).toISOString()); assert.equal(removed.product.backupStatus, 'pending');
  assert.deepEqual(removed.product.source, original.source); assert.equal(removed.product.originalPriceCents, original.originalPriceCents);
  f.advance(1000); assert.deepEqual(f.service.removeProduct(original.id), removed);
  assert.deepEqual(f.store.listProducts().map(p => p.id), ['p2']); assert.equal(f.store.listProducts({ includeRemoved: true }).length, 2);
  assert.equal(f.store.getProduct(original.id).revision, 2); assert.equal(f.service.listProducts().removedProducts[0].id, original.id);
  assert.deepEqual(f.service.getCatalog(f.batch, { allProducts: true }).products.map(p => p.id), ['p2']);
  assert.equal(f.service.queryOrders(f.batch, order.phone).totalCents, 22000);
  const queried = f.service.queryOrders(f.batch, order.phone).products[0];
  assert.equal(queried.originalPriceCents, undefined); assert.equal(queried.pricing, undefined); assert.equal(queried.source, undefined);
  assert.deepEqual(rawHistory(f.store), beforeHistory); assert.deepEqual(f.store.getMeta('feishu-product-backup'), beforeBackup);
  assert.equal(f.service.overview().productCount, 1); assert.equal(f.service.overview().productSync.counts.total, 2);
  assert.equal(f.service.overview().productSync.counts.backedUp, 1); assert.equal(f.service.overview().productSync.backup.pending, 1);
  assert.throws(() => f.service.submit(f.batch, { ...order, submissionId: randomUUID() }), { code: 'PRODUCT_CHANGED' });
  for (const patch of [{ onSale: true }, { name: '静默恢复' }, { priceCents: 1 }]) assert.throws(() => f.service.updateProduct(original.id, patch), { code: 'PRODUCT_REMOVED' });
  assert.throws(() => f.service.updateProductStatus({ productIds: [original.id, 'p2'], onSale: true }), { code: 'PRODUCT_REMOVED' });
  assert.equal(f.store.getProduct('p2').revision, 1);
  const restored = f.service.restoreProduct(original.id);
  assert.equal(restored.restored, true); assert.equal(restored.product.removedAt, null); assert.equal(restored.product.onSale, false);
  assert.equal(restored.product.revision, 3); assert.deepEqual(f.service.restoreProduct(original.id), restored);
  f.service.updateProduct(original.id, { onSale: true }); assert.equal(f.store.getProduct(original.id).onSale, true);
  assert.equal(f.service.queryOrders(f.batch, order.phone).totalCents, 22000);
});

test('bulk removal validates every ID and rolls back revisions and frozen legacy snapshots on any database failure', t => {
  const f = fixture(t); const p = f.service.getCatalog(f.batch).products.find(p => p.id === 'sam_111');
  f.service.submit(f.batch, payload(f, p)); f.store.db.exec('UPDATE order_lines SET snapshot_json=NULL');
  const before = f.store.listProducts({ includeRemoved: true }); const history = rawHistory(f.store);
  assert.throws(() => f.service.removeProducts({ productIds: ['sam_111', 'missing'] }), error => error.code === 'PRODUCT_NOT_FOUND' && error.details.productIds[0] === 'missing');
  for (const input of [{ productIds: [] }, { productIds: ['p2', 'p2'] }, { productIds: [123] }, { productIds: ['p2'], onSale: false },
    { productIds: Array.from({ length: 201 }, (_, i) => `p${i}`) }]) assert.throws(() => f.service.removeProducts(input), { code: 'INVALID_PRODUCT_REMOVE' });
  f.store.db.exec("CREATE TRIGGER fail_remove BEFORE UPDATE OF removed_at ON products WHEN NEW.product_id='p2' BEGIN SELECT RAISE(ABORT,'failed second remove'); END");
  assert.throws(() => f.service.removeProducts({ productIds: ['sam_111', 'p2'] }), /failed second remove/);
  assert.deepEqual(f.store.listProducts({ includeRemoved: true }), before); assert.deepEqual(rawHistory(f.store), history);
  f.store.db.exec('DROP TRIGGER fail_remove');
  const removed = f.service.removeProducts({ productIds: ['sam_111', 'p2'] }); assert.equal(removed.updated, 2); assert.equal(removed.unchanged, 0);
  assert.deepEqual(removed.products.map(p => p.revision), [2, 2]); assert.equal(f.store.listProducts().length, 0);
  const again = f.service.removeProducts({ productIds: ['sam_111', 'p2'] }); assert.equal(again.updated, 0); assert.equal(again.unchanged, 2);
  assert.equal(f.store.listOrderLines(f.batch.code)[0].snapshot.priceCents, 11000);
  assert.equal(f.service.queryOrders(f.batch, '13800138000').totalCents, 11000);
  assert.equal(f.service.overview().productCount, 0); assert.equal(f.service.overview().productSync.pending, 2);
  for (const method of ['removeProduct', 'restoreProduct']) {
    assert.throws(() => f.service[method]('missing'), { code: 'PRODUCT_NOT_FOUND' });
    assert.throws(() => f.service[method]('p2', { unexpected: true }), { code: 'INVALID_PRODUCT_REMOVE' });
  }
});

test('removed products retain batch associations and locked split rules but cannot be newly added to any period', t => {
  const splitRule = { partsPerPack: 2, portionSpec: '半箱', priceCents: 5500 };
  const f = fixture(t, { batch: { splitRules: { sam_111: splitRule } } });
  const p = f.service.getCatalog(f.batch).products.find(p => p.id === 'sam_111');
  f.service.submit(f.batch, payload(f, p)); const group = f.service.getSplitGroups(f.batch.code)[0];
  const sibling = f.service.createBatch({ requestId: randomUUID(), communityName: '另一个团', productIds: ['p2'] }).batch;
  f.service.removeProduct('sam_111');
  const updated = f.service.updateBatch(f.batch.code, { title: '修改仍可保存', productIds: f.batch.productIds, splitRules: { sam_111: splitRule } }).batch;
  assert.deepEqual(updated.productIds, f.batch.productIds); assert.deepEqual(updated.splitRules, { sam_111: splitRule });
  assert.deepEqual(updated.splitLockedProductIds, ['sam_111']); assert.deepEqual(f.service.getSplitGroups(f.batch.code)[0], group);
  assert.throws(() => f.service.updateBatch(sibling.code, { productIds: ['p2', 'sam_111'] }), { code: 'INVALID_PRODUCTS' });
  assert.throws(() => f.service.createBatch({ requestId: randomUUID(), communityName: '新团', productIds: ['sam_111'] }), { code: 'INVALID_PRODUCTS' });
  f.service.updateBatch(f.batch.code, { collecting: false });
  assert.ok(f.service.confirmSplit(f.batch.code, 'sam_111', { remainderPolicy: 'topUp' }).group.settledAt);
  assert.equal(f.store.getProduct('sam_111').removedAt, new Date(start).toISOString());
});

test('pricing previews and asynchronous source prices cannot revive removed products or survive remove plus restore', async t => {
  let release; let began;
  const started = new Promise(resolve => { began = resolve; });
  const f = fixture(t, { sams: { sourcePrice: async () => { began(); await new Promise(resolve => { release = resolve; });
    return { priceCents: 12000, queriedAt: new Date(start).toISOString() }; } } });
  const pending = f.service.previewProductPricing({ productIds: ['sam_111', 'p2'], markupBps: 500 });
  const appliedPreview = f.service.previewProductPricing({ productIds: ['sam_111'], markupBps: 1000 });
  f.service.applyProductPricing({ previewId: appliedPreview.previewId });
  const sourcePrice = f.service.sourceProductPrice('sam_111'); await started;
  f.service.removeProduct('sam_111'); release(); await assert.rejects(sourcePrice, { code: 'PRODUCT_REMOVED' });
  assert.equal(f.service.productPricing.previews.size, 2);
  assert.throws(() => f.service.previewProductPricing({ productIds: ['sam_111'], markupBps: 0 }), { code: 'PRODUCT_REMOVED' });
  for (const previewId of [pending.previewId, appliedPreview.previewId]) assert.throws(() => f.service.applyProductPricing({ previewId }), { code: 'PRODUCT_REMOVED' });
  f.service.restoreProduct('sam_111');
  for (const previewId of [pending.previewId, appliedPreview.previewId]) assert.throws(() => f.service.applyProductPricing({ previewId }), { code: 'PRODUCT_REVISION_CONFLICT' });
  assert.equal(f.store.getProduct('p2').priceCents, 2200); assert.equal(f.store.getProduct('sam_111').originalPriceCents, 10000);
});

test('backup and configuration jobs exclude visibility changes inside transactions; imports and selection skip removed entities', async t => {
  const jobs = new SyncJobs(); const f = fixture(t, { productMutationBusy: () => jobs.active.has('products') || jobs.active.has('feishu-save') });
  for (const key of ['products', 'feishu-save']) {
    let release; jobs.start(key, () => new Promise(resolve => { release = resolve; })); await Promise.resolve();
    assert.throws(() => f.service.removeProducts({ productIds: ['sam_111', 'p2'] }), { code: 'PRODUCT_BACKUP_BUSY' });
    assert.equal(f.store.getProduct('sam_111').revision, 1); release({ status: 'success' }); await jobs.waitForIdle();
  }
  f.service.removeProduct('sam_111'); const removed = f.store.getProduct('sam_111');
  const incoming = { ...products[0], priceCents: 12000, source: { ...source, priceCents: 12000 } };
  const selected = f.service.selectProducts([incoming]); assert.equal(selected.added, 0); assert.equal(selected.skipped, 1);
  f.store.importProducts([incoming, products[1]]); assert.deepEqual(f.store.getProduct('sam_111'), removed);
  const search = await f.sams.search({ keyword: '商品', storeId: location.storeId, storeType: location.storeType });
  assert.equal(search.products[0].inCatalog, true);
  let release; jobs.start('products', () => new Promise(resolve => { release = resolve; })); await Promise.resolve();
  assert.throws(() => f.service.restoreProduct('sam_111'), { code: 'PRODUCT_BACKUP_BUSY' });
  release({ status: 'success' }); await jobs.waitForIdle();
  assert.equal(f.service.restoreProduct('sam_111').product.onSale, false);
});

test('fresh private purchase uses current upstream price after removal without overwriting same-ID removed drafts or historical orders', async t => {
  const f = fixture(t); const token = randomUUID();
  f.service.removeProduct('sam_111'); const first = await add(f, token);
  assert.equal(first.id, 'self_2_6505_111'); assert.equal(first.priceCents, 12000); assert.equal(first.source, undefined);
  const firstOrder = { submissionId: randomUUID(), name: '顾客', phone: '13800138000', items: [{ productId: first.id, quantity: 1, version: first.version }] };
  await f.customer.submit(f.batch, token, firstOrder); f.service.removeProduct(first.id);
  const removed = f.store.getProduct(first.id); assert.equal(removed.onSale, false);
  const next = await add(f, token); assert.equal(next.id, first.id); assert.equal(next.priceCents, 12000);
  const nextItems = [{ productId: next.id, quantity: 2, version: next.version }];
  const quote = f.customer.quote(f.batch, token, { phone: firstOrder.phone, items: nextItems });
  const secondOrder = { ...firstOrder, submissionId: randomUUID(), items: nextItems,
    feePolicyVersion: quote.feePolicyVersion, feeQuoteVersion: quote.feeQuoteVersion };
  await f.customer.submit(f.batch, token, secondOrder);
  assert.deepEqual(f.store.getProduct(first.id), removed); assert.equal(f.store.listProducts().length, 1);
  assert.equal(f.service.queryOrders(f.batch, firstOrder.phone).totalCents, 36000);
  assert.equal(f.store.listOrderLines(f.batch.code).every(line => line.snapshot.priceCents === 12000 && !line.snapshot.split), true);
  assert.equal(f.customer.list(f.batch, token).products[0].originalPriceCents, undefined);
  assert.equal(f.service.getCatalog(f.batch).products.some(p => p.id === first.id), false);
});

test('removed period split blocks fresh same-SPU personal aliases before and after settlement and never points at a hidden recommendation', async t => {
  for (const settled of [false, true]) {
    const f = fixture(t, { products: [products[1]] }); const token = randomUUID();
    // A private alias quoted before the administrator recommends this source SKU.
    f.service.updateBatch(f.batch.code, { productIds: ['p2'] });
    const alias = await add(f, token);
    assert.equal(alias.id, 'self_2_6505_111');
    f.store.importProducts(products);
    f.service.updateBatch(f.batch.code, { productIds: ['sam_111', 'p2'], splitRules: { sam_111: { partsPerPack: 2, portionSpec: '半箱', priceCents: 5500 } } });
    const split = f.service.getCatalog(f.batch).products.find(p => p.id === 'sam_111');
    f.service.submit(f.batch, payload(f, split));
    if (settled) { f.service.updateBatch(f.batch.code, { collecting: false }); f.service.confirmSplit(f.batch.code, 'sam_111', { remainderPolicy: 'topUp' }); f.service.updateBatch(f.batch.code, { collecting: true }); }
    f.service.removeProduct('sam_111');
    const items = [{ productId: alias.id, quantity: 1, version: alias.version }];
    assert.throws(() => f.customer.quote(f.batch, token, { phone: '13900139000', items }), error => error.code === 'SPLIT_PRODUCT_REMOVED' && error.details.recommendedProductId === undefined);
    await assert.rejects(f.customer.submit(f.batch, token, { submissionId: randomUUID(), name: '顾客', phone: '13900139000', items }), { code: 'SPLIT_PRODUCT_REMOVED' });
    const searched = await f.customer.search(f.batch, token, { keyword: '商品' });
    assert.equal(searched.products[0].selectable, false); assert.match(searched.products[0].selectionUnavailableReason, /拼份商品已移除/);
    await assert.rejects(f.customer.add(f.batch, token, { selectionId: searched.selectionId, spuId: '111' }), { code: 'SPLIT_PRODUCT_REMOVED' });
    assert.equal(f.customer.list(f.batch, token).products[0].selectable, false);
    assert.equal(f.store.listOrderLines(f.batch.code).length, 1);
  }
});

test('nullable removal schema upgrades without modifying rows and archived products survive SQLite restart with historical amounts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-product-remove-')); const path = join(dir, 'orders.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, { path }); const p = f.service.getCatalog(f.batch).products.find(p => p.id === 'sam_111');
  f.service.submit(f.batch, payload(f, p)); f.store.db.exec('ALTER TABLE products DROP COLUMN removed_at');
  const before = f.store.db.prepare('SELECT * FROM products').all().map(row => ({ ...row })); const history = rawHistory(f.store);
  f.store.close(); const upgraded = new LocalStore({ path });
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM products').all().map(({ removed_at, ...row }) => row), before);
  assert.deepEqual(rawHistory(upgraded), history); assert.equal(upgraded.getProduct('sam_111').removedAt, null);
  const service = new LocalService({ store: upgraded, now: () => new Date(start) }); service.removeProduct('sam_111'); upgraded.close();
  const reopened = new LocalStore({ path }); t.after(() => reopened.close()); const final = new LocalService({ store: reopened });
  assert.equal(reopened.listProducts().length, 1); assert.equal(reopened.getProduct('sam_111').removedAt, new Date(start).toISOString());
  assert.equal(final.queryOrders(f.batch, '13800138000').totalCents, 11000); assert.deepEqual(rawHistory(reopened), history);
  assert.equal(final.restoreProduct('sam_111').product.onSale, false); assert.equal(final.queryOrders(f.batch, '13800138000').totalCents, 11000);
});
