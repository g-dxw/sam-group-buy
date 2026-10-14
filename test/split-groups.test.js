import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore, productVersion, samsStoreKey } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { CustomerSelection, customerOwner } from '../server/customer-selection.js';
import { normalizeSplitRules, allocateSplit } from '../server/split-groups.js';
import { SamsCatalog } from '../server/sams-catalog.js';

const time = '2026-10-13T10:00:00.000Z';
const phone = '13800138000';
const rule = { partsPerPack: 3, portionSpec: '约600g / 份', priceCents: 6000 };
const source = { platform: 'samsclub_cn', spuId: '111', storeId: '6505', storeType: 2 };
const products = [{ id: 'beef', name: '牛肉整盒', spec: '1.8kg', unit: '盒', priceCents: 18000,
  category: '生鲜', onSale: true, source }, { id: 'milk', name: '牛奶', spec: '1L', unit: '盒', priceCents: 1000, category: '饮品', onSale: true }];
const storeLocation = { cityCode: '440300', cityName: '深圳市', storeId: '6505', storeType: 2, name: '深圳福田店' };
function fixture(t, options = {}) {
  let clock = Date.parse(time);
  const store = new LocalStore({ path: options.path || ':memory:' });
  store.importProducts(options.products || products);
  const service = new LocalService({ store, now: () => new Date(clock) });
  const batch = service.createBatch({ requestId: randomUUID(), communityName: '拼份验收', samsStore: storeLocation,
    splitRules: { beef: rule }, ...options.batch }).batch;
  t.after(() => store.close());
  return { store, service, batch, now: () => clock, advance: (ms = 1) => clock += ms };
}
function customerFixture(f) {
  const token = randomUUID();
  const state = { priceCents: 21000, hook: null, calls: [] };
  const sams = new SamsCatalog({ now: f.now, fetchImpl: async (url, init) => {
    if (!String(url).startsWith('https://api-sams.walmartmobile.cn/api/v1/sams/')) throw new Error('remote calls forbidden');
    const body = JSON.parse(init.body); state.calls.push({ url, body });
    const detail = url.endsWith('querySpuDetailToNFC');
    if (detail && state.hook) await state.hook();
    const row = { spuId: '111', storeId: '6505', storeType: 2, title: '山姆牛肉整盒 1.8kg',
      subTitle: '原整盒商品说明', image: 'https://images.test/111.jpg',
      priceInfo: [{ priceType: 1, price: String(state.priceCents) }],
      isAvailable: true, isPutOnSale: true, isStoreAvailable: true, stockInfo: { stockQuantity: 5 } };
    return new Response(JSON.stringify({ code: 'Success', data: detail ? row : { dataList: [row], hasNextPage: false } }));
  } });
  const customer = new CustomerSelection({ store: f.store, service: f.service, sams, now: f.now });
  const addWhole = async () => {
    const search = await customer.search(f.batch, token, { keyword: '牛肉' });
    return (await customer.add(f.batch, token, { selectionId: search.selectionId, spuId: '111' })).product;
  };
  const payload = selections => {
    const items = selections.map(({ product, quantity = 1 }) => ({ productId: product.id, quantity, version: product.version }));
    const quote = customer.quote(f.batch, token, { phone, items, feePolicyVersion: f.service.getCatalog(f.batch).batch.feePolicyVersion });
    return { submissionId: randomUUID(), name: '整包与分装顾客', phone, items,
      feePolicyVersion: quote.feePolicyVersion, feeQuoteVersion: quote.feeQuoteVersion };
  };
  return { token, state, customer, addWhole, payload };
}
function makeOrder(f, quantity, overrides = {}, productId = 'beef') {
  const catalog = f.service.getCatalog(f.batch);
  const item = { productId, quantity, version: catalog.products.find(p => p.id === productId).version };
  const quote = f.service.quote(f.batch, { items: [item], phone: overrides.phone || phone, feePolicyVersion: catalog.batch.feePolicyVersion });
  return { submissionId: randomUUID(), name: '客户', phone, items: [item],
    feePolicyVersion: quote.feePolicyVersion, feeQuoteVersion: quote.feeQuoteVersion, ...overrides };
}
function submit(f, quantity, overrides = {}, productId = 'beef') {
  const order = makeOrder(f, quantity, overrides, productId);
  f.service.submit(f.batch, order); f.advance();
  return f.store.listOrderLines(f.batch.code).find(line => line.submissionId === order.submissionId);
}
function close(f) { f.service.updateBatch(f.batch.code, { collecting: false }); }
function confirm(f, remainderPolicy = 'cancel') { close(f); return f.service.confirmSplit(f.batch.code, 'beef', { remainderPolicy }).group; }

