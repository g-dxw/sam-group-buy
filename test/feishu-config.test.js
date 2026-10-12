import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { LocalStore } from '../server/local-store.js';
import { FeishuConfigService } from '../server/feishu-config.js';
import { FeishuSync, EXPORT_FIELDS } from '../server/feishu-sync.js';

const token = 'OldBaseToken1234567890';
const nextToken = 'NewBaseToken1234567890';
const source = { baseToken: token, feishuUrl: `https://example.feishu.cn/base/${token}`,
  productTableId: 'tblProducts12345', orderTableId: 'tblOrders12345',
  settingsTableId: 'tblSettings12345', imageUrlTemplate: '/custom/{id}.png' };
const changed = { baseToken: nextToken, feishuUrl: `https://example.larkoffice.com/base/${nextToken}`,
  productTableId: 'tblProducts67890', orderTableId: 'tblOrders67890' };
const productFields = [
  ['商品ID', 'text'], ['商品名称', 'text'], ['规格', 'text'], ['销售单位', 'text'],
  ['单价', 'number'], ['分类', 'text'], ['在售', 'checkbox'], ['排序', 'number'],
].map(([name, type]) => ({ name, type }));
const numeric = new Set(['数量', '预期明细数', '同步单价', '同步金额', '数据版本']);
const options = { 处理状态: ['待采购', '已买到', '缺货', '已领取', '已取消'], 同步状态: ['待确认', '已确认'] };
const orderFields = EXPORT_FIELDS.map(name => ({ name,
  type: numeric.has(name) ? 'number' : name === '提交时间' ? 'datetime' : options[name] ? 'select' : 'text',
  ...(options[name] ? { multiple: false, options: options[name].map(name => ({ name })) } : {}) }));
function mockApi() {
  const api = { calls: [], schemas: new Map(), onCall: null, pages: null };
  for (const config of [source, changed]) {
    api.schemas.set(config.productTableId, structuredClone(productFields));
    api.schemas.set(config.orderTableId, structuredClone(orderFields));
  }
  api.call = async args => {
    api.calls.push([...args]);
    assert.ok(['+url-resolve', '+base-get', '+table-list', '+table-get'].includes(args[1]), 'configuration must never write Feishu');
    if (api.onCall) await api.onCall(args);
    const param = name => args[args.indexOf(name) + 1];
    if (args[1] === '+url-resolve') return { base_token: new URL(param('--url')).pathname.split('/')[2], resource_type: 'bitable' };
    if (args[1] === '+base-get') {
      const baseToken = param('--base-token');
      return { base: { base_token: baseToken, name: '演示商品库', url: `https://example.feishu.cn/base/${baseToken}` } };
    }
    if (args[1] === '+table-list') return api.pages?.get(param('--offset')) || { tables: [
      { id: source.productTableId, name: '商品表' }, { id: source.orderTableId, name: '下单明细' },
    ], total: 2 };
    if (args[1] === '+table-get') {
      const tableId = param('--table-id');
      if (!api.schemas.has(tableId)) throw Object.assign(new Error('private upstream body token=SECRET'), { code: 'SECRET' });
      return { table: { id: tableId, name: '表格' }, fields: structuredClone(api.schemas.get(tableId)) };
    }
  };
  return api;
}
function fixture(t) {
  const store = new LocalStore({ path: ':memory:' });
  t.after(() => store.close());
  store.setMeta('exportSource', { ...source });
  store.importProducts([{ id: 'P1', name: '演示商品', spec: '12盒', unit: '箱', priceCents: 1000,
    category: '演示', onSale: true, sort: 1 }]);
  const community = store.createCommunity({ name: '配置验收群' });
  const batch = store.createBatch({ code: 'config-test', communityId: community.id, productIds: ['P1'] });
  const submissionId = randomUUID();
  store.saveSubmission(batch.code, { submissionId, phone: '13800000000', name: '验收', note: '',
    items: [{ productId: 'P1', quantity: 2 }] });
  const lineId = `${submissionId}:P1`;
  store.markExported(batch.code, lineId, 1, 'recExisting123');
  store.setMeta(`feishu-export:${batch.code}`, { status: 'success', pendingCreates: {}, viewUrl: 'https://example.feishu.cn/view', lastSyncedAt: '2026-10-12T03:00:00Z' });
  const api = mockApi();
  const service = new FeishuConfigService({ store, larkCall: api.call });
  return { store, batch, lineId, api, service };
}
const configInput = config => Object.fromEntries(['feishuUrl', 'baseToken', 'productTableId', 'orderTableId'].map(key => [key, config[key]]));
const fingerprint = config => createHash('sha256').update(JSON.stringify([config.baseToken, config.orderTableId])).digest('hex').slice(0, 24);

