import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';

const timestamp = '2026-10-12T10:00:00.000Z';
const editedAt = '2026-10-12T11:00:00.000Z';
const image = 'http://image.sams.test/products/milk.jpg';
const phone = '13800138000';

function selected(spuId = '123456', overrides = {}) {
  return { id: `sam_${spuId}`, name: '山姆牛奶 12瓶', spec: '12瓶', unit: '件', priceCents: 9900,
    category: '其他', onSale: false, sort: 1, imageUrl: image,
    source: { platform: 'samsclub_cn', spuId, storeId: '6513', storeType: 2,
      storeName: '重庆渝北山姆会员商店', cityCode: '500100', cityName: '重庆市',
      keyword: '牛奶', queriedAt: timestamp, priceCents: 9900, description: '纯牛奶' },
    ...overrides };
}
function fixture(t, path) {
  const dir = path == null ? mkdtempSync(join(tmpdir(), 'sam-local-products-')) : null;
  path ??= join(dir, 'orders.sqlite');
  const store = new LocalStore({ path });
  const service = new LocalService({ store, now: () => new Date(timestamp) });
  t.after(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  return { store, service };
}
function order(service, batch, productId = 'sam_123456') {
  return { submissionId: randomUUID(), phone, name: '小王', note: '', items: [{ productId,
    quantity: 2, version: service.getCatalog(batch).products.find(product => product.id === productId).version }] };
}
function offered(service) {
  service.selectProducts([selected()]);
  service.updateProduct('sam_123456', { onSale: true });
  return service.createBatch({ requestId: randomUUID(), communityName: '本地商品测试群' }).batch;
}

test('selection saves actual image and provenance, defaults off sale, and only skips existing products', (t) => {
  const { store, service } = fixture(t);
  const first = service.selectProducts([selected()]);
  assert.equal(first.added, 1);
  assert.equal(first.skipped, 0);
  assert.equal(first.products[0].onSale, false);
  assert.equal(first.products[0].revision, 1);
  assert.equal(first.products[0].createdAt, timestamp);
  assert.equal(first.products[0].imageUrl, image);
  assert.deepEqual(first.products[0].source, selected().source);
  assert.equal(first.products[0].backupStatus, 'pending');
  service.now = () => new Date(editedAt);
  service.updateProduct('sam_123456', { name: '团长核对名称', priceCents: 10500, onSale: true,
    imageUrl: 'https://images.test/edited.jpg', category: '乳品', sort: 5 });
  const edited = store.getProduct('sam_123456');
  const second = service.selectProducts([selected('123456', { name: '来自另一次查询' }), selected('654321')]);
  assert.equal(second.added, 1);
  assert.equal(second.skipped, 1);
  assert.deepEqual(store.getProduct('sam_123456'), edited);
  assert.equal(store.getProduct('sam_654321').onSale, false);
  assert.equal(store.listProducts().length, 2);
  const replay = service.selectProducts([selected('654321'), selected('654321')]);
  assert.equal(replay.added, 0);
  assert.equal(replay.skipped, 2);
  assert.equal(replay.products.length, 1);
});

test('selection leaves unrelated on-sale products and order export revisions unchanged', (t) => {
  const { store, service } = fixture(t);
  const batch = offered(service);
  service.submit(batch, order(service, batch));
  const before = store.getProduct('sam_123456');
  service.selectProducts([selected('888888')]);
  assert.deepEqual(store.getProduct('sam_123456'), before);
  assert.equal(store.listOrderLines(batch.code)[0].revision, 1);
  assert.deepEqual(service.getCatalog(batch).products.map(product => product.id), ['sam_123456']);
});

test('any incomplete item rejects the entire selection instead of storing a partial batch or zero price', (t) => {
  const { store, service } = fixture(t);
  const invalid = [
    { name: '' }, { spec: ' ' }, { unit: '' }, { priceCents: null }, { priceCents: undefined },
    { priceCents: 99.9 }, { imageUrl: null }, { imageUrl: 'javascript:alert(1)' },
    { imageUrl: '/images/placeholder.svg' }, { source: null },
    { source: { ...selected().source, priceCents: 1 } },
    { source: { ...selected().source, queriedAt: '2026-10-12' } },
    { source: { ...selected().source, storeType: '2' } },
    { source: { ...selected().source, spuId: 'different' } },
    { source: { ...selected().source, keyword: '' } },
  ];
  for (const patch of invalid) {
    assert.throws(() => service.selectProducts([selected('111111'), selected('123456', patch)]), error => error.status === 400);
    assert.equal(store.listProducts().length, 0);
  }
  for (const input of [null, {}, [], Array.from({ length: 201 }, (_, index) => selected(String(index)))]) {
    assert.throws(() => service.selectProducts(input), { code: 'INVALID_PRODUCT_SELECTION' });
  }
  assert.equal(store.listProducts().length, 0);
});

test('database failure on a later selection item rolls back earlier inserts', (t) => {
  const { store, service } = fixture(t);
  store.db.exec(`CREATE TRIGGER fail_selection BEFORE INSERT ON products
    WHEN NEW.product_id='sam_222222' BEGIN SELECT RAISE(ABORT,'selection failure'); END`);
  assert.throws(() => service.selectProducts([selected('111111'), selected('222222')]), /selection failure/);
  assert.equal(store.listProducts().length, 0);
});

test('explicit real zero sale prices can be selected without replacing absent prices', (t) => {
  const { store, service } = fixture(t);
  service.selectProducts([selected('123456', { priceCents: 0, source: { ...selected().source, priceCents: 0 } })]);
  assert.equal(store.getProduct('sam_123456').priceCents, 0);
});

test('only complete official rank provenance permits an empty keyword; invalid rank selection rolls back atomically', t => {
  const { store, service } = fixture(t);
  const rankSource = { ...selected().source, method: 'rank', keyword: '', rankId: '3317885016381467926',
    rankName: '蛋白质热销榜', rankCategoryId: '283381372025991', rankCategoryName: '精选蛋白质' };
  for (const patch of [{ method: 'search' }, { method: 'other' }, { method: undefined }, { keyword: '假关键词' },
    { rankId: '' }, { rankCategoryId: 'x' }, { rankName: '' }, { rankCategoryName: ' ' }]) {
    assert.throws(() => service.selectProducts([selected('111111'), selected('123456', { source: { ...rankSource, ...patch } })]), { code: 'INVALID_PRODUCT_SELECTION' });
    assert.equal(store.listProducts().length, 0);
  }
  assert.equal(service.selectProducts([selected('123456', { source: rankSource })]).added, 1);
  assert.equal(store.getProduct('sam_123456').source.keyword, '');
  assert.equal(store.getProduct('sam_123456').category, '其他');
});

test('rank browsing provenance survives closing and reopening its temporary database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-rank-provenance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite');
  const source = { ...selected().source, method: 'rank', keyword: '', rankId: '3317885016381467926',
    rankName: '蛋白质热销榜', rankCategoryId: '283381372025991', rankCategoryName: '精选蛋白质' };
  let store = new LocalStore({ path });
  new LocalService({ store }).selectProducts([selected('123456', { source })]);
  const before = store.getProduct('sam_123456');
  store.close();
  store = new LocalStore({ path });
  try {
    assert.deepEqual(store.getProduct('sam_123456'), before);
    assert.deepEqual(store.getProduct('sam_123456').source, source);
    assert.equal(new LocalService({ store }).selectProducts([selected('123456', { source })]).skipped, 1);
  } finally { store.close(); }
});

