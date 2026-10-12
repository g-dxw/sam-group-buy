import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';

const phone = '13800138000';
const products = [
  { recordId: 'p1', id: 'SAM-001', name: '演示牛奶', spec: '12 瓶', unit: '箱', priceCents: 9900, category: '乳品', onSale: true, sort: 1 },
  { recordId: 'p2', id: 'SAM-002', name: '演示鸡蛋', spec: '24 个', unit: '盒', priceCents: 3900, category: '生鲜', onSale: true, sort: 2 },
];
const timestamp = '2026-10-12T08:00:00.000Z';

function fixture(t) {
  const store = new LocalStore({ path: ':memory:' });
  store.importProducts(products, { lastSyncedAt: timestamp });
  const service = new LocalService({ store, now: () => new Date(timestamp) });
  const batch = service.createBatch({ requestId: randomUUID(), communityName: '测试小区' }).batch;
  t.after(() => store.close());
  return { store, service, batch };
}
function payload(service, batch, quantities = [2], overrides = {}) {
  const catalog = service.getCatalog(batch);
  return { submissionId: randomUUID(), phone, name: '测试小王', note: '',
    items: quantities.map((quantity, index) => ({ productId: catalog.products[index].id,
      quantity, version: catalog.products[index].version })), ...overrides };
}

test('local atomic submit completes immediately; normalized phone and supplemental order total 3', (t) => {
  const { store, service, batch } = fixture(t);
  const first = payload(service, batch, [2], { phone: '+86 138-0013-8000' });
  assert.equal(service.submit(batch, first).status, 'completed');
  assert.equal(service.submit(batch, payload(service, batch, [1])).status, 'completed');
  const query = service.queryOrders(batch, `0086 ${phone}`);
  assert.equal(query.phone, phone);
  assert.equal(query.products[0].quantity, 3);
  assert.equal(query.totalCents, 29700);
  assert.equal(query.pendingCount, 0);
  assert.equal(store.listExportLines(batch.code).length, 2);
  assert.ok(store.listExportLines(batch.code).every(line => line.revision === 1 && line.syncedRevision === 0));
});

test('UUID replay is idempotent after manual editing or closure, while different content conflicts', (t) => {
  const { service, store, batch } = fixture(t);
  const order = payload(service, batch);
  service.submit(batch, order);
  const line = store.listOrderLines(batch.code)[0];
  service.updateOrder(batch.code, line.recordId, { quantity: 5, status: '已取消' });
  service.updateBatch(batch.code, { collecting: false });
  assert.equal(service.submit(batch, { ...order, phone: `+86 ${phone}` }).status, 'completed');
  assert.equal(store.listOrderLines(batch.code).length, 1);
  assert.equal(store.listOrderLines(batch.code)[0].quantity, 5);
  assert.throws(() => service.submit(batch, { ...order, name: '另一人' }), error => error.code === 'SUBMISSION_CONFLICT');
});

test('a failure saving the second line rolls back the complete order and its UUID claim', (t) => {
  const { service, store, batch } = fixture(t);
  const order = payload(service, batch, [2, 1]);
  store.db.exec(`CREATE TRIGGER fail_second_line BEFORE INSERT ON order_lines
    WHEN NEW.product_id='SAM-002' BEGIN SELECT RAISE(ABORT,'test failure'); END`);
  assert.throws(() => service.submit(batch, order), /test failure/);
  assert.equal(store.getSubmission(batch.code, order.submissionId), null);
  assert.equal(store.listOrderLines(batch.code).length, 0);
  store.db.exec('DROP TRIGGER fail_second_line');
  assert.equal(service.submit(batch, order).status, 'completed');
  assert.equal(store.listOrderLines(batch.code).length, 2);
});