test('拒绝非官方HTTPS链接、任意参数、非法表编号和版本，CLI尚未调用', async t => {
  const { api, service } = fixture(t);
  for (const input of [
    { feishuUrl: `http://example.feishu.cn/base/${token}` },
    { feishuUrl: `https://feishu.cn.attacker.test/base/${token}` },
    { feishuUrl: `https://attacker.test/base/${token}` },
    { feishuUrl: `https://user:password@example.feishu.cn/base/${token}` },
    { feishuUrl: `https://example.feishu.cn:444/base/${token}` },
    { feishuUrl: `https://example.feishu.cn/wiki/${token}` },
    { baseToken: token, credential: 'secret' }, { baseToken: '--anything' },
  ]) await assert.rejects(service.inspect(input), { code: 'FEISHU_CONFIG_INVALID' });
  const original = service.get();
  for (const input of [
    { ...configInput(source), baseToken: nextToken },
    { ...configInput(source), productTableId: 'product-name' },
    { ...configInput(source), productTableId: source.orderTableId },
    { ...configInput(source), secret: 'hidden' },
    { ...configInput(source), revision: -1 },
  ]) assert.equal((await service.check(input)).status, 'error');
  await assert.rejects(service.save(configInput(source)), { code: 'FEISHU_CONFIG_INVALID' });
  assert.deepEqual(service.get(), original);
  assert.equal(api.calls.length, 0);
});

test('发现全分页表目录，只返回Table，检查类型与单选状态且不回显上游错误', async t => {
  const { api, service } = fixture(t);
  api.pages = new Map([
    ['0', { tables: [{ id: source.productTableId, name: '商品表', type: 'table' }], total: 3 }],
    ['1', { tables: [{ id: 'docxIgnore', name: '说明', type: 'docx' }], total: 3 }],
    ['2', { tables: [{ id: source.orderTableId, name: '下单明细', type: 'table' }], total: 3 }],
  ]);
  const result = await service.inspect({ feishuUrl: `${source.feishuUrl}?table=${source.productTableId}#view` });
  assert.equal(result.base.feishuUrl, source.feishuUrl);
  assert.equal(result.tables.length, 2);
  assert.equal(result.tables[0].productCompatible, true);
  assert.equal(result.tables[1].orderCompatible, true);
  assert.deepEqual(api.calls.filter(args => args[1] === '+table-list').map(args => args.at(-1)), ['0', '1', '2']);
  assert.ok(!api.calls.some(args => args.includes('docxIgnore')));
  api.schemas.get(source.orderTableId).find(field => field.name === '处理状态').options.pop();
  const checked = await service.check(configInput(source));
  assert.equal(checked.status, 'error');
  assert.match(checked.checks.orders.missingFields.join(','), /缺少选项：已取消/);
  api.onCall = async () => { throw Object.assign(new Error('access_token=SECRET'), { code: 'TOKEN-SECRET' }); };
  const failed = await service.check(configInput(source));
  assert.equal(failed.status, 'error');
  assert.equal(failed.code, 'FEISHU_CONFIG_CHECK_FAILED');
  assert.ok(!JSON.stringify(failed).includes('SECRET'));
  await assert.rejects(service.inspect({ baseToken: token }), error => !error.message.includes('SECRET'));
});

