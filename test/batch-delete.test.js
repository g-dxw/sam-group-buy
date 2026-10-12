import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { CustomerSelection, customerOwner } from '../server/customer-selection.js';
import { SamsCatalog } from '../server/sams-catalog.js';
import { SyncJobs } from '../server/sync-jobs.js';

const start = Date.parse('2026-10-13T10:00:00Z');
const product = { id: 'p1', name: '期次删除测试', spec: '一箱', unit: '箱', priceCents: 10000, onSale: true };
const location = { cityCode: '440300', storeId: '6505', storeType: 2, name: '测试门店', cityName: '深圳市' };
function fixture(t, options = {}) {
  let clock = start;
  const store = new LocalStore({ path: options.path || ':memory:' });
  if (!store.listProducts().length) store.importProducts([product]);
  const service = new LocalService({ store, now: () => new Date(clock), batchMutationBusy: options.batchMutationBusy });
  const request = { requestId: randomUUID(), communityName: '期次删除验收', ...options.batch };
  const batch = service.createBatch(request).batch;
  t.after(() => { try { store.close(); } catch {} });
  return { store, service, batch, request, advance: ms => clock += ms };
}
function payload(f, qty = 1) {
  const catalog = f.service.getCatalog(f.batch); const p = catalog.products[0];
  const items = [{ productId: p.id, quantity: qty, version: p.version }];
  const quote = f.service.quote(f.batch, { phone: '13800138000', items, feePolicyVersion: catalog.batch.feePolicyVersion });
  return { submissionId: randomUUID(), name: '顾客', phone: '13800138000', items,
    feePolicyVersion: quote.feePolicyVersion, feeQuoteVersion: quote.feeQuoteVersion };
}
const preserved = store => Object.fromEntries(['products', 'submissions', 'order_lines', 'customer_selections', 'customer_products', 'split_settlements']
  .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test('only closed or expired batches can be soft deleted; delete/restore repeat safely and restore stays closed', t => {
  const f = fixture(t, { batch: { cutoffAt: new Date(start + 60_000).toISOString() } });
  assert.throws(() => f.service.deleteBatch(f.batch.code), { code: 'BATCH_DELETE_OPEN' });
  assert.equal(f.store.getBatch(f.batch.code).deletedAt, null);
  f.advance(60_000);
  const deleted = f.service.deleteBatch(f.batch.code);
  assert.equal(deleted.deleted, true); assert.equal(deleted.batch.collecting, false);
  assert.equal(deleted.batch.deletedAt, new Date(start + 60_000).toISOString());
  f.advance(1000); assert.deepEqual(f.service.deleteBatch(f.batch.code), deleted);
  assert.equal(f.store.getBatch(f.batch.code), null); assert.deepEqual(f.store.listBatches(), []);
  assert.equal(f.store.getBatch(f.batch.code, { includeDeleted: true }).collecting, true);
  assert.equal(f.service.overview().deletedBatches.length, 1);
  const restored = f.service.restoreBatch(f.batch.code);
  assert.equal(restored.restored, true); assert.equal(restored.batch.deletedAt, null);
  assert.equal(restored.batch.collectionEnabled, false); assert.equal(restored.batch.collecting, false);
  assert.deepEqual(f.service.restoreBatch(f.batch.code), restored);
  for (const method of ['deleteBatch', 'restoreBatch']) {
    assert.throws(() => f.service[method](f.batch.code, { unexpected: true }), { code: 'INVALID_BATCH_DELETE' });
    assert.throws(() => f.service[method]('missing'), { code: 'BATCH_NOT_FOUND' });
  }
});

test('soft deletion preserves catalog, orders, splits, private selections and Feishu metadata; stats and links hide archived data', t => {
  const f = fixture(t, { batch: { samsStore: location, splitRules: { p1: { partsPerPack: 2, portionSpec: '半箱', priceCents: 5000 } } } });
  const order = payload(f, 2); f.service.submit(f.batch, order);
  f.service.updateBatch(f.batch.code, { collecting: false }); f.service.confirmSplit(f.batch.code, 'p1', { remainderPolicy: 'cancel' });
  const ownerHash = customerOwner(randomUUID());
  f.store.saveCustomerSelection({ selectionId: randomUUID(), batchCode: f.batch.code, ownerHash, storeKey: 'store',
    data: { keep: true }, expiresAt: start + 60_000 }, start);
  f.store.saveCustomerProduct(f.batch.code, ownerHash, 'store', { ...product, id: 'private', source: { customerSelected: true } }, start);
  const syncMeta = { pendingCreates: { unresolved: { outcome: 'unknown' } }, viewUrl: 'https://example.test/view' };
  f.store.setMeta(`feishu-export:${f.batch.code}`, syncMeta); f.store.setMeta(`legacySource:${f.batch.code}`, { keep: true });
  const before = preserved(f.store); const beforeStats = f.service.getStats([f.batch.code]);
  f.service.deleteBatch(f.batch.code);
  assert.deepEqual(preserved(f.store), before);
  assert.deepEqual(f.store.getMeta(`feishu-export:${f.batch.code}`), syncMeta);
  assert.deepEqual(f.store.getMeta(`legacySource:${f.batch.code}`), { keep: true });
  const overview = f.service.overview(); assert.equal(overview.batches.length, 0); assert.equal(overview.deletedBatches.length, 1);
  assert.equal(f.service.getStats().orders.length, 0); assert.equal(f.service.getStats().products.length, 0);
  for (const read of [() => f.service.getCatalog(f.batch), () => f.service.queryOrders(f.batch, order.phone),
    () => f.service.quote(f.batch, { phone: order.phone, items: order.items }), () => f.service.submit(f.batch, order),
    () => f.service.getSubmission(f.batch, order.submissionId), () => f.service.getStats([f.batch.code]),
    () => f.store.listExportLines(f.batch.code)]) assert.throws(read, { code: 'BATCH_NOT_FOUND' });
  f.service.restoreBatch(f.batch.code);
  assert.deepEqual(preserved(f.store), before); assert.deepEqual(f.service.getStats([f.batch.code]), beforeStats);
  assert.equal(f.service.queryOrders(f.batch, order.phone).totalCents, 10000);
});

test('default period falls back to an active batch, deleted period numbers and create UUIDs are never reused', t => {
  const f = fixture(t); f.service.updateBatch(f.batch.code, { collecting: false });
  const nextRequest = { requestId: randomUUID(), communityName: f.request.communityName, collecting: false };
  const next = f.service.createBatch(nextRequest).batch;
  assert.equal(f.store.getMeta('defaultBatch'), f.batch.code);
  f.service.deleteBatch(f.batch.code); assert.equal(f.store.getMeta('defaultBatch'), next.code);
  assert.equal(f.service.getBatch().code, next.code);
  assert.throws(() => f.service.createBatch(f.request), { code: 'BATCH_REQUEST_DELETED' });
  assert.throws(() => f.store.createBatch({ code: f.batch.code, communityId: f.batch.communityId }), { code: 'BATCH_REQUEST_DELETED' });
  assert.equal(f.store.importLegacyBatch({ code: f.batch.code }, {}, [product], []).imported, false);
  f.service.deleteBatch(next.code); assert.equal(f.store.getMeta('defaultBatch'), null);
  assert.throws(() => f.service.getBatch(), { code: 'BATCH_NOT_FOUND' });
  assert.equal(f.service.overview().defaultBatch, null);
  assert.equal(f.store.listCommunities()[0].nextPeriodNumber, 3);
  f.service.restoreBatch(next.code); assert.equal(f.store.getMeta('defaultBatch'), next.code);
  assert.equal(f.service.createBatch({ requestId: randomUUID(), communityName: f.request.communityName }).batch.periodNumber, 3);
});

test('running order exports or config saves block deletion inside the mutation transaction, and failure rolls back default fallback', async t => {
  const jobs = new SyncJobs();
  const f = fixture(t, { batch: { collecting: false }, batchMutationBusy: code => jobs.active.has(`orders:${code}`) || jobs.active.has('feishu-save') });
  for (const key of [`orders:${f.batch.code}`, 'feishu-save']) {
    let release; jobs.start(key, () => new Promise(resolve => { release = resolve; })); await Promise.resolve();
    assert.throws(() => f.service.deleteBatch(f.batch.code), { code: 'BATCH_SYNC_BUSY' });
    assert.equal(f.store.getBatch(f.batch.code).deletedAt, null);
    release({ status: 'success' }); await jobs.waitForIdle();
  }
  f.store.db.exec("CREATE TRIGGER fail_delete BEFORE UPDATE OF deleted_at ON batches BEGIN SELECT RAISE(ABORT,'delete failure'); END");
  assert.throws(() => f.service.deleteBatch(f.batch.code), /delete failure/);
  assert.equal(f.store.getMeta('defaultBatch'), f.batch.code); assert.equal(f.store.getBatch(f.batch.code).deletedAt, null);
  f.store.db.exec('DROP TRIGGER fail_delete'); f.service.deleteBatch(f.batch.code);
  let release; jobs.start('feishu-save', () => new Promise(resolve => { release = resolve; })); await Promise.resolve();
  assert.throws(() => f.service.restoreBatch(f.batch.code), { code: 'BATCH_SYNC_BUSY' });
  release({ status: 'success' }); await jobs.waitForIdle();
  assert.equal(f.service.restoreBatch(f.batch.code).batch.collecting, false);
});

test('archived batches survive reopening SQLite and regain all original data after explicit restore', t => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-delete-restart-')); const path = join(dir, 'orders.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, { path }); const order = payload(f); f.service.submit(f.batch, order);
  f.service.updateBatch(f.batch.code, { collecting: false }); const before = preserved(f.store);
  const deletedAt = f.service.deleteBatch(f.batch.code).batch.deletedAt; f.store.close();
  const reopened = new LocalStore({ path }); t.after(() => reopened.close()); const service = new LocalService({ store: reopened });
  assert.equal(reopened.getBatch(f.batch.code), null); assert.equal(service.overview().deletedBatches[0].deletedAt, deletedAt);
  assert.deepEqual(preserved(reopened), before); assert.equal(reopened.getMeta('defaultBatch'), null);
  service.restoreBatch(f.batch.code); assert.deepEqual(preserved(reopened), before);
  assert.equal(service.queryOrders(f.batch.code, order.phone).totalCents, 10000);
  assert.equal(service.getBatch(f.batch.code).collecting, false);
});

