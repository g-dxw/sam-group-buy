import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from '../server/local-store.js';
import { FeishuSync, EXPORT_FIELDS } from '../server/feishu-sync.js';

const source = { baseToken: 'test-base', productTableId: 'test-products', orderTableId: 'test-orders' };
const product = id => ({ id, name: `商品${id}`, spec: '12盒装', unit: '箱', priceCents: 1000, category: '演示', onSale: true, sort: 1 });
function fixture({ items = [{ productId: 'P1', quantity: 2 }] } = {}) {
  const store = new LocalStore({ path: ':memory:' });
  store.importProducts([product('P1'), product('P2')]);
  const community = store.createCommunity({ name: '同步验收群' });
  const batch = store.createBatch({ code: 'sync-test', communityId: community.id, productIds: ['P1', 'P2'] });
  // This fixture represents imported legacy orders without frozen product/fee snapshots.
  store.saveSubmission(batch.code, { submissionId: 'submission-test', phone: '13800000000', name: '验收用户', note: '无需采购', items }, { submittedAt: '2026-10-12T04:00:00.000Z' });
  return { store, batch };
}
function remote() {
  const api = { rows: [], createdCalls: 0, updateCalls: 0, onCreate: null, onUpdate: null, counter: 0 };
  const filterMatches = (fields, filter) => {
    const values = (filter?.conditions || []).map(([key, op, value]) => op === '==' && fields[key] === value);
    return !values.length || (filter.logic === 'or' ? values.some(Boolean) : values.every(Boolean));
  };
  api.readRecordsCall = async (_base, _table, fields, filter) => api.rows.filter(row => filterMatches(row.fields, filter))
    .map(row => ({ record_id: row.record_id, fields: Object.fromEntries(fields.map(key => [key, row.fields[key]])) }));
  api.larkCall = async args => {
    const command = args[1];
    const payload = args.includes('--json') ? JSON.parse(args[args.indexOf('--json') + 1]) : null;
    if (command === '+table-get') return { fields: EXPORT_FIELDS.map(name => ({ name })) };
    if (command === '+record-get') {
      const ids = args.flatMap((arg, i) => arg === '--record-id' ? [args[i + 1]] : []);
      return { records: structuredClone(api.rows.filter(row => ids.includes(row.record_id))) };
    }
    if (command === '+record-batch-create') {
      api.createdCalls += 1;
      const save = records => {
        const ids = records.map(fields => {
          const record_id = `remote-${++api.counter}`;
          api.rows.push({ record_id, fields: structuredClone(fields) }); return record_id;
        });
        return { record_id_list: ids };
      };
      if (api.onCreate) return api.onCreate(payload.create_records, save);
      return save(payload.create_records);
    }
    if (command === '+record-batch-update') {
      api.updateCalls += 1;
      if (api.onUpdate) await api.onUpdate(payload.update_records);
      for (const [id, patch] of Object.entries(payload.update_records)) {
        const row = api.rows.find(row => row.record_id === id);
        assert.ok(row); Object.assign(row.fields, structuredClone(patch));
      }
      return {};
    }
    throw new Error(`Unexpected mock command ${command}`);
  };
  return api;
}
const syncer = (store, api, extra = {}) => new FeishuSync({ store, communityTables: false, sourceConfig: source, larkCall: api.larkCall,
  readRecordsCall: api.readRecordsCall, backoffMs: [], createBatchViews: false, ...extra });

test('旧无快照订单首次写入后整单确认；调价冻结旧金额，取消仍同步本地版本', async () => {
  const { store, batch } = fixture(); const api = remote(); const sync = syncer(store, api);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows.length, 1);
  assert.deepEqual(api.rows[0].fields['同步状态'], ['已确认']);
  assert.equal(api.rows[0].fields['同步金额'], 20);
  assert.equal((await sync.syncOrders(batch.code)).counts.unchanged, 1);
  assert.equal(api.createdCalls, 1);
  store.importProducts([{ ...product('P1'), priceCents: 1500 }, product('P2')]);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows[0].fields['同步单价'], 10);
  assert.equal(api.rows[0].fields['同步金额'], 20);
  store.updateOrder(batch.code, 'submission-test:P1', { status: '已取消' });
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.deepEqual(api.rows[0].fields['处理状态'], ['已取消']);
  assert.equal(api.rows[0].fields['同步金额'], 0);
  assert.equal(api.createdCalls, 1); store.close();
});

test('新增超时但远端已保存：新实例先对账，不重复追加', async () => {
  const { store, batch } = fixture(); const api = remote();
  api.onCreate = (_rows, save) => { save(_rows); api.onCreate = null; throw Object.assign(new Error('request timeout'), { uncertain: true }); };
  assert.equal((await syncer(store, api).syncOrders(batch.code)).status, 'error');
  assert.equal(store.getMeta(`feishu-export:${batch.code}`).pendingCreates['submission-test:P1'].outcome, 'unknown');
  assert.equal((await syncer(store, api).syncOrders(batch.code)).status, 'success');
  assert.equal(api.createdCalls, 1); assert.equal(api.rows.length, 1); store.close();
});

