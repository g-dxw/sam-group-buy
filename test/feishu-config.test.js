import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { LocalStore } from '../server/local-store.js';
import { FeishuConfigService } from '../server/feishu-config.js';
import { FeishuSync, EXPORT_FIELDS, ORDER_FEE_SCHEMA, ORDER_SPLIT_SCHEMA, productDestination, productBackupArchiveKey } from '../server/feishu-sync.js';

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

test('拼份备份字段可选但必须唯一text，检查与保存投影完整保留兼容提示', async t => {
  const { api, service } = fixture(t);
  const missingNames = Object.keys(ORDER_SPLIT_SCHEMA);
  const ordinary = await service.check(configInput(source));
  assert.equal(ordinary.status, 'success', 'existing ordinary-order table remains usable');
  assert.equal(ordinary.checks.orders.splitCompatible, false);
  assert.deepEqual(ordinary.checks.orders.missingSplitFields, missingNames);
  assert.match(ordinary.checks.orders.message, /同步拼份信息/);
  await service.save({ ...configInput(source), revision: 0 });
  assert.equal(service.get().lastCheck.checks.orders.splitCompatible, false);
  assert.deepEqual(service.get().lastCheck.checks.orders.missingSplitFields, missingNames);
  const discovered = await service.inspect({ baseToken: token });
  assert.equal(discovered.tables[1].orderCompatible, true);
  assert.equal(discovered.tables[1].splitCompatible, false);
  assert.deepEqual(discovered.tables[1].missingSplitFields, missingNames);

  api.schemas.get(source.orderTableId).push({ name: missingNames[0], type: 'text' });
  const compatible = await service.check(configInput(source));
  assert.equal(compatible.status, 'success');
  assert.equal(compatible.checks.orders.splitCompatible, true);
  assert.deepEqual(compatible.checks.orders.missingSplitFields, []);
  await service.save({ ...configInput(source), revision: 1 });
  assert.equal(service.get().lastCheck.checks.orders.splitCompatible, true);

  api.schemas.get(source.orderTableId).find(field => field.name === missingNames[0]).type = 'formula';
  const invalid = await service.check(configInput(source));
  assert.equal(invalid.status, 'error');
  assert.match(invalid.checks.orders.missingFields.join(','), /同步拼份信息（需 text 类型）/);
  api.schemas.get(source.orderTableId).find(field => field.name === missingNames[0]).type = 'text';
  api.schemas.get(source.orderTableId).push({ name: missingNames[0], type: 'text' });
  const duplicate = await service.check(configInput(source));
  assert.equal(duplicate.status, 'error');
  assert.match(duplicate.checks.orders.missingFields.join(','), /同步拼份信息（字段名称重复）/);
});

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

test('切换Base固定旧目标归属，保留远端映射直到各期手动同步，数量状态商品不变', async t => {
  const { service, store, batch, lineId } = fixture(t);
  store.updateOrder(batch.code, lineId, { status: '已取消', quantity: 3 });
  const oldMeta = store.getMeta(`feishu-export:${batch.code}`);
  const result = await service.save({ ...changed, revision: 0 });
  assert.equal(result.changedDestination, true);
  assert.equal(result.markedPending, 1);
  assert.equal(result.revision, 1);
  const line = store.listExportLines(batch.code)[0];
  assert.equal(line.remoteRecordId, 'recExisting123');
  assert.equal(line.syncedRevision, 1);
  assert.equal(line.quantity, 3);
  assert.equal(line.status, '已取消');
  assert.equal(line.revision, 2);
  assert.deepEqual(store.getMeta(`feishu-export:${batch.code}`), { ...oldMeta,
    destination: { baseToken: source.baseToken, orderTableId: source.orderTableId },
    scope: 'legacy', tableName: '历史订单表', feishuUrl: source.feishuUrl });
  assert.equal(store.getMeta(`feishu-export-archive:${fingerprint(source)}:${batch.code}`), null);
  const saved = store.getMeta('exportSource');
  assert.equal(saved.settingsTableId, source.settingsTableId);
  assert.equal(saved.imageUrlTemplate, source.imageUrlTemplate);
  assert.equal(saved.baseToken, nextToken);
  assert.equal(saved.productTableId, changed.productTableId);
  assert.equal(saved.orderScope, 'community');
  assert.equal(result.groupTablesCreatedAutomatically, true);
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
  assert.deepEqual(store.getMeta(key).pendingCreates, oldMeta.pendingCreates);
  assert.deepEqual(store.getMeta(key).destination, { baseToken: source.baseToken, orderTableId: source.orderTableId });
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
  assert.deepEqual(store.getMeta(`feishu-export:${batch.code}`), { ...meta,
    destination: { baseToken: source.baseToken, orderTableId: source.orderTableId },
    scope: 'legacy', tableName: '历史订单表', feishuUrl: source.feishuUrl });
  assert.equal(store.listExportLines(batch.code)[0].remoteRecordId, 'recExisting123');
  assert.equal(store.listExportLines(batch.code)[0].syncedRevision, 1);
  const repeat = await service.save({ ...saved.config, revision: 1 });
  assert.equal(repeat.changedDestination, false);
  api.pages = new Map([['0', { tables: [], has_more: true, total: 20 }]]);
  await assert.rejects(service.inspect({ baseToken: token }), { code: 'FEISHU_CONFIG_RESPONSE_INVALID' });
});

