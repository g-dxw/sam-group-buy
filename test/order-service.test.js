import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../server/journal.js';
import { DomainError, OrderService } from '../server/order-service.js';

const batch = { code: 'demo', name: '演示', imageUrlTemplate: '/images/products/{id}.svg' };
const phone = '13800138000';
const defaults = [
  { id: 'SAM-001', name: '演示牛奶', spec: '12 瓶', unit: '箱', priceCents: 9900, onSale: true, sort: 1, category: '乳品' },
  { id: 'SAM-002', name: '演示鸡蛋', spec: '24 个', unit: '盒', priceCents: 3900, onSale: true, sort: 2, category: '生鲜' },
];

class FakeRepository {
  constructor() {
    this.data = new Map();
    this.createCalls = [];
    this.confirmCalls = [];
    this.readCalls = 0;
    this.createHooks = [];
    this.confirmHooks = [];
    this.readHook = null;
    this.productError = null;
    this.orderTableError = null;
    this.activeWrites = 0;
    this.maxActiveWrites = 0;
    this.sequence = 0;
  }
  forBatch(value) {
    if (!this.data.has(value.code)) this.data.set(value.code, {
      products: structuredClone(defaults),
      settings: { title: '本期演示', description: '', collecting: true, cutoffAt: null, contactNote: '修改请联系组织者' },
      lines: [],
    });
    return this.data.get(value.code);
  }
  async readProducts(value) {
    if (this.productError) throw this.productError;
    return structuredClone(this.forBatch(value).products);
  }
  async readSettings(value) { return structuredClone(this.forBatch(value).settings); }
  async verifyOrderTable() { if (this.orderTableError) throw this.orderTableError; }
  async readOrderLines(value, filter = {}) {
    this.readCalls += 1;
    if (this.readHook) return this.readHook(value, filter, this);
    return this.readCurrent(value, filter);
  }
  readCurrent(value, { phone: matchPhone, submissionId } = {}) {
    return structuredClone(this.forBatch(value).lines.filter((line) => (!matchPhone || line.phone === matchPhone)
      && (!submissionId || line.submissionId === submissionId)));
  }
  add(value, lines) {
    const result = lines.map((line) => ({ ...structuredClone(line), recordId: `rec${++this.sequence}` }));
    this.forBatch(value).lines.push(...result);
    return structuredClone(result);
  }
  async createOrderLines(value, lines) {
    this.createCalls.push({ batch: value.code, lines: structuredClone(lines) });
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      const hook = this.createHooks.shift();
      return hook ? await hook(value, lines, this) : this.add(value, lines);
    } finally { this.activeWrites -= 1; }
  }
  async confirmOrderLines(value, ids) {
    this.confirmCalls.push([...ids]);
    const hook = this.confirmHooks.shift();
    if (hook) return hook(value, ids, this);
    for (const line of this.forBatch(value).lines) if (ids.includes(line.recordId)) line.syncStatus = '已确认';
  }
}

function fixture(t, options = {}) {
  const journal = options.journal || new Journal({ path: ':memory:' });
  const repository = options.repository || new FakeRepository();
  const service = new OrderService({ repository, journal, retryDelayMs: 0, ...options });
  t.after(async () => { await service.waitForIdle(); journal.close(); });
  return { journal, repository, service };
}

async function order(service, quantities = [2], overrides = {}, value = batch) {
  const catalog = await service.getCatalog(value);
  return {
    submissionId: randomUUID(), name: '测试小王', phone, note: '',
    items: quantities.map((quantity, index) => ({
      productId: catalog.products[index].id, quantity, version: catalog.products[index].version,
    })), ...overrides,
  };
}

async function finish(service, value, payload) {
  const result = await service.submit(value, payload);
  await service.waitForIdle(value);
  return service.getSubmission(value, result.submissionId);
}

test('manually abandoned partial creation no longer appears pending or counts as an order', async t => {
  const { service, repository, journal } = fixture(t);
  const payload = await order(service, [1, 1]);
  repository.createHooks.push((value, lines, repo) => {
    repo.add(value, lines.slice(0, 1));
    throw Object.assign(new Error('unknown partial create'), { uncertain: true });
  });
  await service.submit(batch, payload);
  await service.waitForIdle(batch);
  journal.update(batch.code, payload.submissionId, { status: 'failed', phase: 'abandoned' });
  const result = await service.queryOrders(batch, phone);
  assert.equal(result.pendingCount, 0);
  assert.equal(result.hasOrders, false);
  assert.equal(result.totalCents, 0);
  assert.equal(repository.forBatch(batch).lines.length, 1);
});

