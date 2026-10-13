import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore, productVersion, samsStoreKey } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { CustomerSelection, customerOwner } from '../server/customer-selection.js';
import { billLines, billingSummary, incrementalBilling, normalizeFeePolicy } from '../server/order-billing.js';

const phone = '13800138000';
const time = Date.parse('2026-10-13T03:00:00Z');
const shop = { cityCode: '500100', storeId: '6513', storeType: 2, name: '重庆渝北店', cityName: '重庆市' };
const regular = { id: 'regular', name: '推荐商品', spec: '1盒', unit: '盒', priceCents: 2980, onSale: true, category: '其他' };

function fixture(t, { policy = { recommendedRateBps: 100, selfSelectedRateBps: 200 }, price = 2980, path = ':memory:' } = {}) {
  const store = new LocalStore({ path });
  let now = time;
  const service = new LocalService({ store, now: () => new Date(now) });
  if (!store.listProducts().length) store.importProducts([{ ...regular, priceCents: price }]);
  const batch = store.listBatches()[0] || service.createBatch({ requestId: randomUUID(), communityName: '收费测试', samsStore: shop, feePolicy: policy }).batch;
  const token = randomUUID();
  const customer = new CustomerSelection({ store, service, sams: new Proxy({}, { get: () => { throw new Error('quote must not call upstream'); } }), now: () => now });
  t.after(() => { try { store.close(); } catch {} });
  return { store, service, batch, token, customer, advance: ms => { now += ms; } };
}
function addPersonal(f, price = 6900) {
  const product = { ...regular, id: 'self_2_6513_beef', name: '自选牛肉', priceCents: price, selfSelected: true,
    version: 'a'.repeat(64), selectable: true, spuId: 'beef', expiresAt: new Date(time + 30 * 60000).toISOString(),
    quotedAt: new Date(time).toISOString(), source: { platform: 'samsclub_cn', spuId: 'beef', storeId: '6513', storeType: 2, customerSelected: true } };
  f.store.saveCustomerProduct(f.batch.code, customerOwner(f.token), samsStoreKey(shop), product, time);
  return product;
}
function body(f, productList = f.service.getCatalog(f.batch).products, extra = {}) {
  const input = { submissionId: randomUUID(), phone, name: '客户', note: '',
    feePolicyVersion: f.service.getCatalog(f.batch).batch.feePolicyVersion,
    items: productList.map(product => ({ productId: product.id, quantity: 1, version: product.version })), ...extra };
  input.feeQuoteVersion = f.customer.quote(f.batch, f.token, quoteBody(input)).feeQuoteVersion;
  return input;
}
function quoteBody(input) { return { items: input.items, phone: input.phone, feePolicyVersion: input.feePolicyVersion }; }

test('fee policies validate integer basis points, inheritance and explicit zero; rate and recommendation membership are versioned', t => {
  const f = fixture(t);
  assert.deepEqual(normalizeFeePolicy(), { recommendedRateBps: 0, selfSelectedRateBps: null });
  for (const policy of [null, [], { recommendedRateBps: -1, selfSelectedRateBps: null }, { recommendedRateBps: 10001, selfSelectedRateBps: 0 },
    { recommendedRateBps: 0.1, selfSelectedRateBps: 0 }, { recommendedRateBps: 100, selfSelectedRateBps: false },
    { recommendedRateBps: 100, selfSelectedRateBps: null, forged: 1 }]) assert.throws(() => normalizeFeePolicy(policy), { code: 'INVALID_FEE_POLICY' });
  const initial = f.service.getCatalog(f.batch).batch.feePolicyVersion;
  assert.match(initial, /^[0-9a-f]{64}$/);
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: null } });
  const inherited = f.service.getCatalog(f.batch).batch.feePolicyVersion;
  assert.notEqual(inherited, initial);
  const personal = addPersonal(f);
  const input = body(f, [personal]);
  assert.equal(f.customer.quote(f.batch, f.token, quoteBody(input)).feeTotalCents, 69);
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: 0 } });
  assert.throws(() => f.customer.quote(f.batch, f.token, quoteBody(input)), { code: 'FEE_POLICY_CHANGED' });
  const zero = body(f, [personal]);
  assert.equal(f.customer.quote(f.batch, f.token, quoteBody(zero)).feeTotalCents, 0);
  f.store.addCustomerCatalogProduct(personal);
  f.service.updateProduct(personal.id, { onSale: true });
  f.service.updateBatch(f.batch.code, { productIds: ['regular', personal.id] });
  assert.notEqual(f.service.getCatalog(f.batch).batch.feePolicyVersion, zero.feePolicyVersion);
  assert.throws(() => f.customer.quote(f.batch, f.token, quoteBody(zero)), { code: 'FEE_POLICY_CHANGED' });
});

