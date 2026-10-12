import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from '../server/local-store.js';
import { FeishuSync, PRODUCT_SCHEMA, PRODUCT_BACKUP_SCHEMA, productDestination, productBackupArchiveKey } from '../server/feishu-sync.js';

const source = { baseToken: 'mock-base', productTableId: 'mock-products', orderTableId: 'mock-orders' };
const product = (id, extra = {}) => ({ id, name: `商品${id}`, spec: '12盒装', unit: '箱', priceCents: 1000,
  category: '演示', onSale: true, sort: 1, imageUrl: 'https://example.test/product.jpg',
  source: { platform: 'samsclub_cn', spuId: id, storeId: '6505', priceCents: 1200 }, ...extra });
const schemaFields = schema => Object.entries(schema).map(([name, type]) => ({ name, type }));
function fixture(t, { count = 2, legacySchema = false } = {}) {
  const store = new LocalStore({ path: ':memory:' });
  t.after(() => store.close());
  store.setMeta('exportSource', source);
  store.importProducts(Array.from({ length: count }, (_, i) => product(`P${i + 1}`)));
  const api = { rows: [], counter: 0, createdCalls: 0, updateCalls: 0, schemaCreates: [], schemas: schemaFields(legacySchema ? PRODUCT_SCHEMA : PRODUCT_BACKUP_SCHEMA),
    onCreate: null, onUpdate: null, onSchema: null, onRead: null };
  api.readRecordsCall = async (_base, table, fields, filter) => {
    assert.equal(table, source.productTableId);
    if (api.onRead) await api.onRead();
    return api.rows.filter(row => !filter || filter.conditions.some(([key, operation, value]) => operation === '==' && row.fields[key] === value))
      .map(row => ({ record_id: row.record_id, fields: Object.fromEntries(fields.map(name => [name, structuredClone(row.fields[name])])) }));
  };
  api.larkCall = async (args, options) => {
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value('--table-id'), source.productTableId, 'product backup must not write order or unrelated tables');
    if (args[1] === '+table-get') return { fields: structuredClone(api.schemas) };
    if (args[1] === '+record-get') {
      const ids = args.flatMap((arg, i) => arg === '--record-id' ? [args[i + 1]] : []);
      return { records: structuredClone(api.rows.filter(row => ids.includes(row.record_id))) };
    }
    assert.equal(options?.write, true);
    const payload = JSON.parse(value('--json'));
    if (args[1] === '+field-create') {
      assert.ok(Array.isArray(payload), 'official field-create uses a direct array, not a wrapper');
      api.schemaCreates.push(payload);
      if (api.onSchema) return api.onSchema(payload);
      api.schemas.push(...payload); return {};
    }
    if (args[1] === '+record-batch-create') {
      api.createdCalls += 1;
      const save = rows => ({ record_id_list: rows.map(fields => {
        const record_id = `remote-${++api.counter}`;
        api.rows.push({ record_id, fields: structuredClone(fields) }); return record_id;
      }) });
      if (api.onCreate) return api.onCreate(payload.create_records, save);
      return save(payload.create_records);
    }
    if (args[1] === '+record-batch-update') {
      api.updateCalls += 1;
      if (api.onUpdate) await api.onUpdate(payload.update_records);
      for (const [id, fields] of Object.entries(payload.update_records)) {
        const row = api.rows.find(row => row.record_id === id); assert.ok(row);
        Object.assign(row.fields, structuredClone(fields));
      }
      return {};
    }
    throw new Error(`Unexpected mock operation ${args[1]}`);
  };
  const sync = () => new FeishuSync({ store, larkCall: api.larkCall, readRecordsCall: api.readRecordsCall,
    backoffMs: [], createBatchViews: false, repository: { readProducts() { throw new Error('must never import remote products'); } } });
  return { store, api, sync };
}