test('catalog maps product ID images and normalizes phone; two orders append 2 + 1', async (t) => {
  const { service, repository } = fixture(t);
  const catalog = await service.getCatalog(batch);
  assert.equal(catalog.products[0].imageUrl, '/images/products/SAM-001.svg');
  const first = await order(service, [2], { phone: '+86 138-0013-8000' });
  assert.equal((await finish(service, batch, first)).status, 'completed');
  const second = await order(service, [1]);
  assert.equal((await finish(service, batch, second)).status, 'completed');
  const query = await service.queryOrders(batch, '0086 13800138000');
  assert.equal(query.phone, phone);
  assert.equal(query.products[0].quantity, 3);
  assert.equal(query.totalCents, 29700);
  assert.equal(query.pendingCount, 0);
  assert.equal(repository.createCalls.length, 2);
});

test('same UUID and normalized payload never create twice; changed payload conflicts', async (t) => {
  const { service, repository } = fixture(t);
  const payload = await order(service);
  await Promise.all([service.submit(batch, payload), service.submit(batch, { ...payload, phone: `+86 ${phone}` })]);
  await service.waitForIdle();
  assert.equal((await service.submit(batch, payload)).status, 'completed');
  assert.equal(repository.createCalls.length, 1);
  await assert.rejects(service.submit(batch, { ...payload, name: '另一人' }), (error) => error.status === 409 && error.code === 'SUBMISSION_CONFLICT');
  await assert.rejects(service.submit(batch, { ...payload, items: [{ ...payload.items[0], quantity: 3 }] }), (error) => error.code === 'SUBMISSION_CONFLICT');
});

test('parallel distinct submissions use one writer per batch', async (t) => {
  const { service, repository } = fixture(t);
  for (let i = 0; i < 6; i += 1) repository.createHooks.push(async (value, lines, repo) => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return repo.add(value, lines);
  });
  const payloads = await Promise.all(Array.from({ length: 6 }, () => order(service, [1])));
  await Promise.all(payloads.map((payload) => service.submit(batch, payload)));
  await service.waitForIdle();
  assert.equal(repository.maxActiveWrites, 1);
  assert.equal(repository.forBatch(batch).lines.length, 6);
  assert.ok(payloads.every((payload) => service.getSubmission(batch, payload.submissionId).status === 'completed'));
});

test('a settled partial failure reconciles existing rows and creates only missing rows', async (t) => {
  const { service, repository } = fixture(t);
  repository.createHooks.push(async (value, lines, repo) => {
    repo.add(value, [lines[0]]);
    throw Object.assign(new Error('known partial failure'), { outcome: 'settled' });
  });
  const payload = await order(service, [2, 1]);
  assert.equal((await finish(service, batch, payload)).status, 'completed');
  assert.deepEqual(repository.createCalls.map((call) => call.lines.length), [2, 1]);
  assert.equal(repository.forBatch(batch).lines.length, 2);
  assert.equal(new Set(repository.forBatch(batch).lines.map((line) => line.lineId)).size, 2);
});

test('create timeout after full commit is reconciled without another create', async (t) => {
  const { service, repository } = fixture(t);
  repository.createHooks.push(async (value, lines, repo) => {
    repo.add(value, lines);
    throw Object.assign(new Error('timeout'), { uncertain: true, outcome: 'unknown' });
  });
  const payload = await order(service, [2, 1]);
  assert.equal((await finish(service, batch, payload)).status, 'completed');
  assert.equal(repository.createCalls.length, 1);
  assert.equal(repository.confirmCalls.length, 1);
});

test('unknown partial or empty result never retries create; blocks only its batch', async (t) => {
  const { service, repository } = fixture(t);
  repository.createHooks.push(async (value, lines, repo) => {
    repo.add(value, [lines[0]]);
    throw Object.assign(new Error('still in flight'), { outcome: 'unknown' });
  });
  const payload = await order(service, [2, 1]);
  assert.equal((await finish(service, batch, payload)).status, 'reconciling');
  await service.waitForIdle();
  const second = await order(service, [1]);
  await service.submit(batch, second);
  await service.waitForIdle();
  assert.equal(repository.createCalls.length, 1);
  assert.equal(service.getSubmission(batch, second.submissionId).status, 'pending');
  const other = { ...batch, code: 'other' };
  const independent = await order(service, [1], {}, other);
  assert.equal((await finish(service, other, independent)).status, 'completed');
  assert.equal(repository.createCalls.length, 2);
  const query = await service.queryOrders(batch, phone);
  assert.equal(query.products.length, 0);
  assert.equal(query.pendingCount, 2);
  assert.equal(repository.confirmCalls.length, 1);
});