test('split rules validate strictly, trim specs and reject unselected/duplicate same-SPU rules', t => {
  assert.deepEqual(normalizeSplitRules({ beef: { ...rule, portionSpec: '  约600g / 份  ' } }), { beef: rule });
  for (const value of [null, [], { beef: { ...rule, partsPerPack: 1 } }, { beef: { ...rule, partsPerPack: 1001 } },
    { beef: { ...rule, partsPerPack: 2.5 } }, { beef: { ...rule, portionSpec: '  ' } },
    { beef: { ...rule, priceCents: -1 } }, { beef: { ...rule, priceCents: 1.5 } }, { beef: { ...rule, unknown: true } }]) {
    assert.throws(() => normalizeSplitRules(value), { code: 'INVALID_SPLIT_RULES' });
  }
  const f = fixture(t);
  assert.throws(() => f.service.updateBatch(f.batch.code, { splitRules: { unknown: rule } }), { code: 'INVALID_SPLIT_RULES' });
  f.store.importProducts([...products, { ...products[0], id: 'beef-alias' }]);
  assert.throws(() => f.service.updateBatch(f.batch.code, { productIds: ['beef', 'beef-alias', 'milk'] }), { code: 'INVALID_SPLIT_RULES' });
  assert.throws(() => f.service.updateBatch(f.batch.code, { productIds: ['beef', 'beef-alias'], splitRules: { beef: rule, 'beef-alias': rule } }), { code: 'INVALID_SPLIT_RULES' });
});

test('period split view uses portion price/unit/version and keeps original shared SKU untouched', t => {
  const f = fixture(t);
  const catalog = f.service.getCatalog(f.batch);
  const product = catalog.products.find(p => p.id === 'beef');
  assert.equal(product.unit, '份'); assert.equal(product.priceCents, 6000); assert.equal(product.spec, rule.portionSpec);
  assert.equal(product.split.packPriceCents, undefined); assert.equal(product.split.packSpec, '1.8kg');
  assert.notEqual(product.version, productVersion(f.store.getProduct('beef')));
  assert.equal(f.store.getProduct('beef').priceCents, 18000);
  assert.equal(catalog.products.find(p => p.id === 'milk').version, productVersion(f.store.getProduct('milk')));
  const other = f.service.createBatch({ requestId: randomUUID(), communityName: '另一期' }).batch;
  assert.equal(f.service.getCatalog(other).products.find(p => p.id === 'beef').priceCents, 18000);
  f.service.updateBatch(f.batch.code, { splitRules: { beef: { ...rule, priceCents: 6100 } } });
  assert.notEqual(f.service.getCatalog(f.batch).products[0].version, product.version);
});

test('pending split estimates price and fees without charging until confirmed, and requires quote even at zero fees', t => {
  const f = fixture(t, { batch: { feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: null } } });
  const order = makeOrder(f, 5);
  const quote = f.service.quote(f.batch, { items: order.items, phone, feePolicyVersion: order.feePolicyVersion });
  assert.equal(quote.pendingSplit, true); assert.equal(quote.pendingGoodsCents, 30000);
  assert.equal(quote.goodsTotalCents, 30000); assert.equal(quote.feeTotalCents, 300); assert.equal(quote.totalCents, 30300);
  f.service.submit(f.batch, order);
  const bill = f.service.queryOrders(f.batch, phone);
  assert.equal(bill.totalCents, 0); assert.equal(bill.feeTotalCents, 0); assert.equal(bill.pendingGoodsCents, 30000); assert.equal(bill.pendingQuantity, 5);
  assert.deepEqual(bill.products[0].statuses, []); assert.equal(bill.products[0].split.pendingQuantity, 5);
  assert.equal(f.service.getStats([f.batch.code]).products.length, 0);
  const noFee = fixture(t);
  const missing = makeOrder(noFee, 1); delete missing.feeQuoteVersion;
  assert.throws(() => noFee.service.submit(noFee.batch, missing), { code: 'FEE_QUOTE_CHANGED' });
});

