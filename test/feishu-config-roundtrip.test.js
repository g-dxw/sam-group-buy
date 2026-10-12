import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../server/local-store.js';
import { FeishuConfigService } from '../server/feishu-config.js';
import { FeishuSync, EXPORT_FIELDS } from '../server/feishu-sync.js';

const targets = {
  A: { baseToken: 'RoundtripBaseTokenA1234', productTableId: 'tblProductsA1234', orderTableId: 'tblOrdersA1234' },
  B: { baseToken: 'RoundtripBaseTokenB1234', productTableId: 'tblProductsB1234', orderTableId: 'tblOrdersB1234' },
};
for (const source of Object.values(targets)) source.feishuUrl = `https://example.feishu.cn/base/${source.baseToken}`;
const productSchema = [
  ['商品ID', 'text'], ['商品名称', 'text'], ['规格', 'text'], ['销售单位', 'text'],
  ['单价', 'number'], ['分类', 'text'], ['在售', 'checkbox'], ['排序', 'number'],
].map(([name, type]) => ({ name, type }));
const numbers = new Set(['数量', '预期明细数', '同步单价', '同步金额', '数据版本']);
const options = { 处理状态: ['待采购', '已买到', '缺货', '已领取', '已取消'], 同步状态: ['待确认', '已确认'] };
const orderSchema = EXPORT_FIELDS.map(name => ({ name,
  type: numbers.has(name) ? 'number' : name === '提交时间' ? 'datetime' : options[name] ? 'select' : 'text',
  ...(options[name] ? { multiple: false, options: options[name].map(name => ({ name })) } : {}) }));

function isolatedRemote() {
  const destinations = Object.fromEntries(Object.keys(targets).map(key => [key, {
    rows: [], createdCalls: 0, updateCalls: 0, counter: 0,
  }]));
  const targetFor = (baseToken, tableId) => {
    const found = Object.entries(targets).find(([, target]) => target.baseToken === baseToken
      && (!tableId || [target.productTableId, target.orderTableId].includes(tableId)));
    assert.ok(found, 'mock access must use a table belonging to the selected Base');
    return { key: found[0], source: found[1], remote: destinations[found[0]] };
  };
  const matches = (fields, filter) => {
    const comparisons = (filter?.conditions || []).map(([field, operation, value]) => operation === '==' && fields[field] === value);
    return !comparisons.length || (filter.logic === 'or' ? comparisons.some(Boolean) : comparisons.every(Boolean));
  };
  const larkCall = async args => {
    const value = flag => args[args.indexOf(flag) + 1];
    if (args[1] === '+url-resolve') return { base_token: new URL(value('--url')).pathname.split('/')[2], resource_type: 'bitable' };
    const { key, source, remote } = targetFor(value('--base-token'), args.includes('--table-id') ? value('--table-id') : null);
    if (args[1] === '+base-get') return { base: { base_token: source.baseToken, name: `模拟${key}`, url: source.feishuUrl } };
    if (args[1] === '+table-get') return { table: { id: value('--table-id') },
      fields: structuredClone(value('--table-id') === source.productTableId ? productSchema : orderSchema) };
    assert.equal(value('--table-id'), source.orderTableId, 'only the selected order table can receive order operations');
    if (args[1] === '+record-get') {
      const recordIds = args.flatMap((argument, index) => argument === '--record-id' ? [args[index + 1]] : []);
      return { records: structuredClone(remote.rows.filter(row => recordIds.includes(row.record_id))) };
    }
    const payload = JSON.parse(value('--json'));
    if (args[1] === '+record-batch-create') {
      remote.createdCalls += 1;
      const record_id_list = payload.create_records.map(fields => {
        const record_id = `rec${key}${++remote.counter}`;
        remote.rows.push({ record_id, fields: structuredClone(fields) });
        return record_id;
      });
      return { record_id_list };
    }
    if (args[1] === '+record-batch-update') {
      remote.updateCalls += 1;
      for (const [recordId, fields] of Object.entries(payload.update_records)) {
        const row = remote.rows.find(row => row.record_id === recordId);
        assert.ok(row, 'a record ID must belong to the selected destination');
        Object.assign(row.fields, structuredClone(fields));
      }
      return {};
    }
    assert.fail(`Unexpected CLI command ${args[1]}`);
  };
  const readRecordsCall = async (baseToken, tableId, fields, filter) => {
    const { source, remote } = targetFor(baseToken, tableId);
    assert.equal(tableId, source.orderTableId);
    return remote.rows.filter(row => matches(row.fields, filter)).map(row => ({ record_id: row.record_id,
      fields: Object.fromEntries(fields.map(field => [field, structuredClone(row.fields[field])])) }));
  };
  return { destinations, larkCall, readRecordsCall };
}