test('phone, submission lookup, catalog scope and admin editing stay within the batch', (t) => {
  const { service, store, batch } = fixture(t);
  const other = service.createBatch({ requestId: randomUUID(), communityName: '另一个小区', productIds: ['SAM-002'] }).batch;
  const first = payload(service, batch);
  service.submit(batch, first);
  assert.equal(service.queryOrders(other, phone).hasOrders, false);
  assert.throws(() => service.getSubmission(other, first.submissionId), error => error.status === 404);
  const original = store.listOrderLines(batch.code)[0];
  assert.throws(() => service.updateOrder(other.code, original.recordId, { status: '已取消' }), error => error.status === 404);
  const all = service.getCatalog(batch).products;
  assert.throws(() => service.submit(other, { ...first, submissionId: randomUUID(), items: [{ productId: 'SAM-001', quantity: 1, version: all[0].version }] }), error => error.code === 'PRODUCT_CHANGED');
  assert.deepEqual(service.getCatalog(other).products.map(product => product.id), ['SAM-002']);
});

test('per-community period numbers advance automatically and creation UUID retries remain stable', (t) => {
  const { service, batch } = fixture(t);
  const create = { requestId: randomUUID(), communityName: '测试小区' };
  const next = service.createBatch(create).batch;
  assert.equal(batch.periodNumber, 1);
  assert.equal(next.periodNumber, 2);
  assert.equal(next.title, '测试小区 · 第2期');
  assert.equal(service.createBatch(create).batch.code, next.code);
  assert.throws(() => service.createBatch({ ...create, description: '不同内容' }), error => error.code === 'BATCH_REQUEST_CONFLICT');
  assert.equal(service.createBatch({ requestId: randomUUID(), communityName: '另一个小区' }).batch.periodNumber, 1);
  const community = service.createCommunity({ name: '  测试小区  ' }).community;
  assert.equal(community.id, next.communityId);
  assert.equal(service.overview().communities.find(item => item.id === community.id).nextPeriodNumber, 3);
  assert.throws(() => service.updateBatch(next.code, { periodNumber: 99 }), error => error.code === 'INVALID_BATCH_FIELDS');
  assert.throws(() => service.updateBatch(next.code, { communityName: '搬走' }), error => error.code === 'INVALID_BATCH_FIELDS');
});

test('two Node workers using one SQLite file allocate distinct periods and preserve all batches', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-local-period-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite');
  const seeded = new LocalStore({ path });
  seeded.importProducts(products);
  seeded.createCommunity({ name: '并发小区' });
  seeded.close();
  const storeUrl = new URL('../server/local-store.js', import.meta.url).href;
  const serviceUrl = new URL('../server/local-service.js', import.meta.url).href;
  const requests = [randomUUID(), randomUUID()];
  const periods = await Promise.all(requests.map(requestId => new Promise((resolve, reject) => {
    const worker = new Worker(`(async()=>{
      const {parentPort}=require('node:worker_threads');
      const {LocalStore}=await import(${JSON.stringify(storeUrl)});
      const {LocalService}=await import(${JSON.stringify(serviceUrl)});
      const store=new LocalStore({path:${JSON.stringify(path)}});
      const service=new LocalService({store});
      const result=service.createBatch({requestId:${JSON.stringify(requestId)},communityName:'并发小区'});
      store.close();parentPort.postMessage(result.batch.periodNumber);
    })().catch(error=>{throw error;});`, { eval: true });
    worker.once('message', resolve);
    worker.once('error', reject);
  })));
  assert.deepEqual(periods.sort(), [1, 2]);
  const store = new LocalStore({ path });
  assert.equal(store.listBatches().length, 2);
  store.close();
});

test('invalid full product snapshot preserves catalog, sync metadata and existing orders', (t) => {
  const { service, store, batch } = fixture(t);
  service.submit(batch, payload(service, batch));
  const before = store.getMeta('productSync');
  const invalid = structuredClone(products);
  invalid[0].priceCents = 12000;
  invalid[1].priceCents = -1;
  assert.throws(() => store.importProducts(invalid), error => error.code === 'INVALID_PRODUCT_SNAPSHOT');
  assert.equal(store.getProduct('SAM-001').priceCents, 9900);
  assert.equal(store.listOrderLines(batch.code)[0].revision, 1);
  assert.deepEqual(store.getMeta('productSync'), before);
  assert.throws(() => store.importProducts([products[0], products[0]]), error => error.code === 'INVALID_PRODUCT_SNAPSHOT');
});