test('FIFO allows part of one request to form, rounds frozen fees, and turns surplus into unformed free portions', t => {
  const f = fixture(t, { batch: { feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: null } } });
  const first = submit(f, 2, { phone: '13800138001', name: '先来' });
  const second = submit(f, 3, { phone: '13800138002', name: '后来' });
  assert.throws(() => f.service.confirmSplit(f.batch.code, 'beef', { remainderPolicy: 'cancel' }), { code: 'SPLIT_CONFIRM_OPEN' });
  const group = confirm(f);
  assert.equal(group.progress.purchasedPacks, 1); assert.equal(group.progress.formedPortions, 3); assert.equal(group.progress.unformedPortions, 2);
  assert.equal(group.customers.find(c => c.lineId === first.lineId).formedQuantity, 2);
  assert.equal(group.customers.find(c => c.lineId === second.lineId).formedQuantity, 1);
  const bill = f.service.queryOrders(f.batch, '13800138002');
  assert.equal(bill.goodsTotalCents, 6000); assert.equal(bill.feeTotalCents, 60); assert.equal(bill.totalCents, 6060); assert.equal(bill.pendingGoodsCents, 0);
  assert.equal(bill.products[0].quantity, 3); assert.equal(bill.products[0].split.unformedQuantity, 2);
  assert.deepEqual(bill.products[0].statuses, [{ status: '待采购', quantity: 1 }]);
  const procurement = f.service.getStats([f.batch.code]).products[0];
  assert.equal(procurement.quantity, 1); assert.equal(procurement.priceCents, 18000); assert.equal(procurement.unit, '盒');
  assert.equal(procurement.amountCents, 18000); assert.equal(procurement.split, true);
});

test('current period fees update pending and confirmed split orders while only formed portions are charged', t => {
  const f = fixture(t, { batch: { feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: null } } });
  const first = submit(f, 3, { phone: '13800138001' });
  const surplus = submit(f, 1, { phone: '13800138002' });
  const snapshots = f.store.listOrderLines(f.batch.code).map(line => line.snapshot);
  for (const line of f.store.listExportLines(f.batch.code)) f.store.markExported(f.batch.code, line.lineId, line.revision, `remote:${line.lineId}`);
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 200, selfSelectedRateBps: null } });
  assert.deepEqual(f.store.listExportLines(f.batch.code).map(line => [line.feeRateBps, line.amountCents, line.feeCents, line.revision, line.syncedRevision]),
    [[200, 0, 0, 2, 1], [200, 0, 0, 2, 1]]);
  confirm(f);
  assert.deepEqual([f.service.queryOrders(f.batch, '13800138001').goodsTotalCents,
    f.service.queryOrders(f.batch, '13800138001').feeTotalCents], [18000, 360]);
  assert.equal(f.service.queryOrders(f.batch, '13800138002').totalCents, 0);
  f.service.updateBatch(f.batch.code, { feePolicy: { recommendedRateBps: 300, selfSelectedRateBps: null } });
  assert.equal(f.service.queryOrders(f.batch, '13800138001').feeTotalCents, 540);
  assert.equal(f.service.queryOrders(f.batch, '13800138002').feeTotalCents, 0);
  assert.equal(f.store.listExportLines(f.batch.code).find(line => line.lineId === surplus.lineId).feeRateBps, 300);
  f.service.updateOrder(f.batch.code, first.lineId, { status: '已取消' });
  assert.equal(f.service.queryOrders(f.batch, '13800138001').totalCents, 0);
  assert.deepEqual(f.store.listOrderLines(f.batch.code).map(line => line.snapshot), snapshots);
});