test('editable price and product information preserve legacy dynamic amounts atomically and reject stale new orders', (t) => {
  const { store, service } = fixture(t);
  const batch = offered(service);
  const oldOrder = order(service, batch);
  service.submit(batch, oldOrder);
  store.db.prepare('UPDATE order_lines SET snapshot_json=NULL WHERE batch_code=?').run(batch.code);
  const original = store.listExportLines(batch.code)[0];
  store.markExported(batch.code, original.lineId, original.revision, 'remote-1');
  const oldVersion = oldOrder.items[0].version;
  const oldCreatedAt = store.getProduct('sam_123456').createdAt;
  service.now = () => new Date(editedAt);
  const result = service.updateProduct('sam_123456', { name: '核对牛奶', spec: '6瓶', unit: '箱', priceCents: 12300 });
  assert.equal(result.product.revision, 3);
  assert.equal(result.product.createdAt, oldCreatedAt);
  assert.equal(result.product.updatedAt, editedAt);
  assert.equal(result.product.source.priceCents, 9900);
  assert.notEqual(result.product.version, oldVersion);
  const dirty = store.listExportLines(batch.code, { onlyDirty: true });
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].revision, 2);
  assert.equal(dirty[0].syncedRevision, 1);
  assert.equal(dirty[0].remoteRecordId, 'remote-1');
  assert.equal(dirty[0].amountCents, 24600);
  assert.equal(service.queryOrders(batch, phone).totalCents, 24600);
  assert.throws(() => service.submit(batch, { ...oldOrder, submissionId: randomUUID() }), { code: 'PRODUCT_CHANGED' });
  assert.equal(store.markExported(batch.code, original.lineId, original.revision, 'remote-1'), false);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 1);
});