test('a database failure during product apply rolls back prices and dirty revisions together', (t) => {
  const { service, store, batch } = fixture(t);
  service.submit(batch, payload(service, batch));
  store.db.exec(`CREATE TRIGGER fail_product_update BEFORE UPDATE ON products
    WHEN NEW.product_id='SAM-002' BEGIN SELECT RAISE(ABORT,'product failure'); END`);
  const snapshot = structuredClone(products);
  snapshot[0].priceCents = 12000;
  assert.throws(() => store.importProducts(snapshot), /product failure/);
  assert.equal(store.getProduct('SAM-001').priceCents, 9900);
  assert.equal(store.listOrderLines(batch.code)[0].revision, 1);
});

test('unchanged sync counts zero updates; explicit and missing products are kept but stopped', (t) => {
  const { store } = fixture(t);
  assert.equal(store.importProducts(structuredClone(products)).updated, 0);
  const snapshot = [{ ...products[0], onSale: false }];
  const sync = store.importProducts(snapshot);
  assert.equal(sync.offSale, 2);
  assert.equal(sync.disabled, 2);
  assert.equal(sync.total, 1);
  assert.equal(store.listProducts().length, 2);
  assert.equal(store.getProduct('SAM-001').onSale, false);
  assert.equal(store.getProduct('SAM-002').onSale, false);
});

test('current product changes alter existing amounts and dirty each affected export row', (t) => {
  const { service, store, batch } = fixture(t);
  service.submit(batch, payload(service, batch, [2, 1]));
  for (const line of store.listExportLines(batch.code)) store.markExported(batch.code, line.lineId, 1, `remote-${line.recordId}`);
  const snapshot = structuredClone(products);
  snapshot[0].priceCents = 12300;
  snapshot[0].name = '新名称牛奶';
  snapshot[0].spec = '新规格';
  store.importProducts(snapshot);
  const query = service.queryOrders(batch, phone);
  assert.equal(query.products[0].priceCents, 12300);
  assert.equal(query.products[0].name, '新名称牛奶');
  assert.equal(query.totalCents, 28500);
  const dirty = store.listExportLines(batch.code, { onlyDirty: true });
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].revision, 2);
  assert.equal(dirty[0].syncedRevision, 1);
  assert.equal(dirty[0].amountCents, 24600);
  assert.equal(dirty[0].remoteRecordId.startsWith('remote-'), true);
});

test('sync acknowledgement of an older version cannot clear a concurrent edit', (t) => {
  const { service, store, batch } = fixture(t);
  service.submit(batch, payload(service, batch));
  const exported = store.listExportLines(batch.code)[0];
  service.updateOrder(batch.code, exported.recordId, { quantity: 4 });
  assert.equal(store.markExported(batch.code, exported.lineId, exported.revision, 'remote-1'), false);
  const latest = store.listExportLines(batch.code, { onlyDirty: true })[0];
  assert.equal(latest.quantity, 4);
  assert.equal(latest.revision, 2);
  assert.equal(latest.syncedRevision, 0);
  assert.equal(latest.remoteRecordId, 'remote-1');
  store.markExportError(batch.code, latest.lineId, 'temporary failure');
  assert.equal(store.listExportLines(batch.code)[0].syncError, 'temporary failure');
  assert.equal(store.markExported(batch.code, latest.lineId, latest.revision, 'remote-1'), true);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 0);
  assert.equal(store.listExportLines(batch.code)[0].syncError, null);
});

test('cancelled and out-of-stock rows remain queryable/exportable but leave purchasing totals', (t) => {
  const { service, store, batch } = fixture(t);
  service.submit(batch, payload(service, batch, [2, 1]));
  const lines = store.listOrderLines(batch.code);
  service.updateOrder(batch.code, lines[0].recordId, { status: '已取消' });
  service.updateOrder(batch.code, lines[1].recordId, { status: '缺货' });
  const query = service.queryOrders(batch, phone);
  assert.equal(query.products[0].quantity, 2);
  assert.equal(query.totalCents, 0);
  assert.equal(query.products[0].statuses[0].status, '已取消');
  const stats = service.getStats([batch.code]);
  assert.equal(stats.products.length, 0);
  assert.equal(stats.orders.length, 2);
  assert.equal(stats.customers[0].products.length, 2);
  assert.equal(store.listExportLines(batch.code).length, 2);
  assert.ok(store.listExportLines(batch.code).every(line => line.revision === 2));
});

