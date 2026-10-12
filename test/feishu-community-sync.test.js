import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LocalStore, communityExportArchiveKey } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { FeishuSync, EXPORT_FIELDS, ORDER_FEE_SCHEMA, ORDER_SPLIT_SCHEMA } from '../server/feishu-sync.js';
import { communityOrderFields, communityTableMarker, communityTableName } from '../server/feishu-community-tables.js';
import { packSnapshot } from '../server/split-groups.js';

const sourceA = { baseToken: 'CommunityBaseA1234', productTableId: 'tblProductsA', orderTableId: 'tblLegacyA',
  feishuUrl: 'https://example.feishu.cn/base/CommunityBaseA1234' };
const sourceB = { baseToken: 'CommunityBaseB1234', productTableId: 'tblProductsB', orderTableId: 'tblLegacyB',
  feishuUrl: 'https://example.feishu.cn/base/CommunityBaseB1234' };
const fieldsFor = communityId => communityOrderFields(communityId, EXPORT_FIELDS, ORDER_FEE_SCHEMA, ORDER_SPLIT_SCHEMA);

function mockRemote() {
  const api = { tables: new Map(), tableCreates: [], recordWrites: [], calls: [], counter: 0,
    onCreateTable: null, onRead: null, onGetTable: null, onCreateRecords: null, onList: null, onUpdate: null };
  api.addTable = (baseToken, name, fields, id = `tblMock${++api.counter}`) => {
    const table = { id, name, baseToken, fields: structuredClone(fields), rows: [], views: [] };
    api.tables.set(`${baseToken}:${id}`, table); return table;
  };
  api.table = (baseToken, id) => { const table = api.tables.get(`${baseToken}:${id}`); assert.ok(table, `${baseToken}:${id}`); return table; };
  api.larkCall = async (args, options) => {
    const flag = key => args[args.indexOf(key) + 1];
    const baseToken = flag('--base-token'); const command = args[1];
    api.calls.push({ command, baseToken, tableId: args.includes('--table-id') ? flag('--table-id') : null });
    if (command === '+table-list') {
      if (api.onList) return api.onList(args);
      const tables = [...api.tables.values()].filter(table => table.baseToken === baseToken);
      const offset = Number(flag('--offset')); const limit = Number(flag('--limit'));
      return { tables: tables.slice(offset, offset + limit).map(({ id, name }) => ({ id, name })), has_more: offset + limit < tables.length };
    }
    if (command === '+table-create') {
      assert.equal(options?.write, true);
      const name = flag('--name'); const fields = JSON.parse(flag('--fields'));
      api.tableCreates.push({ baseToken, name, fields });
      const save = () => ({ table: { id: api.addTable(baseToken, name, fields).id } });
      return api.onCreateTable ? api.onCreateTable({ baseToken, name, fields }, save) : save();
    }
    const table = api.table(baseToken, flag('--table-id'));
    if (command === '+table-get') {
      if (api.onGetTable) await api.onGetTable(table);
      return { table: { id: table.id, name: table.name }, fields: structuredClone(table.fields) };
    }
    if (command === '+record-get') {
      const ids = args.flatMap((arg, i) => arg === '--record-id' ? [args[i + 1]] : []);
      return { records: structuredClone(table.rows.filter(row => ids.includes(row.record_id))) };
    }
    if (command === '+view-list') return { views: structuredClone(table.views) };
    assert.equal(options?.write, true);
    const payload = JSON.parse(flag('--json'));
    if (command === '+view-create') { table.views.push({ ...payload, id: `vewMock${++api.counter}` }); return {}; }
    if (command === '+view-set-filter' || command === '+view-set-visible-fields') {
      Object.assign(table.views.find(view => view.id === flag('--view-id')), payload); return {};
    }
    api.recordWrites.push({ command, baseToken, tableId: table.id, payload: structuredClone(payload) });
    if (command === '+record-batch-create') {
      const save = () => ({ record_id_list: payload.create_records.map(fields => {
        const record_id = `recMock${++api.counter}`;
        table.rows.push({ record_id, fields: structuredClone(fields) }); return record_id;
      }) });
      return api.onCreateRecords ? api.onCreateRecords(table, payload.create_records, save) : save();
    }
    assert.equal(command, '+record-batch-update');
    if (api.onUpdate) await api.onUpdate(table, payload.update_records);
    for (const [id, patch] of Object.entries(payload.update_records)) {
      const row = table.rows.find(row => row.record_id === id); assert.ok(row);
      Object.assign(row.fields, structuredClone(patch));
    }
    return {};
  };
  api.readRecordsCall = async (baseToken, tableId, fields, filter) => {
    const table = api.table(baseToken, tableId);
    if (api.onRead) await api.onRead(table);
    return table.rows.filter(row => !filter || filter.conditions.some(([field, op, value]) => op === '==' && row.fields[field] === value))
      .map(row => ({ record_id: row.record_id, fields: Object.fromEntries(fields.map(field => [field, structuredClone(row.fields[field])])) }));
  };
  for (const source of [sourceA, sourceB]) api.addTable(source.baseToken, '历史下单明细', fieldsFor('legacy'), source.orderTableId);
  return api;
}

