import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../server/local-store.js';
import { LocalService } from '../server/local-service.js';
import { FeishuSync, EXPORT_FIELDS, ORDER_FEE_SCHEMA, ORDER_SPLIT_SCHEMA } from '../server/feishu-sync.js';

const source = { baseToken: 'split-mock-base', productTableId: 'split-mock-products', orderTableId: 'split-mock-orders' };
const splitField = Object.keys(ORDER_SPLIT_SCHEMA)[0];
const pack = { partsPerPack: 3, portionSpec: '约600g/份', packSpec: '1.8kg/盒', packUnit: '盒',
  packPriceCents: 18000, packProductId: 'P1', packProductName: '拼份验收牛肉' };

// The mock store follows the backend's trusted export contract. No remote CLI,
// real orders, or real schemas are used by these backup protocol tests.
function fixture({ ordinary = false } = {}) {
  const batch = { code: 'split-backup-test', communityName: '拼份验收群', periodLabel: '第1期' };
  const line = { lineId: 'split-submission:P1', submissionId: 'split-submission', batchCode: batch.code,
    communityName: batch.communityName, periodLabel: batch.periodLabel,
    phone: '13800000000', name: '拼份验收客户', productId: 'P1', quantity: 2, note: '', status: '待采购',
    submittedAt: '2026-10-13T01:00:00Z', expectedLines: 1, revision: 1, syncedRevision: 0, remoteRecordId: null,
    productName: pack.packProductName, spec: ordinary ? pack.packSpec : pack.portionSpec, unit: ordinary ? '盒' : '份',
    priceCents: ordinary ? pack.packPriceCents : 6000, amountCents: ordinary ? 36000 : 0,
    feeCategory: 'recommended', feeRateBps: 0, feeCents: 0, payableCents: ordinary ? 36000 : 0,
    ...(!ordinary ? { split: { ...pack, requestedQuantity: 2, formedQuantity: 0, pendingQuantity: 2,
      unformedQuantity: 0, settledAt: null } } : {}) };
  const meta = new Map();
  const store = {
    line, acknowledgements: [], errors: [],
    getBatch: code => code === batch.code ? structuredClone(batch) : null,
    listExportLines: (_code, { onlyDirty = false } = {}) => onlyDirty && line.syncedRevision >= line.revision ? [] : [structuredClone(line)],
    getMeta: key => structuredClone(meta.get(key) ?? null),
    setMeta: (key, value) => meta.set(key, structuredClone(value)),
    markExported(_code, lineId, revision, recordId) {
      this.acknowledgements.push({ lineId, revision, recordId });
      if (revision === line.revision) { line.syncedRevision = revision; line.remoteRecordId = recordId; }
    },
    markExportError(_code, lineId, message) { this.errors.push({ lineId, message }); },
  };
  return { store, batch, line };
}

