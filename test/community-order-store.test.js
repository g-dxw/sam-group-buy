import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore, communityExportArchiveKey } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';

const start = '2026-10-13T10:00:00.000Z';
const source = { baseToken: 'base-a', productTableId: 'products', orderTableId: 'global-orders',
  feishuUrl: 'https://example.feishu.cn/base/base-a?table=global-orders&view=old', orderScope: 'community' };
const legacy = { baseToken: source.baseToken, orderTableId: source.orderTableId };
function fixture(t, path = ':memory:') {
  const store = new LocalStore({ path }); const service = new LocalService({ store, now: () => new Date(start) });
  store.importProducts([{ id: 'p1', name: '冻结售价商品', spec: '一盒', unit: '盒', priceCents: 1100, onSale: true,
    source: { platform: 'samsclub_cn', priceCents: 1000 } }]);
  store.setMeta('exportSource', source);
  const batches = ['甲群', '甲群', '乙群'].map(communityName => service.createBatch({ requestId: randomUUID(), communityName,
    feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: null } }).batch);
  for (const batch of batches) {
    const catalog = service.getCatalog(batch); const product = catalog.products[0]; const items = [{ productId: product.id, quantity: 2, version: product.version }];
    const quote = service.quote(batch, { phone: '13800138000', items, feePolicyVersion: catalog.batch.feePolicyVersion });
    service.submit(batch, { submissionId: randomUUID(), name: '顾客', phone: '13800138000', items,
      feePolicyVersion: quote.feePolicyVersion, feeQuoteVersion: quote.feeQuoteVersion });
    const line = store.listExportLines(batch.code)[0]; store.markExported(batch.code, line.lineId, line.revision, `remote-${batch.code}`);
    store.setMeta(`feishu-export:${batch.code}`, { status: 'success', lastSyncedAt: start, counts: { unchanged: 1, pending: 0 },
      pendingCreates: {}, viewUrl: `https://example.test/legacy/${batch.code}` });
  }
  t.after(() => { try { store.close(); } catch {} });
  return { store, service, batches };
}
function bind(f, batch, tableId = '甲群-orders', baseToken = source.baseToken) {
  return f.store.setCommunityOrderTable(baseToken, batch.communityId, { baseToken, communityId: batch.communityId,
    tableId, tableName: `${batch.communityName} · 订单`, status: 'ready', createAttempt: null });
}
const bindings = (store, code) => store.listOrderLines(code).map(({ lineId, revision, remoteRecordId, syncedRevision, syncError }) =>
  ({ lineId, revision, remoteRecordId, syncedRevision, syncError }));
const businessRows = store => ({
  submissions: store.db.prepare('SELECT * FROM submissions ORDER BY rowid').all(),
  lines: store.db.prepare('SELECT * FROM order_lines ORDER BY id').all().map(({ remote_record_id, synced_revision, export_error, ...line }) => line),
  split: store.db.prepare('SELECT * FROM split_settlements ORDER BY rowid').all(),
});

test('stable community bindings are shared by its periods but isolated across communities and Bases', t => {
  const f = fixture(t); const [first, second, other] = f.batches;
  assert.equal(first.communityId, second.communityId); assert.notEqual(first.communityId, other.communityId);
  assert.equal(f.store.getCommunityOrderTable(source.baseToken, first.communityId), null);
  const a = bind(f, first); const b = bind(f, other, '乙群-orders'); const alternate = bind(f, first, 'different-base-orders', 'base-b');
  assert.deepEqual(f.store.getCommunityOrderTable(source.baseToken, second.communityId), a);
  assert.deepEqual(f.store.getCommunityOrderTable(source.baseToken, other.communityId), b);
  assert.deepEqual(f.store.getCommunityOrderTable('base-b', second.communityId), alternate);
  for (const value of [{ ...a, communityId: other.communityId }, { ...a, baseToken: 'base-b' }, { ...a, status: 'unknown' }, { ...a, tableId: null }]) {
    assert.throws(() => f.store.setCommunityOrderTable(source.baseToken, first.communityId, value), { code: 'INVALID_COMMUNITY_ORDER_TABLE' });
  }
});

