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

test('HTTP pricing APIs require admin auth, preview before apply, reject stale edits and keep customer orders frozen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sam-pricing-http-'));
  const store = new LocalStore({ path: join(dir, 'orders.sqlite') });
  store.importProducts([{ id: 'sam_123', name: '山姆定价测试', spec: '一盒', unit: '盒', priceCents: 10000, onSale: true,
    source: { platform: 'samsclub_cn', spuId: '123', storeId: '6505', storeType: 2, storeName: '测试门店',
      priceCents: 10000, queriedAt: '2026-10-12T10:00:00Z' } },
  { id: 'manual', name: '缺原价商品', spec: '一盒', unit: '盒', priceCents: 3000, onSale: true }]);
  store.setMeta('localInitialized', true); store.close();
  const preload = join(dir, 'source-detail.mjs');
  await writeFile(preload, `globalThis.fetch=async(url,init)=>{
    if(!String(url).endsWith('/goods-portal/spuStoreModel/querySpuDetailToNFC'))throw new Error('other network forbidden');
    const body=JSON.parse(init.body);if(body.spuIdList[0]!=='123'||body.visitStoreId!=='6505')throw new Error('wrong binding');
    return new Response(JSON.stringify({code:'Success',data:{spuId:'123',storeId:'6505',storeType:2,priceInfo:[{priceType:1,price:'12000'}]}}));
  };`);
  const lark = join(dir, 'block-lark.cjs'); await writeFile(lark, `#!${process.execPath}\nthrow new Error('Feishu forbidden');\n`, { mode: 0o700 });
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`; const password = 'pricing-api-test';
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
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(origin + '/api/health', { signal: AbortSignal.timeout(400) })).status === 200) break; } catch {}
    if (Date.now() > deadline) throw new Error(`pricing server timeout: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  let cookie = '';
  const request = async (path, method = 'GET', body, authenticated = true) => {
    const response = await fetch(origin + path, { method, headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authenticated && cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), response };
  };
  const login = await request('/api/admin/login', 'POST', { password }, false);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const previewPath = '/api/admin/products/pricing/preview';
  assert.equal((await request(previewPath, 'POST', { productIds: ['sam_123'], markupBps: 500 }, false)).status, 401);
  assert.equal((await request('/api/admin/products/sam_123/source-price', 'GET', undefined, false)).status, 401);
  const create = await request('/api/admin/batches', 'POST', { requestId: randomUUID(), communityName: '定价HTTP验收' });
  const code = create.json.batch.code; const catalogPath = `/api/batches/${code}/catalog`;
  const catalog = (await request(catalogPath, 'GET', undefined, false)).json;
  const order = { submissionId: randomUUID(), phone: '13800138000', name: '顾客',
    items: [{ productId: 'sam_123', quantity: 1, version: catalog.products.find(product => product.id === 'sam_123').version }] };
  assert.equal((await request(`/api/batches/${code}/orders`, 'POST', order, false)).status, 200);
  const missing = await request(previewPath, 'POST', { productIds: ['sam_123', 'manual'], markupBps: 500 });
  assert.equal(missing.status, 400); assert.deepEqual(missing.json.error.details.productIds, ['manual']);
  const preview = await request(previewPath, 'POST', { productIds: ['sam_123'], markupBps: 500 });
  assert.equal(preview.status, 200); assert.equal(preview.json.rows[0].priceCents, 10500);
  const applied = await request('/api/admin/products/pricing/apply', 'POST', { previewId: preview.json.previewId });
  assert.equal(applied.status, 200); assert.equal(applied.json.products[0].priceCents, 10500);
  assert.deepEqual((await request('/api/admin/products/pricing/apply', 'POST', { previewId: preview.json.previewId })).json, applied.json);
  const stale = await request('/api/admin/products/sam_123', 'PATCH', { expectedRevision: 1, priceCents: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'PRODUCT_REVISION_CONFLICT');
  const sourcePrice = await request('/api/admin/products/sam_123/source-price');
  assert.equal(sourcePrice.status, 200); assert.equal(sourcePrice.json.originalPriceCents, 12000);
  assert.equal(sourcePrice.json.priceCents, 12600);
  const refreshed = await request('/api/admin/products/sam_123', 'PATCH', { originalPriceCents: 12000,
    sourcePricePreviewId: sourcePrice.json.previewId, expectedRevision: 2 });
  assert.equal(refreshed.status, 200); assert.equal(refreshed.json.product.priceCents, 12600);
  assert.equal(refreshed.json.product.source.priceCents, 10000);
  const freshPublic = (await request(catalogPath, 'GET', undefined, false)).json;
  assert.equal(freshPublic.products.find(product => product.id === 'sam_123').priceCents, 12600);
  assert.equal(JSON.stringify(freshPublic).includes('originalPriceCents'), false);
  assert.equal(JSON.stringify(freshPublic).includes('markupBps'), false);
  const query = await request(`/api/batches/${code}/query`, 'POST', { phone: '13800138000' }, false);
  assert.equal(query.json.totalCents, 10000);
  const pricing = { mode: 'amount', markupBps: null, amountCents: 500 };
  const amountPreview = await request(previewPath, 'POST', { productIds: ['sam_123'], pricing });
  assert.equal(amountPreview.status, 200); assert.deepEqual(amountPreview.json.pricing, pricing);
  assert.equal(amountPreview.json.rows[0].priceCents, 12500);
  const amountApplied = await request('/api/admin/products/pricing/apply', 'POST', { previewId: amountPreview.json.previewId });
  assert.equal(amountApplied.status, 200); assert.deepEqual(amountApplied.json.products[0].pricing, pricing);
  assert.deepEqual(amountApplied.json.pricing, pricing);
  assert.equal(amountApplied.json.products[0].priceCents, 12500);
  assert.deepEqual((await request('/api/admin/products/pricing/apply', 'POST', { previewId: amountPreview.json.previewId })).json, amountApplied.json);
  const mixed = await request(previewPath, 'POST', { productIds: ['sam_123'], pricing, markupBps: 500 });
  assert.equal(mixed.status, 400);
  const amountPublic = (await request(catalogPath, 'GET', undefined, false)).json;
  assert.equal(amountPublic.products.find(product => product.id === 'sam_123').priceCents, 12500);
  assert.equal(JSON.stringify(amountPublic).includes('amountCents'), false);
  assert.equal((await request(`/api/batches/${code}/query`, 'POST', { phone: '13800138000' }, false)).json.totalCents, 10000);
});