function fixture(t, { split = false } = {}) {
  const store = new LocalStore({ path: ':memory:' }); t.after(() => store.close());
  store.setMeta('exportSource', sourceA);
  store.importProducts([{ id: 'P1', name: '验收牛肉', spec: '1kg/包', unit: '包', priceCents: 1000,
    originalPriceCents: 900, pricing: { mode: 'fixed', markupBps: null }, category: '生鲜', onSale: true, sort: 0 }]);
  const first = store.createCommunity({ name: '甲群' }); const second = store.createCommunity({ name: '乙群' });
  const rule = { partsPerPack: 2, portionSpec: '500g/份', priceCents: 500 };
  const batches = ['first', 'next', 'other'].map((code, i) => store.createBatch({ code, communityId: i === 2 ? second.id : first.id,
    productIds: ['P1'], collecting: true, feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: 200 },
    splitRules: split ? { P1: rule } : {} }));
  const addOrder = (batch, quantity = 2) => {
    const submissionId = randomUUID(); const item = { productId: 'P1', quantity };
    const product = store.getProduct('P1');
    store.saveSubmission(batch.code, { submissionId, phone: '13800000000', name: '模拟客户', note: '', items: [item] },
      { submittedAt: '2026-10-13T03:00:00.000Z', lines: [{ ...item, snapshot: { id: product.id, name: product.name,
        spec: split ? rule.portionSpec : product.spec, unit: split ? '份' : product.unit,
        priceCents: split ? rule.priceCents : product.priceCents, feeCategory: 'recommended', feeRateBps: 100,
        ...(split ? { split: packSnapshot(product, rule) } : {}) } }] });
    return `${submissionId}:P1`;
  };
  const lineIds = batches.map(batch => addOrder(batch));
  const api = mockRemote();
  const sync = (extra = {}) => new FeishuSync({ store, larkCall: api.larkCall, readRecordsCall: api.readRecordsCall,
    backoffMs: [], createBatchViews: false, ...extra });
  return { store, api, sync, first, second, batches, lineIds, addOrder };
}

test('默认按群建表，同群并发多期共用一表，不同群独立，商品和历史总表不写入', async t => {
  const { store, api, sync, first, second, batches } = fixture(t);
  assert.equal(api.tableCreates.length, 0, '查询或构造实例不会建表');
  const results = await Promise.all(batches.map(batch => sync().syncOrders(batch.code)));
  assert.ok(results.every(result => result.status === 'success'), JSON.stringify(results));
  assert.equal(api.tableCreates.length, 2);
  const a = store.getCommunityOrderTable(sourceA.baseToken, first.id);
  const b = store.getCommunityOrderTable(sourceA.baseToken, second.id);
  assert.notEqual(a.tableId, b.tableId); assert.equal(a.status, 'ready');
  assert.equal(a.tableName, '甲群 · 下单明细');
  assert.equal(api.table(sourceA.baseToken, a.tableId).rows.length, 2);
  assert.equal(api.table(sourceA.baseToken, b.tableId).rows.length, 1);
  assert.ok(api.recordWrites.every(write => [a.tableId, b.tableId].includes(write.tableId)));
  assert.equal(api.table(sourceA.baseToken, sourceA.orderTableId).rows.length, 0);
  const schema = api.tableCreates[0].fields;
  assert.deepEqual(schema.map(field => field.name), [...EXPORT_FIELDS, ...Object.keys(ORDER_FEE_SCHEMA), ...Object.keys(ORDER_SPLIT_SCHEMA)]);
  assert.equal(schema[0].description, communityTableMarker(first.id));
  assert.equal(schema.find(field => field.name === '同步金额').style.precision, 2);
  assert.equal(schema.find(field => field.name === '同步代购费率').style.precision, 2);
  assert.equal(schema.find(field => field.name === '数量').style.precision, 0);
  assert.equal(results[0].scope, 'community');
  assert.equal(results[0].targetTableName, a.tableName);
  assert.equal(new URL(results[0].targetTableUrl).searchParams.get('table'), a.tableId);
  assert.equal((await sync().syncOrders(batches[0].code)).counts.unchanged, 1);
  assert.equal(api.tableCreates.length, 2);
  assert.equal(store.listExportLines(batches[0].code, { onlyDirty: true }).length, 0);
});

