import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { SamsCatalog } from '../server/sams-catalog.js';
import { CustomerSelection, customerOwner } from '../server/customer-selection.js';

const token = randomUUID();
const otherToken = randomUUID();
const fixedStore = { cityCode: '440300', storeId: '6505', storeType: 2, name: '深圳福田店', cityName: '深圳市' };
const differentStore = { ...fixedStore, storeId: '6506', name: '深圳龙华店' };
const start = Date.parse('2026-10-12T10:00:00Z');
const ordinary = { id: 'ordinary', name: '团长推荐', spec: '一盒', unit: '盒', priceCents: 1000, category: '其他', onSale: true, sort: 0 };
const makeRow = (spuId, price = 2980, extra = {}) => ({ spuId, storeId: '6505', storeType: 2, title: `商品 ${spuId} 1kg`,
  subTitle: '可信官方说明', images: [`https://images.test/${spuId}.jpg`], image: `https://images.test/${spuId}.jpg`,
  priceInfo: [{ priceType: 2, price: '0' }, { priceType: 1, price: String(price) }],
  isAvailable: true, isStoreAvailable: true, isPutOnSale: true, stockInfo: { stockQuantity: 5, safeStockQuantity: 0 }, ...extra });

function fixture(t, path = ':memory:') {
  let time = start;
  const store = new LocalStore({ path });
  const service = new LocalService({ store, now: () => new Date(time) });
  if (!store.listProducts().length) store.importProducts([ordinary]);
  const batch = store.listBatches()[0] || service.createBatch({ requestId: randomUUID(), communityName: '测试小区', samsStore: fixedStore }).batch;
  const state = { rows: [makeRow('111'), makeRow('222')], detail: new Map(), calls: [], hook: null, offline: false };
  const sams = new SamsCatalog({ now: () => time, fetchImpl: async (url, init) => {
    if (!String(url).startsWith('https://api-sams.walmartmobile.cn/api/v1/sams/')) throw new Error('remote calls forbidden');
    if (state.offline) throw new Error('mock offline');
    const body = JSON.parse(init.body); state.calls.push({ url, body });
    let data;
    if (url.endsWith('allAddressList')) data = { list: [{ cityCode: '440300', cityName: '深圳市' }] };
    else if (url.endsWith('getStoreListByCityCodePlus')) data = [{ storeId: '6505', storeType: 2, storeName: '深圳福田店' }, { storeId: '6506', storeType: 2, storeName: '深圳龙华店' }];
    else if (url.endsWith('goods-portal/spu/search')) data = { dataList: state.rows, hasNextPage: false, totalCount: state.rows.length };
    else if (url.endsWith('querySpuDetailToNFC')) {
      if (state.hook) await state.hook(body);
      data = state.detail.has(body.spuIdList[0]) ? state.detail.get(body.spuIdList[0]) : state.rows.find(row => row.spuId === body.spuIdList[0]);
    } else throw new Error('unexpected mock endpoint');
    return new Response(JSON.stringify({ code: 'Success', data }));
  } });
  const customer = new CustomerSelection({ store, service, sams, now: () => time });
  t.after(() => { try { store.close(); } catch {} });
  return { store, service, sams, customer, batch, state, advance: ms => { time += ms; } };
}
async function add(f, spuId = '111', owner = token) {
  const search = await f.customer.search(f.batch, owner, { keyword: '商品', page: 1 });
  return (await f.customer.add(f.batch, owner, { selectionId: search.selectionId, spuId })).product;
}
function order(f, products, overrides = {}) {
  return { submissionId: randomUUID(), phone: '13800138000', name: '测试顾客', note: '',
    items: products.map(product => ({ productId: product.id, quantity: 1, version: product.version })), ...overrides };
}
const mockDetailCalls = f => f.state.calls.filter(call => call.url.endsWith('querySpuDetailToNFC'));