test('multiple periods merge purchasing while customer lists stay separated by batch and phone', (t) => {
  const { service, batch } = fixture(t);
  const period2 = service.createBatch({ requestId: randomUUID(), communityName: '测试小区' }).batch;
  const other = service.createBatch({ requestId: randomUUID(), communityName: '隔壁小区' }).batch;
  service.submit(batch, payload(service, batch, [2]));
  service.submit(period2, payload(service, period2, [1]));
  service.submit(other, payload(service, other, [4]));
  const selected = service.getStats([batch.code, period2.code]);
  assert.equal(selected.products[0].quantity, 3);
  assert.equal(selected.customers.length, 2);
  assert.equal(selected.customers[0].batchCodes.length, 1);
  assert.equal(selected.totalCents, 29700);
  const all = service.getStats();
  assert.equal(all.products[0].quantity, 7);
  assert.equal(all.customers.length, 3);
  assert.equal(all.orderCount, 3);
  assert.equal(all.dirtyCount, 3);
});

test('removing a product from offered IDs or stopping it preserves its submitted display and amount', (t) => {
  const { service, store, batch } = fixture(t);
  const order = payload(service, batch);
  service.submit(batch, order);
  service.updateBatch(batch.code, { productIds: ['SAM-002'] });
  store.importProducts([{ ...products[0], onSale: false }, products[1]]);
  assert.deepEqual(service.getCatalog(batch).products.map(product => product.id), ['SAM-002']);
  assert.equal(service.queryOrders(batch, phone).products[0].name, '演示牛奶');
  assert.equal(service.queryOrders(batch, phone).totalCents, 19800);
  assert.throws(() => service.submit(batch, { ...order, submissionId: randomUUID() }), error => error.code === 'PRODUCT_CHANGED');
});

test('cutoff and fresh price/version reject new submissions without affecting saved orders', (t) => {
  const { service, store, batch } = fixture(t);
  const order = payload(service, batch);
  const changed = structuredClone(products);
  changed[0].priceCents += 1;
  store.importProducts(changed);
  assert.throws(() => service.submit(batch, order), error => error.code === 'PRODUCT_CHANGED');
  service.submit(batch, payload(service, batch));
  service.updateBatch(batch.code, { cutoffAt: '2026-10-11T00:00:00+08:00' });
  assert.equal(service.getCatalog(batch).batch.collecting, false);
  assert.throws(() => service.submit(batch, payload(service, batch)), error => error.code === 'COLLECTION_CLOSED');
  assert.equal(service.queryOrders(batch, phone).hasOrders, true);
});

test('admin preserves an enabled switch when extending an expired batch, and new orders reopen', (t) => {
  const { service, store, batch } = fixture(t);
  const expired = service.updateBatch(batch.code, {
    collecting: true, cutoffAt: '2026-10-11T00:00:00+08:00',
  }).batch;
  assert.equal(expired.collectionEnabled, true);
  assert.equal(expired.collecting, false);
  const editable = service.overview().batches.find(item => item.code === batch.code);
  assert.equal(editable.collectionEnabled, true);
  assert.equal(editable.collecting, false);
  assert.equal(store.getBatch(batch.code).collecting, true);
  assert.equal(service.getCatalog(batch).batch.collectionEnabled, undefined);
  assert.throws(() => service.submit(batch, payload(service, batch)), error => error.code === 'COLLECTION_CLOSED');

  // Mirrors the admin form: only the date changes, while the checkbox keeps
  // the stored switch rather than copying the expired effective state.
  const extended = service.updateBatch(batch.code, {
    collecting: editable.collectionEnabled, cutoffAt: '2026-10-13T18:00:00+08:00',
  }).batch;
  assert.equal(extended.collectionEnabled, true);
  assert.equal(extended.collecting, true);
  assert.equal(store.getBatch(batch.code).collecting, true);
  assert.equal(service.overview().batches.find(item => item.code === batch.code).collecting, true);
  const catalog = service.getCatalog(batch);
  assert.equal(catalog.batch.collecting, true);
  assert.equal(catalog.batch.collectionEnabled, undefined);
  assert.equal(service.submit(batch, payload(service, batch)).status, 'completed');
});

