import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from '../server/local-store.js';
import { FeishuSync, EXPORT_FIELDS, ORDER_FEE_SCHEMA } from '../server/feishu-sync.js';

const source = { baseToken: 'fees-mock-base', productTableId: 'fees-mock-products', orderTableId: 'fees-mock-orders' };
const feeFields = Object.keys(ORDER_FEE_SCHEMA);
const product = (id, priceCents) => ({ id, name: `验收商品${id}`, spec: '1包装', unit: '件',
  priceCents, category: '演示', onSale: true, sort: 1 });

function fixture(t, { legacy = false, priceCents = 1000, rateBps = 100, mixed = false } = {}) {
  const store = new LocalStore({ path: ':memory:' });
  t.after(() => store.close());
  const products = [product('P1', priceCents), ...(mixed ? [product('P2', 5000)] : [])];
  store.importProducts(products);
  const community = store.createCommunity({ name: '收费备份验收群' });
  const batch = store.createBatch({ code: 'fees-backup-test', communityId: community.id,
    productIds: products.map(row => row.id), feePolicy: { recommendedRateBps: rateBps, selfSelectedRateBps: 200 } });
  const items = products.map((row, index) => ({ productId: row.id, quantity: index === 0 && mixed ? 2 : 1 }));
  store.saveSubmission(batch.code, { submissionId: 'fees-submission', phone: '13800000000', name: '验收客户', items }, {
    submittedAt: '2026-10-13T01:00:00Z',
    ...(!legacy ? { lines: items.map((item, index) => ({ ...item, snapshot: { ...products[index],
      feeCategory: index === 0 ? 'recommended' : 'selfSelected', feeRateBps: index === 0 ? rateBps : 200,
      ...(index ? { selfSelected: true } : {}) } })) } : {}),
  });
  return { store, batch, products };
}

function remote({ fees = true, transform = fields => fields } = {}) {
  const api = { rows: [], writes: [], reads: [], counter: 0,
    schema: [...EXPORT_FIELDS.map(name => ({ name })), ...(fees ? Object.entries(ORDER_FEE_SCHEMA).map(([name, type]) => ({ name, type })) : [])] };
  api.larkCall = async args => {
    const command = args[1];
    assert.equal(args[args.indexOf('--table-id') + 1], source.orderTableId);
    if (command === '+table-get') return { fields: structuredClone(api.schema) };
    if (command === '+record-get') {
      const ids = args.flatMap((arg, index) => arg === '--record-id' ? [args[index + 1]] : []);
      return { records: structuredClone(api.rows.filter(row => ids.includes(row.record_id))) };
    }
    assert.ok(['+record-batch-create', '+record-batch-update'].includes(command), 'fees backup must not change schemas or create fee SKUs');
    const payload = JSON.parse(args[args.indexOf('--json') + 1]);
    api.writes.push({ command, payload: structuredClone(payload) });
    if (command === '+record-batch-create') return { record_id_list: payload.create_records.map(fields => {
      const record_id = `fees-record-${++api.counter}`;
      api.rows.push({ record_id, fields: transform(structuredClone(fields)) });
      return record_id;
    }) };
    for (const [id, patch] of Object.entries(payload.update_records)) {
      const row = api.rows.find(row => row.record_id === id);
      assert.ok(row);
      row.fields = transform({ ...row.fields, ...structuredClone(patch) });
    }
    return {};
  };
  api.readRecordsCall = async (_base, _table, fields) => {
    api.reads.push([...fields]);
    return api.rows.map(row => ({ record_id: row.record_id,
      fields: Object.fromEntries(fields.map(name => [name, row.fields[name]])) }));
  };
  return api;
}
const syncer = (store, api) => new FeishuSync({ store, sourceConfig: source, larkCall: api.larkCall,
  readRecordsCall: api.readRecordsCall, createBatchViews: false, backoffMs: [] });