function fixture(t) {
  const store = new LocalStore({ path: ':memory:' });
  t.after(() => store.close());
  store.setMeta('exportSource', { ...targets.A, imageUrlTemplate: '/images/{id}/cover.svg' });
  store.importProducts([{ id: 'P1', name: '演示牛奶', spec: '12盒', unit: '箱', priceCents: 1000,
    category: '演示', onSale: true, sort: 1 }]);
  const community = store.createCommunity({ name: '往返同步验收群' });
  const batch = store.createBatch({ code: 'roundtrip-test', communityId: community.id, productIds: ['P1'] });
  const submissionId = randomUUID();
  const lineId = `${submissionId}:P1`;
  store.saveSubmission(batch.code, { submissionId, phone: '13800000000', name: '模拟验收', note: '无需采购',
    items: [{ productId: 'P1', quantity: 2 }] });
  const remote = isolatedRemote();
  const config = new FeishuConfigService({ store, larkCall: remote.larkCall });
  const sync = new FeishuSync({ store, larkCall: remote.larkCall, readRecordsCall: remote.readRecordsCall,
    createBatchViews: false, backoffMs: [] });
  const saveTarget = target => config.save({ ...targets[target], revision: config.get().revision });
  return { store, batch, lineId, remote, config, sync, saveTarget };
}

test('配置A→B→A后复用各自原明细，现有同步实例将当前数量写入两个目标而不追加', async t => {
  const { store, batch, lineId, remote, sync, saveTarget } = fixture(t);
  const a = remote.destinations.A;
  const b = remote.destinations.B;
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  const originalAId = a.rows[0].record_id;
  assert.equal(a.rows[0].fields['数量'], 2);
  assert.equal(store.listExportLines(batch.code)[0].remoteRecordId, originalAId);

  assert.equal((await saveTarget('B')).changedDestination, true);
  assert.equal(store.listExportLines(batch.code)[0].remoteRecordId, null);
  store.updateOrder(batch.code, lineId, { quantity: 5 });
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  const originalBId = b.rows[0].record_id;
  assert.equal(b.rows[0].fields['数量'], 5);
  assert.equal(a.rows[0].fields['数量'], 2, 'changing the destination never writes the previous table');
  assert.equal(store.listExportLines(batch.code)[0].remoteRecordId, originalBId);

  assert.equal((await saveTarget('A')).changedDestination, true);
  const returned = await sync.syncOrders(batch.code);
  assert.equal(returned.status, 'success');
  assert.equal(returned.counts.created, 0);
  assert.equal(a.rows[0].record_id, originalAId);
  assert.equal(store.listExportLines(batch.code)[0].remoteRecordId, originalAId);
  for (const destination of [a, b]) {
    assert.equal(destination.rows.length, 1);
    assert.equal(destination.createdCalls, 1);
    assert.equal(destination.rows[0].fields['明细编号'], lineId);
    assert.equal(destination.rows[0].fields['数量'], 5);
    assert.equal(destination.rows[0].fields['同步金额'], 50);
    assert.deepEqual(destination.rows[0].fields['同步状态'], ['已确认']);
  }
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 0);
  const repeated = await sync.syncOrders(batch.code);
  assert.equal(repeated.status, 'success');
  assert.equal(repeated.counts.created, 0);
  assert.equal(a.createdCalls, 1);
  assert.equal(b.createdCalls, 1);
});

test('切回A发现原lineID归属其他团购时停止全部写入，保留本地当前数量和待同步状态', async t => {
  const { store, batch, lineId, remote, sync, saveTarget } = fixture(t);
  const a = remote.destinations.A;
  const b = remote.destinations.B;
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  const originalAId = a.rows[0].record_id;
  await saveTarget('B');
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  store.updateOrder(batch.code, lineId, { quantity: 9 });
  a.rows[0].fields['团购ID'] = 'other-community-batch';
  await saveTarget('A');
  const writesBefore = [a.createdCalls, a.updateCalls, b.createdCalls, b.updateCalls];
  const rowsBefore = structuredClone([a.rows, b.rows]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await sync.syncOrders(batch.code);
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'REMOTE_ID_CONFLICT');
    assert.equal(result.pending, 1);
    assert.equal(result.counts.created, 0);
    assert.equal(result.counts.updated, 0);
  }
  assert.deepEqual([a.createdCalls, a.updateCalls, b.createdCalls, b.updateCalls], writesBefore);
  assert.deepEqual([a.rows, b.rows], rowsBefore);
  assert.equal(a.rows[0].record_id, originalAId);
  assert.equal(a.rows.length, 1);
  assert.equal(b.rows.length, 1);
  const local = store.listExportLines(batch.code)[0];
  assert.equal(local.quantity, 9);
  assert.equal(local.remoteRecordId, null);
  assert.equal(local.syncedRevision, 0);
  assert.ok(local.revision > local.syncedRevision);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 1);
});