test('extending a manually closed batch keeps its switch disabled and rejects new orders', (t) => {
  const { service, store, batch } = fixture(t);
  service.updateBatch(batch.code, {
    collecting: false, cutoffAt: '2026-10-11T00:00:00+08:00',
  });
  const editable = service.overview().batches.find(item => item.code === batch.code);
  assert.equal(editable.collectionEnabled, false);
  assert.equal(editable.collecting, false);
  const extended = service.updateBatch(batch.code, {
    collecting: editable.collectionEnabled, cutoffAt: '2026-10-13T18:00:00+08:00',
  }).batch;
  assert.equal(extended.collectionEnabled, false);
  assert.equal(extended.collecting, false);
  assert.equal(store.getBatch(batch.code).collecting, false);
  const catalog = service.getCatalog(batch);
  assert.equal(catalog.batch.collecting, false);
  assert.equal(catalog.batch.collectionEnabled, undefined);
  assert.throws(() => service.submit(batch, payload(service, batch)), error => error.code === 'COLLECTION_CLOSED');
  assert.equal(store.listOrderLines(batch.code).length, 0);
});

test('legacy bootstrap imports complete submissions once and preserves original codes and remote IDs', (t) => {
  const store = new LocalStore({ path: ':memory:' });
  const service = new LocalService({ store });
  t.after(() => store.close());
  const id = randomUUID();
  const line = { recordId: 'rec-old', submissionId: id, lineId: `${id}:SAM-001`, phone,
    name: '旧顾客', note: '', productId: 'SAM-001', quantity: 2, status: '已取消',
    syncStatus: '已确认', expectedLines: 1, submittedAt: timestamp };
  const config = { code: 'old-demo', name: '旧演示', imageUrlTemplate: '/custom/{id}.jpg', baseToken: 'secret-base', feishuUrl: 'https://example.test/base' };
  const settings = { title: '旧演示', collecting: true, communityName: '演示群', periodNumber: 0 };
  const result = store.importLegacyBatch(config, settings, products, [line]);
  assert.equal(result.imported, true);
  assert.equal(service.getBatch('old-demo').periodNumber, 0);
  assert.equal(service.getSubmission('old-demo', id).status, 'completed');
  assert.equal(service.getCatalog('old-demo').products[0].imageUrl, '/custom/SAM-001.jpg');
  assert.equal(store.listExportLines('old-demo')[0].remoteRecordId, 'rec-old');
  assert.equal(store.listExportLines('old-demo', { onlyDirty: true }).length, 1);
  const localId = store.listOrderLines('old-demo')[0].recordId;
  service.updateOrder('old-demo', localId, { quantity: 5, status: '已买到' });
  assert.equal(store.importLegacyBatch(config, settings, [{ ...products[0], priceCents: 1 }], [line]).imported, false);
  assert.equal(store.listOrderLines('old-demo')[0].quantity, 5);
  assert.equal(store.getProduct('SAM-001').priceCents, 9900);
  assert.equal(store.getMeta('legacySource:old-demo').baseToken, 'secret-base');
  assert.equal(JSON.stringify(service.overview()).includes('secret-base'), false);
});

test('outer bootstrap rollback also rolls back nested import products and legacy batch', (t) => {
  const store = new LocalStore({ path: ':memory:' });
  t.after(() => store.close());
  assert.throws(() => store.transaction(() => {
    store.importProducts(products);
    store.importLegacyBatch({ code: 'old', name: '旧批次' }, { collecting: true, communityName: '演示群', periodNumber: 0 }, products, []);
    throw new Error('bootstrap failure');
  }), /bootstrap failure/);
  assert.equal(store.listProducts().length, 0);
  assert.equal(store.listBatches().length, 0);
  assert.equal(store.getMeta('productSync'), null);
});