test('manual legacy migration archives only this period bindings and metadata without changing any frozen order amount or state', t => {
  const f = fixture(t); const [batch, sibling, other] = f.batches; bind(f, batch);
  const business = businessRows(f.store); const before = bindings(f.store, batch.code);
  const otherBindings = [sibling, other].map(b => bindings(f.store, b.code)); const previous = f.store.getMeta(`feishu-export:${batch.code}`);
  const destination = { baseToken: source.baseToken, orderTableId: '甲群-orders' };
  const switched = f.store.switchOrderExportDestination(batch.code, destination, { scope: 'community', tableName: '甲群 · 订单' });
  assert.deepEqual(switched.destination, destination); assert.equal(switched.scope, 'community'); assert.equal(switched.viewUrl, null);
  assert.equal(switched.legacyViewUrl, previous.viewUrl); assert.equal(switched.status, 'pending');
  const archive = f.store.getMeta(communityExportArchiveKey(legacy, batch.code));
  assert.deepEqual(archive.lines, before); assert.deepEqual(archive.meta, { ...previous, destination: legacy, scope: 'legacy' });
  assert.deepEqual(archive.destination, legacy); assert.equal(archive.scope, 'legacy');
  assert.equal(bindings(f.store, batch.code)[0].remoteRecordId, null); assert.equal(bindings(f.store, batch.code)[0].syncedRevision, 0);
  assert.deepEqual([sibling, other].map(b => bindings(f.store, b.code)), otherBindings); assert.deepEqual(businessRows(f.store), business);
  assert.equal(f.service.queryOrders(batch, '13800138000').totalCents, 2222);
  assert.equal(f.service.queryOrders(batch, '13800138000').feeTotalCents, 22);
  assert.deepEqual(f.store.switchOrderExportDestination(batch.code, destination, { scope: 'community', tableName: '甲群 · 订单' }), switched);
  const line = f.store.listExportLines(batch.code)[0]; f.store.markExported(batch.code, line.lineId, line.revision, 'new-community-row');
  const bound = bindings(f.store, batch.code);
  f.store.switchOrderExportDestination(batch.code, destination, { scope: 'community', tableName: '甲群重命名' });
  assert.deepEqual(bindings(f.store, batch.code), bound); assert.equal(f.store.getMeta(`feishu-export:${batch.code}`).tableName, '甲群重命名');
  f.store.switchOrderExportDestination(batch.code, legacy, { scope: 'legacy' });
  assert.equal(bindings(f.store, batch.code)[0].remoteRecordId, null);
  assert.equal(f.store.getMeta(communityExportArchiveKey(destination, batch.code)).lines[0].remoteRecordId, 'new-community-row');
  assert.deepEqual(businessRows(f.store), business);
});

test('uncertain creates can pin their original target but block migration atomically until reconciliation; archived uncertainty is not silently reused', t => {
  const f = fixture(t); const [batch] = f.batches; bind(f, batch);
  const key = `feishu-export:${batch.code}`; const before = bindings(f.store, batch.code); const business = businessRows(f.store);
  const unknown = { pendingCreates: { attempt: { outcome: 'unknown', attemptId: 'keep-this-attempt' } }, viewUrl: 'https://example.test/old' };
  f.store.setMeta(key, unknown);
  const stamped = f.store.switchOrderExportDestination(batch.code, legacy, { scope: 'legacy' });
  assert.deepEqual(stamped.pendingCreates, unknown.pendingCreates); assert.deepEqual(bindings(f.store, batch.code), before);
  const destination = { baseToken: source.baseToken, orderTableId: '甲群-orders' };
  assert.throws(() => f.store.switchOrderExportDestination(batch.code, destination), { code: 'ORDER_EXPORT_PENDING_CREATES' });
  assert.deepEqual(f.store.getMeta(key), stamped); assert.equal(f.store.getMeta(communityExportArchiveKey(legacy, batch.code)), null);
  assert.deepEqual(bindings(f.store, batch.code), before); assert.deepEqual(businessRows(f.store), business);
  f.store.setMeta(key, { ...stamped, pendingCreates: {} });
  f.store.setMeta(communityExportArchiveKey(destination, batch.code), { meta: unknown, lines: [] });
  assert.throws(() => f.store.switchOrderExportDestination(batch.code, destination), { code: 'ORDER_EXPORT_PENDING_CREATES' });
  f.store.db.prepare('DELETE FROM meta WHERE key=?').run(communityExportArchiveKey(destination, batch.code));
  f.store.switchOrderExportDestination(batch.code, destination);
  assert.equal(bindings(f.store, batch.code)[0].syncedRevision, 0);
  assert.equal(f.store.getMeta(communityExportArchiveKey(legacy, batch.code)).meta.pendingCreates.attempt, undefined);
});

