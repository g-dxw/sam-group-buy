import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Execute the actual request functions with isolated state and deferred HTTP.
// No browser storage, business service or real order endpoint is used.
const source = fs.readFileSync(new URL('../client/App.jsx', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
};
const requestFunctions = section('  async function loadCatalog(', '  async function refreshProducts(')
  + section('  async function queryOrders(', '  const batch = catalog?.batch;');

function fixture() {
  const calls = [];
  const changes = { catalogs: [], queryPhones: [], queryResults: [], errors: [] };
  const env = {
    base: '/fixture/period-one', pageAlive: { current: true }, document: { visibilityState: 'visible' },
    catalogValue: { current: { batch: { feePolicyVersion: 'policy-one' }, products: [] } },
    catalogRequest: { current: null }, catalogGeneration: { current: 0 },
    queryRequest: { current: null }, queryGeneration: { current: 0 }, queryPolicyChecked: { current: 'policy-one' },
    queriedOrder: { current: { state: 'ready', result: { phone: '13800138000', products: [], feePolicyVersion: 'policy-one', totalCents: 1000 } } },
    refreshContext: { current: { working: false } }, queryPhone: '13900139000',
    queryFormRef: { current: { phone: '13700137000' } },
    cleanPhone: value => value.replace(/\D/g, '').replace(/^86(?=1\d{10}$)/, ''),
    FormData: class { constructor(form) { this.form = form; } get() { return this.form.phone; } },
    api: (path, options) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject })),
    setCatalog: value => changes.catalogs.push(value), setCatalogState: () => {}, setCatalogError: () => {},
    setQueryPhone: value => changes.queryPhones.push(value), setQueryState: () => {}, setQueryError: value => changes.errors.push(value),
    setQueryResult: value => changes.queryResults.push(value), setQueryRefreshing: () => {},
    setQueryRefreshError: value => changes.errors.push(value),
  };
  const functions = new Function('env', `with (env) { ${requestFunctions}; return { loadCatalog, queryOrders }; }`)(env);
  return { env, calls, changes, ...functions };
}
const bill = (phone, version = 'policy-one', totalCents = 1100) => ({ phone, products: [], feePolicyVersion: version, totalCents });

test('catalog checks coalesce concurrent events and do not remount unchanged data', async () => {
  const h = fixture();
  const first = h.loadCatalog({ silent: true });
  const concurrent = h.loadCatalog({ silent: true });
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(structuredClone(h.env.catalogValue.current));
  await Promise.all([first, concurrent]);
  assert.equal(h.changes.catalogs.length, 0);
  const changed = h.loadCatalog({ silent: true });
  h.calls[1].resolve({ batch: { feePolicyVersion: 'policy-two' }, products: [] });
  await changed;
  assert.equal(h.changes.catalogs.length, 1);
  assert.equal(h.env.catalogValue.current.batch.feePolicyVersion, 'policy-two');
});

test('automatic order refresh uses the last confirmed phone and preserves edited inputs', async () => {
  const h = fixture();
  const first = h.queryOrders(null, { silent: true });
  const duplicate = h.queryOrders(null, { silent: true });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { phone: '13800138000' });
  assert.deepEqual(h.changes.queryPhones, []);
  h.calls[0].resolve(bill('13800138000'));
  await Promise.all([first, duplicate]);
  assert.equal(h.env.queryFormRef.current.phone, '13700137000');
  assert.equal(h.env.queryPhone, '13900139000');
  assert.deepEqual(h.changes.queryPhones, []);
  assert.equal(h.changes.queryResults.length, 1);
});

test('a new manual query supersedes an automatic response without mixing phone orders', async () => {
  const h = fixture();
  const automatic = h.queryOrders(null, { silent: true });
  const manual = h.queryOrders();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.deepEqual(JSON.parse(h.calls[1].options.body), { phone: '13700137000' });
  h.calls[1].resolve(bill('13700137000', 'policy-one', 2200));
  await manual;
  h.calls[0].resolve(bill('13800138000', 'policy-one', 1100));
  await automatic;
  assert.equal(h.env.queriedOrder.current.result.phone, '13700137000');
  assert.equal(h.env.queriedOrder.current.result.totalCents, 2200);
  assert.deepEqual(h.changes.queryPhones, ['13700137000']);
});