test('全量本地商品按ID备份，包含图片和来源；重复同步不新增，不覆盖本地商品', async t => {
  const { store, api, sync } = fixture(t, { legacySchema: true });
  api.rows.push({ record_id: 'existing-p1', fields: { 商品ID: 'P1', 商品名称: '远端旧名称', 单价: 999 } },
    { record_id: 'unrelated', fields: { 商品ID: 'P3', 商品名称: '远端独有商品' } });
  const before = store.listProducts();
  const result = await sync().syncProducts();
  assert.equal(result.status, 'success');
  assert.equal(result.counts.backedUp, 2);
  assert.equal(result.counts.created, 1);
  assert.equal(result.counts.updated, 1);
  assert.deepEqual(store.listProducts(), before);
  assert.equal(api.rows.length, 3);
  const backed = api.rows.find(row => row.fields.商品ID === 'P1');
  assert.equal(backed.record_id, 'existing-p1');
  assert.equal(backed.fields.单价, 10);
  assert.equal(backed.fields.图片地址, before[0].imageUrl);
  assert.deepEqual(JSON.parse(backed.fields.来源数据), before[0].source);
  assert.equal(backed.fields.数据版本, before[0].revision);
  assert.equal(backed.fields.更新时间, before[0].updatedAt);
  assert.deepEqual(api.schemaCreates[0].map(field => field.name), ['图片地址', '来源数据', '数据版本', '更新时间', '定价规则', '移除时间']);
  assert.equal((await sync().backupProducts()).counts.unchanged, 2);
  assert.equal(api.createdCalls, 1);
  assert.equal(api.updateCalls, 1);
  assert.equal(api.schemaCreates.length, 1);
  assert.equal(store.getMeta('feishu-product-backup').destination, productDestination(source));
  assert.equal(api.rows.find(row => row.record_id === 'unrelated').fields.商品名称, '远端独有商品');
});

test('备份期间本地改价：只确认实际发送的旧版本，下一次更新同一远端记录', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  const old = store.getProduct('P1');
  api.onCreate = (rows, save) => {
    store.updateProduct('P1', { priceCents: 1800 }); api.onCreate = null;
    return save(rows);
  };
  const result = await sync().exportProducts();
  assert.equal(result.status, 'pending');
  assert.equal(result.counts.pending, 1);
  assert.equal(store.getMeta('feishu-product-backup').records.P1.revision, old.revision);
  assert.equal(api.rows[0].fields.单价, 10);
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 18);
  assert.equal(api.rows.length, 1);
  assert.equal(api.createdCalls, 1);
});

test('新增超时已写入：新实例先读回对账，确认全部字段且不重复追加', async t => {
  const { store, api, sync } = fixture(t);
  api.onCreate = (rows, save) => { save(rows); api.onCreate = null; throw Object.assign(new Error('timeout'), { uncertain: true }); };
  assert.equal((await sync().exportProducts()).status, 'error');
  assert.equal(store.getMeta('feishu-product-backup').records.P1.pendingCreate.outcome, 'unknown');
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.createdCalls, 1);
  assert.equal(api.rows.length, 2);
});

test('新增未知且未读到结果：重复点击保持待确认，不盲目重写，本地库保留', async t => {
  const { store, api, sync } = fixture(t);
  const before = store.listProducts();
  api.onCreate = () => { throw Object.assign(new Error('timeout'), { uncertain: true }); };
  assert.equal((await sync().exportProducts()).status, 'error');
  const result = await sync().exportProducts();
  assert.equal(result.status, 'pending');
  assert.equal(result.error.code, 'REMOTE_PRODUCT_WRITE_PENDING');
  assert.equal(api.createdCalls, 1);
  assert.deepEqual(store.listProducts(), before);
});

test('明确失败的部分新增，下次只补缺失ID；更新失败可以重试且本地商品不回退', async t => {
  const { store, api, sync } = fixture(t);
  api.onCreate = (rows, save) => { save(rows.slice(0, 1)); api.onCreate = null; throw Object.assign(new Error('settled partial error'), { uncertain: false }); };
  assert.equal((await sync().exportProducts()).status, 'error');
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows.length, 2);
  assert.equal(api.createdCalls, 2);
  store.updateProduct('P1', { priceCents: 2000 });
  api.onUpdate = () => { api.onUpdate = null; throw Object.assign(new Error('denied'), { uncertain: false }); };
  assert.equal((await sync().exportProducts()).status, 'error');
  assert.equal(store.getProduct('P1').priceCents, 2000);
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows.find(row => row.fields.商品ID === 'P1').fields.单价, 20);
});

test('重复远端ID或已绑定记录被改成其他商品，停止写入；不覆盖其他记录', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  api.rows.push({ record_id: 'one', fields: { 商品ID: 'P1' } }, { record_id: 'two', fields: { 商品ID: 'P1' } });
  assert.equal((await sync().exportProducts()).error.code, 'REMOTE_PRODUCT_DUPLICATE');
  assert.equal(api.updateCalls, 0); assert.equal(api.createdCalls, 0);
  api.rows = [{ record_id: 'bound', fields: { 商品ID: 'P2' } }];
  store.setMeta('feishu-product-backup', { destination: productDestination(source), records: { P1: { recordId: 'bound', revision: 1 } } });
  assert.equal((await sync().exportProducts()).error.code, 'REMOTE_PRODUCT_ID_CONFLICT');
  assert.equal(api.updateCalls, 0); assert.equal(api.createdCalls, 0);
});