test('mixed fees use trusted prices and saved categories, apply current rates, keep procurement goods separate and preserve UUID replay', t => {
  const f = fixture(t); const personal = addPersonal(f);
  const input = body(f, [...f.service.getCatalog(f.batch).products, personal]);
  const quoted = f.customer.quote(f.batch, f.token, quoteBody(input));
  assert.equal(quoted.goodsTotalCents, 9880);
  assert.equal(quoted.recommendedFeeCents, 30);
  assert.equal(quoted.selfSelectedFeeCents, 138);
  assert.equal(quoted.totalCents, 10048);
  assert.match(quoted.feeQuoteVersion, /^[0-9a-f]{64}$/);
  const prepared = new Map([[personal.id, personal]]);
  const result = f.service.submit(f.batch, { ...input, feeQuoteVersion: quoted.feeQuoteVersion }, { customerProducts: prepared, ownerHash: customerOwner(f.token) });
  const query = f.service.queryOrders(f.batch, phone);
  assert.equal(query.totalCents, quoted.totalCents);
  assert.deepEqual(query.feeBreakdown, quoted.feeBreakdown);
  const stats = f.service.getStats([f.batch.code]);
  assert.equal(stats.products.reduce((sum, product) => sum + product.amountCents, 0), 9880);
  assert.equal(stats.customers[0].feeTotalCents, 168);
  assert.equal(stats.totalCents, 10048);
  assert.deepEqual(stats.orders.map(line => [line.selfSelected, line.feeCategory, line.feeRateBps, line.feeCents]),
    [[false, 'recommended', 100, 30], [true, 'selfSelected', 200, 138]]);
  f.service.updateProduct('regular', { priceCents: 9999, name: '已改价' });
  f.service.updateProduct(personal.id, { priceCents: 8888, onSale: true });
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 1000, selfSelectedRateBps: 5000 }, collecting: false });
  assert.equal(f.service.queryOrders(f.batch, phone).totalCents, 13628);
  assert.deepEqual(f.service.queryOrders(f.batch, phone).feeBreakdown.map(row => [row.category, row.rateBps, row.feeCents]),
    [['recommended', 1000, 298], ['selfSelected', 5000, 3450]]);
  assert.equal(f.store.listExportLines(f.batch.code)[0].productName, regular.name);
  assert.deepEqual(f.service.submit(f.batch, input, { ownerHash: customerOwner(f.token) }), result);
  assert.deepEqual(f.service.submit(f.batch, { ...input, feePolicyVersion: 'b'.repeat(64), feeQuoteVersion: 'c'.repeat(64) }, { ownerHash: customerOwner(f.token) }), result);
  assert.equal(f.store.listOrderLines(f.batch.code).length, 2);
  assert.throws(() => f.service.submit(f.batch, { ...input, name: '不同人' }, { ownerHash: customerOwner(f.token) }), { code: 'SUBMISSION_CONFLICT' });
});

test('quotes are read-only, isolate private products and permit expired trusted estimates while enforcing changed price and ownership', t => {
  const f = fixture(t); const personal = addPersonal(f); const input = body(f, [personal]);
  const before = JSON.stringify(f.store.listCustomerProducts(f.batch.code, customerOwner(f.token)));
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(f.customer.quote(f.batch, f.token, quoteBody(input)).quoteExpired, false);
  assert.throws(() => f.customer.quote(f.batch, randomUUID(), quoteBody(input)), { code: 'SELF_PRODUCT_CHANGED' });
  assert.throws(() => f.customer.quote(f.batch, null, quoteBody(input)), { code: 'CUSTOMER_TOKEN_REQUIRED' });
  assert.throws(() => f.customer.quote(f.batch, f.token, { ...quoteBody(input), priceCents: 1 }), { code: 'INVALID_QUOTE' });
  assert.throws(() => f.customer.quote(f.batch, f.token, { ...quoteBody(input), phone: 'bad' }), { code: 'INVALID_PHONE' });
  f.advance(31 * 60000);
  assert.equal(f.customer.quote(f.batch, f.token, quoteBody(input)).quoteExpired, true);
  assert.equal(JSON.stringify(f.store.listCustomerProducts(f.batch.code, customerOwner(f.token))), before);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.throws(() => f.service.submit(f.batch, input, { customerProducts: new Map([[personal.id, personal]]), ownerHash: customerOwner(f.token) }), { code: 'SELF_PRODUCT_CHANGED' });
  const ordinary = body(f);
  f.service.updateProduct('regular', { priceCents: 3000 });
  assert.throws(() => f.customer.quote(f.batch, null, quoteBody(ordinary)), { code: 'PRODUCT_CHANGED' });
});