test('unchanged patch is a no-op; metadata and sale edits update product revision without dirtying order amounts', (t) => {
  const { store, service } = fixture(t);
  const batch = offered(service);
  service.submit(batch, order(service, batch));
  const before = store.getProduct('sam_123456');
  const originalVersion = service.getCatalog(batch).products[0].version;
  assert.equal(service.updateProduct(before.id, { name: ` ${before.name} ` }).product.revision, before.revision);
  assert.deepEqual(store.getProduct(before.id), before);
  service.updateProduct(before.id, { imageUrl: 'https://image.test/new.jpg', category: '乳品', sort: 3 });
  assert.equal(store.getProduct(before.id).revision, before.revision + 1);
  assert.equal(service.getCatalog(batch).products[0].version, originalVersion);
  const currentVersion = service.getCatalog(batch).products[0].version;
  service.updateProduct(before.id, { onSale: false });
  assert.equal(store.getProduct(before.id).revision, before.revision + 2);
  assert.notEqual(service.getCatalog(batch).products[0].version, currentVersion);
  assert.equal(store.listOrderLines(batch.code)[0].revision, 1);
  assert.equal(service.queryOrders(batch, phone).totalCents, 19800);
});

test('unknown or invalid PATCH fields cannot mutate identity, source, revision or business fields', (t) => {
  const { store, service } = fixture(t);
  service.selectProducts([selected()]);
  const before = store.getProduct('sam_123456');
  for (const patch of [null, [], {}, { id: 'changed' }, { source: {} }, { revision: 100 }, { createdAt: editedAt },
    { priceCents: null }, { priceCents: -1 }, { priceCents: 9.9 }, { name: ' ' }, { spec: '' },
    { unit: '' }, { onSale: 1 }, { category: '' }, { sort: '1' }, { sort: null },
    { imageUrl: 'data:image/png;base64,evil' }, { imageUrl: '//foreign.test/a.jpg' }, { imageUrl: 'http:foreign.test/a.jpg' }]) {
    assert.throws(() => service.updateProduct(before.id, patch), error => error.status === 400);
    assert.deepEqual(store.getProduct(before.id), before);
  }
  assert.throws(() => service.updateProduct('not-found', { name: '新名称' }), { code: 'PRODUCT_NOT_FOUND' });
});