test('同Base更换历史参考表不会重置任何群表或订单，旧总表的未确认结果保留原目标', async t => {
  const { service, store, batch, lineId } = fixture(t);
  const key = `feishu-export:${batch.code}`;
  const pendingCreates = { [lineId]: { outcome: 'unknown', attemptId: 'old-history-create' } };
  store.setMeta(key, { pendingCreates });
  const bindingKey = `feishu-community-table:${token}:${batch.communityId}`;
  const binding = { status: 'ready', baseToken: token, communityId: batch.communityId,
    tableId: 'tblExistingGroup', tableName: '配置验收群 · 下单明细' };
  store.setMeta(bindingKey, binding);
  const before = store.listExportLines(batch.code);
  const result = await service.save({ ...configInput(source), orderTableId: changed.orderTableId, revision: 0 });
  assert.equal(result.changedDestination, false);
  assert.equal(result.historicalOrderTableChanged, true);
  assert.equal(result.markedPending, 0);
  assert.deepEqual(store.getMeta(bindingKey), binding);
  assert.deepEqual(store.listExportLines(batch.code), before);
  assert.deepEqual(store.getMeta(key).pendingCreates, pendingCreates);
  assert.deepEqual(store.getMeta(key).destination, { baseToken: token, orderTableId: source.orderTableId });
  assert.ok(service.get().groupTablesCreatedAutomatically);
});

test('切换Base保留群表绑定及已删除期次的旧远端记录和归属，不提前迁移', async t => {
  const { service, store, batch } = fixture(t);
  const destination = { baseToken: token, orderTableId: 'tblExistingGroup' };
  const meta = { destination, scope: 'community', pendingCreates: {}, viewUrl: 'https://example.feishu.cn/group-view' };
  store.setMeta(`feishu-export:${batch.code}`, meta);
  const bindingKey = `feishu-community-table:${token}:${batch.communityId}`;
  const binding = { status: 'ready', ...destination, communityId: batch.communityId, tableId: destination.orderTableId };
  store.setMeta(bindingKey, binding);
  store.updateBatch(batch.code, { collecting: false });
  store.deleteBatch(batch.code);
  const rows = store.db.prepare('SELECT * FROM order_lines ORDER BY id').all();
  const result = await service.save({ ...changed, revision: 0 });
  assert.equal(result.changedDestination, true);
  assert.deepEqual(store.getMeta(bindingKey), binding);
  assert.deepEqual(store.getMeta(`feishu-export:${batch.code}`), meta);
  assert.deepEqual(store.db.prepare('SELECT * FROM order_lines ORDER BY id').all(), rows);
});

test('旧8字段商品表可检查保存，提示单向写入备份；已有扩展字段错误类型不通过', async t => {
  const { service, api } = fixture(t);
  const checked = await service.check(configInput(source));
  assert.equal(checked.status, 'success');
  assert.equal(checked.writeMode, 'manual_one_way_backup');
  assert.match(checked.message, /本地商品库为主数据/);
  assert.match(checked.message, /未验证写入权限/);
  assert.deepEqual(checked.checks.products.fieldsToCreate, ['图片地址', '来源数据', '数据版本', '更新时间', '定价规则', '移除时间']);
  await service.save({ ...configInput(source), revision: 0 });
  assert.deepEqual(service.get().lastCheck.checks.products.fieldsToCreate, checked.checks.products.fieldsToCreate);
  api.schemas.get(source.productTableId).push({ name: '来源数据', type: 'formula' });
  const wrong = await service.check(configInput(source));
  assert.equal(wrong.status, 'error');
  assert.match(wrong.checks.products.missingFields.join(','), /来源数据（需 text 类型）/);
});