test('private quotes and selections bind customer/batch/store and never pollute the public scope before submitting', async t => {
  const f = fixture(t);
  await assert.rejects(f.customer.search(f.batch, undefined, { keyword: '商品' }), { code: 'CUSTOMER_TOKEN_REQUIRED' });
  await assert.rejects(f.customer.search(f.batch, token, { keyword: '商品', storeId: '6506' }), { code: 'INVALID_SAMS_QUERY' });
  const search = await f.customer.search(f.batch, token, { keyword: '商品' });
  assert.deepEqual(search.store, fixedStore);
  assert.equal(search.products[0].selfSelected, true);
  assert.equal(search.products[0].description, '可信官方说明');
  const body = { selectionId: search.selectionId, spuId: '111' };
  await assert.rejects(f.customer.add(f.batch, otherToken, body), { code: 'SAMS_SELECTION_EXPIRED' });
  const otherBatch = f.service.createBatch({ requestId: randomUUID(), communityName: '另一个小区', samsStore: fixedStore }).batch;
  await assert.rejects(f.customer.add(otherBatch, token, body), { code: 'SAMS_SELECTION_EXPIRED' });
  await assert.rejects(f.customer.add(f.batch, token, { ...body, priceCents: 1 }), { code: 'INVALID_SAMS_SELECTION' });
  const product = (await f.customer.add(f.batch, token, body)).product;
  assert.equal(product.id, 'self_2_6505_111');
  assert.equal(product.priceCents, 2980);
  assert.equal(product.source, undefined);
  assert.equal(f.store.listProducts().length, 1);
  assert.deepEqual(f.service.getCatalog(f.batch).products.map(p => p.id), ['ordinary']);
  assert.equal(f.customer.list(f.batch, token).products.length, 1);
  assert.deepEqual(f.customer.list(f.batch, otherToken).products, []);
  const searchCall = f.state.calls.find(call => call.url.endsWith('/search'));
  assert.deepEqual(searchCall.body.storeInfoVOList, [{ storeType: 2, storeId: '6505' }]);
  assert.deepEqual(mockDetailCalls(f)[0].body, { spuIdList: ['111'], visitStoreId: '6505', storeInfoList: [{ storeType: 2, storeId: '6505' }], locationSwitch: false });
});

test('strict detail identity, true availability, sale price and positive stock are required; safeStockQuantity zero is valid', async t => {
  for (const patch of [{ spuId: '222' }, { storeId: '6506' }, { storeType: 4 }, { isAvailable: false },
    { isStoreAvailable: undefined }, { isPutOnSale: null }, { stockInfo: { stockQuantity: 0 } },
    { stockInfo: { stockQuantity: '5' } }, { stockInfo: null }, { priceInfo: [{ priceType: 2, price: '0' }] }]) {
    const f = fixture(t); f.state.detail.set('111', makeRow('111', 2980, patch));
    await assert.rejects(add(f), error => ['SELF_PRODUCT_CHANGED', 'INVALID_SAMS_SELECTION'].includes(error.code));
    assert.equal(f.customer.list(f.batch, token).products.length, 0);
  }
  const f = fixture(t);
  assert.equal((await add(f)).selectable, true);
});

test('mixed orders commit one atomic receipt and drafts; all new order prices stay frozen', async t => {
  const f = fixture(t); const personal = await add(f);
  const regular = f.service.getCatalog(f.batch).products[0];
  const payload = order(f, [regular, personal]);
  const result = await f.customer.submit(f.batch, token, payload);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.store.getBatch(f.batch.code).productIds, ['ordinary']);
  const draft = f.store.getProduct(personal.id);
  assert.equal(draft.onSale, false); assert.equal(draft.source.customerSelected, true);
  assert.equal(draft.source.description, '可信官方说明');
  assert.equal(draft.source.storeId, '6505');
  assert.equal(f.service.getCatalog(f.batch).products.length, 1);
  const lines = f.store.listExportLines(f.batch.code);
  const quoteLine = lines.find(line => line.productId === personal.id);
  assert.equal(quoteLine.snapshot.priceCents, 2980);
  assert.equal(quoteLine.amountCents, 2980);
  assert.equal(f.service.getStats([f.batch.code]).totalCents, 3980);
  const publicSummary = f.service.queryOrders(f.batch, payload.phone).products.find(product => product.id === personal.id);
  assert.equal(publicSummary.description, '可信官方说明');
  assert.equal(publicSummary.source, undefined);
  const statsSummary = f.service.getStats([f.batch.code]).products.find(product => product.id === personal.id);
  assert.equal(statsSummary.description, '可信官方说明');
  assert.equal(statsSummary.source, undefined);
  const personalRevision = quoteLine.revision;
  f.service.updateProduct(personal.id, { priceCents: 9999, name: '管理员编辑自选商品' });
  f.service.updateProduct('ordinary', { priceCents: 2000 });
  const updated = f.store.listExportLines(f.batch.code);
  assert.equal(updated.find(line => line.productId === personal.id).priceCents, 2980);
  assert.equal(updated.find(line => line.productId === personal.id).productName, personal.name);
  assert.equal(updated.find(line => line.productId === personal.id).revision, personalRevision);
  assert.equal(updated.find(line => line.productId === 'ordinary').priceCents, 1000);
  assert.equal(f.service.queryOrders(f.batch, payload.phone).totalCents, 3980);
  f.service.updateBatch(f.batch.code, { collecting: false, samsStore: null });
  f.state.offline = true;
  assert.deepEqual(await f.customer.submit(f.batch, token, payload), result);
  await assert.rejects(f.customer.submit(f.batch, otherToken, payload), { code: 'CUSTOMER_TOKEN_MISMATCH' });
  await assert.rejects(f.customer.submit(f.batch, token, { ...payload, note: '变更' }), { code: 'SUBMISSION_CONFLICT' });
  assert.equal(f.store.listOrderLines(f.batch.code).length, 2);
});