test('已确认绑定记录暂不可见时停止新增，恢复可见后仍复用原记录', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  assert.equal((await sync().exportProducts()).status, 'success');
  const receipt = structuredClone(store.getMeta('feishu-product-backup').records.P1);
  const read = api.readRecordsCall;
  const call = api.larkCall;
  api.readRecordsCall = async (...args) => (await read(...args)).filter(row => row.record_id !== receipt.recordId);
  api.larkCall = async (...args) => args[0][1] === '+record-get' ? { records: [] } : call(...args);
  const result = await sync().exportProducts();
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'REMOTE_PRODUCT_BOUND_RECORD_MISSING');
  assert.equal(api.createdCalls, 1);
  assert.equal(api.updateCalls, 0);
  assert.equal(api.rows.length, 1);
  assert.deepEqual(store.getMeta('feishu-product-backup').records.P1, receipt);
  api.readRecordsCall = read; api.larkCall = call;
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.createdCalls, 1);
  assert.equal(store.getMeta('feishu-product-backup').records.P1.recordId, receipt.recordId);
});

test('原绑定不可见但另一同商品ID记录可见，仍停止核对且不重新绑定或更新另一记录', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  assert.equal((await sync().exportProducts()).status, 'success');
  const receipt = structuredClone(store.getMeta('feishu-product-backup').records.P1);
  const read = api.readRecordsCall;
  const call = api.larkCall;
  const other = { record_id: 'other-same-product-id', fields: { ...api.rows[0].fields, 单价: 777 } };
  api.rows.push(other);
  api.readRecordsCall = async (...args) => (await read(...args)).filter(row => row.record_id !== receipt.recordId);
  api.larkCall = async (...args) => args[0][1] === '+record-get' ? { records: [] } : call(...args);
  const result = await sync().exportProducts();
  assert.equal(result.error.code, 'REMOTE_PRODUCT_BOUND_RECORD_MISSING');
  assert.equal(api.createdCalls, 1);
  assert.equal(api.updateCalls, 0);
  assert.equal(other.fields.单价, 777);
  assert.deepEqual(store.getMeta('feishu-product-backup').records.P1, receipt);
});

test('字段创建部分失败重试只补缺失字段；已有备份字段类型错误时不写商品', async t => {
  const { api, sync } = fixture(t, { legacySchema: true });
  api.onSchema = fields => { api.schemas.push(fields[0]); api.onSchema = null; throw Object.assign(new Error('partial field error'), { uncertain: false }); };
  assert.equal((await sync().exportProducts()).status, 'error');
  assert.equal(api.createdCalls, 0);
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.deepEqual(api.schemaCreates[1].map(field => field.name), ['来源数据', '数据版本', '更新时间', '定价规则', '移除时间']);
  api.schemas.find(field => field.name === '图片地址').type = 'formula';
  assert.equal((await sync().exportProducts()).error.code, 'PRODUCT_BACKUP_SCHEMA_INVALID');
  assert.equal(api.createdCalls, 1);
});

test('多个同步实例同时备份复用一次任务；新增响应不完整保留未知标记', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  const results = await Promise.all([sync().exportProducts(), sync().backupProducts()]);
  assert.ok(results.every(result => result.status === 'success'));
  assert.equal(api.createdCalls, 1);
  store.importProducts([product('P1'), product('P2')]);
  api.onCreate = () => ({ record_id_list: [] });
  assert.equal((await sync().exportProducts()).error.code, 'REMOTE_PRODUCT_WRITE_UNCONFIRMED');
  assert.equal(store.getMeta('feishu-product-backup').records.P2.pendingCreate.outcome, 'unknown');
  assert.equal((await sync().exportProducts()).status, 'pending');
  assert.equal(api.createdCalls, 2);
});

test('读取期间配置改到另一商品目标：停止旧目标写入且不覆盖新目标待备份状态', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  const nextSource = { ...source, productTableId: 'new-product-table' };
  const newState = { destination: productDestination(nextSource), records: {}, status: 'pending' };
  api.onRead = () => {
    api.onRead = null;
    store.setMeta('exportSource', nextSource);
    store.setMeta('feishu-product-backup', newState);
  };
  assert.equal((await sync().exportProducts()).error.code, 'PRODUCT_BACKUP_DESTINATION_CHANGED');
  assert.equal(api.createdCalls, 0);
  assert.equal(api.updateCalls, 0);
  assert.deepEqual(store.getMeta('feishu-product-backup'), newState);
  assert.equal(store.getMeta(productBackupArchiveKey(productDestination(source))).status, 'error');
});

