// Feishu is now a manual export destination. This command only adds schema and a new view.
// Historical admin-migration-state.json is retained; no settings or order data is migrated.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lark } from '../server/lark.js';
import { DATA_DIR } from '../server/config.js';
import { loadFeishuSource } from '../server/feishu-source.js';

const statePath = resolve(DATA_DIR, 'feishu-sync-schema-state.json');
const definitions = [
  { name: '团购ID', type: 'text' }, { name: '小区/群名称', type: 'text' }, { name: '期次', type: 'text' },
  { name: '同步商品名称', type: 'text' }, { name: '同步规格', type: 'text' }, { name: '同步销售单位', type: 'text' },
  { name: '同步单价', type: 'number', style: { type: 'currency', precision: 2, currency_code: 'CNY' } },
  { name: '同步金额', type: 'number', style: { type: 'currency', precision: 2, currency_code: 'CNY' } },
  { name: '数据版本', type: 'number', style: { type: 'plain', precision: 0 } },
];
try {
  const source = await loadFeishuSource();
  if (!source) throw new Error('请先配置飞书商品源和订单导出表。');
  const current = await lark(['base', '+table-get', '--base-token', source.baseToken, '--table-id', source.orderTableId]);
  const fields = new Map((current.fields || current.table?.fields || []).map(field => [field.name, field]));
  for (const field of definitions) if (fields.has(field.name) && fields.get(field.name).type !== field.type) throw new Error(`${field.name}已存在但类型不匹配；不会转换原字段。`);
  const missing = definitions.filter(field => !fields.has(field.name));
  if (missing.length) await lark(['base', '+field-create', '--base-token', source.baseToken, '--table-id', source.orderTableId,
    '--json', JSON.stringify(missing)], { write: true });
  const verified = await lark(['base', '+table-get', '--base-token', source.baseToken, '--table-id', source.orderTableId]);
  const ids = Object.fromEntries((verified.fields || verified.table?.fields || []).filter(field => definitions.some(definition => definition.name === field.name)).map(field => [field.name, field.id]));
  if (Object.keys(ids).length !== definitions.length) throw new Error('新增导出字段尚未完整可见，请稍后重跑。');
  const viewName = '后台·本地采购汇总';
  let listed = await lark(['base', '+view-list', '--base-token', source.baseToken, '--table-id', source.orderTableId]);
  let view = (listed.views || listed.items || []).find(item => item.name === viewName);
  if (!view) {
    await lark(['base', '+view-create', '--base-token', source.baseToken, '--table-id', source.orderTableId,
      '--json', JSON.stringify({ name: viewName, type: 'grid' })], { write: true });
    listed = await lark(['base', '+view-list', '--base-token', source.baseToken, '--table-id', source.orderTableId]);
    view = (listed.views || listed.items || []).find(item => item.name === viewName);
  }
  if (!view) throw new Error('采购视图尚未可见，请稍后重跑。');
  const viewId = view.id || view.view_id;
  await lark(['base', '+view-set-group', '--base-token', source.baseToken, '--table-id', source.orderTableId,
    '--view-id', viewId, '--json', JSON.stringify({ group_config: ['小区/群名称', '期次', '商品ID'].map(field => ({ field, desc: false })) })], { write: true });
  await lark(['base', '+view-set-filter', '--base-token', source.baseToken, '--table-id', source.orderTableId,
    '--view-id', viewId, '--json', JSON.stringify({ logic: 'and', conditions: [['同步状态', 'intersects', ['已确认']], ['处理状态', 'disjoint', ['已取消', '缺货']], ['数量', '>', 0]] })], { write: true });
  await lark(['base', '+view-set-visible-fields', '--base-token', source.baseToken, '--table-id', source.orderTableId,
    '--view-id', viewId, '--json', JSON.stringify({ visible_fields: ['团购ID', '小区/群名称', '期次', '手机号', '姓名', '商品ID', '同步商品名称', '同步规格', '同步销售单位', '数量', '同步单价', '同步金额', '处理状态', '备注', '提交时间'] })], { write: true });
  let state = {};
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state[`${source.baseToken}:${source.orderTableId}`] = { fieldIds: ids, viewId, complete: true, updatedAt: new Date().toISOString() };
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
  console.log(JSON.stringify({ ok: true, orderTableId: source.orderTableId, fieldIds: ids, viewId, statePath, recordsChanged: 0, settingsChanged: false }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'SYNC_SCHEMA_FAILED', message: error.message, operation: error.operation, statePath }, null, 2));
  process.exitCode = 1;
}