test('same-SPU local sale prices win, drafts remain private, explicit stops cannot be bypassed, and different stores do not lend prices', async t => {
  const f = fixture(t);
  const source = { platform: 'samsclub_cn', spuId: '111', storeId: '6505', storeType: 2,
    storeName: fixedStore.name, cityCode: fixedStore.cityCode, cityName: fixedStore.cityName, keyword: '商品',
    queriedAt: new Date(start).toISOString(), priceCents: 2980, description: '团长说明' };
  f.service.selectProducts([{ ...ordinary, id: 'sam_111', priceCents: 2980, imageUrl: 'https://images.test/111.jpg', source }]);
  f.service.updateProduct('sam_111', { onSale: true, priceCents: 4500 });
  const reused = await add(f);
  assert.equal(reused.id, 'sam_111'); assert.equal(reused.selfSelected, true);
  assert.equal(reused.priceSource, 'local'); assert.equal(reused.priceCents, 4500);
  await f.customer.submit(f.batch, token, order(f, [reused]));
  f.service.updateBatch(f.batch.code, { productIds: ['ordinary', 'sam_111'] });
  const recommended = await add(f);
  assert.equal(recommended.selfSelected, false); assert.equal(recommended.priceCents, 4500);
  const normalPayload = order(f, [recommended]);
  await f.customer.submit(f.batch, null, normalPayload);
  const normalSnapshot = f.store.listOrderLines(f.batch.code).find(line => line.submissionId === normalPayload.submissionId).snapshot;
  assert.equal(normalSnapshot.selfSelected, false);
  assert.equal(normalSnapshot.feeCategory, 'recommended');
  assert.equal(normalSnapshot.priceCents, 4500);
  f.service.updateProduct('sam_111', { onSale: false });
  await assert.rejects(add(f), { code: 'SELF_PRODUCT_CHANGED' });
  const other = fixture(t);
  other.store.importProducts([{ ...ordinary, id: 'sam_111', priceCents: 8000, source: { ...source, storeId: '6506' }, imageUrl: 'https://images.test/111.jpg' }, ordinary]);
  const separate = await add(other);
  assert.equal(separate.id, 'self_2_6505_111'); assert.equal(separate.priceCents, 2980);
});

test('changed or expired quotes refresh durably before 409 and a second confirmation succeeds without a loop', async t => {
  const f = fixture(t); const first = await add(f); const payload = order(f, [first]);
  f.state.detail.set('111', makeRow('111', 3500));
  await assert.rejects(f.customer.submit(f.batch, token, payload), { code: 'SELF_PRODUCT_CHANGED' });
  assert.equal(f.store.listOrderLines(f.batch.code).length, 0);
  const refreshed = f.customer.list(f.batch, token).products[0];
  assert.equal(refreshed.priceCents, 3500); assert.notEqual(refreshed.version, first.version);
  await f.customer.submit(f.batch, token, order(f, [refreshed]));
  f.advance(31 * 60_000);
  assert.equal(f.customer.list(f.batch, token).products[0].quoteExpired, true);
  const expired = order(f, [refreshed]);
  await assert.rejects(f.customer.submit(f.batch, token, expired), { code: 'SELF_PRODUCT_CHANGED' });
  const renewed = f.customer.list(f.batch, token).products[0];
  assert.equal(renewed.quoteExpired, false);
  assert.notEqual(renewed.version, refreshed.version);
  await assert.rejects(f.customer.submit(f.batch, token, expired), { code: 'SELF_PRODUCT_CHANGED' });
  await f.customer.submit(f.batch, token, order(f, [renewed]));
  assert.equal(f.store.listOrderLines(f.batch.code).length, 2);
});