test('upgrading an existing database only adds nullable deletion state and preserves active batch and order rows', t => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-delete-schema-')); const path = join(dir, 'orders.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, { path }); f.service.submit(f.batch, payload(f));
  f.store.db.exec('ALTER TABLE batches DROP COLUMN deleted_at');
  const beforeBatch = f.store.db.prepare('SELECT * FROM batches').all().map(row => ({ ...row }));
  const beforeData = preserved(f.store); f.store.close();
  const store = new LocalStore({ path }); t.after(() => store.close());
  assert.deepEqual(store.db.prepare('SELECT * FROM batches').all().map(({ deleted_at, ...row }) => row), beforeBatch);
  assert.deepEqual(preserved(store), beforeData);
  assert.equal(store.getBatch(f.batch.code).deletedAt, null);
  assert.equal(store.getBatch(f.batch.code).collecting, true);
  assert.equal(store.getMeta('defaultBatch'), f.batch.code);
});

test('customer search and personal submission pending at deletion cannot save new selections or orders', async t => {
  const raw = { spuId: '999', storeId: '6505', storeType: 2, title: '自选商品一盒', image: 'https://example.test/999.jpg',
    images: ['https://example.test/999.jpg'], priceInfo: [{ priceType: 1, price: '1000' }],
    isAvailable: true, isStoreAvailable: true, isPutOnSale: true, stockInfo: { stockQuantity: 5 } };
  for (const kind of ['search', 'submit']) {
    const f = fixture(t, { batch: { samsStore: location } }); const token = randomUUID();
    let blocking = false; let release; let started;
    const began = new Promise(resolve => { started = resolve; });
    const sams = new SamsCatalog({ fetchImpl: async url => {
      const detail = url.endsWith('querySpuDetailToNFC');
      if (blocking && (kind === 'submit' ? detail : !detail)) { started(); await new Promise(resolve => { release = resolve; }); }
      return new Response(JSON.stringify({ code: 'Success', data: detail ? raw : { dataList: [raw], hasNextPage: false } }));
    } });
    const customer = new CustomerSelection({ store: f.store, service: f.service, sams, now: () => start });
    let selected;
    if (kind === 'submit') {
      const search = await customer.search(f.batch, token, { keyword: '自选' });
      selected = (await customer.add(f.batch, token, { selectionId: search.selectionId, spuId: '999' })).product;
    }
    blocking = true;
    const pending = kind === 'search' ? customer.search(f.batch, token, { keyword: '自选' })
      : customer.submit(f.batch, token, { submissionId: randomUUID(), name: '顾客', phone: '13800138000',
        items: [{ productId: selected.id, quantity: 1, version: selected.version }] });
    await began; f.service.updateBatch(f.batch.code, { collecting: false }); f.service.deleteBatch(f.batch.code);
    const before = preserved(f.store); release();
    await assert.rejects(pending, { code: 'BATCH_NOT_FOUND' });
    assert.deepEqual(preserved(f.store), before);
    assert.equal(f.store.listOrderLines(f.batch.code).length, 0);
  }
});