test('supplemental quotes charge the rounded customer-period increment; changing existing lines invalidates the quote and reallocation dirties exports', t => {
  const f = fixture(t, { policy: { recommendedRateBps: 100, selfSelectedRateBps: null }, price: 50 });
  const first = body(f, undefined, { submissionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  f.service.submit(f.batch, first);
  const initial = f.store.listExportLines(f.batch.code)[0];
  assert.equal(initial.feeCents, 1);
  f.store.markExported(f.batch.code, initial.lineId, initial.revision, 'remote-first');
  const second = body(f, undefined, { submissionId: '00000000-0000-4000-8000-000000000001' });
  const quote = f.customer.quote(f.batch, null, quoteBody(second));
  assert.equal(quote.goodsTotalCents, 50);
  assert.equal(quote.feeTotalCents, 0);
  assert.equal(quote.totalCents, 50);
  f.service.submit(f.batch, { ...second, feeQuoteVersion: quote.feeQuoteVersion });
  const lines = f.store.listExportLines(f.batch.code);
  assert.deepEqual(lines.map(line => line.feeCents), [0, 1]);
  assert.equal(lines[0].revision, 2);
  assert.equal(lines[0].syncedRevision, 1);
  assert.equal(f.service.queryOrders(f.batch, phone).feeTotalCents, 1);
  const third = body(f);
  const stale = f.customer.quote(f.batch, null, quoteBody(third));
  f.service.updateOrder(f.batch.code, lines[1].lineId, { status: '缺货' });
  assert.throws(() => f.service.submit(f.batch, { ...third, feeQuoteVersion: stale.feeQuoteVersion }), { code: 'FEE_QUOTE_CHANGED' });
  const changed = f.store.listExportLines(f.batch.code);
  assert.deepEqual(changed.map(line => [line.amountCents, line.feeCents]), [[50, 1], [0, 0]]);
  assert.equal(changed[0].revision, 3);
  f.service.updateOrder(f.batch.code, changed[0].lineId, { quantity: 3 });
  assert.equal(f.service.queryOrders(f.batch, phone).feeTotalCents, 2);
  f.service.updateOrder(f.batch.code, changed[0].lineId, { status: '已取消' });
  assert.equal(f.service.queryOrders(f.batch, phone).totalCents, 0);
  assert.ok(f.store.listExportLines(f.batch.code).every(line => line.payableCents === 0));
});

test('legacy and new orders adopt current fees and replay offline; new charged orders require current confirmation versions', t => {
  const f = fixture(t, { policy: { recommendedRateBps: 0, selfSelectedRateBps: null } });
  const legacy = body(f); delete legacy.feePolicyVersion;
  f.store.saveSubmission(f.batch.code, f.service.normalizeOrder(legacy));
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: null } });
  const next = body(f);
  assert.throws(() => f.service.submit(f.batch, { ...next, feePolicyVersion: undefined }), { code: 'FEE_POLICY_CHANGED' });
  assert.throws(() => f.service.submit(f.batch, { ...next, feeQuoteVersion: undefined }), { code: 'FEE_QUOTE_CHANGED' });
  assert.throws(() => f.service.submit(f.batch, { ...next, feePolicyVersion: legacy.feePolicyVersion || '0'.repeat(64) }), { code: 'FEE_POLICY_CHANGED' });
  f.service.submit(f.batch, next);
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 200, selfSelectedRateBps: null } });
  f.service.submit(f.batch, body(f));
  const query = f.service.queryOrders(f.batch, phone);
  assert.deepEqual(query.feeBreakdown.map(row => [row.rateBps, row.goodsCents, row.feeCents]), [[200, 8940, 179]]);
  assert.equal(query.totalCents, 9119);
  f.service.updateBatch(f.batch.code, { collecting: false });
  assert.equal(f.service.submit(f.batch, { ...legacy, feePolicyVersion: 'f'.repeat(64) }).status, 'completed');
});