test('unavailable/missing-price quotes remain recoverable but cannot create orders; closed or changed stores retain private lists', async t => {
  const f = fixture(t); const personal = await add(f);
  f.state.detail.set('111', makeRow('111', 2980, { priceInfo: [{ priceType: 2, price: '0' }] }));
  await assert.rejects(f.customer.submit(f.batch, token, order(f, [personal])), { code: 'SELF_PRODUCT_CHANGED' });
  const unavailable = f.customer.list(f.batch, token).products[0];
  assert.equal(unavailable.onSale, false); assert.equal(unavailable.priceUnavailable, true); assert.equal(unavailable.priceCents, 2980);
  f.service.updateBatch(f.batch.code, { collecting: false });
  assert.equal(f.customer.list(f.batch, token).products.length, 1);
  await assert.rejects(f.customer.add(f.batch, token, { selectionId: randomUUID(), spuId: '111' }), { code: 'COLLECTION_CLOSED' });
  f.service.updateBatch(f.batch.code, { collecting: true, samsStore: differentStore });
  assert.equal(f.customer.list(f.batch, token).products[0].storeChanged, true);
  await assert.rejects(f.customer.submit(f.batch, token, order(f, [personal])), { code: 'SELF_PRODUCT_CHANGED' });
  f.service.updateBatch(f.batch.code, { samsStore: null });
  assert.equal(f.customer.list(f.batch, token).products[0].selectable, false);
  assert.equal(f.store.listOrderLines(f.batch.code).length, 0);
});

test('personal price snapshots with different quotes aggregate exact amounts and mark mixed prices', async t => {
  const f = fixture(t); const first = await add(f);
  await f.customer.submit(f.batch, token, order(f, [first]));
  f.state.detail.set('111', makeRow('111', 3500));
  const second = await add(f);
  await f.customer.submit(f.batch, token, order(f, [second]));
  const query = f.service.queryOrders(f.batch, '13800138000');
  assert.equal(query.totalCents, 6480); assert.equal(query.products[0].mixedPrices, true); assert.equal(query.products[0].quantity, 2);
  assert.equal(query.products[0].selfSelected, true);
  const stats = f.service.getStats([f.batch.code]);
  assert.equal(stats.totalCents, 6480); assert.equal(stats.products[0].mixedPrices, true);
  assert.deepEqual(stats.orders.map(line => line.priceCents), [2980, 3500]);
});