test('schema缺失、错误类型或只读公式不能通过；失败保存不改变本地配置和订单', async t => {
  const { api, service, store, batch } = fixture(t);
  const before = { config: service.get(), lines: store.listExportLines(batch.code), meta: store.getMeta(`feishu-export:${batch.code}`) };
  api.schemas.get(source.productTableId).find(field => field.name === '单价').type = 'text';
  api.schemas.get(source.orderTableId).find(field => field.name === '同步金额').type = 'formula';
  api.schemas.get(source.orderTableId).find(field => field.name === '同步状态').multiple = true;
  api.schemas.set(source.orderTableId, api.schemas.get(source.orderTableId).filter(field => field.name !== '数据版本'));
  const checked = await service.check(configInput(source));
  assert.equal(checked.checks.base.status, 'success');
  assert.equal(checked.checks.products.status, 'error');
  assert.ok(checked.checks.orders.missingFields.some(value => value.includes('同步金额')));
  assert.ok(checked.checks.orders.missingFields.some(value => value.includes('同步状态')));
  assert.ok(checked.checks.orders.missingFields.includes('数据版本'));
  await assert.rejects(service.save({ ...configInput(source), revision: 0 }), { code: 'FEISHU_CONFIG_SCHEMA_INVALID' });
  assert.deepEqual({ config: service.get(), lines: store.listExportLines(batch.code), meta: store.getMeta(`feishu-export:${batch.code}`) }, before);
});

test('目标切换归档旧meta、清空远端映射并标记全部本地明细待同步，保留数量状态商品配置', async t => {
  const { service, store, batch, lineId } = fixture(t);
  store.updateOrder(batch.code, lineId, { status: '已取消', quantity: 3 });
  const oldMeta = store.getMeta(`feishu-export:${batch.code}`);
  const result = await service.save({ ...changed, revision: 0 });
  assert.equal(result.changedDestination, true);
  assert.equal(result.markedPending, 1);
  assert.equal(result.revision, 1);
  const line = store.listExportLines(batch.code)[0];
  assert.equal(line.remoteRecordId, null);
  assert.equal(line.syncedRevision, 0);
  assert.equal(line.quantity, 3);
  assert.equal(line.status, '已取消');
  assert.equal(line.revision, 2);
  assert.equal(store.getMeta(`feishu-export:${batch.code}`), null);
  assert.deepEqual(store.getMeta(`feishu-export-archive:${fingerprint(source)}:${batch.code}`), oldMeta);
  const saved = store.getMeta('exportSource');
  assert.equal(saved.settingsTableId, source.settingsTableId);
  assert.equal(saved.imageUrlTemplate, source.imageUrlTemplate);
  assert.equal(saved.baseToken, nextToken);
  assert.equal(saved.productTableId, changed.productTableId);
  assert.equal(store.listProducts().length, 1);
});

test('current或目标归档存在unknown/settled新增时拒绝切换；同target保存允许且不重置', async t => {
  const { service, store, batch, lineId } = fixture(t);
  const key = `feishu-export:${batch.code}`;
  for (const outcome of ['unknown', 'settled']) {
    store.setMeta(key, { pendingCreates: { [lineId]: { outcome } } });
    await assert.rejects(service.save({ ...changed, revision: 0 }), { code: 'FEISHU_CONFIG_PENDING_EXPORT' });
    assert.equal(service.get().revision, 0);
    assert.equal(store.listExportLines(batch.code)[0].remoteRecordId, 'recExisting123');
  }
  const oldMeta = store.getMeta(key);
  const same = await service.save({ ...configInput(source), revision: 0 });
  assert.equal(same.changedDestination, false);
  assert.equal(same.markedPending, 0);
  assert.deepEqual(store.getMeta(key), oldMeta);
  assert.equal(store.listExportLines(batch.code)[0].syncedRevision, 1);
  store.setMeta(key, { pendingCreates: {} });
  store.setMeta(`feishu-export-archive:${fingerprint(changed)}:${batch.code}`, { pendingCreates: { [lineId]: { outcome: 'unknown' } } });
  await assert.rejects(service.save({ ...changed, revision: 1 }), { code: 'FEISHU_CONFIG_PENDING_EXPORT' });
  assert.equal(service.get().revision, 1);
});