test('rounding uses exact integer arithmetic per customer and period, including large valid amounts, not a global re-round', () => {
  const line = (id, amount, phoneValue = phone, batchCode = 'batch', rate = 100) => ({ lineId: id, batchCode, phone: phoneValue,
    amountCents: amount, snapshot: { feeCategory: 'recommended', feeRateBps: rate, selfSelected: false } });
  const bill = billLines([line('a', 50), line('b', 50, '13900139000'), line('c', 50, phone, 'other')]);
  assert.deepEqual(bill.map(row => row.feeCents), [1, 1, 1]);
  assert.equal(billingSummary(bill).feeTotalCents, 3);
  const big = 2_000_000_000_000;
  const exact = billLines([line('big', big, phone, 'batch', 9999)]);
  assert.equal(exact[0].feeCents, Number((BigInt(big) * 9999n + 5000n) / 10000n));
  assert.equal(incrementalBilling([line('a', 50)], [line('b', 50)]).feeTotalCents, 0);
  assert.throws(() => billLines([line('a', Number.MAX_SAFE_INTEGER, phone, 'batch', 10000)]), { code: 'AMOUNT_TOO_LARGE' });
});

test('price snapshots and current fee policies survive reopening SQLite', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-fee-restart-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite'); const f = fixture(t, { path });
  const input = body(f); f.service.submit(f.batch, input);
  const saved = f.service.queryOrders(f.batch, phone);
  f.store.close();
  const restored = fixture(t, { path });
  assert.deepEqual(restored.service.queryOrders(f.batch, phone), saved);
  assert.deepEqual(restored.service.getCatalog(f.batch).batch.feePolicy, { recommendedRateBps: 100, selfSelectedRateBps: 200 });
});

test('updating period fees recalculates existing self selections, queries, stats and export revisions without rewriting snapshots', t => {
  const f = fixture(t, { policy: { recommendedRateBps: 100, selfSelectedRateBps: 0 } });
  const personal = addPersonal(f, 2990);
  const input = body(f, [...f.service.getCatalog(f.batch).products, personal]);
  const owner = customerOwner(f.token);
  const result = f.service.submit(f.batch, input, { customerProducts: new Map([[personal.id, personal]]), ownerHash: owner });
  const before = f.store.listExportLines(f.batch.code);
  const snapshots = f.store.listOrderLines(f.batch.code).map(line => line.snapshot);
  for (const line of before) f.store.markExported(f.batch.code, line.lineId, line.revision, `remote:${line.lineId}`);
  const oldVersion = f.service.queryOrders(f.batch, phone).feePolicyVersion;
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 200, selfSelectedRateBps: null } });
  const query = f.service.queryOrders(f.batch, phone);
  assert.notEqual(query.feePolicyVersion, oldVersion);
  assert.equal(query.feePolicyVersion, f.service.getCatalog(f.batch).batch.feePolicyVersion);
  assert.deepEqual([query.goodsTotalCents, query.recommendedFeeCents, query.selfSelectedFeeCents, query.totalCents], [5970, 60, 60, 6090]);
  const stats = f.service.getStats([f.batch.code]);
  assert.deepEqual([stats.goodsTotalCents, stats.feeTotalCents, stats.totalCents], [5970, 120, 6090]);
  assert.deepEqual(f.store.listOrderLines(f.batch.code).map(line => line.snapshot), snapshots);
  assert.deepEqual(f.store.listExportLines(f.batch.code).map(line => [line.feeRateBps, line.revision, line.syncedRevision]), [[200, 2, 1], [200, 2, 1]]);
  assert.deepEqual(f.service.submit(f.batch, input, { ownerHash: owner }), result);
  assert.deepEqual(f.service.getSubmission(f.batch, input.submissionId), result);
  assert.equal(f.store.listOrderLines(f.batch.code).length, 2);
  f.service.updateBatch(f.batch.code, { productIds: ['regular'], feePolicy: { recommendedRateBps: 200, selfSelectedRateBps: 0 } });
  assert.deepEqual(f.store.listExportLines(f.batch.code).map(line => [line.feeCategory, line.feeRateBps, line.revision]),
    [['recommended', 200, 2], ['selfSelected', 0, 3]]);
  assert.equal(f.service.queryOrders(f.batch, phone).feeTotalCents, 60);
});