test('bulk sale status changes only selected products, skips target-state revisions and preserves batch/order scope', (t) => {
  const { store, service } = fixture(t);
  const batch = offered(service);
  service.selectProducts([selected('222222'), selected('333333')]);
  service.submit(batch, order(service, batch));
  const line = store.listExportLines(batch.code)[0];
  store.markExported(batch.code, line.lineId, line.revision, 'test-order-receipt');
  const before = store.listProducts();
  store.setMeta('exportSource', { baseToken: 'test-base', productTableId: 'test-products' });
  store.setMeta('feishu-product-backup', { destination: 'test-base:test-products', records: Object.fromEntries(
    before.map(product => [product.id, { revision: product.revision, lastBackedUpAt: timestamp }]),
  ) });
  service.now = () => new Date(editedAt);
  const result = service.updateProductStatus({ productIds: ['sam_123456', 'sam_222222'], onSale: true });
  assert.equal(result.updated, 1);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.products.map(product => product.id), ['sam_123456', 'sam_222222']);
  assert.deepEqual(store.getProduct('sam_123456'), before.find(product => product.id === 'sam_123456'));
  const updated = store.getProduct('sam_222222');
  const original = before.find(product => product.id === updated.id);
  assert.deepEqual(updated, { ...original, onSale: true, revision: original.revision + 1, updatedAt: editedAt });
  assert.equal(result.products[0].backupStatus, 'backed_up');
  assert.equal(result.products[1].backupStatus, 'pending');
  assert.deepEqual(store.getProduct('sam_333333'), before.find(product => product.id === 'sam_333333'));
  assert.deepEqual(store.getBatch(batch.code).productIds, ['sam_123456']);
  assert.deepEqual(service.getCatalog(batch).products.map(product => product.id), ['sam_123456']);
  assert.deepEqual(store.listExportLines(batch.code, { onlyDirty: true }), []);
  assert.equal(service.queryOrders(batch, phone).totalCents, 19800);
  const replay = service.updateProductStatus({ productIds: ['sam_123456', 'sam_222222'], onSale: true });
  assert.equal(replay.updated, 0);
  assert.equal(replay.unchanged, 2);
  assert.deepEqual(replay.products, result.products);
  const stopped = service.updateProductStatus({ productIds: ['sam_123456', 'sam_222222'], onSale: false });
  assert.equal(stopped.updated, 2);
  assert.equal(stopped.unchanged, 0);
  assert.deepEqual(store.getBatch(batch.code).productIds, ['sam_123456']);
  assert.equal(service.getCatalog(batch).products[0].onSale, false);
  assert.equal(service.queryOrders(batch, phone).totalCents, 19800);
  assert.deepEqual(store.listExportLines(batch.code, { onlyDirty: true }), []);
});

test('bulk status requires strict booleans, unique valid IDs and at most 200 products; missing IDs fail atomically', (t) => {
  const { store, service } = fixture(t);
  service.selectProducts([selected(), selected('222222')]);
  const before = store.listProducts();
  for (const input of [null, [], {}, { productIds: ['sam_123456'] }, { onSale: true },
    { productIds: [], onSale: true }, { productIds: 'sam_123456', onSale: true },
    ...[null, 0, 1, 'true', 'false'].map(onSale => ({ productIds: ['sam_123456'], onSale })),
    { productIds: ['sam_123456', 'sam_123456'], onSale: true },
    ...['', 'bad/id', 123, null].map(id => ({ productIds: ['sam_123456', id], onSale: true })),
    { productIds: Array(1), onSale: true },
    { productIds: Array.from({ length: 201 }, (_, i) => `sam_${i}`), onSale: true },
    { productIds: ['sam_123456'], onSale: true, priceCents: 1 }]) {
    assert.throws(() => service.updateProductStatus(input), { status: 400, code: 'INVALID_PRODUCT_STATUS' });
    assert.deepEqual(store.listProducts(), before);
  }
  assert.throws(() => service.updateProductStatus({ productIds: ['sam_123456', 'not-found', 'sam_222222'], onSale: true }),
    error => error.code === 'PRODUCT_NOT_FOUND' && error.status === 404 && error.details.productIds[0] === 'not-found');
  assert.deepEqual(store.listProducts(), before);
});

test('a later bulk status database failure rolls back earlier states and revisions', (t) => {
  const { store, service } = fixture(t);
  service.selectProducts([selected('111111'), selected('222222')]);
  const before = store.listProducts();
  store.db.exec(`CREATE TRIGGER fail_bulk_status BEFORE UPDATE ON products WHEN NEW.product_id='sam_222222'
    BEGIN SELECT RAISE(ABORT,'bulk status failure'); END`);
  assert.throws(() => service.updateProductStatus({ productIds: ['sam_111111', 'sam_222222'], onSale: true }), /bulk status failure/);
  assert.deepEqual(store.listProducts(), before);
});