test('定价规则字段缺失可自动补齐，已有字段必须唯一text，连接检查不进行写入', async t => {
  const { service, api } = fixture(t);
  const initial = await service.check(configInput(source));
  assert.equal(initial.status, 'success');
  assert.ok(initial.checks.products.fieldsToCreate.includes('定价规则'));
  assert.match(initial.message, /参考原价与加价设置/);
  assert.match(initial.message, /固定加价金额或比例/);
  const discovery = await service.inspect({ baseToken: token });
  assert.ok(discovery.tables[0].productBackupFieldsToCreate.includes('定价规则'));
  api.schemas.get(source.productTableId).push({ name: '定价规则', type: 'text' });
  const complete = await service.check(configInput(source));
  assert.equal(complete.status, 'success');
  assert.ok(!complete.checks.products.fieldsToCreate.includes('定价规则'));
  api.schemas.get(source.productTableId).find(field => field.name === '定价规则').type = 'formula';
  const wrong = await service.check(configInput(source));
  assert.equal(wrong.status, 'error');
  assert.match(wrong.checks.products.missingFields.join(','), /定价规则（需 text 类型）/);
  api.schemas.get(source.productTableId).find(field => field.name === '定价规则').type = 'text';
  api.schemas.get(source.productTableId).push({ name: '定价规则', type: 'text' });
  const duplicate = await service.check(configInput(source));
  assert.equal(duplicate.status, 'error');
  assert.match(duplicate.checks.products.missingFields.join(','), /定价规则（字段名称重复）/);
  assert.ok(api.calls.every(call => call.options?.write !== true));
});

test('移除时间备份字段缺失可补齐，已有字段必须唯一text且检查不写飞书', async t => {
  const { service, api } = fixture(t);
  const initial = await service.check(configInput(source));
  assert.equal(initial.status, 'success');
  assert.ok(initial.checks.products.fieldsToCreate.includes('移除时间'));
  assert.match(initial.message, /已移除商品保留下架备份/);
  const discovery = await service.inspect({ baseToken: token });
  assert.ok(discovery.tables[0].productBackupFieldsToCreate.includes('移除时间'));
  api.schemas.get(source.productTableId).push({ name: '移除时间', type: 'text' });
  assert.equal((await service.check(configInput(source))).status, 'success');
  api.schemas.get(source.productTableId).find(field => field.name === '移除时间').type = 'datetime';
  const wrong = await service.check(configInput(source));
  assert.equal(wrong.status, 'error');
  assert.match(wrong.checks.products.missingFields.join(','), /移除时间（需 text 类型）/);
  api.schemas.get(source.productTableId).find(field => field.name === '移除时间').type = 'text';
  api.schemas.get(source.productTableId).push({ name: '移除时间', type: 'text' });
  const duplicate = await service.check(configInput(source));
  assert.equal(duplicate.status, 'error');
  assert.match(duplicate.checks.products.missingFields.join(','), /移除时间（字段名称重复）/);
  assert.ok(api.calls.every(call => call.options?.write !== true));
});

test('切换商品目标只标记备份待处理，保留本地主数据和订单；切回仍保留未知新增对账标记', async t => {
  const { service, store, batch } = fixture(t);
  const products = store.listProducts();
  const orders = store.listExportLines(batch.code);
  const oldBackup = { destination: productDestination(source), status: 'pending', records: {
    P1: { recordId: 'old-product-record', revision: products[0].revision,
      lastBackedUpAt: '2026-10-12T03:00:00Z', pendingCreate: { outcome: 'unknown', attemptId: 'previous-attempt' } },
  }, lastSyncedAt: '2026-10-12T03:00:00Z' };
  store.setMeta('feishu-product-backup', oldBackup);
  const next = { ...configInput(source), productTableId: changed.productTableId };
  const saved = await service.save({ ...next, revision: 0 });
  assert.equal(saved.changedProductDestination, true);
  assert.equal(saved.productsMarkedPending, 1);
  assert.equal(saved.changedDestination, false);
  assert.deepEqual(store.listProducts(), products);
  assert.deepEqual(store.listExportLines(batch.code), orders);
  assert.deepEqual(store.getMeta(productBackupArchiveKey(productDestination(source))), oldBackup);
  const state = store.getMeta('feishu-product-backup');
  assert.equal(state.destination, productDestination(next));
  assert.equal(state.counts.pending, 1);
  assert.deepEqual(state.records, {});
  await service.save({ ...configInput(source), revision: 1 });
  const restored = store.getMeta('feishu-product-backup');
  assert.equal(restored.status, 'pending');
  assert.equal(restored.records.P1.revision, 0);
  assert.equal(restored.records.P1.pendingCreate.attemptId, 'previous-attempt');
  assert.deepEqual(store.listProducts(), products);
});