test('旧商品定价规则按固定售价派生，缺原价保留null，来源快照不变', () => {
  const sync = new FeishuSync({ store: {} });
  const fields = sync.productFields(product('legacy', { revision: 1, updatedAt: '2026-10-13T01:00:00Z' }));
  assert.deepEqual(JSON.parse(fields.定价规则), { originalPriceCents: 1200, pricing: { markupBps: null, mode: 'fixed' } });
  assert.equal(fields.单价, 10);
  assert.deepEqual(JSON.parse(fields.来源数据), product('legacy').source);
  const noReference = sync.productFields(product('no-reference', { source: null, revision: 1,
    updatedAt: '2026-10-13T01:00:00Z' }));
  assert.deepEqual(JSON.parse(noReference.定价规则), { originalPriceCents: null, pricing: { markupBps: null, mode: 'fixed' } });
  assert.equal(noReference.单价, 10);
});

test('原价和规则备份完整，固定→零加价→比例→固定覆写同一记录并清除旧比例', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  const sourceSnapshot = structuredClone(store.getProduct('P1').source);
  store.updateProduct('P1', { originalPriceCents: null });
  assert.equal((await sync().exportProducts()).status, 'success');
  const recordId = api.rows[0].record_id;
  assert.deepEqual(JSON.parse(api.rows[0].fields.定价规则), { originalPriceCents: null, pricing: { markupBps: null, mode: 'fixed' } });

  store.updateProduct('P1', { originalPriceCents: 1200, pricing: { mode: 'markup', markupBps: 0 } });
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 12);
  assert.deepEqual(JSON.parse(api.rows[0].fields.定价规则), { originalPriceCents: 1200, pricing: { markupBps: 0, mode: 'markup' } });

  store.updateProduct('P1', { pricing: { mode: 'markup', markupBps: 525 } });
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 12.63);
  assert.deepEqual(JSON.parse(api.rows[0].fields.定价规则), { originalPriceCents: 1200, pricing: { markupBps: 525, mode: 'markup' } });

  store.updateProduct('P1', { originalPriceCents: null, priceCents: 1100, pricing: { mode: 'fixed', markupBps: null } });
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 11);
  assert.deepEqual(JSON.parse(api.rows[0].fields.定价规则), { originalPriceCents: null, pricing: { markupBps: null, mode: 'fixed' } });
  assert.deepEqual(JSON.parse(api.rows[0].fields.来源数据), sourceSnapshot);
  assert.deepEqual(store.getProduct('P1').source, sourceSnapshot);
  assert.equal(api.rows[0].record_id, recordId);
  assert.equal(api.rows.length, 1);
  assert.equal(api.createdCalls, 1);
  assert.equal(store.getMeta('feishu-product-backup').records.P1.revision, store.getProduct('P1').revision);
});

test('定价规则字段同名重复、错误类型或公式时停止写入，不确认已备份', async t => {
  for (const type of ['number', 'formula', 'duplicate']) {
    const { store, api, sync } = fixture(t, { count: 1 });
    if (type === 'duplicate') api.schemas.push({ name: '定价规则', type: 'text' });
    else api.schemas.find(field => field.name === '定价规则').type = type;
    const result = await sync().exportProducts();
    assert.equal(result.error.code, 'PRODUCT_BACKUP_SCHEMA_INVALID', type);
    assert.match(result.error.message, /定价规则/, type);
    assert.equal(api.createdCalls, 0, type);
    assert.equal(api.updateCalls, 0, type);
    assert.equal(api.schemaCreates.length, 0, type);
    assert.equal(store.getMeta('feishu-product-backup').records.P1?.lastBackedUpAt, undefined, type);
  }
});