test('top-up purchases ceiling packs while customer pays only requested shares; one policy confirmation is idempotent', t => {
  const f = fixture(t); submit(f, 5);
  const group = confirm(f, 'topUp');
  assert.equal(group.progress.purchasedPacks, 2); assert.equal(group.progress.topUpPortions, 1); assert.equal(group.progress.formedPortions, 5);
  assert.equal(f.service.queryOrders(f.batch, phone).totalCents, 30000);
  const versions = f.store.listExportLines(f.batch.code).map(line => line.revision);
  assert.deepEqual(f.service.confirmSplit(f.batch.code, 'beef', { remainderPolicy: 'topUp' }).group, group);
  assert.deepEqual(f.store.listExportLines(f.batch.code).map(line => line.revision), versions);
  assert.throws(() => f.service.confirmSplit(f.batch.code, 'beef', { remainderPolicy: 'cancel' }), { code: 'SPLIT_ALREADY_CONFIRMED' });
  assert.throws(() => f.service.confirmSplit(f.batch.code, 'beef', { remainderPolicy: 'other' }), { code: 'INVALID_SPLIT_CONFIRM' });
});

test('surplus-only request forms zero and is never charged; canceled request before cutoff does not consume FIFO capacity', t => {
  const f = fixture(t);
  const canceled = submit(f, 3, { phone: '13800138001' });
  f.service.updateOrder(f.batch.code, canceled.recordId, { status: '已取消' });
  submit(f, 2);
  const group = confirm(f);
  assert.equal(group.progress.totalPortions, 2); assert.equal(group.progress.purchasedPacks, 0);
  const lines = f.store.listExportLines(f.batch.code);
  assert.ok(lines.every(line => line.amountCents === 0 && line.feeCents === 0 && line.split.pendingQuantity === 0));
  assert.equal(lines[0].split.unformedQuantity, 3);
});

test('confirmed allocation persists after cancellation, forbids quantity edits and new requests after reopening', t => {
  const f = fixture(t); const first = submit(f, 3, { phone: '13800138001' }); submit(f, 2);
  const stale = makeOrder(f, 1);
  confirm(f);
  f.service.updateOrder(f.batch.code, first.recordId, { status: '缺货' });
  const group = f.service.getSplitGroups(f.batch)[0];
  assert.equal(group.progress.purchasedPacks, 1); assert.equal(group.progress.retainedPortions, 3);
  assert.equal(group.customers.find(c => c.phone === phone).formedQuantity, 0);
  const old = f.store.listExportLines(f.batch.code).find(line => line.lineId === first.lineId);
  assert.equal(old.split.formedQuantity, 3); assert.equal(old.amountCents, 0); assert.equal(old.feeCents, 0);
  assert.throws(() => f.service.updateOrder(f.batch.code, first.recordId, { quantity: 2 }), { code: 'SPLIT_QUANTITY_LOCKED' });
  f.service.updateBatch(f.batch.code, { collecting: true });
  assert.throws(() => f.service.submit(f.batch, stale), { code: 'SPLIT_SETTLED' });
});

test('ordered split dimensions lock while later portion-price and pack edits affect only fresh orders', t => {
  const f = fixture(t); submit(f, 1);
  assert.deepEqual(f.service.getBatch(f.batch).splitRules, { beef: rule });
  assert.deepEqual(f.service.safeBatch(f.service.getBatch(f.batch)).splitLockedProductIds, ['beef']);
  for (const splitRules of [{}, { beef: { ...rule, partsPerPack: 4 } }, { beef: { ...rule, portionSpec: '另一规格' } }]) {
    assert.throws(() => f.service.updateBatch(f.batch.code, { splitRules }), { code: 'SPLIT_RULE_LOCKED' });
  }
  f.service.updateBatch(f.batch.code, { splitRules: { beef: { ...rule, priceCents: 7000 } } });
  f.service.updateProduct('beef', { priceCents: 20000, spec: '2kg' }); submit(f, 2);
  confirm(f);
  const lines = f.store.listExportLines(f.batch.code);
  assert.deepEqual(lines.map(line => line.priceCents), [6000, 7000]);
  assert.deepEqual(lines.map(line => line.split.packPriceCents), [18000, 20000]);
  assert.deepEqual(lines.map(line => line.split.packSpec), ['1.8kg', '2kg']);
  assert.equal(f.service.queryOrders(f.batch, phone).goodsTotalCents, 20000);
});