function remote({ split = true, fees = true, transform = fields => fields } = {}) {
  const api = { rows: [], writes: [], reads: [], calls: [], counter: 0,
    schema: [...EXPORT_FIELDS.map(name => ({ name })),
      ...(fees ? Object.entries(ORDER_FEE_SCHEMA).map(([name, type]) => ({ name, type })) : []),
      ...(split ? Object.entries(ORDER_SPLIT_SCHEMA).map(([name, type]) => ({ name, type })) : [])] };
  api.larkCall = async args => {
    api.calls.push(args);
    const command = args[1];
    assert.equal(args[args.indexOf('--table-id') + 1], source.orderTableId);
    if (command === '+table-get') return { fields: structuredClone(api.schema) };
    if (command === '+record-get') {
      const ids = args.flatMap((arg, index) => arg === '--record-id' ? [args[index + 1]] : []);
      return { records: structuredClone(api.rows.filter(row => ids.includes(row.record_id))) };
    }
    assert.ok(['+record-batch-create', '+record-batch-update'].includes(command), 'backup must not silently create a schema or SKU');
    const payload = JSON.parse(args[args.indexOf('--json') + 1]);
    api.writes.push({ command, payload: structuredClone(payload) });
    if (command === '+record-batch-create') return { record_id_list: payload.create_records.map(fields => {
      const record_id = `split-record-${++api.counter}`;
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
const syncer = (store, api) => new FeishuSync({ store, communityTables: false, sourceConfig: source, larkCall: api.larkCall,
  readRecordsCall: api.readRecordsCall, createBatchViews: false, backoffMs: [] });

test('未确认拼份备份完整规则与零金额；确认、取消更新原记录并保留成团历史', async () => {
  const { store, batch, line } = fixture();
  const api = remote();
  const sync = syncer(store, api);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows.length, 1);
  const originalId = api.rows[0].record_id;
  assert.deepEqual(JSON.parse(api.rows[0].fields[splitField]), line.split);
  assert.deepEqual(Object.keys(JSON.parse(api.rows[0].fields[splitField])), Object.keys(line.split).sort());
  assert.equal(api.rows[0].fields['数量'], 2, 'requested quantity stays distinguishable from fulfilled quantity');
  assert.equal(api.rows[0].fields['同步销售单位'], '份');
  assert.equal(api.rows[0].fields['同步金额'], 0);
  assert.equal(api.rows[0].fields['同步应付金额'], 0);
  assert.ok(api.reads.every(fields => fields.includes(splitField)), 'the allocation must be read back for every reconciliation');
  assert.equal((await sync.syncOrders(batch.code)).counts.unchanged, 1);

  Object.assign(line, { revision: 2, amountCents: 6000, feeRateBps: 100, feeCents: 60, payableCents: 6060,
    split: { ...line.split, formedQuantity: 1, pendingQuantity: 0, unformedQuantity: 1, settledAt: '2026-10-13T02:00:00Z' } });
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows.length, 1);
  assert.equal(api.rows[0].record_id, originalId);
  assert.equal(api.rows[0].fields['同步金额'], 60);
  assert.equal(api.rows[0].fields['同步代购费'], 0.6);
  assert.equal(api.rows[0].fields['同步应付金额'], 60.6);
  assert.deepEqual(JSON.parse(api.rows[0].fields[splitField]), line.split);
  assert.equal(line.syncedRevision, 2);

  Object.assign(line, { revision: 3, status: '已取消', amountCents: 0, feeCents: 0, payableCents: 0 });
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows[0].record_id, originalId);
  assert.equal(api.rows[0].fields['同步金额'], 0);
  assert.equal(api.rows[0].fields['同步代购费'], 0);
  assert.equal(api.rows[0].fields['同步应付金额'], 0);
  assert.equal(JSON.parse(api.rows[0].fields[splitField]).formedQuantity, 1, 'cancellation retains the settled allocation history');
  assert.equal(JSON.parse(api.rows[0].fields[splitField]).settledAt, '2026-10-13T02:00:00Z');
  assert.equal(line.syncedRevision, 3);
  assert.equal(api.rows.length, 1);
});

test('缺拼份信息字段时即使未成团金额零也拒绝写入和本地ack；旧普通订单表可继续备份', async () => {
  const { store, batch, line } = fixture();
  const api = remote({ split: false });
  const result = await syncer(store, api).syncOrders(batch.code);
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'EXPORT_SPLIT_SCHEMA_MISSING');
  assert.match(result.error.message, /本地订单已保存/);
  assert.match(result.error.message, /同步拼份信息/);
  assert.equal(api.writes.length, 0);
  assert.equal(api.rows.length, 0);
  assert.equal(store.acknowledgements.length, 0);
  assert.equal(line.syncedRevision, 0);
  const ordinary = fixture({ ordinary: true });
  const legacyApi = remote({ split: false, fees: false });
  assert.equal((await syncer(ordinary.store, legacyApi).syncOrders(ordinary.batch.code)).status, 'success');
  assert.equal(legacyApi.rows[0].fields['同步金额'], 360);
  assert.ok(!Object.hasOwn(legacyApi.rows[0].fields, splitField));
});

test('已有拼份信息字段类型错误、只读公式或同名重复时拒绝写入且不更改表结构', async () => {
  for (const type of ['number', 'formula', 'duplicate']) {
    const { store, batch } = fixture();
    const api = remote();
    if (type === 'duplicate') api.schema.push({ name: splitField, type: 'text' });
    else api.schema.find(field => field.name === splitField).type = type;
    const result = await syncer(store, api).syncOrders(batch.code);
    assert.equal(result.error.code, 'EXPORT_SPLIT_SCHEMA_INVALID', type);
    assert.equal(api.writes.length, 0, type);
    assert.equal(store.acknowledgements.length, 0, type);
  }
});

test('飞书读回丢失或篡改规则、成团数时保持待确认，不清除本地待备份', async () => {
  for (const mutation of ['missing', 'formed', 'packPrice']) {
    const { store, batch, line } = fixture();
    const api = remote({ transform: fields => {
      if (mutation === 'missing') delete fields[splitField];
      else if (fields[splitField]) {
        const split = JSON.parse(fields[splitField]);
        if (mutation === 'formed') split.formedQuantity = 1;
        else split.packPriceCents = 1;
        fields[splitField] = JSON.stringify(split);
      }
      return fields;
    } });
    const result = await syncer(store, api).syncOrders(batch.code);
    assert.equal(result.status, 'pending', mutation);
    assert.equal(result.error.code, 'REMOTE_UPDATE_PENDING', mutation);
    assert.equal(store.acknowledgements.length, 0, mutation);
    assert.equal(line.syncedRevision, 0, mutation);
    assert.deepEqual(api.rows[0].fields['同步状态'], ['待确认'], mutation);
  }
});

test('不完整规则、份数不守恒或应付商品金额不符时在读取远端前拒绝', async () => {
  const cases = [
    line => { delete line.split.packPriceCents; },
    line => { line.split.requestedQuantity = 3; },
    line => { line.split.pendingQuantity = 1; },
    line => { line.split.partsPerPack = 1; },
    line => { line.split.packUnit = ''; },
    line => { line.amountCents = 6000; line.payableCents = 6000; },
    line => { line.split.settledAt = '2026-10-13T02:00:00Z'; },
    line => { line.split = { ...line.split, settledAt: '2026-10-13T02:00:00Z', formedQuantity: 1, pendingQuantity: 0, unformedQuantity: 1 }; },
  ];
  for (const mutate of cases) {
    const { store, batch, line } = fixture();
    mutate(line);
    const api = remote();
    const result = await syncer(store, api).syncOrders(batch.code);
    assert.equal(result.error.code, 'LOCAL_EXPORT_SPLIT_INVALID');
    assert.equal(api.calls.length, 0);
    assert.equal(api.reads.length, 0);
    assert.equal(api.writes.length, 0);
    assert.equal(store.acknowledgements.length, 0);
  }
});

test('普通商品在有拼份字段的表中保存空值，与拼份JSON明确区分', async () => {
  const { store, batch } = fixture({ ordinary: true });
  const api = remote();
  assert.equal((await syncer(store, api).syncOrders(batch.code)).status, 'success');
  assert.equal(api.rows[0].fields[splitField], '');
});

test('采购包价参考来源可选兼容旧拼份快照，新来源完整读回，未知来源或字段拒绝', async () => {
  for (const packPriceSource of [undefined, 'reference', 'sale_fallback']) {
    const { store, batch, line } = fixture();
    if (packPriceSource !== undefined) line.split.packPriceSource = packPriceSource;
    const api = remote();
    assert.equal((await syncer(store, api).syncOrders(batch.code)).status, 'success');
    const backed = JSON.parse(api.rows[0].fields[splitField]);
    assert.deepEqual(backed, line.split);
    assert.equal(backed.packPriceSource, packPriceSource);
  }
  for (const patch of [{ packPriceSource: 'unknown' }, { packPriceSource: null }, { unexpected: true }]) {
    const { store, batch, line } = fixture();
    Object.assign(line.split, patch);
    const api = remote();
    const result = await syncer(store, api).syncOrders(batch.code);
    assert.equal(result.error.code, 'LOCAL_EXPORT_SPLIT_INVALID');
    assert.equal(api.calls.length, 0);
    assert.equal(api.writes.length, 0);
  }
  const { store, batch, line } = fixture();
  line.split.packPriceSource = 'reference';
  const api = remote({ transform: fields => {
    if (fields[splitField]) {
      const rules = JSON.parse(fields[splitField]);
      rules.packPriceSource = 'sale_fallback';
      fields[splitField] = JSON.stringify(rules);
    }
    return fields;
  } });
  const result = await syncer(store, api).syncOrders(batch.code);
  assert.equal(result.status, 'pending');
  assert.equal(store.acknowledgements.length, 0);
});

test('真实本地拼份订单从报名到确认采购、缺货完整更新已备份明细，冻结价格费率且不重排', async t => {
  const store = new LocalStore({ path: ':memory:' });
  t.after(() => store.close());
  const product = { id: 'P1', name: pack.packProductName, spec: pack.packSpec, unit: pack.packUnit,
    priceCents: pack.packPriceCents, category: '肉类', onSale: true, sort: 1 };
  store.importProducts([product]);
  let clock = '2026-10-13T01:00:00Z';
  const service = new LocalService({ store, now: () => new Date(clock) });
  const batch = service.createBatch({ requestId: randomUUID(), communityName: '真实本地拼份验收群', productIds: ['P1'],
    feePolicy: { recommendedRateBps: 100, selfSelectedRateBps: null },
    splitRules: { P1: { partsPerPack: 3, portionSpec: pack.portionSpec, priceCents: 6000 } } }).batch;
  const submit = (phone, quantity) => {
    const catalog = service.getCatalog(batch.code);
    const items = [{ productId: 'P1', quantity, version: catalog.products[0].version }];
    const policy = { feePolicyVersion: catalog.batch.feePolicyVersion };
    const quote = service.quote(batch.code, { phone, items, ...policy });
    return service.submit(batch.code, { submissionId: randomUUID(), name: '本地拼份验收', phone, items,
      ...policy, feeQuoteVersion: quote.feeQuoteVersion });
  };
  submit('13800000001', 1);
  clock = '2026-10-13T01:01:00Z';
  submit('13800000002', 4);
  const before = store.listExportLines(batch.code);
  assert.deepEqual(before.map(line => line.split.pendingQuantity), [1, 4]);
  assert.ok(before.every(line => line.amountCents === 0 && line.feeCents === 0));
  const api = remote();
  const sync = syncer(store, api);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  const originalIds = api.rows.map(row => row.record_id);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 0);

  service.updateBatch(batch.code, { collecting: false });
  clock = '2026-10-13T02:00:00Z';
  const confirmed = service.confirmSplit(batch.code, 'P1', { remainderPolicy: 'cancel' });
  assert.equal(confirmed.group.progress.purchasedPacks, 1);
  assert.equal(confirmed.group.progress.unformedPortions, 2);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 2);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.deepEqual(api.rows.map(row => row.record_id), originalIds);
  assert.deepEqual(api.rows.map(row => row.fields['同步金额']), [60, 120]);
  assert.deepEqual(api.rows.map(row => row.fields['同步代购费']), [0.6, 1.2]);
  assert.deepEqual(api.rows.map(row => JSON.parse(row.fields[splitField]).formedQuantity), [1, 2]);
  assert.deepEqual(api.rows.map(row => JSON.parse(row.fields[splitField]).unformedQuantity), [0, 2]);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 0);

  store.importProducts([{ ...product, priceCents: 25000 }]);
  service.updateBatch(batch.code, { feePolicy: { recommendedRateBps: 900, selfSelectedRateBps: null } });
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.deepEqual(api.rows.map(row => row.fields['同步单价']), [60, 60]);
  assert.deepEqual(api.rows.map(row => row.fields['同步代购费率']), [1, 1]);
  assert.ok(api.rows.every(row => JSON.parse(row.fields[splitField]).packPriceCents === 18000));

  const second = store.listExportLines(batch.code)[1];
  service.updateOrder(batch.code, second.lineId, { status: '缺货' });
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 1);
  assert.equal(service.getSplitGroups(batch.code)[0].progress.retainedPortions, 2);
  assert.equal((await sync.syncOrders(batch.code)).status, 'success');
  assert.deepEqual(api.rows.map(row => row.record_id), originalIds);
  assert.deepEqual(api.rows.map(row => row.fields['同步金额']), [60, 0]);
  assert.deepEqual(api.rows.map(row => row.fields['同步代购费']), [0.6, 0]);
  assert.deepEqual(api.rows.map(row => JSON.parse(row.fields[splitField]).formedQuantity), [1, 2]);
  assert.equal(store.listExportLines(batch.code, { onlyDirty: true }).length, 0);
});
