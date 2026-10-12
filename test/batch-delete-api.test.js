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

test('HTTP delete/restore enforces auth, closed state, export exclusion and archived customer 404s while preserving order data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sam-batch-delete-http-'));
  const marker = join(dir, 'sync-started'); const gate = join(dir, 'sync-release');
  const seeded = new LocalStore({ path: join(dir, 'orders.sqlite') });
  seeded.importProducts([{ id: 'p1', name: '可恢复期次验收商品', spec: '一盒', unit: '盒', priceCents: 1000, onSale: true }]);
  seeded.setMeta('localInitialized', true);
  seeded.setMeta('exportSource', { baseToken: 'isolated-test', productTableId: 'test-products', orderTableId: 'test-orders' });
  seeded.close();
  const preload = join(dir, 'block-network.mjs'); await writeFile(preload, "globalThis.fetch=async()=>{throw new Error('remote network forbidden in batch deletion test')};\n");
  const lark = join(dir, 'fake-lark.cjs');
  await writeFile(lark, `#!${process.execPath}\nconst fs=require('node:fs');
    if(!['+table-get','+table-list'].includes(process.argv[3]))throw new Error('all remote writes and unplanned reads forbidden');
    (async()=>{fs.writeFileSync(${JSON.stringify(marker)},'started');
    while(!fs.existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));
    process.stdout.write(JSON.stringify({ok:true,data:{fields:[]}}));})();\n`, { mode: 0o700 });
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`; const password = 'batch-delete-api-test';
  const child = spawn(process.execPath, ['--import', preload, 'server/index.js'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', PORT: String(port),
      PUBLIC_BASE_URL: origin, ADMIN_PASSWORD: password, LARK_CLI_BIN: lark }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`batch deletion test timeout: ${log}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await waitUntil(async () => { try { return (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(400) })).status === 200; } catch { return false; } });
  let cookie = '';
  const request = async (path, method = 'GET', body, authenticated = true, headers = {}) => {
    const response = await fetch(origin + path, { method, headers: { ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authenticated && cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), response };
  };
  const login = await request('/api/admin/login', 'POST', { password }, false);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const createInput = { requestId: randomUUID(), communityName: '删除HTTP验收' };
  const created = await request('/api/admin/batches', 'POST', createInput); assert.equal(created.status, 201);
  const code = created.json.batch.code; const adminPath = `/api/admin/batches/${code}`; const publicPath = `/api/batches/${code}`;
  assert.equal((await request(adminPath, 'DELETE', {}, false)).status, 401);
  assert.equal((await request(`${adminPath}/restore`, 'POST', {}, false)).status, 401);
  assert.equal((await request(adminPath, 'DELETE', {}, true, { Origin: 'http://foreign.test' })).status, 403);
  const open = await request(adminPath, 'DELETE', {}); assert.equal(open.status, 409); assert.equal(open.json.error.code, 'BATCH_DELETE_OPEN');
  const catalog = (await request(`${publicPath}/catalog`, 'GET', undefined, false)).json;
  const order = { submissionId: randomUUID(), name: '顾客', phone: '13800138000',
    items: [{ productId: 'p1', quantity: 2, version: catalog.products[0].version }] };
  assert.equal((await request(`${publicPath}/orders`, 'POST', order, false)).status, 200);
  assert.equal((await request(adminPath, 'PATCH', { collecting: false })).status, 200);
  const running = await request(`${adminPath}/sync/orders`, 'POST', {}); assert.equal(running.status, 202);
  await waitUntil(async () => { try { await stat(marker); return true; } catch { return false; } });
  const busy = await request(adminPath, 'DELETE', {}); assert.equal(busy.status, 409); assert.equal(busy.json.error.code, 'BATCH_SYNC_BUSY');
  await writeFile(gate, 'release');
  await waitUntil(async () => (await request(`/api/admin/jobs/${running.json.id}`)).json.status !== 'running');
  const invalid = await request(adminPath, 'DELETE', { productIds: [] }); assert.equal(invalid.status, 400);
  const deleted = await request(adminPath, 'DELETE', {}); assert.equal(deleted.status, 200); assert.equal(deleted.json.deleted, true);
  assert.ok(deleted.json.batch.deletedAt); assert.deepEqual((await request(adminPath, 'DELETE', {})).json, deleted.json);
  const overview = (await request('/api/admin/overview')).json;
  assert.equal(overview.batches.length, 0); assert.equal(overview.deletedBatches[0].code, code); assert.equal(overview.defaultBatch, null);
  const emptyHome = await fetch(origin + '/', { redirect: 'manual' });
  assert.equal(emptyHome.status, 200); assert.equal(emptyHome.headers.get('location'), null);
  assert.deepEqual((await request('/api/batches', 'GET', undefined, false)).json, { batches: [] });
  for (const [suffix, method, body] of [['catalog', 'GET'], ['query', 'POST', { phone: order.phone }],
    ['quote', 'POST', { phone: order.phone, items: order.items }], ['orders', 'POST', order],
    ['customer-products', 'GET'], ['customer-products', 'POST', {}], ['sams/search?keyword=商品', 'GET'],
    [`submissions/${order.submissionId}`, 'GET']]) {
    const result = await request(`${publicPath}/${suffix}`, method, body, false);
    assert.equal(result.status, 404, suffix); assert.equal(result.json.error.code, 'BATCH_NOT_FOUND');
  }
  assert.equal((await request(`/api/admin/stats?codes=${code}`)).status, 404);
  assert.equal((await request('/api/admin/stats')).json.orders.length, 0);
  const replay = await request('/api/admin/batches', 'POST', createInput);
  assert.equal(replay.status, 409); assert.equal(replay.json.error.code, 'BATCH_REQUEST_DELETED');
  const audit = new LocalStore({ path: join(dir, 'orders.sqlite') });
  assert.equal(audit.getBatch(code), null); assert.equal(audit.getBatch(code, { includeDeleted: true }).code, code);
  assert.equal(audit.listOrderLines(code).length, 1); assert.equal(audit.listOrderLines(code)[0].snapshot.priceCents, 1000);
  assert.equal(audit.listProducts().length, 1); audit.close();
  const restored = await request(`${adminPath}/restore`, 'POST', {});
  assert.equal(restored.status, 200); assert.equal(restored.json.restored, true);
  assert.equal(restored.json.batch.collectionEnabled, false); assert.equal(restored.json.batch.deletedAt, null);
  assert.deepEqual((await request(`${adminPath}/restore`, 'POST', {})).json, restored.json);
  assert.equal((await request(`${publicPath}/query`, 'POST', { phone: order.phone }, false)).json.totalCents, 2000);
  const restoredHome = await fetch(origin + '/', { redirect: 'manual' });
  assert.equal(restoredHome.status, 200); assert.equal(restoredHome.headers.get('location'), null);
  assert.deepEqual((await request('/api/batches', 'GET', undefined, false)).json, { batches: [] });
  assert.equal((await request(`${publicPath}/orders`, 'POST', { ...order, submissionId: randomUUID() }, false)).status, 409);
});
