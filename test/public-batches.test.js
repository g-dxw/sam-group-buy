import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';

const start = Date.parse('2026-10-13T10:00:00Z');
const publicKeys = ['code', 'communityName', 'title', 'periodLabel', 'periodNumber', 'description', 'cutoffAt', 'pickupAt', 'pickupLocation', 'productCount', 'coverImages'];
function fixture(t) {
  let clock = start; const store = new LocalStore({ path: ':memory:' });
  store.importProducts(Array.from({ length: 5 }, (_, i) => ({ id: `p${i + 1}`, name: `商品${i + 1}`, spec: '一箱', unit: '箱', priceCents: 1000,
    onSale: true, sort: i, imageUrl: `https://images.test/${i + 1}.jpg`, source: { privateToken: 'private-source-data' } })));
  const service = new LocalService({ store, now: () => new Date(clock), sams: { sourcePrice: () => { throw new Error('public listing must never fetch upstream'); } } });
  t.after(() => store.close());
  const create = (name, extra = {}) => service.createBatch({ requestId: randomUUID(), communityName: name, ...extra }).batch;
  return { store, service, create, advance: ms => clock += ms };
}

test('public list includes every ongoing period independent of default and follows catalog cutoff/deletion semantics', t => {
  const f = fixture(t);
  const open = f.create('开放群', { description: '公开介绍', pickupLocation: '公开取货点', pickupAt: new Date(start + 3_600_000).toISOString() });
  const expiring = f.create('即将截单', { cutoffAt: new Date(start + 1000).toISOString() });
  const closed = f.create('手动已关闭', { collecting: false });
  const cutoff = f.create('已到截单', { cutoffAt: new Date(start).toISOString() });
  const deleted = f.create('已删除', { collecting: false }); f.service.deleteBatch(deleted.code);
  f.store.setMeta('defaultBatch', closed.code);
  let result = f.service.listPublicBatches(); assert.deepEqual(result.batches.map(b => b.code), [expiring.code, open.code]);
  assert.equal(result.batches.find(b => b.code === open.code).description, '公开介绍');
  assert.equal(result.batches.find(b => b.code === open.code).pickupLocation, '公开取货点');
  for (const batch of [open, expiring, closed, cutoff]) assert.equal(result.batches.some(b => b.code === batch.code), f.service.getCatalog(batch).batch.collecting);
  f.advance(1000); assert.equal(f.service.getCatalog(expiring).batch.collecting, false);
  assert.deepEqual(f.service.listPublicBatches().batches.map(b => b.code), [open.code]);
  assert.equal(f.service.getCatalog(closed).products.length, 5);
});

test('public cards count only saleable recommendations, cap current covers at three, and never include private/order/sync fields', t => {
  const f = fixture(t); const batch = f.create('公开群', { contactNote: 'private-contact', description: '客户可以看到的介绍' });
  const p = f.service.getCatalog(batch).products[0];
  f.service.submit(batch, { submissionId: randomUUID(), name: 'private-customer-name', phone: '13800138000', note: 'private-order-note',
    items: [{ productId: p.id, quantity: 1, version: p.version }] });
  f.store.setMeta('exportSource', { baseToken: 'private-base', productTableId: 'private-product-table', orderTableId: 'private-order-table' });
  f.store.setMeta(`feishu-export:${batch.code}`, { viewUrl: 'https://private-sync.test', pendingCreates: { 'private-attempt': { outcome: 'unknown' } } });
  f.store.saveCustomerProduct(batch.code, 'private-owner', 'private-store', { id: 'private-personal-id', name: 'private-personal-name',
    spec: '一盒', unit: '盒', priceCents: 1000, onSale: true, source: { customerSelected: true } }, start);
  const card = f.service.listPublicBatches().batches[0];
  assert.deepEqual(Object.keys(card).sort(), [...publicKeys].sort()); assert.equal(card.productCount, 5);
  assert.deepEqual(card.coverImages, ['https://images.test/1.jpg', 'https://images.test/2.jpg', 'https://images.test/3.jpg']);
  assert.equal(JSON.stringify(card).includes('private-'), false); assert.equal(JSON.stringify(card).includes('13800138000'), false);
  f.service.updateProduct('p1', { onSale: false }); f.service.removeProduct('p2');
  const current = f.service.listPublicBatches().batches[0]; assert.equal(current.productCount, 3);
  assert.deepEqual(current.coverImages, ['https://images.test/3.jpg', 'https://images.test/4.jpg', 'https://images.test/5.jpg']);
  f.service.updateBatch(batch.code, { productIds: ['p3'] });
  assert.equal(f.service.listPublicBatches().batches[0].productCount, 1);
  assert.deepEqual(f.service.listPublicBatches().batches[0].coverImages, ['https://images.test/3.jpg']);
});

test('settled split recommendations do not advertise saleable products; ongoing zero-product periods still have a public entry', t => {
  const f = fixture(t); const batch = f.create('拼份群', { productIds: ['p1'],
    splitRules: { p1: { partsPerPack: 2, portionSpec: '半箱', priceCents: 500 } } });
  assert.equal(f.service.listPublicBatches().batches[0].productCount, 1);
  f.service.updateBatch(batch.code, { collecting: false }); f.service.confirmSplit(batch.code, 'p1', { remainderPolicy: 'cancel' });
  f.service.updateBatch(batch.code, { collecting: true });
  const card = f.service.listPublicBatches().batches[0]; assert.equal(card.code, batch.code);
  assert.equal(card.productCount, 0); assert.deepEqual(card.coverImages, []);
  assert.equal(f.service.getCatalog(batch).products.filter(p => p.onSale).length, 0);
});

test('empty or all-closed local data returns an empty list without changing metadata or default batch', t => {
  const f = fixture(t); assert.deepEqual(f.service.listPublicBatches(), { batches: [] });
  const closed = f.create('已关闭', { collecting: false }); const before = f.store.getMeta('defaultBatch');
  assert.deepEqual(f.service.listPublicBatches(), { batches: [] }); assert.equal(f.store.getMeta('defaultBatch'), before);
  assert.equal(f.store.getBatch(closed.code).collecting, false);
});