test('读回丢失或篡改原价、比例、模式时保持待确认，不ack商品版本', async t => {
  for (const mutation of ['missing', 'originalPriceCents', 'markupBps', 'mode']) {
    const { store, api, sync } = fixture(t, { count: 1 });
    api.onRead = () => {
      for (const row of api.rows) {
        if (mutation === 'missing') delete row.fields.定价规则;
        else {
          const rules = JSON.parse(row.fields.定价规则);
          if (mutation === 'originalPriceCents') rules.originalPriceCents = 0;
          if (mutation === 'markupBps') rules.pricing.markupBps = 100;
          if (mutation === 'mode') rules.pricing.mode = 'markup';
          row.fields.定价规则 = JSON.stringify(rules);
        }
      }
    };
    const result = await sync().exportProducts();
    assert.equal(result.status, 'pending', mutation);
    assert.equal(result.error.code, 'REMOTE_PRODUCT_UPDATE_PENDING', mutation);
    assert.equal(result.counts.backedUp, 0, mutation);
    assert.equal(store.getMeta('feishu-product-backup').records.P1?.lastBackedUpAt, undefined, mutation);
  }
});

test('本地原价/规则非法或售价不符时在创建字段、写远端之前拒绝备份', async t => {
  for (const patch of [
    { originalPriceCents: '1200' }, { originalPriceCents: -1 },
    { pricing: { mode: 'fixed', markupBps: 0 } },
    { pricing: { mode: 'fixed', markupBps: null, unknown: true } },
    { pricing: { mode: 'markup', markupBps: 100001 } },
    { originalPriceCents: null, pricing: { mode: 'markup', markupBps: 0 } },
    { originalPriceCents: 1200, pricing: { mode: 'markup', markupBps: 500 }, priceCents: 1000 },
  ]) {
    const { store, api, sync } = fixture(t, { count: 1, legacySchema: true });
    const row = { ...store.getProduct('P1'), ...patch };
    store.listProducts = () => [structuredClone(row)];
    const result = await sync().exportProducts();
    assert.equal(result.error.code, 'LOCAL_PRODUCTS_PRICING_INVALID');
    assert.equal(api.schemaCreates.length, 0);
    assert.equal(api.createdCalls, 0);
    assert.equal(api.updateCalls, 0);
    assert.equal(store.getMeta('feishu-product-backup').records.P1?.lastBackedUpAt, undefined);
  }
});

test('备份写入期间更改比例只确认发送版本，下次覆写原记录为新定价规则', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  const previous = store.getProduct('P1');
  api.onCreate = (rows, save) => {
    store.updateProduct('P1', { pricing: { mode: 'markup', markupBps: 1000 } });
    api.onCreate = null;
    return save(rows);
  };
  const result = await sync().exportProducts();
  assert.equal(result.status, 'pending');
  assert.equal(store.getMeta('feishu-product-backup').records.P1.revision, previous.revision);
  assert.equal(JSON.parse(api.rows[0].fields.定价规则).pricing.mode, 'fixed');
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 13.2);
  assert.deepEqual(JSON.parse(api.rows[0].fields.定价规则), { originalPriceCents: 1200, pricing: { markupBps: 1000, mode: 'markup' } });
  assert.equal(api.rows.length, 1);
  assert.equal(api.createdCalls, 1);
});

test('固定加价金额备份0和精确分，换比例或旧固定售价完整清除amount字段', async t => {
  const { store, api, sync } = fixture(t, { count: 1 });
  const sourceSnapshot = structuredClone(store.getProduct('P1').source);
  store.updateProduct('P1', { pricing: { mode: 'amount', markupBps: null, amountCents: 0 } });
  assert.equal((await sync().exportProducts()).status, 'success');
  const recordId = api.rows[0].record_id;
  assert.equal(api.rows[0].fields.单价, 12);
  assert.deepEqual(JSON.parse(api.rows[0].fields.定价规则), {
    originalPriceCents: 1200, pricing: { amountCents: 0, markupBps: null, mode: 'amount' },
  });
  assert.equal(api.rows[0].fields.定价规则, '{"originalPriceCents":1200,"pricing":{"amountCents":0,"markupBps":null,"mode":"amount"}}');

  store.updateProduct('P1', { pricing: { mode: 'amount', markupBps: null, amountCents: 205 } });
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 14.05);
  assert.equal(JSON.parse(api.rows[0].fields.定价规则).pricing.amountCents, 205);

  store.updateProduct('P1', { pricing: { mode: 'markup', markupBps: 500 } });
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 12.6);
  assert.deepEqual(JSON.parse(api.rows[0].fields.定价规则).pricing, { markupBps: 500, mode: 'markup' });

  store.updateProduct('P1', { pricing: { mode: 'amount', markupBps: null, amountCents: 300 } });
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 15);
  store.updateProduct('P1', { originalPriceCents: null, priceCents: 1100, pricing: { mode: 'fixed', markupBps: null } });
  assert.equal((await sync().exportProducts()).status, 'success');
  assert.equal(api.rows[0].fields.单价, 11);
  assert.deepEqual(JSON.parse(api.rows[0].fields.定价规则), {
    originalPriceCents: null, pricing: { markupBps: null, mode: 'fixed' },
  });
  assert.deepEqual(JSON.parse(api.rows[0].fields.来源数据), sourceSnapshot);
  assert.equal(api.rows[0].record_id, recordId);
  assert.equal(api.rows.length, 1);
  assert.equal(api.createdCalls, 1);
  assert.equal(store.getMeta('feishu-product-backup').records.P1.revision, store.getProduct('P1').revision);
});