test('群表完整分页读回恢复已有归属，重复名称、外来marker或错误schema不建不写', async t => {
  for (const mutation of ['valid', 'duplicate', 'foreign', 'missing', 'wrongType', 'duplicateField', 'multiSelect', 'missingStatus']) {
    const { api, sync, first, batches } = fixture(t);
    for (let i = 0; i < 105; i += 1) api.addTable(sourceA.baseToken, `其他表${i}`, []);
    const fields = fieldsFor(first.id);
    if (mutation === 'foreign') fields[0].description = communityTableMarker('other-group');
    if (mutation === 'missing') fields.pop();
    if (mutation === 'wrongType') fields.find(field => field.name === '同步金额').type = 'formula';
    if (mutation === 'duplicateField') fields.push({ ...fields[0] });
    if (mutation === 'multiSelect') fields.find(field => field.name === '处理状态').multiple = true;
    if (mutation === 'missingStatus') fields.find(field => field.name === '处理状态').options.pop();
    api.addTable(sourceA.baseToken, communityTableName(first.name), fields);
    if (mutation === 'duplicate') api.addTable(sourceA.baseToken, communityTableName(first.name), fields);
    const result = await sync().syncOrders(batches[0].code);
    assert.equal(result.status, mutation === 'valid' ? 'success' : 'error', mutation);
    assert.equal(api.tableCreates.length, 0, mutation);
    if (mutation !== 'valid') assert.equal(api.recordWrites.length, 0, mutation);
    assert.ok(api.calls.filter(call => call.command === '+table-list').length >= 2, mutation);
  }
});

test('群表创建先保存attempt，超时已创建可在新实例读回恢复，未知不可见停止重建', async t => {
  for (const saved of [true, false]) {
    const { store, api, sync, first, batches } = fixture(t);
    api.onCreateTable = (_input, save) => {
      const state = store.getCommunityOrderTable(sourceA.baseToken, first.id);
      assert.equal(state.createAttempt.outcome, 'unknown'); assert.ok(state.createAttempt.attemptId);
      if (saved) save();
      api.onCreateTable = null;
      throw Object.assign(new Error('timeout'), { uncertain: true });
    };
    assert.equal((await sync().syncOrders(batches[0].code)).status, 'error');
    assert.equal(store.getCommunityOrderTable(sourceA.baseToken, first.id).createAttempt.outcome, 'unknown');
    const result = await sync().syncOrders(batches[0].code);
    assert.equal(result.status, saved ? 'success' : 'error');
    if (!saved) assert.equal(result.error.code, 'COMMUNITY_TABLE_CREATE_PENDING');
    assert.equal(api.tableCreates.length, 1);
    if (!saved) assert.equal(api.recordWrites.length, 0);
  }
});

test('建表响应缺ID先读回核查，明确失败才允许重建，分页不完整时不创建', async t => {
  for (const scenario of ['missingId', 'settled', 'pagination']) {
    const { api, sync, batches } = fixture(t);
    if (scenario === 'pagination') api.onList = () => ({ tables: [], has_more: true });
    else api.onCreateTable = (_input, save) => {
      api.onCreateTable = null;
      if (scenario === 'missingId') { save(); return {}; }
      throw Object.assign(new Error('permission denied'), { uncertain: false });
    };
    assert.equal((await sync().syncOrders(batches[0].code)).status, 'error');
    if (scenario === 'pagination') assert.equal(api.tableCreates.length, 0);
    else {
      assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
      assert.equal(api.tableCreates.length, scenario === 'missingId' ? 1 : 2);
    }
  }
});