test('overview and dirty counts represent the current group target and expose a legacy view only as a legacy link', t => {
  const f = fixture(t); const [first, second, other] = f.batches;
  let overview = f.service.overview(); assert.equal(overview.dirtyCount, 3); assert.equal(f.service.getStats().dirtyCount, 3);
  assert.equal(overview.ordersSync[first.code].groupTable.status, 'pending'); assert.equal(overview.ordersSync[first.code].viewUrl, null);
  assert.equal(overview.ordersSync[first.code].legacyViewUrl, `https://example.test/legacy/${first.code}`);
  assert.equal(f.store.listExportLines(first.code, { onlyDirty: true }).length, 1);
  f.store.setMeta('exportSource', null);
  assert.equal(f.service.overview().ordersSync[first.code].groupTable.status, 'unconfigured');
  f.store.setMeta('exportSource', { baseToken: source.baseToken, productTableId: source.productTableId });
  assert.equal(f.service.overview().ordersSync[first.code].groupTable.status, 'unconfigured');
  f.store.setMeta('exportSource', source);
  assert.equal(f.service.overview().ordersSync[first.code].groupTable.status, 'pending');
  f.store.setCommunityOrderTable(source.baseToken, first.communityId, { baseToken: source.baseToken, communityId: first.communityId,
    tableId: null, tableName: '甲群 · 订单', status: 'pending', createAttempt: { outcome: 'unknown' } });
  assert.equal(f.service.overview().ordersSync[second.code].groupTable.status, 'pending');
  bind(f, first); bind(f, other, '乙群-orders');
  const target = { baseToken: source.baseToken, orderTableId: '甲群-orders' };
  f.store.switchOrderExportDestination(first.code, target, { tableName: '甲群 · 订单' });
  const line = f.store.listExportLines(first.code)[0]; f.store.markExported(first.code, line.lineId, line.revision, 'new-row');
  const key = `feishu-export:${first.code}`; f.store.setMeta(key, { ...f.store.getMeta(key), status: 'success', viewUrl: 'https://example.test/group-view' });
  overview = f.service.overview(); assert.equal(overview.ordersSync[first.code].viewUrl, 'https://example.test/group-view');
  assert.equal(overview.ordersSync[first.code].groupTable.status, 'ready'); assert.equal(overview.ordersSync[first.code].pending, 0);
  assert.equal(overview.ordersSync[second.code].pending, 1); assert.equal(overview.ordersSync[second.code].viewUrl, null);
  const url = new URL(overview.ordersSync[first.code].groupTable.url); assert.equal(url.searchParams.get('table'), '甲群-orders'); assert.equal(url.searchParams.has('view'), false);
  assert.equal(overview.dirtyCount, 2); assert.equal(f.service.getStats().dirtyCount, 2); assert.equal(f.store.listExportLines(first.code, { onlyDirty: true }).length, 0);
  f.store.setMeta('exportSource', { ...source, orderTableId: 'another-historical-global' });
  assert.equal(f.store.listExportLines(first.code, { onlyDirty: true }).length, 0);
  f.store.setMeta('exportSource', { ...source, baseToken: 'base-b' });
  assert.equal(f.store.listExportLines(first.code, { onlyDirty: true }).length, 1); assert.equal(f.service.overview().ordersSync[first.code].viewUrl, null);
  assert.equal(f.store.getCommunityOrderTable(source.baseToken, first.communityId).tableId, target.orderTableId);
  f.store.setMeta('exportSource', source); f.service.updateOrder(first.code, line.lineId, { quantity: 3 });
  assert.equal(f.service.overview().ordersSync[first.code].pending, 1);
});