test('新增未知且远端没有结果：再次同步保持待确认，不盲目重写', async () => {
  const { store, batch } = fixture(); const api = remote();
  api.onCreate = () => { throw Object.assign(new Error('timeout'), { uncertain: true }); };
  await syncer(store, api).syncOrders(batch.code);
  const result = await syncer(store, api).syncOrders(batch.code);
  assert.equal(result.status, 'pending'); assert.equal(result.error.code, 'REMOTE_WRITE_PENDING');
  assert.equal(api.createdCalls, 1); assert.equal(api.rows.length, 0); store.close();
});

test('明确结束的部分写入，仅补缺失明细；全组存在前不确认', async () => {
  const { store, batch } = fixture({ items: [{ productId: 'P1', quantity: 2 }, { productId: 'P2', quantity: 1 }] });
  const api = remote();
  api.onCreate = (rows, save) => { save(rows.slice(0, 1)); api.onCreate = null; throw Object.assign(new Error('settled partial rejection'), { uncertain: false }); };
  assert.equal((await syncer(store, api).syncOrders(batch.code)).status, 'error');
  assert.equal(api.rows.length, 1); assert.deepEqual(api.rows[0].fields['同步状态'], ['待确认']);
  assert.equal((await syncer(store, api).syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows.length, 2); assert.equal(new Set(api.rows.map(row => row.fields['明细编号'])).size, 2);
  assert.ok(api.rows.every(row => row.fields['同步状态'][0] === '已确认')); store.close();
});

test('同步中管理员改数量：旧版本ack不清新修改，下次同步更新同远端记录', async () => {
  const { store, batch } = fixture(); const api = remote(); const sync = syncer(store, api);
  api.onUpdate = async updates => {
    if (Object.values(updates).some(row => row['同步状态']?.[0] === '已确认')) {
      api.onUpdate = null; store.updateOrder(batch.code, 'submission-test:P1', { quantity: 5 });
    }
  };
  const result = await sync.syncOrders(batch.code);
  assert.equal(result.status, 'pending'); assert.equal(result.pending, 1);
  assert.equal(store.listExportLines(batch.code)[0].syncedRevision, 0);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows.length, 1); assert.equal(api.rows[0].fields['数量'], 5); store.close();
});

test('同明细ID属于另一团购，或stored remote ID属于其他明细，拒绝覆盖', async () => {
  const { store, batch } = fixture(); const api = remote();
  api.rows.push({ record_id: 'foreign', fields: { '明细编号': 'submission-test:P1', '团购ID': 'another', '提交编号': 'submission-test', '商品ID': 'P1' } });
  assert.equal((await syncer(store, api).syncOrders(batch.code)).error.code, 'REMOTE_ID_CONFLICT');
  assert.equal(api.createdCalls, 0); assert.equal(api.updateCalls, 0);
  api.rows[0].fields['明细编号'] = 'unrelated:P2';
  store.markExported(batch.code, 'submission-test:P1', 1, 'foreign');
  assert.equal((await syncer(store, api).syncOrders(batch.code)).error.code, 'REMOTE_ID_CONFLICT');
  assert.equal(api.createdCalls, 0); store.close();
});

test('同store并发手动同步复用同任务，schema不全时不写订单', async () => {
  const { store, batch } = fixture(); const api = remote();
  const sync1 = syncer(store, api); const sync2 = syncer(store, api);
  const results = await Promise.all([sync1.syncOrders(batch.code), sync2.syncOrders(batch.code)]);
  assert.ok(results.every(result => result.status === 'success')); assert.equal(api.createdCalls, 1);
  api.larkCall = async () => ({ fields: [] });
  assert.equal((await syncer(store, api).syncOrders(batch.code)).error.code, 'EXPORT_SCHEMA_MISSING');
  assert.equal(api.rows.length, 1); store.close();
});

test('本期飞书采购视图排除取消、缺货、未确认和零数量', async () => {
  let filter;
  const sync = new FeishuSync({ store: {}, sourceConfig: {}, larkCall: async args => {
    if (args[1] === '+view-list') return { views: [{ name: '测试小区 第1期 · test-batch', id: 'test-view' }] };
    if (args[1] === '+view-set-filter') filter = JSON.parse(args[args.indexOf('--json') + 1]);
    return {};
  } });
  await sync.batchView({ baseToken: 'test', orderTableId: 'test', feishuUrl: 'https://example.test/base' },
    { code: 'test-batch', communityName: '测试小区', periodLabel: '第1期' });
  assert.equal(filter.logic, 'and');
  assert(filter.conditions.some(condition => condition[0] === '同步状态' && condition[2].includes('已确认')));
  assert(filter.conditions.some(condition => condition[0] === '处理状态' && condition[1] === 'disjoint' && condition[2].includes('已取消') && condition[2].includes('缺货')));
  assert(filter.conditions.some(condition => condition[0] === '数量' && condition[1] === '>' && condition[2] === 0));
});