test('supplemental quotes recompute the existing zero-rate snapshot before charging the current rounded increment', t => {
  const f = fixture(t, { policy: { recommendedRateBps: 0, selfSelectedRateBps: null }, price: 25 });
  f.service.submit(f.batch, body(f));
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 200, selfSelectedRateBps: null } });
  assert.equal(f.service.queryOrders(f.batch, phone).feeTotalCents, 1);
  const next = body(f);
  const quote = f.service.quote(f.batch, quoteBody(next));
  assert.deepEqual([quote.goodsTotalCents, quote.feeTotalCents, quote.totalCents], [25, 0, 25]);
  f.service.submit(f.batch, next);
  assert.deepEqual(f.service.queryOrders(f.batch, phone).feeBreakdown.map(row => [row.rateBps, row.goodsCents, row.feeCents]), [[200, 50, 1]]);
});

test('a failed export revision update rolls the entire period fee edit back', t => {
  const f = fixture(t, { policy: { recommendedRateBps: 0, selfSelectedRateBps: null } });
  f.service.submit(f.batch, body(f));
  const before = f.store.listExportLines(f.batch.code);
  f.store.db.exec("CREATE TRIGGER fail_fee_revision BEFORE UPDATE OF revision ON order_lines BEGIN SELECT RAISE(ABORT,'forced fee revision failure'); END");
  assert.throws(() => f.store.updateBatch(f.batch.code, { title: 'must roll back',
    feePolicy: { recommendedRateBps: 200, selfSelectedRateBps: null } }), /forced fee revision failure/);
  assert.equal(f.store.getBatch(f.batch.code).title, f.batch.title);
  assert.deepEqual(f.store.getBatch(f.batch.code).feePolicy, f.batch.feePolicy);
  assert.deepEqual(f.store.listExportLines(f.batch.code), before);
});

test('one-time local billing upgrade marks historical zero-rate backups dirty and keeps snapshots and remote IDs intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-current-fee-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite');
  const f = fixture(t, { path, policy: { recommendedRateBps: 0, selfSelectedRateBps: 0 } });
  const personal = addPersonal(f, 2990);
  const input = body(f, [personal]);
  f.service.submit(f.batch, input, { customerProducts: new Map([[personal.id, personal]]), ownerHash: customerOwner(f.token) });
  const saved = f.store.listOrderLines(f.batch.code)[0];
  f.store.markExported(f.batch.code, saved.lineId, 1, 'old-remote-record');
  const archived = f.service.createBatch({ requestId: randomUUID(), communityName: '归档收费测试', productIds: ['regular'],
    feePolicy: { recommendedRateBps: 0, selfSelectedRateBps: null } }).batch;
  f.service.submit(archived, body({ ...f, batch: archived }));
  const archivedLine = f.store.listOrderLines(archived.code)[0];
  f.store.markExported(archived.code, archivedLine.lineId, 1, 'archived-remote-record');
  // Model a database written by the previous frozen-rate implementation.
  f.store.db.prepare('UPDATE batches SET fee_policy_json=? WHERE code=?')
    .run(JSON.stringify({ recommendedRateBps: 200, selfSelectedRateBps: 200 }), f.batch.code);
  f.store.db.prepare('UPDATE batches SET fee_policy_json=?,deleted_at=?,collecting=0 WHERE code=?')
    .run(JSON.stringify({ recommendedRateBps: 200, selfSelectedRateBps: null }), new Date(time).toISOString(), archived.code);
  f.store.setMeta('orderBillingPolicyVersion', 'frozen-rates');
  f.store.close();
  const restored = fixture(t, { path });
  const line = restored.store.listExportLines(f.batch.code)[0];
  assert.deepEqual([line.priceCents, line.feeCategory, line.feeRateBps, line.feeCents, line.payableCents], [2990, 'selfSelected', 200, 60, 3050]);
  assert.deepEqual([line.revision, line.syncedRevision, line.remoteRecordId], [2, 1, 'old-remote-record']);
  assert.deepEqual(line.snapshot, saved.snapshot);
  const hiddenLine = restored.store.listExportLines(archived.code, { includeDeleted: true })[0];
  assert.deepEqual([hiddenLine.feeRateBps, hiddenLine.revision, hiddenLine.syncedRevision, hiddenLine.remoteRecordId], [200, 2, 1, 'archived-remote-record']);
  assert.equal(restored.store.getBatch(archived.code), null);
  assert.equal(restored.store.getMeta('orderBillingPolicyVersion'), 'current-batch-fees-v1');
  restored.store.close();
  const reopened = fixture(t, { path });
  assert.deepEqual(reopened.store.listExportLines(f.batch.code)[0], line);
  assert.deepEqual(reopened.store.listExportLines(archived.code, { includeDeleted: true })[0], hiddenLine);
});