test('singleflight reuses an in-flight UUID and rejects conflicting bodies without duplicate NFC calls or orders', async t => {
  const f = fixture(t); const personal = await add(f); const payload = order(f, [personal]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.state.hook = () => gate;
  const callsBefore = mockDetailCalls(f).length;
  const first = f.customer.submit(f.batch, token, payload);
  const second = f.customer.submit(f.batch, token, payload);
  assert.equal(f.customer.receipt(f.batch, token, payload.submissionId).status, 'processing');
  assert.throws(() => f.customer.receipt(f.batch, otherToken, payload.submissionId), { code: 'CUSTOMER_TOKEN_MISMATCH' });
  await assert.rejects(f.customer.submit(f.batch, token, { ...payload, note: '冲突' }), { code: 'SUBMISSION_CONFLICT' });
  release();
  assert.deepEqual(await first, await second);
  assert.equal(mockDetailCalls(f).length - callsBefore, 1);
  assert.equal(f.store.listOrderLines(f.batch.code).length, 1);
  assert.equal(f.customer.submissions.size, 0);
});

test('changes while NFC is pending are rechecked before committing store, sale or local price decisions', async t => {
  for (const change of ['store', 'closed', 'stop', 'price']) {
    const f = fixture(t);
    if (change === 'stop' || change === 'price') {
      const source = { platform: 'samsclub_cn', spuId: '111', storeId: '6505', storeType: 2, storeName: fixedStore.name,
        keyword: '商品', queriedAt: new Date(start).toISOString(), priceCents: 2980 };
      f.service.selectProducts([{ ...ordinary, id: 'sam_111', priceCents: 2980, imageUrl: 'https://images.test/111.jpg', source }]);
      f.service.updateProduct('sam_111', { onSale: true });
    }
    const personal = await add(f);
    f.state.hook = async () => {
      if (change === 'store') f.service.updateBatch(f.batch.code, { samsStore: differentStore });
      if (change === 'closed') f.service.updateBatch(f.batch.code, { collecting: false });
      if (change === 'stop') f.service.updateProduct('sam_111', { onSale: false });
      if (change === 'price') f.service.updateProduct('sam_111', { priceCents: 9999 });
    };
    await assert.rejects(f.customer.submit(f.batch, token, order(f, [personal])), error => ['SELF_PRODUCT_CHANGED', 'COLLECTION_CLOSED'].includes(error.code));
    assert.equal(f.store.listOrderLines(f.batch.code).length, 0);
  }
});

test('SQLite rollback on a later order line also rolls back new catalog drafts and the submission receipt', async t => {
  const f = fixture(t); const personal = await add(f); const regular = f.service.getCatalog(f.batch).products[0];
  f.store.db.exec("CREATE TRIGGER fail_line BEFORE INSERT ON order_lines WHEN NEW.product_id='self_2_6505_111' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  const payload = order(f, [regular, personal]);
  await assert.rejects(f.customer.submit(f.batch, token, payload), /test rollback/);
  assert.equal(f.store.getSubmission(f.batch.code, payload.submissionId), null);
  assert.equal(f.store.getProduct(personal.id), null);
  assert.equal(f.store.listOrderLines(f.batch.code).length, 0);
});

test('transaction-time local stops and concurrent quote revisions cannot override the decisions made before committing', async t => {
  for (const change of ['new-stop', 'quote']) {
    const f = fixture(t); const personal = await add(f);
    const originalSubmit = f.service.submit.bind(f.service);
    f.service.submit = (...args) => {
      if (change === 'new-stop') {
        f.store.importProducts([ordinary, { ...ordinary, id: 'sam_111', onSale: false, source: {
          platform: 'samsclub_cn', spuId: '111', storeId: '6505', storeType: 2,
        } }]);
      } else {
        const quote = f.store.getCustomerProduct(f.batch.code, customerOwner(token), personal.id);
        f.store.saveCustomerProduct(f.batch.code, customerOwner(token), quote.storeKey,
          { ...quote.product, version: 'f'.repeat(64) }, start);
      }
      return originalSubmit(...args);
    };
    await assert.rejects(f.customer.submit(f.batch, token, order(f, [personal])), { code: 'SELF_PRODUCT_CHANGED' });
    assert.equal(f.store.listOrderLines(f.batch.code).length, 0);
    assert.equal(f.store.getProduct(personal.id), null);
  }
});

test('a promoted customer-origin draft is an ordinary recommendation and its new normal orders freeze the recommendation price', async t => {
  const f = fixture(t); const personal = await add(f);
  await f.customer.submit(f.batch, token, order(f, [personal]));
  f.service.updateProduct(personal.id, { onSale: true, priceCents: 4000 });
  f.service.updateBatch(f.batch.code, { productIds: ['ordinary', personal.id] });
  const recommended = f.service.getCatalog(f.batch).products.find(product => product.id === personal.id);
  assert.equal(recommended.selfSelected, undefined);
  const normal = order(f, [recommended]);
  await f.customer.submit(f.batch, null, normal);
  f.service.updateProduct(personal.id, { priceCents: 5000 });
  const lines = f.store.listExportLines(f.batch.code);
  assert.deepEqual(lines.map(line => line.priceCents), [2980, 4000]);
  const stats = f.service.getStats([f.batch.code]);
  assert.deepEqual(stats.orders.map(line => line.selfSelected), [true, false]);
  assert.equal(stats.products[0].mixedPrices, true);
  assert.equal(stats.products[0].selfSelected, true);
  assert.equal(stats.totalCents, 6980);
});

test('a stable private ID uses the recommendation fee when the same store and SPU is later recommended under another local ID', async t => {
  const f = fixture(t);
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: 500 } });
  const first = await add(f);
  const quotedOrder = product => {
    const input = order(f, [product], { feePolicyVersion: f.service.getCatalog(f.batch).batch.feePolicyVersion });
    const quoted = f.customer.quote(f.batch, token, { items: input.items, phone: input.phone, feePolicyVersion: input.feePolicyVersion });
    return { input: { ...input, feeQuoteVersion: quoted.feeQuoteVersion }, quoted };
  };
  const original = quotedOrder(first);
  assert.equal(original.quoted.selfSelectedFeeCents, 149);
  await f.customer.submit(f.batch, token, original.input);
  const source = { platform: 'samsclub_cn', spuId: '111', storeId: '6505', storeType: 2, storeName: fixedStore.name,
    cityCode: fixedStore.cityCode, cityName: fixedStore.cityName, keyword: '商品', queriedAt: new Date(start).toISOString(), priceCents: 2980 };
  f.service.selectProducts([{ ...ordinary, id: 'sam_111', priceCents: 2980, imageUrl: 'https://images.test/111.jpg', source }]);
  f.service.updateProduct('sam_111', { onSale: true, priceCents: 4000 });
  f.service.updateBatch(f.batch.code, { productIds: ['ordinary', 'sam_111'] });
  assert.throws(() => f.customer.quote(f.batch, token, { items: original.input.items, phone: original.input.phone,
    feePolicyVersion: original.input.feePolicyVersion }), { code: 'FEE_POLICY_CHANGED' });
  const refreshed = f.customer.list(f.batch, token).products[0];
  assert.equal(refreshed.id, first.id);
  assert.equal(refreshed.feeCategory, 'recommended');
  assert.equal(refreshed.priceCents, 4000);
  const additional = quotedOrder(refreshed);
  assert.equal(additional.quoted.recommendedFeeCents, 40);
  assert.equal(additional.quoted.selfSelectedFeeCents, 0);
  await f.customer.submit(f.batch, token, additional.input);
  const lines = f.store.listExportLines(f.batch.code);
  assert.deepEqual(lines.map(line => [line.feeCategory, line.feeRateBps, line.priceCents, line.feeCents]),
    [['selfSelected', 500, 2980, 149], ['recommended', 100, 4000, 40]]);
  assert.equal(f.service.queryOrders(f.batch, original.input.phone).totalCents, 7169);
});