test('固定加价金额规则缺字段、非法金额、多余键或售价不符时不写远端', async t => {
  for (const patch of [
    { pricing: { mode: 'amount', markupBps: null } },
    { pricing: { mode: 'amount', amountCents: 0 } },
    { pricing: { mode: 'amount', markupBps: 0, amountCents: 0 } },
    { pricing: { mode: 'amount', markupBps: null, amountCents: -1 } },
    { pricing: { mode: 'amount', markupBps: null, amountCents: 0.1 } },
    { pricing: { mode: 'amount', markupBps: null, amountCents: '205' } },
    { pricing: { mode: 'amount', markupBps: null, amountCents: 100_000_001 } },
    { pricing: { mode: 'amount', markupBps: null, amountCents: 205, extra: true } },
    { originalPriceCents: null, pricing: { mode: 'amount', markupBps: null, amountCents: 0 } },
    { pricing: { mode: 'amount', markupBps: null, amountCents: 205 }, priceCents: 1000 },
    { pricing: { mode: 'fixed', markupBps: null, amountCents: 205 } },
    { pricing: { mode: 'markup', markupBps: 500, amountCents: 205 } },
  ]) {
    const { store, api, sync } = fixture(t, { count: 1, legacySchema: true });
    const row = { ...store.getProduct('P1'), ...patch };
    store.listProducts = () => [structuredClone(row)];
    const result = await sync().exportProducts();
    assert.equal(result.error.code, 'LOCAL_PRODUCTS_PRICING_INVALID', JSON.stringify(patch));
    assert.equal(api.schemaCreates.length, 0);
    assert.equal(api.createdCalls, 0);
    assert.equal(api.updateCalls, 0);
    assert.equal(store.getMeta('feishu-product-backup').records.P1?.lastBackedUpAt, undefined);
  }
});

test('固定加价金额读回缺失、篡改或添加未知键时不确认商品备份版本', async t => {
  for (const mutation of ['missingAmount', 'amount', 'extra']) {
    const { store, api, sync } = fixture(t, { count: 1 });
    store.updateProduct('P1', { pricing: { mode: 'amount', markupBps: null, amountCents: 205 } });
    api.onRead = () => {
      for (const row of api.rows) {
        const rules = JSON.parse(row.fields.定价规则);
        if (mutation === 'missingAmount') delete rules.pricing.amountCents;
        if (mutation === 'amount') rules.pricing.amountCents = 0;
        if (mutation === 'extra') rules.pricing.extra = true;
        row.fields.定价规则 = JSON.stringify(rules);
      }
    };
    const result = await sync().exportProducts();
    assert.equal(result.status, 'pending', mutation);
    assert.equal(result.error.code, 'REMOTE_PRODUCT_UPDATE_PENDING', mutation);
    assert.equal(result.counts.backedUp, 0, mutation);
    assert.equal(store.getMeta('feishu-product-backup').records.P1?.lastBackedUpAt, undefined, mutation);
  }
});

test('旧商品表仅缺移除时间时自动补齐唯一text，空时间区别在售状态', async t => {
  const { api, sync } = fixture(t, { count: 1 });
  api.schemas = api.schemas.filter(field => field.name !== '移除时间');
  const result = await sync().exportProducts();
  assert.equal(result.status, 'success');
  assert.deepEqual(api.schemaCreates, [[{ name: '移除时间', type: 'text' }]]);
  assert.equal(api.rows[0].fields.移除时间, '');
  assert.equal(api.rows[0].fields.在售, true);
  assert.ok(!Object.hasOwn(JSON.parse(api.rows[0].fields.定价规则), 'removedAt'));
});