test('a failed binding reset rolls the archive and metadata back; missing original destination never discards historical record IDs', t => {
  const f = fixture(t); const [batch] = f.batches; const before = bindings(f.store, batch.code); const meta = f.store.getMeta(`feishu-export:${batch.code}`);
  const target = { baseToken: source.baseToken, orderTableId: '甲群-orders' };
  f.store.db.exec("CREATE TRIGGER fail_switch BEFORE UPDATE OF remote_record_id ON order_lines BEGIN SELECT RAISE(ABORT,'switch failed'); END");
  assert.throws(() => f.store.switchOrderExportDestination(batch.code, target), /switch failed/);
  assert.deepEqual(bindings(f.store, batch.code), before); assert.deepEqual(f.store.getMeta(`feishu-export:${batch.code}`), meta);
  assert.equal(f.store.getMeta(communityExportArchiveKey(legacy, batch.code)), null); f.store.db.exec('DROP TRIGGER fail_switch');
  f.store.setMeta('exportSource', { baseToken: source.baseToken });
  assert.throws(() => f.store.switchOrderExportDestination(batch.code, target), { code: 'ORDER_EXPORT_DESTINATION_UNKNOWN' });
  assert.deepEqual(bindings(f.store, batch.code), before);
  assert.throws(() => f.store.switchOrderExportDestination('missing', target), { code: 'BATCH_NOT_FOUND' });
  for (const target of [{ baseToken: 'base-a' }, { baseToken: 'base-a', orderTableId: '' }, { ...legacy, extra: true }]) {
    assert.throws(() => f.store.switchOrderExportDestination(batch.code, target), { code: 'INVALID_ORDER_EXPORT_DESTINATION' });
  }
});

test('reopening and restoring an archived period retains its stable group table; startup does not migrate any old record binding', t => {
  const dir = mkdtempSync(join(tmpdir(), 'community-order-restart-')); const path = join(dir, 'orders.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true })); const f = fixture(t, path); const [batch, sibling] = f.batches;
  const binding = bind(f, batch); const destination = { baseToken: source.baseToken, orderTableId: binding.tableId };
  f.store.switchOrderExportDestination(batch.code, destination, { tableName: binding.tableName });
  const line = f.store.listExportLines(batch.code)[0]; f.store.markExported(batch.code, line.lineId, line.revision, 'community-row');
  f.service.updateBatch(batch.code, { collecting: false }); f.service.deleteBatch(batch.code);
  const business = businessRows(f.store); const beforeBindings = f.batches.map(b => bindings(f.store, b.code)); f.store.close();
  const reopened = new LocalStore({ path }); t.after(() => reopened.close()); const service = new LocalService({ store: reopened });
  assert.deepEqual(f.batches.map(b => bindings(reopened, b.code)), beforeBindings); assert.deepEqual(businessRows(reopened), business);
  assert.deepEqual(reopened.getCommunityOrderTable(source.baseToken, sibling.communityId), binding);
  assert.equal(reopened.getBatch(batch.code), null); assert.equal(service.overview().ordersSync[batch.code], undefined);
  service.restoreBatch(batch.code); assert.equal(reopened.getBatch(batch.code).collecting, false);
  assert.equal(service.overview().ordersSync[batch.code].groupTable.tableId, binding.tableId);
  assert.equal(reopened.listExportLines(batch.code, { onlyDirty: true }).length, 0); assert.equal(service.queryOrders(batch, '13800138000').totalCents, 2222);
  assert.equal(reopened.listExportLines(sibling.code, { onlyDirty: true }).length, 1);
  // Explicit shared mode is an internal compatibility option for old protocol
  // fixtures; real community mode must never infer it from legacy export meta.
  reopened.setMeta('exportSource', { ...source, orderScope: 'shared' });
  assert.equal(reopened.listExportLines(sibling.code, { onlyDirty: true }).length, 0);
  reopened.setMeta('exportSource', source); assert.equal(reopened.listExportLines(sibling.code, { onlyDirty: true }).length, 1);
});