test('old SQLite batches and ordinary orders migrate without needing a store or changing existing amounts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-customer-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite'); const f = fixture(t, path);
  const regular = f.service.getCatalog(f.batch).products[0];
  const payload = order(f, [regular]); f.service.submit(f.batch, payload);
  const lines = f.store.listOrderLines(f.batch.code).map(({ snapshot, ...line }) => line);
  f.store.db.exec('DROP TABLE customer_selections');
  f.store.db.exec('DROP TABLE customer_products');
  f.store.db.exec('ALTER TABLE batches DROP COLUMN sams_store_json');
  f.store.db.exec('ALTER TABLE order_lines DROP COLUMN snapshot_json');
  f.store.db.exec('ALTER TABLE submissions DROP COLUMN customer_hash');
  f.store.close();
  const restored = fixture(t, path);
  assert.equal(restored.service.getBatch(f.batch).samsStore, null);
  assert.deepEqual(restored.store.listOrderLines(f.batch.code).map(({ snapshot, ...line }) => line), lines);
  assert.equal(restored.service.queryOrders(f.batch, payload.phone).totalCents, 1000);
  assert.equal((await restored.customer.submit(f.batch, null, payload)).status, 'completed');
  assert.deepEqual(restored.customer.list(f.batch, token).products, []);
});

test('quotes, query snapshots, store configuration and order prices survive restart with customer isolation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-customer-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite');
  const f = fixture(t, path); const product = await add(f);
  const search = await f.customer.search(f.batch, token, { keyword: '商品' });
  await f.customer.submit(f.batch, token, order(f, [product]));
  f.store.close();
  const restored = fixture(t, path);
  assert.deepEqual(restored.service.getBatch(f.batch).samsStore, fixedStore);
  assert.equal(restored.customer.list(f.batch, token).products[0].priceCents, 2980);
  assert.deepEqual(restored.customer.list(f.batch, otherToken).products, []);
  assert.equal((await restored.customer.add(f.batch, token, { selectionId: search.selectionId, spuId: '222' })).product.id, 'self_2_6505_222');
  assert.equal(restored.service.queryOrders(f.batch, '13800138000').totalCents, 2980);
});