test('exactly 200 products can change status atomically and an identical replay is a complete no-op', (t) => {
  const { store, service } = fixture(t);
  const products = Array.from({ length: 200 }, (_, i) => selected(String(100000 + i)));
  service.selectProducts(products);
  const productIds = products.map(product => product.id);
  const changed = service.updateProductStatus({ productIds, onSale: true });
  assert.equal(changed.updated, 200);
  assert.equal(changed.unchanged, 0);
  assert.equal(changed.products.length, 200);
  assert.ok(changed.products.every(product => product.onSale && product.revision === 2));
  const before = store.listProducts();
  const repeat = service.updateProductStatus({ productIds, onSale: true });
  assert.equal(repeat.updated, 0);
  assert.equal(repeat.unchanged, 200);
  assert.deepEqual(store.listProducts(), before);
});

test('failed product edit rolls back both product values and affected order revisions', (t) => {
  const { store, service } = fixture(t);
  const batch = offered(service);
  service.submit(batch, order(service, batch));
  const before = store.getProduct('sam_123456');
  store.db.exec(`CREATE TRIGGER fail_product_edit BEFORE UPDATE ON products
    BEGIN SELECT RAISE(ABORT,'edit failure'); END`);
  assert.throws(() => service.updateProduct(before.id, { priceCents: 12300 }), /edit failure/);
  assert.deepEqual(store.getProduct(before.id), before);
  assert.equal(store.listOrderLines(batch.code)[0].revision, 1);
});

test('actual images flow to customer catalog, query and purchase statistics without admin provenance', (t) => {
  const { service } = fixture(t);
  const batch = offered(service);
  const product = service.getCatalog(batch).products[0];
  assert.equal(product.imageUrl, image);
  for (const privateField of ['source', 'revision', 'createdAt', 'recordId', 'backupStatus', 'lastBackedUpAt']) {
    assert.equal(product[privateField], undefined);
  }
  service.submit(batch, order(service, batch));
  assert.equal(service.queryOrders(batch, phone).products[0].imageUrl, image);
  assert.equal(service.getStats([batch.code]).products[0].imageUrl, image);
  assert.equal(service.getStats([batch.code]).orders[0].imageUrl, image);
  service.updateProduct(product.id, { imageUrl: null });
  assert.match(service.getCatalog(batch).products[0].imageUrl, /sam_123456/);
});

test('backup state follows current destination and exact revision, keeping edits pending after older backup', (t) => {
  const { store, service } = fixture(t);
  service.selectProducts([selected()]);
  const source = { baseToken: 'test-base', productTableId: 'test-products' };
  store.setMeta('exportSource', source);
  store.setMeta('feishu-product-backup', { destination: 'test-base:test-products', status: 'success',
    lastSyncedAt: timestamp, counts: { created: 1, updated: 0 }, records: {
      sam_123456: { recordId: 'remote-product', revision: 1, lastBackedUpAt: timestamp },
    } });
  assert.equal(service.listProducts().products[0].backupStatus, 'backed_up');
  assert.equal(service.listProducts().products[0].lastBackedUpAt, timestamp);
  assert.equal(service.overview().productSync.counts.backedUp, 1);
  service.updateProduct('sam_123456', { priceCents: 10100 });
  assert.equal(service.listProducts().products[0].backupStatus, 'pending');
  assert.equal(service.listProducts().products[0].lastBackedUpAt, timestamp);
  assert.equal(service.overview().productSync.counts.pending, 1);
  const backup = store.getMeta('feishu-product-backup');
  backup.records.sam_123456.revision = 2;
  backup.records.sam_123456.pendingCreate = { outcome: 'unknown' };
  store.setMeta('feishu-product-backup', backup);
  assert.equal(service.listProducts().products[0].backupStatus, 'pending');
  delete backup.records.sam_123456.pendingCreate;
  store.setMeta('feishu-product-backup', backup);
  assert.equal(service.listProducts().products[0].backupStatus, 'backed_up');
  store.setMeta('exportSource', { ...source, productTableId: 'new-target' });
  assert.equal(service.listProducts().products[0].backupStatus, 'pending');
  assert.equal(service.listProducts().products[0].lastBackedUpAt, null);
  const overview = service.overview();
  assert.equal(overview.productSync.counts.total, 1);
  assert.equal(overview.productSync.counts.offSale, 1);
  assert.equal(overview.productSync.lastSyncedAt, null);
  assert.equal(JSON.stringify(overview).includes('test-base'), false);
  assert.equal(JSON.stringify(overview).includes('remote-product'), false);
});