test('incomplete legacy groups are excluded and incomplete local groups cannot be edited or counted', (t) => {
  const { service, store, batch } = fixture(t);
  const order = payload(service, batch, [2, 1]);
  service.submit(batch, order);
  const lines = store.listOrderLines(batch.code);
  store.db.prepare('DELETE FROM order_lines WHERE id=?').run(Number(lines[1].recordId));
  assert.equal(service.queryOrders(batch, phone).hasOrders, false);
  assert.equal(service.getStats([batch.code]).products.length, 0);
  assert.equal(service.getStats([batch.code]).pendingSubmissions, 1);
  assert.throws(() => service.updateOrder(batch.code, lines[0].recordId, { quantity: 3 }), error => error.code === 'ORDER_INCOMPLETE');
});

test('validation prevents malformed quantities, statuses, timestamps and community membership changes', (t) => {
  const { service, store, batch } = fixture(t);
  for (const quantity of [0, -1, 0.5, 1000, '2']) assert.throws(() => service.submit(batch, payload(service, batch, [quantity])), error => error.code === 'INVALID_QUANTITY');
  assert.throws(() => service.submit(batch, payload(service, batch, [1], { phone: '123' })), error => error.code === 'INVALID_PHONE');
  service.submit(batch, payload(service, batch));
  const id = store.listOrderLines(batch.code)[0].recordId;
  assert.throws(() => service.updateOrder(batch.code, id, { status: '随便状态' }), error => error.code === 'INVALID_ORDER_UPDATE');
  assert.throws(() => service.updateOrder(batch.code, id, { quantity: null }), error => error.code === 'INVALID_ORDER_UPDATE');
  assert.throws(() => service.updateOrder(batch.code, id, { status: null }), error => error.code === 'INVALID_ORDER_UPDATE');
  assert.throws(() => service.updateOrder(batch.code, id, { phone: '13900139000' }), error => error.code === 'INVALID_ORDER_UPDATE');
  assert.throws(() => service.updateBatch(batch.code, { cutoffAt: 'tomorrow' }), error => error.code === 'INVALID_DATE');
  assert.throws(() => service.createBatch({ requestId: randomUUID(), communityName: '测试小区', periodNumber: 2 }), error => error.code === 'INVALID_BATCH_FIELDS');
  service.updateOrder(batch.code, id, { quantity: 0 });
  assert.equal(service.queryOrders(batch, phone).totalCents, 0);
});

test('public catalog and admin sync summaries hide private source and export-attempt metadata', (t) => {
  const { store, service, batch } = fixture(t);
  store.setMeta('exportSource', { baseToken: 'private-base', feishuUrl: 'https://example.test/base' });
  store.setMeta('feishu-products', { status: 'success', lastSyncedAt: timestamp, counts: { added: 1, updated: 2, offSale: 0, total: 3 } });
  store.setMeta(`feishu-export:${batch.code}`, { status: 'success', lastSyncedAt: timestamp,
    counts: { updated: 1 }, pendingCreates: { secret: { attemptId: 'private-attempt' } } });
  const catalog = service.getCatalog(batch);
  assert.equal(catalog.batch.feishuUrl, undefined);
  assert.equal(catalog.batch.productIds, undefined);
  assert.equal(catalog.products[0].recordId, undefined);
  assert.equal(catalog.products[0].updatedAt, undefined);
  const overview = service.overview();
  assert.equal(overview.productSync.counts.total, 3);
  assert.equal(overview.ordersSync[batch.code].lastSyncedAt, timestamp);
  assert.equal(JSON.stringify(overview).includes('private-base'), false);
  assert.equal(JSON.stringify(overview).includes('private-attempt'), false);
});

test('local orders persist across restart with completed receipts and export revisions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-local-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite');
  let store = new LocalStore({ path });
  store.importProducts(products);
  let service = new LocalService({ store });
  const batch = service.createBatch({ requestId: randomUUID(), communityName: '持久小区' }).batch;
  const order = payload(service, batch);
  service.submit(batch, order);
  store.close();
  store = new LocalStore({ path });
  service = new LocalService({ store });
  assert.equal(service.getSubmission(batch, order.submissionId).status, 'completed');
  assert.equal(service.queryOrders(batch, phone).totalCents, 19800);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 1);
  store.close();
});
