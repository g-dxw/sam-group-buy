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
  assert.deepEqual(api.schemaCreates[0].map(field => field.name), ['图片地址', '来源数据', '数据版本', '更新时间']);
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
  assert.deepEqual(api.schemaCreates[1].map(field => field.name), ['来源数据', '数据版本', '更新时间']);
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