test('已绑定群表消失、重命名或marker被改时不创建替代表、不改变既有明细绑定', async t => {
  for (const mutation of ['missing', 'rename', 'marker']) {
    const { store, api, sync, first, batches } = fixture(t);
    assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
    const binding = store.getCommunityOrderTable(sourceA.baseToken, first.id);
    const receipt = store.listExportLines(batches[0].code)[0].remoteRecordId;
    if (mutation === 'missing') api.tables.delete(`${sourceA.baseToken}:${binding.tableId}`);
    if (mutation === 'rename') api.table(sourceA.baseToken, binding.tableId).name = '其他名字';
    if (mutation === 'marker') api.table(sourceA.baseToken, binding.tableId).fields[0].description = communityTableMarker('foreign');
    const writes = api.recordWrites.length;
    assert.equal((await sync().syncOrders(batches[0].code)).status, 'error', mutation);
    assert.equal(api.tableCreates.length, 1, mutation);
    assert.equal(api.recordWrites.length, writes, mutation);
    assert.equal(store.listExportLines(batches[0].code)[0].remoteRecordId, receipt, mutation);
  }
});

test('旧总表首次按群迁移只归档本期绑定，旧记录不改，其他期和商品数据保留', async t => {
  const { store, api, sync, batches } = fixture(t);
  for (const batch of batches) assert.equal((await sync({ communityTables: false }).syncOrders(batch.code)).status, 'success');
  const oldLines = batches.map(batch => store.listExportLines(batch.code));
  const products = store.listProducts({ includeRemoved: true });
  const legacy = api.table(sourceA.baseToken, sourceA.orderTableId);
  const rows = structuredClone(legacy.rows); const writes = api.recordWrites.length;
  const result = await sync().syncOrders(batches[0].code);
  assert.equal(result.status, 'success');
  const archive = store.getMeta(communityExportArchiveKey({ baseToken: sourceA.baseToken, orderTableId: sourceA.orderTableId }, batches[0].code));
  assert.equal(archive.lines[0].remoteRecordId, oldLines[0][0].remoteRecordId);
  assert.equal(archive.lines[0].syncedRevision, oldLines[0][0].syncedRevision);
  assert.equal(archive.meta.scope, 'legacy');
  assert.deepEqual(legacy.rows, rows);
  assert.ok(api.recordWrites.slice(writes).every(write => write.tableId !== sourceA.orderTableId));
  assert.notEqual(store.listExportLines(batches[0].code)[0].remoteRecordId, oldLines[0][0].remoteRecordId);
  assert.deepEqual(store.listExportLines(batches[1].code), oldLines[1]);
  assert.deepEqual(store.listExportLines(batches[2].code), oldLines[2]);
  assert.deepEqual(store.listProducts({ includeRemoved: true }), products);
});

test('旧总表unknown结果先只读对账，可见才切群表，未知缺失或归属冲突都阻断', async t => {
  for (const scenario of ['visible', 'missing', 'foreign', 'ackMismatch']) {
    const { store, api, sync, batches, lineIds } = fixture(t);
    api.onCreateRecords = (_table, _records, save) => {
      if (scenario !== 'missing') save(); api.onCreateRecords = null;
      throw Object.assign(new Error('timeout'), { uncertain: true });
    };
    assert.equal((await sync({ communityTables: false }).syncOrders(batches[0].code)).status, 'error');
    const legacy = api.table(sourceA.baseToken, sourceA.orderTableId);
    if (scenario === 'foreign') legacy.rows[0].fields.团购ID = 'unrelated-batch';
    if (scenario === 'ackMismatch') {
      const meta = store.getMeta(`feishu-export:${batches[0].code}`);
      meta.pendingCreates[lineIds[0]].ackRecordId = 'different-record'; store.setMeta(`feishu-export:${batches[0].code}`, meta);
    }
    const oldRows = structuredClone(legacy.rows); const writes = api.recordWrites.length;
    const result = await sync().syncOrders(batches[0].code);
    assert.equal(result.status, scenario === 'visible' ? 'success' : 'error', scenario);
    assert.deepEqual(legacy.rows, oldRows, scenario);
    assert.ok(api.recordWrites.slice(writes).every(write => write.tableId !== sourceA.orderTableId));
    if (scenario !== 'visible') {
      assert.equal(api.tableCreates.length, 0, scenario);
      assert.ok(store.getMeta(`feishu-export:${batches[0].code}`).pendingCreates[lineIds[0]], scenario);
    }
  }
});