test('全部商品移除后切换商品目标仍标记全部待备份，切回保留旧目标绑定且不恢复商品', async t => {
  const { service, store, batch } = fixture(t);
  store.removeProducts({ productIds: ['P1'] }, { timestamp: '2026-10-13T03:00:00.000Z' });
  const products = store.listProducts({ includeRemoved: true });
  const orders = store.listExportLines(batch.code);
  const oldBackup = { destination: productDestination(source), status: 'success', records: {
    P1: { recordId: 'removed-product-record', revision: products[0].revision, lastBackedUpAt: '2026-10-13T03:01:00.000Z' },
  }, lastSyncedAt: '2026-10-13T03:01:00.000Z' };
  store.setMeta('feishu-product-backup', oldBackup);
  const next = { ...configInput(source), productTableId: changed.productTableId };
  const result = await service.save({ ...next, revision: 0 });
  assert.equal(result.changedProductDestination, true);
  assert.equal(result.productsMarkedPending, 1);
  assert.deepEqual(store.getMeta('feishu-product-backup').counts,
    { created: 0, updated: 0, unchanged: 0, total: 1, backedUp: 0, pending: 1 });
  assert.equal(store.getMeta('feishu-product-backup').pending, 1);
  assert.deepEqual(store.getMeta(productBackupArchiveKey(productDestination(source))), oldBackup);
  assert.deepEqual(store.listProducts(), []);
  assert.deepEqual(store.listProducts({ includeRemoved: true }), products);
  assert.deepEqual(store.listExportLines(batch.code), orders);
  await service.save({ ...configInput(source), revision: 1 });
  const restored = store.getMeta('feishu-product-backup');
  assert.equal(restored.records.P1.recordId, 'removed-product-record');
  assert.equal(restored.records.P1.revision, 0);
  assert.equal(restored.counts.pending, 1);
  assert.deepEqual(store.listProducts({ includeRemoved: true }), products);
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

test('旧订单表仍可检查保存，收费字段缺失明确提示；完整收费字段通过并保留能力信息', async t => {
  const { service, api } = fixture(t);
  const missingNames = Object.keys(ORDER_FEE_SCHEMA);
  const legacy = await service.check(configInput(source));
  assert.equal(legacy.status, 'success');
  assert.equal(legacy.checks.orders.feeCompatible, false);
  assert.deepEqual(legacy.checks.orders.missingFeeFields, missingNames);
  assert.match(legacy.checks.orders.message, /仅支持零费订单备份/);
  await service.save({ ...configInput(source), revision: 0 });
  assert.deepEqual(service.get().lastCheck.checks.orders.missingFeeFields, missingNames);
  const discovered = await service.inspect({ baseToken: token });
  assert.equal(discovered.tables[1].orderCompatible, true);
  assert.equal(discovered.tables[1].feeCompatible, false);
  assert.deepEqual(discovered.tables[1].missingFeeFields, missingNames);
  api.schemas.get(source.orderTableId).push(...Object.entries(ORDER_FEE_SCHEMA).map(([name, type]) => ({ name, type })));
  await service.save({ ...configInput(source), revision: service.get().revision });
  const complete = service.get().lastCheck;
  assert.equal(complete.checks.orders.feeCompatible, true);
  assert.deepEqual(complete.checks.orders.missingFeeFields, []);
});

test('可选收费字段已经存在时必须唯一且类型正确，缺少其他收费字段不掩盖错误', async t => {
  const { service, api } = fixture(t);
  const schema = api.schemas.get(source.orderTableId);
  schema.push({ name: '同步代购费', type: 'formula' });
  let checked = await service.check(configInput(source));
  assert.equal(checked.status, 'error');
  assert.match(checked.checks.orders.missingFields.join(','), /同步代购费（需 number 类型）/);
  schema.at(-1).type = 'number';
  schema.push({ name: '同步代购费', type: 'number' });
  checked = await service.check(configInput(source));
  assert.equal(checked.status, 'error');
  assert.match(checked.checks.orders.missingFields.join(','), /同步代购费（字段名称重复）/);
});
