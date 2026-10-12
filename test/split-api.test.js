import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../server/local-store.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sam-split-http-'));
  const seeded = new LocalStore({ path: join(dir, 'orders.sqlite') });
  seeded.importProducts([{ id: 'beef', name: '牛肉拼份测试', spec: '1.8kg', unit: '盒', priceCents: 18000,
    category: '生鲜', onSale: true }, { id: 'milk', name: '牛奶', spec: '1L', unit: '盒', priceCents: 1000, category: '乳品', onSale: true }]);
  seeded.setMeta('localInitialized', true); seeded.close();
  const preload = join(dir, 'block-network.mjs');
  await writeFile(preload, `globalThis.fetch=async()=>{throw new Error('remote network forbidden in split HTTP test')};\n`);
  const lark = join(dir, 'block-lark.cjs');
  await writeFile(lark, `#!${process.execPath}\nthrow new Error('Feishu calls forbidden');\n`, { mode: 0o700 });
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = 'split-api-test-password';
  const child = spawn(process.execPath, ['--import', preload, 'server/index.js'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', PORT: String(port),
      PUBLIC_BASE_URL: origin, ADMIN_PASSWORD: password, LARK_CLI_BIN: lark }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM'); await exited; clearTimeout(force);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 6000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`split test server exited: ${log}`);
    try { if ((await fetch(origin + '/api/health', { signal: AbortSignal.timeout(400) })).status === 200) break; } catch {}
    if (Date.now() > deadline) throw new Error(`split test server timeout: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  let cookie = '';
  const request = async (path, method = 'GET', body, auth = true) => {
    const response = await fetch(origin + path, { method, headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth && cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), response };
  };
  const login = await request('/api/admin/login', 'POST', { password }, false); assert.equal(login.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  return { request };
}

test('real HTTP split flow preserves pending estimates, requires closed collection, confirms FIFO and rejects later append', async t => {
  const { request } = await fixture(t);
  const create = await request('/api/admin/batches', 'POST', { requestId: randomUUID(), communityName: '拼份HTTP验收',
    productIds: ['beef', 'milk'], splitRules: { beef: { partsPerPack: 3, portionSpec: '约600g', priceCents: 6000 } },
    feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: null } });
  assert.equal(create.status, 201);
  const code = create.json.batch.code;
  const endpoint = `/api/admin/batches/${code}/split/beef/confirm`;
  assert.equal((await request(endpoint, 'POST', { remainderPolicy: 'cancel' }, false)).status, 401);
  const catalog = (await request(`/api/batches/${code}/catalog`, 'GET', undefined, false)).json;
  assert.equal(catalog.products.find(p => p.id === 'beef').unit, '份');
  const items = [{ productId: 'beef', quantity: 5, version: catalog.products.find(p => p.id === 'beef').version }];
  const quote = await request(`/api/batches/${code}/quote`, 'POST', { items, phone: '13800138000', feePolicyVersion: catalog.batch.feePolicyVersion }, false);
  assert.equal(quote.status, 200); assert.equal(quote.json.pendingGoodsCents, 30000); assert.equal(quote.json.totalCents, 30300);
  const payload = { submissionId: randomUUID(), name: '拼份测试', phone: '13800138000', items,
    feePolicyVersion: quote.json.feePolicyVersion, feeQuoteVersion: quote.json.feeQuoteVersion };
  assert.equal((await request(`/api/batches/${code}/orders`, 'POST', payload, false)).status, 200);
  const pending = await request(`/api/batches/${code}/query`, 'POST', { phone: '13800138000' }, false);
  assert.equal(pending.json.totalCents, 0); assert.equal(pending.json.pendingQuantity, 5);
  const stillOpen = await request(endpoint, 'POST', { remainderPolicy: 'cancel' });
  assert.equal(stillOpen.status, 409); assert.equal(stillOpen.json.error.code, 'SPLIT_CONFIRM_OPEN');
  assert.equal((await request(`/api/admin/batches/${code}`, 'PATCH', { collecting: false })).status, 200);
  const confirmed = await request(endpoint, 'POST', { remainderPolicy: 'cancel' });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.json.group.progress.purchasedPacks, 1);
  assert.equal(confirmed.json.group.customers[0].formedQuantity, 3);
  assert.deepEqual((await request(endpoint, 'POST', { remainderPolicy: 'cancel' })).json, confirmed.json);
  const actual = await request(`/api/batches/${code}/query`, 'POST', { phone: '13800138000' }, false);
  assert.equal(actual.json.totalCents, 18180); assert.equal(actual.json.pendingGoodsCents, 0);
  assert.equal(actual.json.products[0].split.unformedQuantity, 2);
  const stats = await request(`/api/admin/stats?codes=${code}`);
  assert.equal(stats.json.products[0].quantity, 1); assert.equal(stats.json.products[0].unit, '盒');
  const recordId = stats.json.orders[0].recordId;
  const invalidQty = await request(`/api/admin/batches/${code}/orders/${recordId}`, 'PATCH', { quantity: 4 });
  assert.equal(invalidQty.status, 409); assert.equal(invalidQty.json.error.code, 'SPLIT_QUANTITY_LOCKED');
  await request(`/api/admin/batches/${code}`, 'PATCH', { collecting: true });
  const append = await request(`/api/batches/${code}/orders`, 'POST', { ...payload, submissionId: randomUUID() }, false);
  assert.equal(append.status, 409); assert.equal(append.json.error.code, 'SPLIT_SETTLED');
  assert.equal((await request(`/api/batches/${code}/orders`, 'POST', payload, false)).status, 200);
  const canceled = await request(`/api/admin/batches/${code}/orders/${recordId}`, 'PATCH', { status: '已取消' });
  assert.equal(canceled.status, 200); assert.equal(canceled.json.order.amountCents, 0); assert.equal(canceled.json.order.split.formedQuantity, 3);
  const finalStats = (await request(`/api/admin/stats?codes=${code}`)).json;
  assert.equal(finalStats.splitGroups[0].progress.retainedPortions, 3); assert.equal(finalStats.totalCents, 0);
});