test('existing ordinary orders cannot be converted to split; remaining legacy lines freeze previous price', t => {
  const f = fixture(t, { batch: { splitRules: {} } }); submit(f, 1);
  assert.throws(() => f.service.updateBatch(f.batch.code, { splitRules: { beef: rule } }), { code: 'SPLIT_RULE_LOCKED' });
  const oldPayload = { submissionId: randomUUID(), name: '旧客户', phone: '13800138002', items: [{ productId: 'milk', quantity: 1, version: productVersion(f.store.getProduct('milk')) }] };
  f.store.saveSubmission(f.batch.code, oldPayload);
  f.service.updateProduct('milk', { priceCents: 2000 });
  assert.equal(f.service.queryOrders(f.batch, '13800138002').totalCents, 1000);
  assert.equal(f.store.listExportLines(f.batch.code).find(line => line.phone === '13800138002').split, undefined);
});

test('confirmation reallocates frozen customer fees and marks formerly backed-up ordinary siblings dirty', t => {
  const f = fixture(t, { products: [{ ...products[0], priceCents: 3 }, { ...products[1], priceCents: 1 }],
    batch: { feePolicy: { recommendedRateBps: 5000, selfSelectedRateBps: null }, splitRules: { beef: { ...rule, priceCents: 1 } } } });
  const ordinary = submit(f, 1, { submissionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, 'milk');
  assert.equal(f.store.listExportLines(f.batch.code)[0].feeCents, 1);
  f.store.markExported(f.batch.code, ordinary.lineId, 1, 'remote-ordinary');
  for (let index = 1; index <= 3; index++) submit(f, 1, { submissionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
  confirm(f);
  const lines = f.store.listExportLines(f.batch.code);
  assert.equal(lines.find(line => line.lineId === ordinary.lineId).feeCents, 0);
  assert.equal(lines.find(line => line.lineId === ordinary.lineId).revision, 2);
  assert.ok(f.store.listExportLines(f.batch.code, { onlyDirty: true }).some(line => line.lineId === ordinary.lineId));
  assert.equal(f.service.queryOrders(f.batch, phone).feeTotalCents, 2);
  assert.equal(lines.reduce((sum, line) => sum + line.feeCents, 0), 2);
});

test('split UUID replay and confirmation are transactional and durable across SQLite reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'split-durable-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'orders.sqlite');
  const f = fixture(t, { path }); const order = makeOrder(f, 5);
  f.service.submit(f.batch, order); assert.equal(f.service.submit(f.batch, order).status, 'completed');
  assert.equal(f.store.listOrderLines(f.batch.code).length, 1); close(f);
  f.store.db.exec(`CREATE TRIGGER fail_split BEFORE UPDATE ON order_lines BEGIN SELECT RAISE(ABORT,'split rollback'); END`);
  assert.throws(() => f.service.confirmSplit(f.batch.code, 'beef', { remainderPolicy: 'topUp' }), /split rollback/);
  assert.equal(f.store.getSplitSettlement(f.batch.code, 'beef'), null);
  assert.equal(f.store.listExportLines(f.batch.code)[0].amountCents, 0);
  f.store.db.exec('DROP TRIGGER fail_split'); f.service.confirmSplit(f.batch.code, 'beef', { remainderPolicy: 'topUp' });
  const secondStore = new LocalStore({ path }); t.after(() => secondStore.close());
  const second = new LocalService({ store: secondStore });
  assert.equal(second.queryOrders(f.batch, phone).goodsTotalCents, 30000);
  assert.equal(second.confirmSplit(f.batch.code, 'beef', { remainderPolicy: 'topUp' }).group.progress.topUpPortions, 1);
});

test('same-time FIFO follows stable line ID instead of insertion order', () => {
  const lines = [{ lineId: 'z', submittedAt: time, quantity: 2, status: '待采购' }, { lineId: 'a', submittedAt: time, quantity: 2, status: '待采购' }];
  const result = allocateSplit(lines, 3, 'cancel', time);
  assert.deepEqual(result.allocations, { a: 2, z: 1 });
});

test('same-SPU whole-pack search and recommended portions coexist with their own prices, units and fee rates', async t => {
  const f = fixture(t, { batch: { feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: 500 } } });
  const c = customerFixture(f);
  const portion = f.service.getCatalog(f.batch).products.find(product => product.id === 'beef');
  const whole = await c.addWhole();
  assert.equal(portion.purchaseIdentity.kind, 'portion');
  assert.equal(whole.purchaseIdentity.kind, 'whole');
  assert.equal(whole.id, 'self_2_6505_111'); assert.notEqual(whole.id, portion.id);
  assert.equal(whole.priceCents, 21000); assert.equal(whole.spec, '1.8kg'); assert.equal(whole.unit, '件');
  assert.equal(whole.split, undefined); assert.equal(whole.feeCategory, 'selfSelected');
  assert.equal(portion.priceCents, 6000); assert.equal(portion.spec, rule.portionSpec); assert.equal(portion.unit, '份');
  const payload = c.payload([{ product: portion, quantity: 3 }, { product: whole }]);
  const quote = c.customer.quote(f.batch, c.token, { phone, items: payload.items, feePolicyVersion: payload.feePolicyVersion });
  assert.equal(quote.goodsTotalCents, 39000); assert.equal(quote.recommendedFeeCents, 180);
  assert.equal(quote.selfSelectedFeeCents, 1050); assert.equal(quote.totalCents, 40230);
  assert.equal((await c.customer.submit(f.batch, c.token, payload)).status, 'completed');
  assert.equal(f.store.getSubmission(f.batch.code, payload.submissionId).expectedLines, 2);
  const before = f.store.listExportLines(f.batch.code);
  const packLine = before.find(line => line.productId === whole.id);
  assert.deepEqual([packLine.unit, packLine.priceCents, packLine.feeCategory, packLine.feeRateBps, packLine.feeCents],
    ['件', 21000, 'selfSelected', 500, 1050]);
  assert.equal(packLine.split, undefined);
  assert.equal(f.service.queryOrders(f.batch, phone).totalCents, 22050);
  const group = confirm(f);
  assert.equal(group.progress.totalPortions, 3); assert.equal(group.progress.purchasedPacks, 1);
  assert.equal(group.customers.length, 1); assert.equal(group.customers[0].lineId, before.find(line => line.productId === portion.id).lineId);
  const after = f.store.listExportLines(f.batch.code);
  assert.equal(after.find(line => line.productId === whole.id).amountCents, 21000);
  assert.equal(after.find(line => line.productId === whole.id).feeCents, 1050);
  assert.equal(f.service.queryOrders(f.batch, phone).totalCents, 40230);
  assert.equal(f.service.getStats([f.batch.code]).products.length, 2);
  f.service.updateProduct('beef', { priceCents: 25000 });
  assert.equal(f.store.listExportLines(f.batch.code).find(line => line.productId === whole.id).priceCents, 21000);
  assert.equal(f.store.listExportLines(f.batch.code).find(line => line.productId === portion.id).priceCents, 6000);
});