test('按群备份收费和拼份快照，结算和取消更新同一群表记录', async t => {
  const { store, api, sync, first, batches, lineIds } = fixture(t, { split: true });
  assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
  const binding = store.getCommunityOrderTable(sourceA.baseToken, first.id);
  const table = api.table(sourceA.baseToken, binding.tableId); const id = table.rows[0].record_id;
  assert.equal(table.rows[0].fields.同步金额, 0);
  assert.equal(JSON.parse(table.rows[0].fields.同步拼份信息).pendingQuantity, 2);
  store.updateBatch(batches[0].code, { collecting: false });
  new LocalService({ store }).confirmSplit(batches[0].code, 'P1', { remainderPolicy: 'cancel' });
  assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
  assert.equal(table.rows[0].fields.同步金额, 10);
  assert.equal(table.rows[0].fields.同步代购费, 0.1);
  assert.equal(table.rows[0].fields.同步应付金额, 10.1);
  assert.equal(JSON.parse(table.rows[0].fields.同步拼份信息).formedQuantity, 2);
  store.updateOrder(batches[0].code, lineIds[0], { status: '已取消' });
  assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
  assert.equal(table.rows[0].fields.同步金额, 0);
  assert.equal(table.rows[0].fields.同步代购费, 0);
  assert.equal(table.rows[0].record_id, id); assert.equal(table.rows.length, 1);
});

test('飞书Base A→B→A时各群目标独立恢复，同名同群记录读回复用，其他期不重置', async t => {
  const { store, api, sync, first, batches, lineIds } = fixture(t);
  assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
  const a = store.getCommunityOrderTable(sourceA.baseToken, first.id);
  const originalId = store.listExportLines(batches[0].code)[0].remoteRecordId;
  store.setMeta('exportSource', sourceB);
  store.updateOrder(batches[0].code, lineIds[0], { quantity: 5 });
  assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
  const b = store.getCommunityOrderTable(sourceB.baseToken, first.id); assert.notEqual(a.tableId, b.tableId);
  assert.equal(api.table(sourceA.baseToken, a.tableId).rows[0].fields.数量, 2);
  assert.equal(api.table(sourceB.baseToken, b.tableId).rows[0].fields.数量, 5);
  store.setMeta('exportSource', sourceA);
  const returned = await sync().syncOrders(batches[0].code);
  assert.equal(returned.status, 'success'); assert.equal(returned.counts.created, 0);
  assert.equal(store.listExportLines(batches[0].code)[0].remoteRecordId, originalId);
  assert.equal(api.table(sourceA.baseToken, a.tableId).rows[0].fields.数量, 5);
  assert.equal(api.tableCreates.length, 2);
  assert.equal(store.getMeta(`feishu-export:${batches[1].code}`), null);
});

test('返回旧群目标时利用归档绑定直接读回，目录漏行且直接读取也缺失时停止新增', async t => {
  for (const directVisible of [true, false]) {
    const { store, api, sync, first, batches } = fixture(t);
    assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
    const binding = store.getCommunityOrderTable(sourceA.baseToken, first.id);
    const a = api.table(sourceA.baseToken, binding.tableId); const id = a.rows[0].record_id;
    store.setMeta('exportSource', sourceB);
    assert.equal((await sync().syncOrders(batches[0].code)).status, 'success');
    store.setMeta('exportSource', sourceA);
    const read = api.readRecordsCall; const call = api.larkCall;
    api.readRecordsCall = async (base, table, ...args) => base === sourceA.baseToken && table === binding.tableId ? [] : read(base, table, ...args);
    api.larkCall = async (args, options) => !directVisible && args[1] === '+record-get'
      && args[args.indexOf('--base-token') + 1] === sourceA.baseToken ? { records: [] } : call(args, options);
    const creates = api.recordWrites.filter(write => write.command === '+record-batch-create').length;
    const result = await sync().syncOrders(batches[0].code);
    assert.equal(result.status, directVisible ? 'success' : 'error');
    if (!directVisible) {
      assert.equal(result.error.code, 'REMOTE_BOUND_RECORD_MISSING');
      assert.equal(store.listExportLines(batches[0].code)[0].syncedRevision, 0);
      assert.equal(store.listExportLines(batches[0].code)[0].remoteRecordId, null);
    } else assert.equal(store.listExportLines(batches[0].code)[0].remoteRecordId, id);
    assert.equal(api.recordWrites.filter(write => write.command === '+record-batch-create').length, creates);
    assert.equal(a.rows.length, 1); assert.equal(a.rows[0].record_id, id);
  }
});