test('automatic refresh failures retain the last bill with an explicit retry message', async () => {
  const h = fixture();
  const pending = h.queryOrders(null, { silent: true });
  h.calls[0].reject(new Error('service unavailable'));
  await pending;
  assert.equal(h.env.queriedOrder.current.result.totalCents, 1000);
  assert.equal(h.changes.queryResults.length, 0);
  assert.match(h.changes.errors.at(-1), /当前显示上次查询结果/);
  assert.equal(h.env.queryRequest.current, null);
  assert.deepEqual(h.changes.queryPhones, []);
});

test('disposed or superseded catalog and query responses cannot update the page', async () => {
  const h = fixture();
  const catalog = h.loadCatalog({ silent: true });
  const query = h.queryOrders(null, { silent: true });
  h.env.pageAlive.current = false;
  h.env.catalogGeneration.current += 1; h.env.queryGeneration.current += 1;
  h.calls[0].resolve({ batch: { feePolicyVersion: 'late-policy' }, products: [] });
  h.calls[1].resolve(bill('13800138000', 'late-policy'));
  await Promise.all([catalog, query]);
  assert.deepEqual(h.changes.catalogs, []);
  assert.deepEqual(h.changes.queryResults, []);
});

test('visible-page checks skip hidden or working pages and refresh bills only for changed policy', async () => {
  const body = section('  useEffect(() => {\n    if (!catalog) return;', '  }, [code, Boolean(catalog),').replace('  useEffect(() => {', '');
  const events = new Map();
  let now = 10000;
  let tick;
  let catalogCalls = 0; let queryCalls = 0; let customerCalls = 0;
  let latestPolicy = 'policy-one';
  const env = {
    catalog: {}, Date: { now: () => now },
    document: { visibilityState: 'visible', addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) },
    window: { addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) },
    refreshContext: { current: { working: false, catalogState: 'ready', identity: { token: 'fixture', error: '' } } },
    queriedOrder: { current: { state: 'ready', result: { phone: '13800138000', feePolicyVersion: 'policy-one' } } },
    queryPolicyChecked: { current: 'policy-one' },
    loadCatalog: async () => { catalogCalls++; return { batch: { feePolicyVersion: latestPolicy } }; },
    queryOrders: async () => { queryCalls++; env.queriedOrder.current.result.feePolicyVersion = latestPolicy; env.queryPolicyChecked.current = latestPolicy; },
    loadCustomerProducts: async () => { customerCalls++; },
    setInterval: (fn, delay) => { assert.equal(delay, 30000); tick = fn; return 'timer'; }, clearInterval: () => {},
  };
  const cleanup = new Function('env', `with (env) { ${body} }`)(env);
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  tick(); await settle(); assert.equal(catalogCalls, 1); assert.equal(queryCalls, 0); assert.equal(customerCalls, 0);
  env.document.visibilityState = 'hidden'; tick(); await settle(); assert.equal(catalogCalls, 1);
  env.document.visibilityState = 'visible'; env.refreshContext.current.working = true; tick(); await settle(); assert.equal(catalogCalls, 1);
  env.refreshContext.current.working = false; latestPolicy = 'policy-two'; events.get('focus')(); events.get('visibilitychange')(); await settle();
  assert.equal(catalogCalls, 2, 'focus and visibility events are coalesced');
  assert.equal(queryCalls, 1); assert.equal(customerCalls, 0);
  now += 30000; tick(); await settle(); assert.equal(catalogCalls, 3); assert.equal(queryCalls, 1, 'unchanged policies do not re-query');
  latestPolicy = 'policy-three'; now += 30000; tick(); await settle(); assert.equal(queryCalls, 2); assert.equal(customerCalls, 1);
  cleanup(); assert.equal(events.size, 0);
});