test('legacy private whole-pack quotes never become portion prices or redirect to the portion product', async t => {
  const f = fixture(t); const c = customerFixture(f); const ownerHash = customerOwner(c.token);
  const personal = { id: 'self_2_6505_111', name: '旧私人整盒', spec: '1.8kg', unit: '盒', priceCents: 18000,
    source, spuId: '111', onSale: true, selectable: true, version: 'a'.repeat(64), expiresAt: '2026-10-14T00:00:00Z',
    selfSelected: true, reusedProductId: 'beef', localVersion: productVersion(f.store.getProduct('beef')) };
  f.store.saveCustomerProduct(f.batch.code, ownerHash, samsStoreKey(storeLocation), personal, Date.parse(time));
  const listed = c.customer.list(f.batch, c.token).products[0];
  assert.equal(listed.id, personal.id); assert.equal(listed.purchaseIdentity.kind, 'whole');
  assert.equal(listed.recommendedProductId, undefined); assert.equal(listed.split, undefined);
  assert.equal(listed.priceCents, 18000); assert.equal(listed.spec, '1.8kg'); assert.equal(listed.unit, '盒');
  const refreshed = await c.addWhole();
  assert.equal(refreshed.id, personal.id); assert.equal(refreshed.priceCents, 21000);
  assert.equal(refreshed.split, undefined); assert.equal(refreshed.spec, '1.8kg'); assert.equal(refreshed.unit, '件');
  await c.customer.submit(f.batch, c.token, c.payload([{ product: refreshed }]));
  assert.equal(f.store.listOrderLines(f.batch.code)[0].snapshot.split, undefined);
});