test('selected products and local edits survive closing and reopening a SQLite file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-selected-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite');
  let store = new LocalStore({ path });
  let service = new LocalService({ store, now: () => new Date(timestamp) });
  service.selectProducts([selected()]);
  service.updateProduct('sam_123456', { priceCents: 10800, onSale: true });
  const before = store.getProduct('sam_123456');
  store.close();
  store = new LocalStore({ path });
  service = new LocalService({ store });
  try {
    assert.deepEqual(store.getProduct('sam_123456'), before);
    assert.equal(service.listProducts().products[0].imageUrl, image);
    assert.equal(service.selectProducts([selected()]).skipped, 1);
    assert.deepEqual(store.getProduct('sam_123456'), before);
  } finally { store.close(); }
});

test('old SQLite schema migrates additively and keeps original products, orders and export receipts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-old-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite');
  let store = new LocalStore({ path });
  const service = new LocalService({ store, now: () => new Date(timestamp) });
  store.importProducts([{ id: 'OLD-001', recordId: 'old-product-record', name: '历史牛奶', spec: '12瓶',
    unit: '箱', priceCents: 9900, category: '乳品', onSale: true, sort: 0 }], { syncedAt: timestamp });
  const batch = service.createBatch({ requestId: randomUUID(), communityName: '历史小区' }).batch;
  const payload = order(service, batch, 'OLD-001');
  service.submit(batch, payload);
  const line = store.listExportLines(batch.code)[0];
  store.markExported(batch.code, line.lineId, line.revision, 'old-order-record');
  store.close();
  const old = new DatabaseSync(path);
  for (const column of ['image_url', 'source_json', 'revision', 'created_at']) old.exec(`ALTER TABLE products DROP COLUMN ${column}`);
  old.close();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    store = new LocalStore({ path });
    try {
      const migrated = store.getProduct('OLD-001');
      assert.equal(migrated.recordId, 'old-product-record');
      assert.equal(migrated.priceCents, 9900);
      assert.equal(migrated.onSale, true);
      assert.equal(migrated.revision, 1);
      assert.equal(migrated.createdAt, timestamp);
      assert.equal(migrated.imageUrl, null);
      assert.equal(migrated.source, null);
      assert.equal(store.getSubmission(batch.code, payload.submissionId).status, 'completed');
      const migratedLine = store.listExportLines(batch.code)[0];
      assert.equal(migratedLine.remoteRecordId, 'old-order-record');
      assert.equal(migratedLine.syncedRevision, 1);
      assert.equal(migratedLine.amountCents, 19800);
      const columns = store.db.prepare('PRAGMA table_info(products)').all().map(column => column.name);
      for (const column of ['image_url', 'source_json', 'revision', 'created_at']) assert.equal(columns.filter(value => value === column).length, 1);
    } finally { store.close(); }
  }
});

test('empty inventory batch errors point to local selection and do not commit a community or batch', (t) => {
  const { store, service } = fixture(t);
  assert.throws(() => service.createBatch({ requestId: randomUUID(), communityName: '空商品测试群' }), error => {
    assert.equal(error.code, 'NO_PRODUCTS');
    assert.match(error.message, /山姆查询选品入库/);
    assert.equal(error.message.includes('飞书'), false);
    return true;
  });
  assert.equal(store.listCommunities().length, 0);
  assert.equal(store.listBatches().length, 0);
});