test('收费按真实商品明细备份，商品额、费率、分摊费用、类别和应付完整读回；取消费用归零', async t => {
  const { store, batch, products } = fixture(t, { mixed: true });
  const api = remote();
  const sync = syncer(store, api);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows.length, 2);
  const [recommended, selfSelected] = api.rows.map(row => row.fields);
  assert.deepEqual(api.rows.map(row => row.fields['商品ID']), ['P1', 'P2']);
  assert.equal(recommended['同步金额'], 20);
  assert.equal(recommended['同步代购费率'], 1);
  assert.equal(recommended['同步代购费'], 0.2);
  assert.equal(recommended['同步收费类别'], '推荐商品');
  assert.equal(recommended['同步应付金额'], 20.2);
  assert.equal(selfSelected['同步金额'], 50);
  assert.equal(selfSelected['同步代购费率'], 2);
  assert.equal(selfSelected['同步代购费'], 1);
  assert.equal(selfSelected['同步收费类别'], '自选商品');
  assert.equal(selfSelected['同步应付金额'], 51);
  assert.equal(api.rows.reduce((sum, row) => sum + row.fields['同步应付金额'], 0), 71.2);
  assert.ok(api.reads.every(fields => feeFields.every(name => fields.includes(name))));
  assert.ok(api.rows.every(row => row.fields['同步状态'][0] === '已确认'));
  assert.equal((await sync.syncOrders(batch.code)).counts.unchanged, 2);
  store.importProducts(products.map(row => ({ ...row, priceCents: row.priceCents * 2 })));
  store.updateBatch(batch.code, { feePolicy: { recommendedRateBps: 900, selfSelectedRateBps: 800 } });
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows[0].fields['同步应付金额'], 20.2, 'accepted price and rate stay frozen');
  store.updateOrder(batch.code, 'fees-submission:P2', { status: '缺货' });
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows[1].fields['同步金额'], 0);
  assert.equal(api.rows[1].fields['同步代购费'], 0);
  assert.equal(api.rows[1].fields['同步应付金额'], 0);
  assert.equal(api.rows[1].fields['同步代购费率'], 2, 'the agreed rate survives cancellation');
  assert.equal(api.rows.length, 2);
});

test('缺全部或部分收费字段时，非零费率订单即使费用舍入为零也拒绝备份且不写记录', async t => {
  for (const partial of [false, true]) {
    const { store, batch } = fixture(t, { priceCents: 1 });
    const api = remote({ fees: false });
    if (partial) api.schema.push({ name: '同步代购费', type: 'number' });
    assert.equal(store.listExportLines(batch.code)[0].feeCents, 0);
    const result = await syncer(store, api).syncOrders(batch.code);
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'EXPORT_FEE_SCHEMA_MISSING');
    assert.match(result.error.message, /本地订单已保存/);
    assert.match(result.error.message, /同步收费类别/);
    assert.equal(api.writes.length, 0);
    assert.equal(store.listExportLines(batch.code)[0].syncedRevision, 0);
    assert.equal(store.getSubmission(batch.code, 'fees-submission').status, 'completed');
  }
});

test('旧零费订单表继续备份；补齐收费字段后可在原商品明细补写零费快照', async t => {
  const { store, batch } = fixture(t, { legacy: true });
  const api = remote({ fees: false });
  const sync = syncer(store, api);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  const originalId = api.rows[0].record_id;
  assert.equal(api.rows[0].fields['同步金额'], 10);
  assert.ok(feeFields.every(name => !Object.hasOwn(api.rows[0].fields, name)));
  api.schema.push(...Object.entries(ORDER_FEE_SCHEMA).map(([name, type]) => ({ name, type })));
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows.length, 1);
  assert.equal(api.rows[0].record_id, originalId);
  assert.equal(api.rows[0].fields['同步代购费'], 0);
  assert.equal(api.rows[0].fields['同步代购费率'], 0);
  assert.equal(api.rows[0].fields['同步收费类别'], '推荐商品');
  assert.equal(api.rows[0].fields['同步应付金额'], 10);
});