test('移除时间字段错误类型或重复时不写商品，不丢已备份绑定', async t => {
  for (const type of ['datetime', 'formula', 'duplicate']) {
    const { store, api, sync } = fixture(t, { count: 1 });
    assert.equal((await sync().exportProducts()).status, 'success');
    const receipt = structuredClone(store.getMeta('feishu-product-backup').records.P1);
    if (type === 'duplicate') api.schemas.push({ name: '移除时间', type: 'text' });
    else api.schemas.find(field => field.name === '移除时间').type = type;
    const result = await sync().exportProducts();
    assert.equal(result.error.code, 'PRODUCT_BACKUP_SCHEMA_INVALID', type);
    assert.match(result.error.message, /移除时间/, type);
    assert.equal(api.createdCalls, 1, type);
    assert.equal(api.updateCalls, 0, type);
    assert.deepEqual(store.getMeta('feishu-product-backup').records.P1, receipt, type);
  }
});

test('非法移除时间或移除后仍在售时在读取远端前拒绝，不生成字段或写记录', async t => {
  for (const patch of [
    { removedAt: '' }, { removedAt: '2026-10-13' }, { removedAt: 'not-a-date' },
    { removedAt: 1791831600000 }, { removedAt: '2026-10-13T01:00:00.000Z', onSale: true },
  ]) {
    const { store, api, sync } = fixture(t, { count: 1, legacySchema: true });
    const row = { ...store.getProduct('P1'), onSale: false, ...patch };
    store.listProducts = () => [structuredClone(row)];
    const result = await sync().exportProducts();
    assert.equal(result.error.code, 'LOCAL_PRODUCTS_REMOVAL_INVALID', JSON.stringify(patch));
    assert.equal(api.schemaCreates.length, 0);
    assert.equal(api.createdCalls, 0);
    assert.equal(api.updateCalls, 0);
    assert.equal(store.getMeta('feishu-product-backup').records.P1?.lastBackedUpAt, undefined);
  }
});

test('移除商品仍全量备份且恢复清空移除时间，保留同一记录、来源和定价规则', async t => {
  const { store, api, sync } = fixture(t);
  store.updateProduct('P1', { pricing: { mode: 'amount', markupBps: null, amountCents: 205 } });
  assert.equal((await sync().exportProducts()).status, 'success');
  const row = api.rows.find(row => row.fields.商品ID === 'P1');
  const previous = structuredClone(row);
  const removedAt = '2026-10-13T03:00:00.000Z';
  store.removeProducts({ productIds: ['P1'] }, { timestamp: removedAt });
  assert.equal(store.listProducts().length, 1);
  const removedResult = await sync().exportProducts();
  assert.equal(removedResult.status, 'success');
  assert.equal(removedResult.counts.total, 2);
  assert.equal(removedResult.counts.backedUp, 2);
  assert.equal(row.fields.移除时间, removedAt);
  assert.equal(row.fields.在售, false);
  assert.equal(row.fields.单价, 14.05);
  assert.equal(row.fields.来源数据, previous.fields.来源数据);
  assert.equal(row.fields.定价规则, previous.fields.定价规则);
  assert.equal(Object.hasOwn(JSON.parse(row.fields.定价规则), 'removedAt'), false);
  assert.equal(store.getMeta('feishu-product-backup').records.P1.revision, store.getProduct('P1').revision);

  store.restoreProduct('P1', { timestamp: '2026-10-13T04:00:00.000Z' });
  const restoredResult = await sync().exportProducts();
  assert.equal(restoredResult.status, 'success');
  assert.equal(row.fields.移除时间, '');
  assert.equal(row.fields.在售, false, '恢复仍下架');
  assert.equal(row.fields.来源数据, previous.fields.来源数据);
  assert.equal(row.fields.定价规则, previous.fields.定价规则);
  assert.equal(row.record_id, previous.record_id);
  assert.equal(api.rows.length, 2);
  assert.equal(api.createdCalls, 1);
});

test('全部已移除仍首次备份，无在售商品也不忽略未知新增对账', async t => {
  const { store, api, sync } = fixture(t);
  store.removeProducts({ productIds: ['P1', 'P2'] }, { timestamp: '2026-10-13T03:00:00.000Z' });
  assert.deepEqual(store.listProducts(), []);
  api.onCreate = (rows, save) => {
    save(rows); api.onCreate = null;
    throw Object.assign(new Error('timeout'), { uncertain: true });
  };
  const failed = await sync().exportProducts();
  assert.equal(failed.status, 'error');
  assert.equal(failed.counts.total, 2);
  assert.equal(failed.counts.pending, 2);
  const result = await sync().exportProducts();
  assert.equal(result.status, 'success');
  assert.equal(result.counts.backedUp, 2);
  assert.equal(result.counts.pending, 0);
  assert.equal(api.createdCalls, 1);
  assert.equal(api.rows.length, 2);
  assert.ok(api.rows.every(row => row.fields.移除时间 === '2026-10-13T03:00:00.000Z' && row.fields.在售 === false));
});