test('an existing private whole quote remains whole after a matching recommendation is split and later settled', async t => {
  const f = fixture(t, { products: [products[1]], batch: { splitRules: {} } }); const c = customerFixture(f);
  const oldWhole = await c.addWhole();
  f.store.importProducts(products);
  f.service.updateBatch(f.batch.code, { productIds: ['beef', 'milk'], splitRules: { beef: rule },
    feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: 500 } });
  const listed = c.customer.list(f.batch, c.token).products[0];
  assert.equal(listed.id, oldWhole.id); assert.equal(listed.priceCents, 21000); assert.equal(listed.spec, '1.8kg');
  assert.equal(listed.feeCategory, 'selfSelected'); assert.equal(listed.split, undefined); assert.equal(listed.unit, '件');
  submit(f, 3, { phone: '13800138001' }); confirm(f);
  f.service.updateBatch(f.batch.code, { collecting: true });
  const available = await c.addWhole();
  assert.equal(available.selectable, true); assert.equal(available.purchaseIdentity.kind, 'whole');
  await c.customer.submit(f.batch, c.token, c.payload([{ product: available }]));
  const line = f.store.listExportLines(f.batch.code).find(line => line.productId === available.id);
  assert.equal(line.split, undefined); assert.equal(line.feeRateBps, 500); assert.equal(line.priceCents, 21000);
  assert.equal(f.service.getSplitGroups(f.batch)[0].progress.totalPortions, 3);
});

test('a private whole ID later used for a portion recommendation migrates to a distinct whole ID before either can be bought', async t => {
  const f = fixture(t, { products: [products[1]], batch: { splitRules: {} } }); const c = customerFixture(f);
  const original = await c.addWhole();
  f.store.importProducts([products[1], { ...products[0], id: original.id }]);
  f.service.updateBatch(f.batch.code, { productIds: ['milk', original.id], splitRules: { [original.id]: rule } });
  const portion = f.service.getCatalog(f.batch).products.find(product => product.id === original.id);
  const migrated = c.customer.list(f.batch, c.token).products[0];
  assert.equal(migrated.id, 'self_whole_2_6505_111'); assert.equal(migrated.previousProductId, original.id);
  assert.equal(migrated.purchaseIdentity.kind, 'whole'); assert.equal(migrated.priceCents, 21000);
  assert.equal(migrated.spec, '1.8kg'); assert.equal(migrated.unit, '件'); assert.equal(migrated.split, undefined);
  assert.equal(portion.purchaseIdentity.kind, 'portion'); assert.equal(portion.priceCents, 6000);
  assert.equal(portion.unit, '份'); assert.notEqual(portion.version, original.version);
  const confirmed = await c.addWhole();
  assert.equal(confirmed.id, migrated.id); assert.equal(confirmed.quoteExpired, false);
  const unique = c.customer.list(f.batch, c.token).products;
  assert.equal(unique.length, 1); assert.equal(unique[0].previousProductId, original.id);
  await c.customer.submit(f.batch, c.token, c.payload([{ product: portion, quantity: 3 }, { product: confirmed }]));
  const lines = f.store.listOrderLines(f.batch.code);
  assert.equal(lines.length, 2);
  assert.equal(lines.find(line => line.productId === original.id).snapshot.unit, '份');
  assert.equal(lines.find(line => line.productId === migrated.id).snapshot.unit, '件');
});