test('收费字段读回丢失或被更改时，保持待确认且不清除本地待备份状态', async t => {
  for (const field of feeFields) {
    const { store, batch } = fixture(t);
    const api = remote({ transform: fields => {
      if (field === '同步收费类别') fields[field] = '错误类别';
      else delete fields[field];
      return fields;
    } });
    const result = await syncer(store, api).syncOrders(batch.code);
    assert.equal(result.status, 'pending', field);
    assert.equal(result.error.code, 'REMOTE_UPDATE_PENDING', field);
    assert.equal(store.listExportLines(batch.code)[0].syncedRevision, 0, field);
    assert.deepEqual(api.rows[0].fields['同步状态'], ['待确认'], field);
  }
  const { store, batch } = fixture(t, { rateBps: 0 });
  const api = remote({ transform: fields => { fields['同步代购费'] = null; return fields; } });
  assert.equal((await syncer(store, api).syncOrders(batch.code)).status, 'pending', 'null must not pass as numeric zero');
});

test('已有收费字段类型错误、公式或同名重复时拒绝写入，不修改表结构', async t => {
  for (const invalid of ['text', 'formula', 'duplicate']) {
    const { store, batch } = fixture(t, { legacy: true });
    const api = remote();
    if (invalid === 'duplicate') api.schema.push({ name: '同步代购费', type: 'number' });
    else api.schema.find(field => field.name === '同步代购费').type = invalid;
    const result = await syncer(store, api).syncOrders(batch.code);
    assert.equal(result.error.code, 'EXPORT_FEE_SCHEMA_INVALID');
    assert.equal(api.writes.length, 0);
  }
});

test('本地收费快照缺字段或应付金额不一致时在读取飞书之前拒绝导出', async t => {
  for (const patch of [{ feeRateBps: undefined }, { payableCents: 0 }, { feeCategory: 'other' }, { feeCents: -1 }]) {
    const { store, batch } = fixture(t);
    const original = store.listExportLines.bind(store);
    store.listExportLines = (...args) => original(...args).map(line => ({ ...line, ...patch }));
    const api = remote();
    const result = await syncer(store, api).syncOrders(batch.code);
    assert.equal(result.error.code, 'LOCAL_EXPORT_FEE_INVALID');
    assert.equal(api.writes.length, 0);
    assert.equal(api.reads.length, 0);
  }
});

test('同一客户追加后按合并金额分摊到分，已备份旧行的费用变动同步到原记录', async t => {
  const { store, batch, products } = fixture(t, { priceCents: 49 });
  const api = remote();
  const sync = syncer(store, api);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  const originalId = api.rows[0].record_id;
  assert.equal(api.rows[0].fields['同步代购费'], 0);
  store.saveSubmission(batch.code, { submissionId: 'z-fees-submission', phone: '13800000000', name: '验收客户',
    items: [{ productId: 'P1', quantity: 1 }] }, {
    submittedAt: '2026-10-13T01:02:00Z', lines: [{ productId: 'P1', quantity: 1,
      snapshot: { ...products[0], feeCategory: 'recommended', feeRateBps: 100 } }],
  });
  assert.ok(store.listExportLines(batch.code)[0].revision > store.listExportLines(batch.code)[0].syncedRevision);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows.length, 2);
  assert.equal(api.rows[0].record_id, originalId);
  assert.equal(api.rows[0].fields['同步代购费'], 0.01);
  assert.equal(api.rows[1].fields['同步代购费'], 0);
  assert.equal(api.rows.reduce((sum, row) => sum + Math.round(row.fields['同步金额'] * 100), 0), 98);
  assert.equal(api.rows.reduce((sum, row) => sum + Math.round(row.fields['同步应付金额'] * 100), 0), 99);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 0);
});
