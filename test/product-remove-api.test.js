import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../server/local-store.js';

test('HTTP product removal requires admin and same origin, blocks backup races, retains history and restores only off sale', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sam-product-remove-http-'));
  const marker = join(dir, 'sync-started'); const gate = join(dir, 'sync-release');
  const seeded = new LocalStore({ path: join(dir, 'orders.sqlite') });
  seeded.importProducts(['p1', 'p2'].map((id, i) => ({ id, name: `移除验收${id}`, spec: '一盒', unit: '盒', priceCents: 1000 + i * 100,
    source: { platform: 'samsclub_cn', spuId: id, storeId: '6505', storeType: 2, priceCents: 1000 }, onSale: true })));
  seeded.setMeta('localInitialized', true); seeded.setMeta('exportSource', { baseToken: 'isolated-test', productTableId: 'test-products', orderTableId: 'test-orders' }); seeded.close();
  const preload = join(dir, 'no-network.mjs'); await writeFile(preload, "globalThis.fetch=async()=>{throw new Error('remote network forbidden in product removal test')};\n");
  const lark = join(dir, 'fake-lark.cjs');
  await writeFile(lark, `#!${process.execPath}\nconst fs=require('node:fs');
    if(process.argv[3]!=='+table-get')throw new Error('unplanned read or remote write forbidden');
    (async()=>{fs.writeFileSync(${JSON.stringify(marker)},'started');
    while(!fs.existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));
    process.stdout.write(JSON.stringify({ok:true,data:{fields:[]}}));})();\n`, { mode: 0o700 });
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`; const password = 'product-remove-api-test';
  const child = spawn(process.execPath, ['--import', preload, 'server/index.js'], { cwd: new URL('../', import.meta.url),
    env: { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: origin, ADMIN_PASSWORD: password, LARK_CLI_BIN: lark },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
  t.after(async () => {
    await writeFile(gate, 'released');
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM'); await exited; clearTimeout(force);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const waitUntil = async predicate => {
    const deadline = Date.now() + 6000;
    while (!(await predicate())) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`product removal HTTP timeout: ${log}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await waitUntil(async () => { try { return (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(400) })).status === 200; } catch { return false; } });
  let cookie = '';
  const request = async (path, method = 'GET', body, authenticated = true, headers = {}) => {
    const response = await fetch(origin + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authenticated && cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), response };
  };
  const login = await request('/api/admin/login', 'POST', { password }, false); cookie = login.response.headers.get('set-cookie').split(';')[0];
  const created = await request('/api/admin/batches', 'POST', { requestId: randomUUID(), communityName: '商品移除HTTP验收' });
  assert.equal(created.status, 201); const code = created.json.batch.code; const publicPath = `/api/batches/${code}`;
  const catalog = (await request(`${publicPath}/catalog`, 'GET', undefined, false)).json;
  const order = { submissionId: randomUUID(), name: '顾客', phone: '13800138000', items: [{ productId: 'p1', quantity: 2, version: catalog.products[0].version }] };
  assert.equal((await request(`${publicPath}/orders`, 'POST', order, false)).status, 200);
  const preview = (await request('/api/admin/products/pricing/preview', 'POST', { productIds: ['p1', 'p2'], markupBps: 1000 })).json;
  assert.equal((await request('/api/admin/products/p1', 'DELETE', {}, false)).status, 401);
  assert.equal((await request('/api/admin/products/p1/restore', 'POST', {}, false)).status, 401);
  assert.equal((await request('/api/admin/products/remove', 'POST', { productIds: ['p1'] }, false)).status, 401);
  assert.equal((await request('/api/admin/products/p1', 'DELETE', {}, true, { Origin: 'https://foreign.test' })).status, 403);
  const running = await request('/api/admin/sync/products/backup', 'POST', {}); assert.equal(running.status, 202);
  await waitUntil(async () => { try { await stat(marker); return true; } catch { return false; } });
  assert.equal((await request('/api/admin/products/p1', 'DELETE', {})).json.error.code, 'PRODUCT_BACKUP_BUSY');
  assert.equal((await request('/api/admin/products/p1/restore', 'POST', {})).json.error.code, 'PRODUCT_BACKUP_BUSY');
  await writeFile(gate, 'release'); await waitUntil(async () => (await request(`/api/admin/jobs/${running.json.id}`)).json.status !== 'running');
  const missing = await request('/api/admin/products/remove', 'POST', { productIds: ['p1', 'missing'] });
  assert.equal(missing.status, 404); assert.equal((await request('/api/admin/products')).json.products.length, 2);
  assert.equal((await request('/api/admin/products/p1', 'DELETE', { unexpected: true })).status, 400);
  const removed = await request('/api/admin/products/p1', 'DELETE', {}); assert.equal(removed.status, 200); assert.equal(removed.json.removed, true);
  assert.equal(removed.json.product.revision, 2); assert.equal(removed.json.product.backupStatus, 'pending'); assert.ok(removed.json.product.removedAt);
  assert.deepEqual((await request('/api/admin/products/p1', 'DELETE', {})).json, removed.json);
  const library = (await request('/api/admin/products')).json; assert.deepEqual(library.products.map(p => p.id), ['p2']); assert.equal(library.removedProducts[0].id, 'p1');
  assert.equal((await request('/api/admin/products/p1', 'PATCH', { onSale: true })).json.error.code, 'PRODUCT_REMOVED');
  assert.equal((await request('/api/admin/products/status', 'POST', { productIds: ['p1', 'p2'], onSale: true })).json.error.code, 'PRODUCT_REMOVED');
  assert.equal((await request('/api/admin/products/pricing/apply', 'POST', { previewId: preview.previewId })).status, 409);
  assert.deepEqual((await request(`${publicPath}/catalog`, 'GET', undefined, false)).json.products.map(p => p.id), ['p2']);
  assert.equal((await request(`${publicPath}/query`, 'POST', { phone: order.phone }, false)).json.totalCents, 2000);
  assert.equal((await request(`${publicPath}/orders`, 'POST', { ...order, submissionId: randomUUID() }, false)).json.error.code, 'CUSTOMER_TOKEN_REQUIRED');
  const patched = await request(`/api/admin/batches/${code}`, 'PATCH', { productIds: ['p1', 'p2'], title: '历史关联可继续编辑' }); assert.equal(patched.status, 200);
  const all = await request('/api/admin/products/remove', 'POST', { productIds: ['p1', 'p2'] }); assert.equal(all.json.updated, 1); assert.equal(all.json.unchanged, 1);
  const overview = (await request('/api/admin/overview')).json; assert.equal(overview.productCount, 0); assert.equal(overview.productSync.counts.total, 2); assert.equal(overview.productSync.pending, 2);
  const audit = new LocalStore({ path: join(dir, 'orders.sqlite') });
  assert.equal(audit.listProducts().length, 0); assert.equal(audit.listProducts({ includeRemoved: true }).length, 2);
  assert.equal(audit.listOrderLines(code)[0].snapshot.priceCents, 1000); assert.deepEqual(audit.getBatch(code).productIds, ['p1', 'p2']); audit.close();
  const restored = await request('/api/admin/products/p1/restore', 'POST', {}); assert.equal(restored.status, 200); assert.equal(restored.json.restored, true);
  assert.equal(restored.json.product.removedAt, null); assert.equal(restored.json.product.onSale, false); assert.equal(restored.json.product.revision, 3);
  assert.deepEqual((await request('/api/admin/products/p1/restore', 'POST', {})).json, restored.json);
  assert.equal((await request('/api/admin/products/pricing/apply', 'POST', { previewId: preview.previewId })).status, 409);
  assert.equal((await request(`${publicPath}/query`, 'POST', { phone: order.phone }, false)).json.totalCents, 2000);
});