test('旧已同步订单在群建表失败时仍报告待备份，保留旧版金额和旧远端绑定', async t => {
  const { store, api, sync, batches } = fixture(t);
  assert.equal((await sync({ communityTables: false }).syncOrders(batches[0].code)).status, 'success');
  const line = store.listExportLines(batches[0].code)[0];
  assert.equal(line.syncedRevision, line.revision);
  api.onCreateTable = () => { throw Object.assign(new Error('timeout'), { uncertain: true }); };
  const result = await sync().syncOrders(batches[0].code);
  assert.equal(result.status, 'error');
  assert.equal(result.pending, 1); assert.equal(result.counts.pending, 1);
  assert.equal(store.listExportLines(batches[0].code, { onlyDirty: true }).length, 1);
  const current = store.listExportLines(batches[0].code)[0];
  assert.equal(current.remoteRecordId, line.remoteRecordId);
  assert.equal(current.syncedRevision, line.syncedRevision);
  assert.equal(current.amountCents, line.amountCents);
});

test('新增可见后确认失败保留attempt与记录ID，重试目录漏读不会重复新增', async t => {
  for (const acknowledged of [true, false]) for (const directVisible of [true, false]) {
    const { store, api, sync, first, batches, lineIds } = fixture(t);
    if (!acknowledged) {
      api.onCreateRecords = (_table, _rows, save) => {
        save(); api.onCreateRecords = null;
        throw Object.assign(new Error('unknown create'), { uncertain: true });
      };
      assert.equal((await sync().syncOrders(batches[0].code)).status, 'error');
    }
    api.onUpdate = (_table, updates) => {
      if (Object.values(updates).some(value => value.同步状态?.[0] === '已确认')) {
        api.onUpdate = null; throw Object.assign(new Error('confirm timeout'), { uncertain: true });
      }
    };
    assert.equal((await sync().syncOrders(batches[0].code)).status, 'error');
    const binding = store.getCommunityOrderTable(sourceA.baseToken, first.id);
    const table = api.table(sourceA.baseToken, binding.tableId); const id = table.rows[0].record_id;
    const pending = store.getMeta(`feishu-export:${batches[0].code}`).pendingCreates[lineIds[0]];
    assert.ok(pending); assert.equal(pending.observedRecordId, id);
    assert.equal(pending.ackRecordId, acknowledged ? id : undefined);
    assert.equal(store.listExportLines(batches[0].code)[0].remoteRecordId, null);
    assert.equal(store.listExportLines(batches[0].code)[0].syncedRevision, 0);
    // A subsequent edit must update the same row, and acknowledge only the new
    // revision after the current quantity has been read back completely.
    store.updateOrder(batches[0].code, lineIds[0], { quantity: 5 });
    const revision = store.listExportLines(batches[0].code)[0].revision;
    const read = api.readRecordsCall; const call = api.larkCall;
    api.readRecordsCall = async (base, tableId, ...args) => tableId === binding.tableId ? [] : read(base, tableId, ...args);
    api.larkCall = async (args, options) => !directVisible && args[1] === '+record-get' ? { records: [] } : call(args, options);
    const creates = api.recordWrites.filter(write => write.command === '+record-batch-create').length;
    const result = await sync().syncOrders(batches[0].code);
    assert.equal(result.status, directVisible ? 'success' : 'error');
    assert.equal(table.rows.length, 1); assert.equal(table.rows[0].record_id, id);
    assert.equal(api.recordWrites.filter(write => write.command === '+record-batch-create').length, creates);
    const after = store.listExportLines(batches[0].code)[0];
    if (directVisible) {
      assert.equal(after.remoteRecordId, id); assert.equal(after.syncedRevision, revision);
      assert.equal(table.rows[0].fields.数量, 5);
      assert.equal(store.getMeta(`feishu-export:${batches[0].code}`).pendingCreates[lineIds[0]], undefined);
    } else {
      assert.equal(result.error.code, 'REMOTE_BOUND_RECORD_MISSING');
      assert.equal(after.syncedRevision, 0);
      assert.ok(store.getMeta(`feishu-export:${batches[0].code}`).pendingCreates[lineIds[0]]);
    }
  }
});