test('a legacy private quote already contaminated with portion data requires a verified whole quote instead of treating the portion price as whole', async t => {
  const f = fixture(t); const c = customerFixture(f);
  const personal = { id: 'self_2_6505_111', name: '旧污染的分装资料', spec: rule.portionSpec, unit: '份', priceCents: 6000,
    source, spuId: '111', onSale: false, selectable: false, version: 'a'.repeat(64), expiresAt: '2026-10-14T00:00:00Z',
    split: { ...rule }, recommendedProductId: 'beef', selfSelected: true,
    reusedProductId: 'beef', localVersion: productVersion(f.store.getProduct('beef')) };
  f.store.saveCustomerProduct(f.batch.code, customerOwner(c.token), samsStoreKey(storeLocation), personal, f.now());
  const listed = c.customer.list(f.batch, c.token).products[0];
  assert.equal(listed.priceCents, null); assert.equal(listed.selectable, false);
  assert.equal(listed.split, undefined); assert.equal(listed.recommendedProductId, undefined);
  assert.equal(listed.purchaseIdentity.kind, 'whole'); assert.match(listed.selectionUnavailableReason, /整包报价.*查询/);
  const confirmed = await c.addWhole();
  assert.equal(confirmed.priceCents, 21000); assert.equal(confirmed.spec, '1.8kg'); assert.equal(confirmed.unit, '件');
  await c.customer.submit(f.batch, c.token, c.payload([{ product: confirmed }]));
  assert.equal(f.store.listOrderLines(f.batch.code)[0].snapshot.priceCents, 21000);
  assert.equal(f.store.listOrderLines(f.batch.code)[0].snapshot.split, undefined);
});

test('mixed whole and portion orders roll back both lines and drafts when a later line fails', async t => {
  const f = fixture(t); const c = customerFixture(f); const whole = await c.addWhole();
  const portion = f.service.getCatalog(f.batch).products.find(product => product.id === 'beef');
  const payload = c.payload([{ product: portion, quantity: 3 }, { product: whole }]);
  f.store.db.exec(`CREATE TRIGGER fail_whole BEFORE INSERT ON order_lines WHEN NEW.product_id='self_2_6505_111' BEGIN SELECT RAISE(ABORT,'mixed rollback'); END`);
  await assert.rejects(c.customer.submit(f.batch, c.token, payload), /mixed rollback/);
  assert.equal(f.store.listOrderLines(f.batch.code).length, 0);
  assert.equal(f.store.getSubmission(f.batch.code, payload.submissionId), null);
  assert.equal(f.store.getProduct(whole.id), null);
});

test('a portion specification change during whole detail refresh rejects a mixed order before committing old units', async t => {
  const f = fixture(t); const c = customerFixture(f); const whole = await c.addWhole();
  const portion = f.service.getCatalog(f.batch).products.find(product => product.id === 'beef');
  const payload = c.payload([{ product: portion, quantity: 3 }, { product: whole }]);
  c.state.hook = () => f.service.updateBatch(f.batch.code, { splitRules: { beef: { ...rule, portionSpec: '新分装规格', priceCents: 7000 } } });
  await assert.rejects(c.customer.submit(f.batch, c.token, payload), { code: 'PRODUCT_CHANGED' });
  assert.equal(f.store.listOrderLines(f.batch.code).length, 0); assert.equal(f.store.getSubmission(f.batch.code, payload.submissionId), null);
  c.state.hook = null;
  const currentWhole = c.customer.list(f.batch, c.token).products[0];
  const currentPortion = f.service.getCatalog(f.batch).products.find(product => product.id === 'beef');
  await c.customer.submit(f.batch, c.token, c.payload([{ product: currentPortion, quantity: 3 }, { product: currentWhole }]));
  const lines = f.store.listOrderLines(f.batch.code);
  assert.equal(lines.find(line => line.productId === 'beef').snapshot.spec, '新分装规格');
  assert.equal(lines.find(line => line.productId === whole.id).snapshot.spec, '1.8kg');
});