test('successful create with temporarily invisible rows is never repeated', async (t) => {
  const { service, repository } = fixture(t);
  repository.readHook = () => [];
  const payload = await order(service);
  assert.equal((await finish(service, batch, payload)).status, 'reconciling');
  await service.waitForIdle();
  assert.equal(repository.createCalls.length, 1);
  repository.readHook = null;
  service.getSubmission(batch, payload.submissionId);
  await service.waitForIdle();
  assert.equal(service.getSubmission(batch, payload.submissionId).status, 'completed');
  assert.equal(repository.createCalls.length, 1);
});

test('duplicate remote line IDs are not confirmed, included, or recreated', async (t) => {
  const { service, repository } = fixture(t);
  repository.createHooks.push(async (value, lines, repo) => {
    const records = repo.add(value, lines);
    repo.add(value, [lines[0]]);
    return records;
  });
  const payload = await order(service);
  assert.equal((await finish(service, batch, payload)).status, 'reconciling');
  assert.equal(repository.confirmCalls.length, 0);
  const query = await service.queryOrders(batch, phone);
  assert.equal(query.hasOrders, false);
  assert.equal(query.pendingCount, 1);
  assert.equal(repository.createCalls.length, 1);
});

test('unknown confirmation is checked later; no receipt until every line is confirmed', async (t) => {
  const { service, repository } = fixture(t);
  repository.confirmHooks.push(async (value, ids, repo) => {
    repo.forBatch(value).lines.find((line) => line.recordId === ids[0]).syncStatus = '已确认';
    throw Object.assign(new Error('confirmation timeout'), { outcome: 'unknown' });
  });
  const payload = await order(service, [2, 1]);
  const submitted = await service.submit(batch, payload);
  assert.equal(submitted.status, 'pending');
  assert.equal(submitted.receipt, undefined);
  await service.waitForIdle();
  assert.equal((await service.queryOrders(batch, phone)).hasOrders, false);
  service.getSubmission(batch, payload.submissionId);
  await service.waitForIdle();
  assert.equal(service.getSubmission(batch, payload.submissionId).status, 'completed');
  assert.equal(repository.createCalls.length, 1);
  assert.equal(repository.confirmCalls[1].length, 1);
});

test('file journal restores a crashed create by reading it, and does not rebuild completed deletions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-journal-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite');
  const repository = new FakeRepository();
  let journal = new Journal({ path });
  let service = new OrderService({ repository, journal, retryDelayMs: 0 });
  const payload = await order(service, [2, 1]);
  repository.createHooks.push(async (value, lines, repo) => {
    repo.add(value, lines);
    throw Object.assign(new Error('crash-like timeout'), { outcome: 'unknown' });
  });
  repository.readHook = () => { throw new Error('connection unavailable'); };
  await service.submit(batch, payload);
  await service.waitForIdle();
  journal.update(batch.code, payload.submissionId, { phase: 'creating', nextCheckAt: 0 });
  journal.close();
  journal = new Journal({ path });
  service = new OrderService({ repository, journal, retryDelayMs: 0 });
  repository.readHook = null;
  service.recover([batch]);
  await service.waitForIdle();
  assert.equal(service.getSubmission(batch, payload.submissionId).status, 'completed');
  assert.equal(repository.createCalls.length, 1);
  repository.forBatch(batch).lines.splice(0);
  service.recover([batch]);
  await service.submit(batch, payload);
  await service.waitForIdle();
  assert.equal(repository.createCalls.length, 1);
  assert.equal((await service.queryOrders(batch, phone)).hasOrders, false);
  journal.close();
});

test('current price and manual edits are reflected, while completed retries never overwrite them', async (t) => {
  const { service, repository } = fixture(t);
  const payload = await order(service, [2, 1]);
  await finish(service, batch, payload);
  const data = repository.forBatch(batch);
  data.products[0].priceCents = 12300;
  data.products[0].onSale = false;
  data.lines[0].quantity = 5;
  data.lines[0].status = '已买到';
  data.lines[1].status = '已取消';
  const query = await service.queryOrders(batch, phone);
  assert.equal(query.products[0].name, '演示牛奶');
  assert.equal(query.products[0].quantity, 5);
  assert.equal(query.totalCents, 61500);
  assert.equal(query.products[1].amountCents, 0);
  assert.equal(query.products[1].quantity, 1);
  assert.deepEqual(query.products[1].statuses, [{ status: '已取消', quantity: 1 }]);
  await service.submit(batch, payload);
  await service.waitForIdle();
  assert.equal(repository.createCalls.length, 1);
  assert.equal(repository.confirmCalls.length, 1);
  assert.equal(data.lines[0].quantity, 5);
  assert.equal(data.lines[1].status, '已取消');
});

