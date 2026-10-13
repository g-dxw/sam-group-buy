import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { LocalStore, samsStoreKey } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { customerOwner } from '../server/customer-selection.js';

const projectRoot = new URL('../', import.meta.url);
const password = 'catalog-api-test-password';
const proteinRank = '3317885016381467926';
const beefRank = '1135172272143911958';
const proteinCategory = '283381372025991';
const otherCategory = '283381372025992';
const locationQuery = 'storeId=6513&storeType=2&cityCode=500100';

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sam-catalog-api-'));
  const networkLog = join(dir, 'mock-sams-requests.log');
  const larkLog = join(dir, 'forbidden-lark-requests.log');
  const preload = join(dir, 'mock-upstream.mjs');
  const blockedLark = join(dir, 'forbid-lark.cjs');
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api-sams.walmartmobile.cn/api/v1/sams/')) throw new Error('remote network forbidden in catalog API test');
      const body = JSON.parse(init.body);
      appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify({url,body})+'\\n');
      const rankProduct = (spuId, extra = {}) => ({spuId,title:'榜单商品 '+spuId+' 1kg',subTitle:'本地榜单模拟商品',
        storeId:'6513',storeType:2,priceInfo:[{priceType:2,price:'0'},{priceType:1,price:'10990'}],
        image:'https://image.example.test/rank-'+spuId+'.jpg',isAvailable:true,isPutOnSale:true,...extra});
      const data = url.endsWith('allAddressList') ? {list:[{cityCode:'500100',cityName:'重庆市',provinceName:'重庆市',cityInitial:'C'}]}
        : url.endsWith('getStoreListByCityCodePlus') ? [{storeId:'6513',storeType:'2',storeName:'重庆渝北山姆会员商店'}]
        : url.endsWith('goods-portal/spu/search') ? {dataList:[{spuId:'123456',title:'Member’s Mark 纯牛奶 1L',subTitle:'本地模拟商品',
          storeId:'6513',storeType:2,priceInfo:[{priceType:2,price:'0'},{priceType:1,price:'9900'}],
          image:'http://image.example.test/milk.jpg',isAvailable:true,isPutOnSale:true}],totalCount:1,hasNextPage:false}
        : url.endsWith('channel/portal/homeRankDetail/homeRankDetailForVisitor') && [${JSON.stringify(proteinRank)},${JSON.stringify(beefRank)}].includes(body.contentDetailId)
          ? {titleName:body.contentDetailId===${JSON.stringify(proteinRank)}?'蛋白质热销榜':'牛肉热销榜',contentData:{dataList:[
            {categoryId:${JSON.stringify(proteinCategory)},categoryTitle:'精选蛋白质',relationRank:[{contentDetailId:${JSON.stringify(beefRank)},titleName:'牛肉热销榜'}]},
            {categoryId:${JSON.stringify(otherCategory)},categoryTitle:'烘焙乳品',relationRank:[]}]}}
        : url.endsWith('channel/portal/homeRankDetail/queryGoodsInfoPage') ? {
          goodsInfoList:(body.categoryId===${JSON.stringify(otherCategory)}
            ? [rankProduct('900101'),rankProduct('900102',{priceInfo:[{priceType:2,price:'0'}]})]
            : body.pageNum===1 ? Array.from({length:30},(_,i)=>rankProduct(String(900001+i)))
              : [rankProduct('900031'),rankProduct('900032')])
            .filter(row=>!(body.excludeSpuIds||[]).includes(row.spuId)),
          pageNum:body.pageNum,end:body.categoryId===${JSON.stringify(otherCategory)}||body.pageNum>=2,
        } : null;
      if (data === null) throw new Error('unapproved mock endpoint');
      return new Response(JSON.stringify({code:'Success',data}));
    };\n`);
  await writeFile(blockedLark, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(larkLog)}, 'forbidden\\n'); process.exit(99);\n`, { mode: 0o700 });
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', preload, 'server/index.js'], {
    cwd: projectRoot,
    env: { ...process.env, DATA_DIR: dir, ADMIN_PASSWORD: password, HOST: '127.0.0.1', PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, TRUSTED_PROXY_IPS: '', LARK_CLI_BIN: blockedLark },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM');
      await exited;
      clearTimeout(force);
    }
    try { await readFile(larkLog); assert.fail('test server attempted a Feishu call'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`test server exited: ${output}`);
    try {
      const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (health.status === 200) break;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`test server did not become ready: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  let cookie = '';
  const request = async (path, { method = 'GET', body, authenticated = true, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method, headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authenticated && cookie ? { Cookie: cookie } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
    const json = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    return { response, status: response.status, json };
  };
  const login = async () => {
    const result = await request('/api/admin/login', { method: 'POST', body: { password }, authenticated: false });
    assert.equal(result.status, 200);
    cookie = result.response.headers.get('set-cookie').split(';')[0];
    return cookie;
  };
  const remoteCalls = async () => {
    try { return (await readFile(networkLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { origin, dir, request, login, remoteCalls };
}

test('fresh real server boots with no Feishu and serves the public home with an empty ongoing list', async t => {
  const { request, login, dir, remoteCalls } = await fixture(t);
  const health = await request('/api/health');
  assert.equal(health.json.database.connected, true);
  assert.equal(health.json.feishu.configured, false);
  assert.equal(health.json.feishu.mode, 'manual_one_way_backup');
  const root = await request('/');
  assert.equal(root.status, 200);
  assert.equal(root.response.headers.get('location'), null);
  assert.match(root.response.headers.get('content-type'), /text\/html/);
  assert.deepEqual((await request('/api/batches', { authenticated: false })).json, { batches: [] });
  await login();
  assert.deepEqual((await request('/api/admin/products')).json.products, []);
  const overview = (await request('/api/admin/overview')).json;
  assert.equal(overview.productCount, 0);
  assert.equal(overview.batches.length, 0);
  assert.equal(overview.productSync.mode, 'local');
  assert.deepEqual(await remoteCalls(), []);
  const store = new LocalStore({ path: join(dir, 'orders.sqlite') });
  try { assert.equal(store.getMeta('localInitialized'), true); } finally { store.close(); }
});

test('anonymous ongoing list serves every open period with a strict public card and keeps closed direct links and admin auth intact', async t => {
  const { request, dir, remoteCalls } = await fixture(t);
  const store = new LocalStore({ path: join(dir, 'orders.sqlite') });
  try {
    store.importProducts([{ id: 'p1', recordId: 'private-remote-id', name: '公开推荐', spec: '一盒', unit: '盒', priceCents: 1000,
      onSale: true, imageUrl: 'https://images.test/public.jpg', source: { secret: 'private-source' } }]);
    const service = new LocalService({ store });
    const create = (communityName, fields = {}) => service.createBatch({ requestId: randomUUID(), communityName,
      contactNote: 'private-contact', ...fields }).batch;
    const open = create('公开团购', { description: '公开介绍', pickupLocation: '公开取货点', cutoffAt: new Date(Date.now() + 3_600_000).toISOString() });
    const sibling = create('另一期团购');
    const closed = create('已关闭团购', { collecting: false });
    create('已截止团购', { cutoffAt: new Date(Date.now() - 60_000).toISOString() });
    const archived = create('已删除团购', { collecting: false }); service.deleteBatch(archived.code);
    store.setMeta('defaultBatch', closed.code);
    store.setMeta(`feishu-export:${open.code}`, { pendingCreates: { 'private-write-attempt': { outcome: 'unknown' } }, viewUrl: 'https://private-sync.test' });
    const result = await request('/api/batches', { authenticated: false }); assert.equal(result.status, 200);
    assert.deepEqual(result.json.batches.map(batch => batch.code), [sibling.code, open.code]);
    const card = result.json.batches[1];
    assert.deepEqual(Object.keys(card).sort(), ['code', 'communityName', 'title', 'periodLabel', 'periodNumber', 'description',
      'cutoffAt', 'pickupAt', 'pickupLocation', 'productCount', 'coverImages'].sort());
    assert.equal(card.productCount, 1); assert.deepEqual(card.coverImages, ['https://images.test/public.jpg']);
    assert.equal(card.description, '公开介绍'); assert.equal(card.pickupLocation, '公开取货点');
    assert.equal(JSON.stringify(result.json).includes('private-'), false);
    assert.deepEqual((await request('/api/batches?all=true', { authenticated: false })).json, result.json);
    assert.equal((await request('/api/batches', { method: 'POST', body: {}, authenticated: false })).status, 405);
    assert.equal((await request('/api/admin/overview', { authenticated: false })).status, 401);
    const closedCatalog = await request(`/api/batches/${closed.code}/catalog`, { authenticated: false });
    assert.equal(closedCatalog.status, 200); assert.equal(closedCatalog.json.batch.collecting, false);
    assert.equal((await request(`/api/batches/${closed.code}/query`, { method: 'POST', body: { phone: '13800138000' }, authenticated: false })).status, 200);
    assert.equal((await request(`/api/batches/${archived.code}/catalog`, { authenticated: false })).status, 404);
    const home = await request('/'); assert.equal(home.status, 200); assert.equal(home.response.headers.get('location'), null);
    assert.match(home.response.headers.get('content-type'), /text\/html/);
    assert.equal((await request('/admin')).status, 200); assert.equal((await request(`/b/${closed.code}`)).status, 200);
    assert.deepEqual(await remoteCalls(), []);
  } finally { store.close(); }
});

test('real fee API validates both confirmation versions, quotes without upstream or writes, freezes prices and exposes separate goods and fees', async t => {
  const { request, login, dir, remoteCalls } = await fixture(t);
  const seed = new LocalStore({ path: join(dir, 'orders.sqlite') });
  t.after(() => seed.close());
  seed.importProducts([{ id: 'fee_milk', name: '收费测试牛奶', spec: '一盒', unit: '盒', priceCents: 50, category: '其他', onSale: true }]);
  await login();
  const created = await request('/api/admin/batches', { method: 'POST', body: { requestId: randomUUID(), communityName: '收费 API 测试群',
    samsStore: { cityCode: '500100', storeId: '6513', storeType: 2 }, feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: 200 } } });
  assert.equal(created.status, 201);
  const code = created.json.batch.code;
  const base = `/api/batches/${code}`;
  const catalog = (await request(`${base}/catalog`, { authenticated: false })).json;
  assert.deepEqual(catalog.batch.feePolicy, { recommendedRateBps: 100, selfSelectedRateBps: 200 });
  assert.match(catalog.batch.feePolicyVersion, /^[0-9a-f]{64}$/);
  const token = randomUUID();
  const personal = { id: 'self_2_6513_fee_beef', name: '自选收费测试', spec: '一盒', unit: '盒', priceCents: 25, category: '其他', onSale: true,
    version: 'a'.repeat(64), selectable: true, selfSelected: true, spuId: 'fee_beef', expiresAt: new Date(Date.now() + 1800000).toISOString(),
    source: { platform: 'samsclub_cn', storeId: '6513', storeType: 2, spuId: 'fee_beef', customerSelected: true } };
  seed.saveCustomerProduct(code, customerOwner(token), samsStoreKey(created.json.batch.samsStore), personal);
  const items = [{ productId: catalog.products[0].id, quantity: 1, version: catalog.products[0].version }];
  const data = { items, phone: '13800138000', feePolicyVersion: catalog.batch.feePolicyVersion };
  const networkBefore = await remoteCalls();
  const ordersBefore = seed.listOrderLines(code);
  const quotesBefore = seed.listCustomerProducts(code, customerOwner(token));
  const mixed = await request(`${base}/quote`, { method: 'POST', authenticated: false,
    headers: { 'x-customer-token': token }, body: { ...data, items: [...items, { productId: personal.id, quantity: 1, version: personal.version }] } });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.json.goodsTotalCents, 75);
  assert.equal(mixed.json.recommendedFeeCents, 1);
  assert.equal(mixed.json.selfSelectedFeeCents, 1);
  assert.equal(mixed.json.totalCents, 77);
  assert.equal((await request(`${base}/quote`, { method: 'POST', authenticated: false,
    headers: { 'x-customer-token': randomUUID() }, body: { ...data, items: [{ productId: personal.id, quantity: 1, version: personal.version }] } })).status, 409);
  assert.equal((await request(`${base}/quote`, { method: 'POST', authenticated: false, body: { ...data, feeCents: 0 } })).status, 400);
  assert.equal((await request(`${base}/quote`, { method: 'POST', authenticated: false, body: { ...data, feePolicyVersion: 'b'.repeat(64) } })).json.error.code, 'FEE_POLICY_CHANGED');
  assert.equal((await request(`${base}/quote`, { method: 'POST', authenticated: false, body: { ...data, phone: '' } })).status, 200);
  assert.deepEqual(seed.listOrderLines(code), ordersBefore);
  assert.deepEqual(seed.listCustomerProducts(code, customerOwner(token)), quotesBefore);
  assert.deepEqual(await remoteCalls(), networkBefore);
  const quoted = (await request(`${base}/quote`, { method: 'POST', authenticated: false, body: data })).json;
  assert.match(quoted.feeQuoteVersion, /^[0-9a-f]{64}$/);
  const submission = { ...data, submissionId: randomUUID(), name: '收费 API 顾客' };
  assert.equal((await request(`${base}/orders`, { method: 'POST', authenticated: false, body: { ...submission, feePolicyVersion: undefined } })).json.error.code, 'FEE_POLICY_CHANGED');
  assert.equal((await request(`${base}/orders`, { method: 'POST', authenticated: false, body: submission })).json.error.code, 'FEE_QUOTE_CHANGED');
  const saved = await request(`${base}/orders`, { method: 'POST', authenticated: false, body: { ...submission, feeQuoteVersion: quoted.feeQuoteVersion } });
  assert.equal(saved.status, 200);
  assert.equal((await request(`${base}/query`, { method: 'POST', authenticated: false, body: { phone: data.phone } })).json.totalCents, 51);
  const additional = (await request(`${base}/quote`, { method: 'POST', authenticated: false, body: data })).json;
  assert.equal(additional.feeTotalCents, 0);
  const row = (await request('/api/admin/stats')).json.orders[0];
  assert.deepEqual([row.feeCategory, row.feeRateBps, row.feeCents, row.payableCents], ['recommended', 100, 1, 51]);
  const cancelled = await request(`/api/admin/batches/${code}/orders/${row.recordId}`, { method: 'PATCH', body: { status: '已取消' } });
  assert.equal(cancelled.json.order.feeCents, 0);
  assert.equal((await request(`${base}/orders`, { method: 'POST', authenticated: false,
    body: { ...submission, submissionId: randomUUID(), feeQuoteVersion: additional.feeQuoteVersion } })).json.error.code, 'FEE_QUOTE_CHANGED');
  await request('/api/admin/products/fee_milk', { method: 'PATCH', body: { priceCents: 1000 } });
  await request(`/api/admin/batches/${code}`, { method: 'PATCH', body: { collecting: false,
    feePolicy: { recommendedRateBps: 500, selfSelectedRateBps: null } } });
  assert.deepEqual((await request(`${base}/orders`, { method: 'POST', authenticated: false, body: submission })).json, saved.json);
  const stats = (await request('/api/admin/stats')).json;
  assert.equal(stats.goodsTotalCents, 0);
  assert.equal(stats.feeTotalCents, 0);
  assert.equal(stats.orders[0].priceCents, 50);
  assert.equal(stats.orders[0].feeRateBps, 500);
  assert.deepEqual(await remoteCalls(), networkBefore);
});

test('anonymous requests cannot query Sam, write catalog products or start any backup', async t => {
  const { request, remoteCalls } = await fixture(t);
  for (const path of ['/api/admin/products', '/api/admin/sams/cities', '/api/admin/sams/stores?cityCode=500100',
    '/api/admin/sams/search?keyword=牛奶&storeId=6513', `/api/admin/sams/ranks?${locationQuery}`,
    `/api/admin/sams/browse?rankId=${proteinRank}&${locationQuery}`]) {
    const result = await request(path, { authenticated: false });
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, 'ADMIN_LOGIN_REQUIRED');
  }
  for (const [path, method] of [['/api/admin/products/select', 'POST'], ['/api/admin/products/sam_123456', 'PATCH'],
    ['/api/admin/products/status', 'POST'], ['/api/admin/sync/products', 'POST'], ['/api/admin/sync/products/backup', 'POST'], ['/api/admin/sams/browse', 'POST']]) {
    const result = await request(path, { method, body: {}, authenticated: false });
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, 'ADMIN_LOGIN_REQUIRED');
  }
  assert.deepEqual(await remoteCalls(), []);
});

test('authenticated bulk status HTTP changes requested products atomically without altering orders or batch IDs', async t => {
  const { request, login, dir, remoteCalls } = await fixture(t);
  const seed = new LocalStore({ path: join(dir, 'orders.sqlite') });
  try {
    seed.importProducts(['P1', 'P2', 'P3'].map(id => ({ id, name: `批量商品${id}`, spec: '一盒', unit: '盒',
      priceCents: 1500, category: '其他', onSale: id !== 'P2', sort: 0 })));
  } finally { seed.close(); }
  await login();
  const created = await request('/api/admin/batches', { method: 'POST', body: { requestId: randomUUID(),
    communityName: '批量上架测试群', productIds: ['P1'] } });
  assert.equal(created.status, 201);
  const batchCode = created.json.batch.code;
  const catalog = (await request(`/api/batches/${batchCode}/catalog`, { authenticated: false })).json;
  const submission = { submissionId: randomUUID(), phone: '13800138000', name: '批量接口测试', items: [
    { productId: 'P1', quantity: 1, version: catalog.products[0].version },
  ] };
  assert.equal((await request(`/api/batches/${batchCode}/orders`, { method: 'POST', body: submission, authenticated: false })).status, 200);
  const body = { productIds: ['P1', 'P2'], onSale: true };
  const changed = await request('/api/admin/products/status', { method: 'POST', body });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.updated, 1);
  assert.equal(changed.json.unchanged, 1);
  assert.deepEqual(changed.json.products.map(product => [product.id, product.onSale, product.revision]), [['P1', true, 1], ['P2', true, 2]]);
  assert.ok(changed.json.products.every(product => product.backupStatus === 'pending'));
  const replay = await request('/api/admin/products/status', { method: 'POST', body });
  assert.equal(replay.json.updated, 0);
  assert.equal(replay.json.unchanged, 2);
  assert.deepEqual(replay.json.products, changed.json.products);
  const before = (await request('/api/admin/products')).json.products;
  for (const invalid of [{ ...body, onSale: 'false' }, { ...body, productIds: [] },
    { ...body, productIds: ['P1', 'P1'] }, { ...body, priceCents: 1 },
    { ...body, productIds: Array.from({ length: 201 }, (_, i) => `P${i}`) }]) {
    const failed = await request('/api/admin/products/status', { method: 'POST', body: invalid });
    assert.equal(failed.status, 400);
    assert.equal(failed.json.error.code, 'INVALID_PRODUCT_STATUS');
  }
  const missing = await request('/api/admin/products/status', { method: 'POST', body: { productIds: ['P1', 'missing'], onSale: false } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'PRODUCT_NOT_FOUND');
  const foreign = await request('/api/admin/products/status', { method: 'POST', body, headers: { Origin: 'https://foreign.test' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.json.error.code, 'ORIGIN_NOT_ALLOWED');
  assert.deepEqual((await request('/api/admin/products')).json.products, before);
  const stopped = await request('/api/admin/products/status', { method: 'POST', body: { productIds: ['P1', 'P2'], onSale: false } });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.updated, 2);
  assert.equal(stopped.json.unchanged, 0);
  const publicCatalog = (await request(`/api/batches/${batchCode}/catalog`, { authenticated: false })).json;
  assert.deepEqual(publicCatalog.products.map(product => [product.id, product.onSale]), [['P1', false]]);
  const overview = (await request('/api/admin/overview')).json;
  assert.deepEqual(overview.batches.find(batch => batch.code === batchCode).productIds, ['P1']);
  assert.equal((await request('/api/admin/products')).json.products.find(product => product.id === 'P3').onSale, true);
  const query = await request(`/api/batches/${batchCode}/query`, { method: 'POST', body: { phone: submission.phone }, authenticated: false });
  assert.equal(query.json.totalCents, 1500);
  assert.equal((await request('/api/admin/stats')).json.orders[0].revision, 1);
  assert.deepEqual(await remoteCalls(), []);
});

test('authenticated snapshot selection and PATCH preserve duplicates, original source and existing orders', async t => {
  const { request, login, remoteCalls } = await fixture(t);
  await login();
  const query = await request('/api/admin/sams/search?keyword=牛奶&storeId=6513&storeType=2&cityCode=500100&page=1');
  assert.equal(query.status, 200);
  assert.equal(query.json.products[0].price_cents, 9900);
  const selections = { selections: [{ selectionId: query.json.selectionId, spuIds: ['123456'] }] };
  const added = await request('/api/admin/products/select', { method: 'POST', body: selections });
  assert.equal(added.status, 200);
  assert.equal(added.json.added, 1);
  assert.equal(added.json.products[0].onSale, false);
  assert.equal(added.json.products[0].source.storeId, '6513');
  assert.equal(added.json.products[0].source.cityName, '重庆市');
  assert.equal(added.json.products[0].source.keyword, '牛奶');
  const edit = await request('/api/admin/products/sam_123456', { method: 'PATCH', body: { name: '团长核对牛奶', priceCents: 12300, onSale: true } });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.product.revision, 2);
  const create = await request('/api/admin/batches', { method: 'POST', body: { requestId: randomUUID(), communityName: 'API测试小区' } });
  assert.equal(create.status, 201);
  const batchCode = create.json.batch.code;
  const catalog = (await request(`/api/batches/${batchCode}/catalog`, { authenticated: false })).json;
  assert.equal(catalog.products[0].imageUrl, 'http://image.example.test/milk.jpg');
  assert.equal(catalog.products[0].source, undefined);
  const submission = { submissionId: randomUUID(), phone: '13800138000', name: 'API测试顾客', note: '',
    items: [{ productId: 'sam_123456', quantity: 2, version: catalog.products[0].version }] };
  assert.equal((await request(`/api/batches/${batchCode}/orders`, { method: 'POST', body: submission, authenticated: false })).status, 200);
  const duplicate = await request('/api/admin/products/select', { method: 'POST', body: selections });
  assert.equal(duplicate.json.added, 0);
  assert.equal(duplicate.json.skipped, 1);
  assert.equal(duplicate.json.products[0].name, '团长核对牛奶');
  assert.equal(duplicate.json.products[0].priceCents, 12300);
  assert.equal(duplicate.json.products[0].onSale, true);
  const updated = await request('/api/admin/products/sam_123456', { method: 'PATCH', body: { priceCents: 13000 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.product.revision, 3);
  assert.equal(updated.json.product.source.priceCents, 9900);
  assert.equal(updated.json.product.source.keyword, '牛奶');
  const queryOrder = await request(`/api/batches/${batchCode}/query`, { method: 'POST', body: { phone: submission.phone }, authenticated: false });
  assert.equal(queryOrder.json.totalCents, 24600);
  const stats = (await request('/api/admin/stats')).json;
  assert.equal(stats.orders[0].revision, 1);
  assert.equal(stats.orders.length, 1);
  const stale = await request(`/api/batches/${batchCode}/orders`, { method: 'POST', body: { ...submission, submissionId: randomUUID() }, authenticated: false });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'PRODUCT_CHANGED');
  const invalid = await request('/api/admin/products/sam_123456', { method: 'PATCH', body: { source: {}, priceCents: 1 } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_PRODUCT_FIELDS');
  const products = (await request('/api/admin/products')).json.products;
  assert.equal(products.length, 1);
  assert.equal(products[0].priceCents, 13000);
  const root = await request('/');
  assert.equal(root.status, 200);
  assert.equal(root.response.headers.get('location'), null);
  assert.equal((await request('/api/batches', { authenticated: false })).json.batches[0].code, batchCode);
  assert.equal((await remoteCalls()).length, 3);
});

test('unknown snapshots, raw product bodies and cross-origin mutations are rejected without adding products', async t => {
  const { request, login, remoteCalls } = await fixture(t);
  await login();
  const unknown = await request('/api/admin/products/select', { method: 'POST', body: { selections: [{ selectionId: randomUUID(), spuIds: ['123456'] }] } });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.json.error.code, 'SAMS_SELECTION_EXPIRED');
  const raw = await request('/api/admin/products/select', { method: 'POST', body: { products: [{ id: 'sam_123456', priceCents: 1 }] } });
  assert.equal(raw.status, 400);
  assert.equal(raw.json.error.code, 'INVALID_SAMS_SELECTION');
  const foreign = await request('/api/admin/products/select', { method: 'POST', body: {}, headers: { Origin: 'https://foreign.test' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.json.error.code, 'ORIGIN_NOT_ALLOWED');
  assert.deepEqual((await request('/api/admin/products')).json.products, []);
  assert.deepEqual(await remoteCalls(), []);
});

test('rank browsing validates the official store and preserves category pagination without a keyword', async t => {
  const { request, login, remoteCalls } = await fixture(t);
  await login();
  const listing = await request(`/api/admin/sams/ranks?${locationQuery}`);
  assert.equal(listing.status, 200);
  assert.equal(listing.json.mode, 'rank');
  assert.equal(listing.json.store.store_id, '6513');
  assert.ok(listing.json.ranks.some(rank => rank.rank_id === proteinRank && rank.name === '蛋白质热销榜'));
  assert.ok(listing.json.ranks.some(rank => rank.rank_id === beefRank && rank.name === '牛肉热销榜'));
  const first = await request(`/api/admin/sams/browse?rankId=${proteinRank}&${locationQuery}`);
  assert.equal(first.status, 200);
  assert.equal(first.json.mode, 'rank');
  assert.equal(first.json.query, '');
  assert.equal(first.json.total, null);
  assert.equal(first.json.page_size, 30);
  assert.equal(first.json.page, 1);
  assert.equal(first.json.has_more, true);
  assert.equal(first.json.products.length, 30);
  assert.deepEqual(first.json.rank, { rank_id: proteinRank, name: '蛋白质热销榜' });
  assert.deepEqual(first.json.category, { category_id: proteinCategory, name: '精选蛋白质' });
  assert.ok(first.json.categories.some(category => category.category_id === otherCategory && category.name === '烘焙乳品'));
  assert.ok(first.json.selectionId);
  assert.equal(first.json.products[0].price_cents, 10990);
  assert.equal(first.json.products[0].price_cny, 109.9);
  // A real 2,000-entry JSON list is larger than Node's default header limit;
  // POST keeps later pages usable without putting the list in the URL.
  const excluded = [...first.json.products.map(product => product.spu_id),
    ...Array.from({ length: 1970 }, (_, index) => (9001000000000000000n + BigInt(index)).toString())];
  const second = await request('/api/admin/sams/browse', { method: 'POST', body: {
    rankId: proteinRank, categoryId: proteinCategory, page: 2, storeId: '6513', storeType: 2,
    cityCode: '500100', excludeSpuIds: excluded,
  } });
  assert.equal(second.status, 200);
  assert.equal(second.json.page, 2);
  assert.equal(second.json.has_more, false);
  assert.deepEqual(second.json.products.map(product => product.spu_id), ['900031', '900032']);
  assert.notEqual(second.json.selectionId, first.json.selectionId);
  const calls = await remoteCalls();
  const detail = calls.find(call => call.url.endsWith('homeRankDetailForVisitor'));
  assert.deepEqual(detail.body, { contentDetailId: proteinRank, storeInfoList: [{ storeType: 2, storeId: '6513' }] });
  const pages = calls.filter(call => call.url.endsWith('queryGoodsInfoPage'));
  assert.deepEqual(pages.map(call => call.body), [
    { categoryId: proteinCategory, contentDetailId: proteinRank, pageNum: 1, pageSize: 30,
      storeInfoList: [{ storeType: 2, storeId: '6513' }], excludeSpuIds: [], isVisitorRequest: true },
    { categoryId: proteinCategory, contentDetailId: proteinRank, pageNum: 2, pageSize: 30,
      storeInfoList: [{ storeType: 2, storeId: '6513' }], excludeSpuIds: excluded, isVisitorRequest: true },
  ]);
  const related = await request(`/api/admin/sams/browse?rankId=${beefRank}&${locationQuery}`);
  assert.equal(related.status, 200);
  assert.deepEqual(related.json.rank, { rank_id: beefRank, name: '牛肉热销榜' });
  assert.equal((await remoteCalls()).filter(call => call.url.endsWith('homeRankDetailForVisitor'))
    .some(call => call.body.contentDetailId === beefRank), true);
});

test('rank snapshot references save immutable original source and price while duplicate selection keeps local edits', async t => {
  const { request, login, dir } = await fixture(t);
  await login();
  const first = (await request(`/api/admin/sams/browse?rankId=${proteinRank}&${locationQuery}`)).json;
  const second = (await request('/api/admin/sams/browse', { method: 'POST', body: {
    rankId: proteinRank, categoryId: proteinCategory, page: 2, storeId: '6513', storeType: 2,
    cityCode: '500100', excludeSpuIds: ['900001'],
  } })).json;
  const groups = [{ selectionId: first.selectionId, spuIds: ['900001'] }, { selectionId: second.selectionId, spuIds: ['900031'] }];
  const rejected = await request('/api/admin/products/select', { method: 'POST', body: { selections: [
    groups[0], { selectionId: second.selectionId, spuIds: ['900031', 'unknown'] },
  ] } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error.code, 'INVALID_SAMS_SELECTION');
  assert.deepEqual((await request('/api/admin/products')).json.products, []);
  const selected = await request('/api/admin/products/select', { method: 'POST', body: { selections: groups.map(group => ({ ...group,
    priceCents: 1, name: '客户端伪造名称', source: { method: 'rank', rankId: '123', keyword: '客户端伪造' },
  })) } });
  assert.equal(selected.status, 200);
  assert.equal(selected.json.added, 2);
  for (const product of selected.json.products) {
    assert.equal(product.priceCents, 10990);
    assert.equal(product.onSale, false);
    assert.equal(product.source.method, 'rank');
    assert.equal(product.source.keyword, '');
    assert.equal(product.source.rankId, proteinRank);
    assert.equal(product.source.rankName, '蛋白质热销榜');
    assert.equal(product.source.rankCategoryId, proteinCategory);
    assert.equal(product.source.rankCategoryName, '精选蛋白质');
    assert.equal(product.source.storeId, '6513');
    assert.equal(product.source.cityName, '重庆市');
    assert.equal(product.source.priceCents, 10990);
    assert.match(product.source.queriedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.notEqual(product.name, '客户端伪造名称');
  }
  const modified = await request('/api/admin/products/sam_900001', { method: 'PATCH', body: { priceCents: 12500, name: '团长核对榜单商品', onSale: true } });
  assert.equal(modified.status, 200);
  const replay = await request('/api/admin/products/select', { method: 'POST', body: { selections: groups } });
  assert.equal(replay.json.added, 0);
  assert.equal(replay.json.skipped, 2);
  const current = (await request('/api/admin/products')).json.products.find(product => product.id === 'sam_900001');
  assert.equal(current.name, '团长核对榜单商品');
  assert.equal(current.priceCents, 12500);
  assert.equal(current.onSale, true);
  assert.equal(current.source.priceCents, 10990);
  assert.equal(current.source.keyword, '');
  assert.equal((await request(`/api/admin/sams/search?keyword=&${locationQuery}`)).status, 400);
  const keyword = (await request(`/api/admin/sams/search?keyword=牛奶&${locationQuery}`)).json;
  const mixed = await request('/api/admin/products/select', { method: 'POST', body: { selections: [groups[0],
    { selectionId: keyword.selectionId, spuIds: ['123456'] },
  ] } });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.json.added, 1);
  assert.equal(mixed.json.skipped, 1);
  const keywordProduct = mixed.json.products.find(product => product.id === 'sam_123456');
  assert.equal(keywordProduct.source.keyword, '牛奶');
  assert.equal(keywordProduct.source.method, 'search');
  assert.equal(keywordProduct.source.rankId, undefined);
  const stored = new LocalStore({ path: join(dir, 'orders.sqlite') });
  try {
    assert.equal(stored.listProducts().length, 3);
    assert.deepEqual(stored.getProduct('sam_900001').source, current.source);
  } finally { stored.close(); }
});

test('invalid rank/category/page/store requests and missing sale prices cannot partially enter the catalog', async t => {
  const { request, login, remoteCalls } = await fixture(t);
  await login();
  const browse = await request(`/api/admin/sams/browse?rankId=${proteinRank}&categoryId=${otherCategory}&${locationQuery}`);
  assert.equal(browse.status, 200);
  assert.equal(browse.json.category.category_id, otherCategory);
  assert.equal(browse.json.products.length, 2);
  assert.equal(browse.json.products[1].price_cents, null);
  assert.equal(browse.json.products[1].selectable, false);
  const selection = await request('/api/admin/products/select', { method: 'POST', body: { selections: [{
    selectionId: browse.json.selectionId, spuIds: ['900101', '900102'],
  }] } });
  assert.equal(selection.status, 400);
  assert.equal(selection.json.error.code, 'INVALID_SAMS_SELECTION');
  assert.deepEqual((await request('/api/admin/products')).json.products, []);
  const goodsCallsBefore = (await remoteCalls()).filter(call => call.url.endsWith('queryGoodsInfoPage')).length;
  for (const params of [
    `rankId=999999&${locationQuery}`, `rankId=${proteinRank}&categoryId=999999&${locationQuery}`,
    `rankId=${proteinRank}&page=0&${locationQuery}`, `rankId=${proteinRank}&page=101&${locationQuery}`,
    `rankId=${proteinRank}&page=1.5&${locationQuery}`, `rankId=${proteinRank}&storeId=6505&storeType=2&cityCode=500100`,
    `rankId=${proteinRank}&${locationQuery}&excludeSpuIds=../invalid`,
  ]) {
    assert.equal((await request(`/api/admin/sams/browse?${params}`)).status, 400, params);
  }
  assert.equal((await remoteCalls()).filter(call => call.url.endsWith('queryGoodsInfoPage')).length, goodsCallsBefore);
  assert.deepEqual((await request('/api/admin/products')).json.products, []);
});