test('移除或恢复发生在备份写入期间时只确认发送版本，下一次更新原记录', async t => {
  for (const operation of ['remove', 'restore']) {
    const { store, api, sync } = fixture(t, { count: 1 });
    const removedAt = '2026-10-13T03:00:00.000Z';
    if (operation === 'restore') store.removeProducts({ productIds: ['P1'] }, { timestamp: removedAt });
    const sent = store.getProduct('P1');
    api.onCreate = (rows, save) => {
      if (operation === 'remove') store.removeProducts({ productIds: ['P1'] }, { timestamp: removedAt });
      else store.restoreProduct('P1', { timestamp: '2026-10-13T04:00:00.000Z' });
      api.onCreate = null;
      return save(rows);
    };
    const result = await sync().exportProducts();
    assert.equal(result.status, 'pending', operation);
    assert.equal(result.counts.total, 1);
    assert.equal(result.counts.pending, 1);
    assert.equal(result.counts.backedUp, 0);
    assert.equal(store.getMeta('feishu-product-backup').records.P1.revision, sent.revision);
    assert.equal(api.rows[0].fields.移除时间, sent.removedAt || '');
    assert.equal((await sync().exportProducts()).status, 'success');
    assert.equal(api.rows[0].fields.移除时间, store.getProduct('P1').removedAt || '');
    assert.equal(api.rows[0].fields.在售, false);
    assert.equal(api.createdCalls, 1);
    assert.equal(api.rows.length, 1);
  }
});

test('移除时间缺失或篡改读回时不确认新版本，恢复后未清空也保持待备份', async t => {
  for (const mutation of ['missing', 'changed', 'restoreNotCleared']) {
    const { store, api, sync } = fixture(t, { count: 1 });
    const removedAt = '2026-10-13T03:00:00.000Z';
    if (mutation === 'restoreNotCleared') {
      store.removeProducts({ productIds: ['P1'] }, { timestamp: removedAt });
      assert.equal((await sync().exportProducts()).status, 'success');
      store.restoreProduct('P1', { timestamp: '2026-10-13T04:00:00.000Z' });
    } else {
      assert.equal((await sync().exportProducts()).status, 'success');
      store.removeProducts({ productIds: ['P1'] }, { timestamp: removedAt });
    }
    const receipt = structuredClone(store.getMeta('feishu-product-backup').records.P1);
    api.onRead = () => {
      for (const row of api.rows) {
        if (mutation === 'missing') delete row.fields.移除时间;
        else row.fields.移除时间 = mutation === 'restoreNotCleared' ? removedAt : '2026-10-13T03:01:00.000Z';
      }
    };
    const result = await sync().exportProducts();
    assert.equal(result.status, 'pending', mutation);
    assert.equal(result.error.code, 'REMOTE_PRODUCT_UPDATE_PENDING', mutation);
    assert.equal(result.counts.backedUp, 0, mutation);
    assert.equal(result.counts.pending, 1, mutation);
    assert.deepEqual(store.getMeta('feishu-product-backup').records.P1, receipt, mutation);
    api.onRead = null;
    assert.equal((await sync().exportProducts()).status, 'success', mutation);
    assert.equal(api.rows[0].fields.移除时间, store.getProduct('P1').removedAt || '');
    assert.equal(api.createdCalls, 1);
  }
});

test('恢复清空时间后飞书省略空text或读回null仍可确认，不接受遗留非空时间', async t => {
  for (const empty of [undefined, null]) {
    const { store, api, sync } = fixture(t, { count: 1 });
    store.removeProducts({ productIds: ['P1'] }, { timestamp: '2026-10-13T03:00:00.000Z' });
    assert.equal((await sync().exportProducts()).status, 'success');
    store.restoreProduct('P1', { timestamp: '2026-10-13T04:00:00.000Z' });
    api.onRead = () => {
      for (const row of api.rows) if (row.fields.移除时间 === '') {
        if (empty === undefined) delete row.fields.移除时间;
        else row.fields.移除时间 = empty;
      }
    };
    assert.equal((await sync().exportProducts()).status, 'success');
    assert.equal(store.getMeta('feishu-product-backup').records.P1.revision, store.getProduct('P1').revision);
    assert.equal(api.createdCalls, 1);
  }
});