test('revision在异步检查后事务内复查，两个竞争保存只能成功一个', async t => {
  const { service, api, store } = fixture(t);
  let release;
  let block = true;
  const barrier = new Promise(resolve => { release = resolve; });
  api.onCall = async args => { if (args[1] === '+base-get' && block) await barrier; };
  const one = service.save({ ...changed, revision: 0 });
  const two = service.save({ ...configInput(source), revision: 0 });
  block = false; release();
  const results = await Promise.allSettled([one, two]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'FEISHU_CONFIG_REVISION_CONFLICT');
  assert.equal(service.get().revision, 1);
  await assert.rejects(service.save({ ...changed, revision: 0 }), { code: 'FEISHU_CONFIG_REVISION_CONFLICT' });
  assert.equal(store.getMeta('feishu-config-revision'), 1);
});

test('新service读取持久化revision和配置；现有未固定source的同步实例使用新目标', async t => {
  const { service, store } = fixture(t);
  const sync = new FeishuSync({ store });
  assert.equal(sync.source().baseToken, token);
  const saved = await service.save({ ...changed, revision: 0 });
  const recreated = new FeishuConfigService({ store, larkCall: mockApi().call });
  assert.equal(recreated.get().revision, saved.revision);
  assert.deepEqual(recreated.get().config, saved.config);
  assert.equal(recreated.get().lastCheck.status, 'success');
  assert.equal(sync.source().baseToken, nextToken);
  assert.equal(sync.source().orderTableId, changed.orderTableId);
  assert.equal(new FeishuSync({ store }).source().productTableId, changed.productTableId);
});

test('仅换商品表、URL或重复保存不重置订单映射；分页空洞拒绝当作完整目录', async t => {
  const { service, store, api, batch } = fixture(t);
  const meta = store.getMeta(`feishu-export:${batch.code}`);
  const saved = await service.save({ ...configInput(source), feishuUrl: `https://another.feishu.cn/base/${token}`,
    productTableId: changed.productTableId, revision: 0 });
  assert.equal(saved.changedDestination, false);
  assert.deepEqual(store.getMeta(`feishu-export:${batch.code}`), meta);
  assert.equal(store.listExportLines(batch.code)[0].remoteRecordId, 'recExisting123');
  assert.equal(store.listExportLines(batch.code)[0].syncedRevision, 1);
  const repeat = await service.save({ ...saved.config, revision: 1 });
  assert.equal(repeat.changedDestination, false);
  api.pages = new Map([['0', { tables: [], has_more: true, total: 20 }]]);
  await assert.rejects(service.inspect({ baseToken: token }), { code: 'FEISHU_CONFIG_RESPONSE_INVALID' });
});

test('带has_more的目录完成分页；无类型items和非安全lastCheck不对外返回', async t => {
  const { service, store, api } = fixture(t);
  api.pages = new Map([
    ['0', { items: [{ id: source.productTableId, name: '商品表', type: 'table' }], has_more: true }],
    ['1', { items: [{ id: source.orderTableId, name: '订单表', type: 'table' }], has_more: false }],
  ]);
  assert.equal((await service.inspect({ baseToken: token })).tables.length, 2);
  api.pages = new Map([['0', { items: [{ id: source.productTableId, name: '表格' }], has_more: false }]]);
  await assert.rejects(service.inspect({ baseToken: token }), { code: 'FEISHU_CONFIG_RESPONSE_INVALID' });
  store.setMeta('feishu-config-last-check', { status: 'success', config: configInput(source),
    checkedAt: '2026-10-12T03:00:00Z', stdout: 'secret', checks: { base: {}, products: {}, orders: {} } });
  assert.equal(service.get().lastCheck, undefined);
  const saved = await service.save({ ...configInput(source), revision: 0 });
  const metadata = store.getMeta('feishu-config-last-check');
  metadata.stdout = 'secret'; metadata.message = 'secret';
  metadata.checks.base.message = 'secret';
  store.setMeta('feishu-config-last-check', metadata);
  assert.ok(!JSON.stringify(service.get()).includes('secret'));
  metadata.config.orderTableId = changed.orderTableId;
  store.setMeta('feishu-config-last-check', metadata);
  assert.equal(service.get().lastCheck, undefined);
  assert.equal(service.get().revision, saved.revision);
});