test('out-of-stock quantity is shown but excluded from amount; missing product amount is unknown', async (t) => {
  const { service, repository } = fixture(t);
  await finish(service, batch, await order(service, [2, 1]));
  const data = repository.forBatch(batch);
  data.lines[0].status = '缺货';
  let query = await service.queryOrders(batch, phone);
  assert.equal(query.products[0].quantity, 2);
  assert.equal(query.products[0].amountCents, 0);
  assert.equal(query.totalCents, 3900);
  data.products.splice(1, 1);
  query = await service.queryOrders(batch, phone);
  assert.equal(query.products[1].missing, true);
  assert.equal(query.products[1].priceCents, null);
  assert.equal(query.products[1].amountCents, null);
  assert.equal(query.totalCents, null);
});

test('closed and cutoff batches reject new orders but keep querying completed orders', async (t) => {
  const { service, repository } = fixture(t);
  await finish(service, batch, await order(service));
  const payload = await order(service);
  repository.forBatch(batch).settings.collecting = false;
  await assert.rejects(service.submit(batch, payload), (error) => error.code === 'COLLECTION_CLOSED');
  assert.equal((await service.queryOrders(batch, phone)).hasOrders, true);
  repository.forBatch(batch).settings.collecting = true;
  repository.forBatch(batch).settings.cutoffAt = '2000-01-01T00:00:00Z';
  await assert.rejects(service.submit(batch, payload), (error) => error.code === 'COLLECTION_CLOSED');
});

test('price, specification, sale state and duplicate ID errors are detected fresh', async (t) => {
  const { service, repository } = fixture(t);
  const payload = await order(service);
  const data = repository.forBatch(batch);
  data.products[0].priceCents += 1;
  await assert.rejects(service.submit(batch, payload), (error) => error.status === 409 && error.code === 'PRODUCT_CHANGED' && Boolean(error.details.catalog));
  data.products[0].priceCents -= 1;
  data.products[0].spec = '新规格';
  await assert.rejects(service.submit(batch, payload), (error) => error.code === 'PRODUCT_CHANGED');
  data.products[0].spec = defaults[0].spec;
  data.products[0].onSale = false;
  await assert.rejects(service.submit(batch, payload), (error) => error.code === 'PRODUCT_CHANGED');
  data.products.push(structuredClone(data.products[0]));
  await assert.rejects(service.getCatalog(batch), (error) => error.code === 'CATALOG_INVALID');
});

test('queued order is revalidated if cutoff or catalog changes before its write', async (t) => {
  const { service, repository } = fixture(t);
  let release;
  const started = new Promise((resolve) => {
    repository.createHooks.push(async (value, lines, repo) => {
      resolve();
      await new Promise((done) => { release = done; });
      return repo.add(value, lines);
    });
  });
  const first = await order(service);
  const second = await order(service);
  await service.submit(batch, first);
  await started;
  await service.submit(batch, second);
  repository.forBatch(batch).settings.collecting = false;
  release();
  await service.waitForIdle();
  assert.equal(service.getSubmission(batch, first.submissionId).status, 'completed');
  assert.equal(service.getSubmission(batch, second.submissionId).status, 'failed');
  assert.equal(repository.createCalls.length, 1);
});

test('explicit deleted resource is 410; permissions and ambiguous 404 remain unavailable', async (t) => {
  const { service, repository } = fixture(t);
  repository.productError = Object.assign(new Error('deleted'), { resourceMissing: true });
  await assert.rejects(service.getCatalog(batch), (error) => error.status === 410 && error.code === 'BATCH_ENDED');
  repository.productError = Object.assign(new Error('forbidden'), { status: 403 });
  await assert.rejects(service.getCatalog(batch), (error) => error.status === 503 && error.code === 'FEISHU_ACCESS_UNAVAILABLE');
  repository.productError = Object.assign(new Error('ambiguous not found'), { status: 404 });
  await assert.rejects(service.getCatalog(batch), (error) => error.status === 503);
});