test('official configuration drops client names; expired queries and bounded private storage are enforced', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.customer.validateStore({ ...fixedStore, name: '客户端伪造', cityName: '错误城市' }), fixedStore);
  await assert.rejects(f.customer.validateStore({ ...fixedStore, storeId: '9999' }), { code: 'INVALID_SAMS_STORE' });
  const search = await f.customer.search(f.batch, token, { keyword: '商品' });
  f.advance(31 * 60_000);
  await assert.rejects(f.customer.add(f.batch, token, { selectionId: search.selectionId, spuId: '111' }), { code: 'SAMS_SELECTION_EXPIRED' });
  f.store.cleanupCustomerData(start + 31 * 60_000);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM customer_selections').get().n, 0);
  const product = await add(f);
  for (let index = 0; index < 49; index++) f.store.saveCustomerSelection({ selectionId: randomUUID(), batchCode: f.batch.code,
    ownerHash: customerOwner(token), storeKey: 'test', data: {}, expiresAt: start + 32 * 60_000 }, start + 31 * 60_000);
  assert.throws(() => f.store.saveCustomerSelection({ selectionId: randomUUID(), batchCode: f.batch.code,
    ownerHash: customerOwner(token), storeKey: 'test', data: {}, expiresAt: start + 32 * 60_000 }, start + 31 * 60_000), { code: 'CUSTOMER_QUERY_LIMIT' });
  const internal = f.store.getCustomerProduct(f.batch.code, customerOwner(token), product.id).product;
  for (let index = 0; index < 199; index++) f.store.saveCustomerProduct(f.batch.code, customerOwner(token), '["440300","6505",2]', { ...internal, id: `self_test_${index}` }, start + 31 * 60_000);
  assert.throws(() => f.store.saveCustomerProduct(f.batch.code, customerOwner(token), '["440300","6505",2]', { ...internal, id: 'self_over_limit' }, start + 31 * 60_000), { code: 'CUSTOMER_PRODUCT_LIMIT' });
  f.store.cleanupCustomerData(start + 32 * 86400_000);
  assert.equal(f.store.listCustomerProducts(f.batch.code, customerOwner(token)).length, 0);
});

test('completed administrator batch creation replays offline with saved official names and still rejects conflicting bodies', async t => {
  const f = fixture(t);
  const request = { requestId: randomUUID(), communityName: '创建重放小区', title: '核对期次',
    samsStore: { ...fixedStore, name: '客户端旧名称', cityName: '客户端旧城市' } };
  const created = await f.customer.createBatch(request);
  assert.deepEqual(created.batch.samsStore, fixedStore);
  const callCount = f.state.calls.length;
  f.state.offline = true;
  f.sams.stores = async () => { throw new Error('official store listing is now unavailable'); };
  const replay = await f.customer.createBatch({ ...request,
    samsStore: { ...fixedStore, name: '官方名称已更新', cityName: '官方城市名称已更新' } });
  assert.deepEqual(replay, created);
  assert.equal(f.state.calls.length, callCount);
  assert.equal(f.store.listBatches().length, 2);
  await assert.rejects(f.customer.createBatch({ ...request, communityName: '不同小区' }), { code: 'BATCH_REQUEST_CONFLICT' });
  await assert.rejects(f.customer.createBatch({ ...request, title: '不同期次内容' }), { code: 'BATCH_REQUEST_CONFLICT' });
  await assert.rejects(f.customer.createBatch({ ...request, samsStore: differentStore }), { code: 'BATCH_REQUEST_CONFLICT' });
  await assert.rejects(f.customer.createBatch({ ...request, samsStore: { ...fixedStore, storeType: true } }), { code: 'INVALID_SAMS_STORE' });
  await assert.rejects(f.customer.createBatch({ ...request, periodNumber: 100 }), { code: 'INVALID_BATCH_FIELDS' });
  assert.deepEqual(f.store.getBatch(created.batch.code).samsStore, fixedStore);
});
