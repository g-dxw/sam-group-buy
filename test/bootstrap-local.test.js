import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from '../server/local-store.js';
import { markLegacyExportsPending } from '../server/bootstrap-local.js';

test('legacy rows need one export of new reporting fields, without resetting later syncs', t => {
  const store = new LocalStore({ path: ':memory:' }); t.after(() => store.close());
  const products = [{ id: 'P1', name: '牛奶', spec: '24盒', unit: '箱', priceCents: 6990, category: '乳品', onSale: true, sort: 1 }];
  const id = '4eaed197-3d6d-4b90-8bff-a167d13f0d31';
  const line = { recordId: 'remote-1', lineId: `${id}:P1`, submissionId: id, productId: 'P1', phone: '13800000000', name: '测试',
    quantity: 2, status: '待采购', syncStatus: '已确认', expectedLines: 1, submittedAt: new Date().toISOString() };
  store.importLegacyBatch({ code: 'old', name: '原小区' }, { title: '旧期', collecting: true }, products, [line]);
  assert.equal(store.listExportLines('old')[0].syncedRevision, 0);
  store.markExported('old', line.lineId, 1, 'remote-1');
  markLegacyExportsPending(store);
  assert.equal(store.listExportLines('old')[0].syncedRevision, 0);
  store.markExported('old', line.lineId, 1, 'remote-1');
  markLegacyExportsPending(store);
  assert.equal(store.listExportLines('old')[0].syncedRevision, 1);
  assert.equal(store.listOrderLines('old')[0].quantity, 2);
});