test('deleted order table is detected before creating an outbox or accepting the first order', async (t) => {
  const { service, repository, journal } = fixture(t);
  const payload = await order(service);
  repository.orderTableError = Object.assign(new Error('order table deleted'), { resourceMissing: true });
  await assert.rejects(service.getCatalog(batch), (error) => error.status === 410 && error.code === 'BATCH_ENDED');
  await assert.rejects(service.submit(batch, payload), (error) => error.status === 410 && error.code === 'BATCH_ENDED');
  assert.equal(journal.get(batch.code, payload.submissionId), null);
  assert.equal(repository.createCalls.length, 0);
});

for (const stage of ['create', 'read', 'confirm']) {
  test(`confirmed order-table deletion during ${stage} is terminal and never retried`, async (t) => {
    const { service, repository, journal } = fixture(t);
    const deleted = Object.assign(new Error('order table deleted'), { resourceMissing: true });
    const payload = await order(service, [2, 1]);
    if (stage === 'create') repository.createHooks.push(async () => { throw deleted; });
    else if (stage === 'read') repository.readHook = () => { throw deleted; };
    else repository.confirmHooks.push(async () => { throw deleted; });
    await service.submit(batch, payload);
    await service.waitForIdle();
    const result = service.getSubmission(batch, payload.submissionId);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'BATCH_ENDED');
    assert.equal(journal.get(batch.code, payload.submissionId).phase, 'ended');
    assert.equal(journal.listUnfinished([batch.code]).length, 0);
    const createCalls = repository.createCalls.length;
    const confirmCalls = repository.confirmCalls.length;
    const readCalls = repository.readCalls;
    service.recover([batch]);
    await service.submit(batch, payload);
    await service.waitForIdle();
    assert.equal(repository.createCalls.length, createCalls);
    assert.equal(repository.confirmCalls.length, confirmCalls);
    assert.equal(repository.readCalls, readCalls);
  });
}

test('order-table permission or network failure remains reconciling rather than ended', async (t) => {
  const { service, repository } = fixture(t);
  const payload = await order(service);
  repository.readHook = () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
  await service.submit(batch, payload);
  await service.waitForIdle();
  assert.equal(service.getSubmission(batch, payload.submissionId).status, 'reconciling');
  repository.readHook = null;
  await service.waitForIdle();
  assert.equal(service.getSubmission(batch, payload.submissionId).status, 'completed');
  assert.equal(repository.createCalls.length, 1);
});

test('malformed inputs, cross-phone rows and legacy incomplete rows do not leak or count', async (t) => {
  const { service, repository } = fixture(t);
  const payload = await order(service);
  for (const quantity of [0, -1, 0.5, 1000, '2']) {
    await assert.rejects(service.submit(batch, { ...payload, items: [{ ...payload.items[0], quantity }] }), (error) => error.code === 'INVALID_QUANTITY');
  }
  await assert.rejects(service.submit(batch, { ...payload, phone: '123' }), (error) => error.code === 'INVALID_PHONE');
  await assert.rejects(service.submit(batch, { ...payload, items: [payload.items[0], payload.items[0]] }), (error) => error.code === 'INVALID_ITEMS');
  await assert.rejects(service.submit(batch, { ...payload, submissionId: '../escape' }), (error) => error.code === 'INVALID_SUBMISSION_ID');
  assert.throws(() => service.getSubmission(batch, randomUUID()), (error) => error.status === 404);
  const otherPhonePayload = await order(service, [2], { phone: '13900139000' });
  await finish(service, batch, otherPhonePayload);
  repository.readHook = (value) => repository.readCurrent(value);
  const query = await service.queryOrders(batch, phone);
  assert.equal(query.hasOrders, false);
  assert.equal(query.pendingCount, 0);
  assert.ok(new DomainError(400, 'EXAMPLE', 'example') instanceof Error);
});

test('reconciliation polls use cooldown and no autonomous busy loop', async (t) => {
  let timestamp = Date.now();
  const { service, repository } = fixture(t, { now: () => new Date(timestamp), retryDelayMs: 5000 });
  repository.createHooks.push(async () => { throw Object.assign(new Error('unknown'), { outcome: 'unknown' }); });
  const payload = await order(service);
  await service.submit(batch, payload);
  await service.waitForIdle();
  const reads = repository.readCalls;
  for (let i = 0; i < 20; i += 1) service.getSubmission(batch, payload.submissionId);
  await service.waitForIdle();
  assert.equal(repository.readCalls, reads);
  timestamp += 5001;
  service.getSubmission(batch, payload.submissionId);
  await service.waitForIdle();
  assert.equal(repository.readCalls, reads + 1);
  assert.equal(repository.createCalls.length, 1);
});