test('最终本地确认保存失败时整笔回滚并保留建单收据，重试读漏不会重复新增', async t => {
  const { store, api, sync, first, batches, lineIds } = fixture(t);
  const code = batches[0].code; const key = `feishu-export:${code}`;
  const setMeta = store.setMeta.bind(store);
  let failed = false;
  store.setMeta = (name, value) => {
    if (!failed && name === key && Object.keys(value.pendingCreates || {}).length === 0
      && store.listExportLines(code)[0].remoteRecordId) {
      failed = true;
      throw new Error('local confirmation storage interrupted');
    }
    return setMeta(name, value);
  };
  const firstResult = await sync().syncOrders(code);
  assert.equal(firstResult.status, 'error'); assert.equal(failed, true);
  const binding = store.getCommunityOrderTable(sourceA.baseToken, first.id);
  const table = api.table(sourceA.baseToken, binding.tableId);
  const recordId = table.rows[0].record_id;
  assert.equal(table.rows[0].fields.同步状态[0], '已确认');
  const afterFailure = store.listExportLines(code)[0];
  assert.equal(afterFailure.remoteRecordId, null); assert.equal(afterFailure.syncedRevision, 0);
  const receipt = store.getMeta(key).pendingCreates[lineIds[0]];
  assert.equal(receipt.ackRecordId, recordId); assert.equal(receipt.observedRecordId, recordId);
  store.setMeta = setMeta;
  const read = api.readRecordsCall;
  api.readRecordsCall = async (base, tableId, ...args) => tableId === binding.tableId ? [] : read(base, tableId, ...args);
  const creates = api.recordWrites.filter(write => write.command === '+record-batch-create').length;
  assert.equal((await sync().syncOrders(code)).status, 'success');
  assert.equal(api.recordWrites.filter(write => write.command === '+record-batch-create').length, creates);
  assert.equal(table.rows.length, 1); assert.equal(store.listExportLines(code)[0].remoteRecordId, recordId);
  assert.equal(store.getMeta(key).pendingCreates[lineIds[0]], undefined);
});

test('Base配置在建表/查询/确认读回期间变化时停止后续写入且不ack错误目标', async t => {
  for (const point of ['table', 'read', 'confirm']) {
    const { store, api, sync, batches } = fixture(t);
    if (point === 'table') api.onCreateTable = (_input, save) => { const result = save(); store.setMeta('exportSource', sourceB); return result; };
    else api.onRead = table => {
      if (point === 'read' || table.rows[0]?.fields.同步状态?.[0] === '已确认') {
        api.onRead = null; store.setMeta('exportSource', sourceB);
      }
    };
    const result = await sync().syncOrders(batches[0].code);
    assert.equal(result.status, 'error', point);
    assert.equal(result.error.code, 'ORDER_EXPORT_DESTINATION_CHANGED', point);
    assert.equal(store.listExportLines(batches[0].code)[0].syncedRevision, 0, point);
    if (point !== 'confirm') assert.equal(api.recordWrites.length, 0, point);
    assert.ok(api.recordWrites.every(write => write.baseToken === sourceA.baseToken));
  }
});

test('删除期次或改群绑定发生在查询期间时停止同步，已移除商品的旧单仍可备份', async t => {
  for (const operation of ['deleteBatch', 'binding', 'removeProduct']) {
    const { store, api, sync, first, batches } = fixture(t);
    if (operation === 'removeProduct') store.removeProducts({ productIds: ['P1'] });
    else api.onRead = () => {
      api.onRead = null;
      if (operation === 'deleteBatch') {
        store.updateBatch(batches[0].code, { collecting: false }); store.deleteBatch(batches[0].code);
      } else {
        const binding = store.getCommunityOrderTable(sourceA.baseToken, first.id);
        store.setCommunityOrderTable(sourceA.baseToken, first.id, { ...binding, tableId: 'tblForeign' });
      }
    };
    const result = await sync().syncOrders(batches[0].code);
    assert.equal(result.status, operation === 'removeProduct' ? 'success' : 'error', operation);
    if (operation !== 'removeProduct') {
      assert.equal(api.recordWrites.length, 0, operation);
      assert.equal(store.listOrderLines(batches[0].code)[0].syncedRevision, 0, operation);
    }
  }
});
