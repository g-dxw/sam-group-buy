import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lark, readRecords } from '../server/lark.js';
import { DATA_DIR, loadConfig, saveConfig } from '../server/config.js';

const STATE_PATH = resolve(DATA_DIR, 'setup-state.json');
const code = 'demo-20261012';
const name = '山姆代购·本地演示';
const productFields = [
  { name: '商品ID', type: 'text' }, { name: '商品名称', type: 'text' },
  { name: '规格', type: 'text' }, { name: '销售单位', type: 'text' },
  { name: '单价', type: 'number', style: { type: 'currency', precision: 2, currency_code: 'CNY' } },
  { name: '分类', type: 'text' }, { name: '在售', type: 'checkbox' },
  { name: '排序', type: 'number', style: { type: 'plain', precision: 0 } },
];
const orderFields = [
  { name: '明细编号', type: 'text' }, { name: '提交编号', type: 'text' },
  { name: '手机号', type: 'text', description: '本期按手机号合并，文本字段保留原号码。' },
  { name: '姓名', type: 'text' }, { name: '商品ID', type: 'text' },
  { name: '数量', type: 'number', style: { type: 'plain', precision: 0 } },
  { name: '备注', type: 'text' },
  { name: '处理状态', type: 'select', multiple: false, default_value: ['待采购'], options: [
    { name: '待采购', hue: 'Orange' }, { name: '已买到', hue: 'Green' },
    { name: '缺货', hue: 'Red' }, { name: '已领取', hue: 'Blue' }, { name: '已取消', hue: 'Gray' },
  ] },
  { name: '提交时间', type: 'datetime', style: { format: 'yyyy-MM-dd HH:mm' } },
  { name: '同步状态', type: 'select', multiple: false, default_value: ['待确认'], options: [
    { name: '待确认', hue: 'Orange' }, { name: '已确认', hue: 'Green' },
  ], description: '由服务确认整单完整后设置，请勿手动修改。' },
  { name: '预期明细数', type: 'number', style: { type: 'plain', precision: 0 }, description: '服务技术字段，请勿手动修改。' },
];
const settingsFields = [
  { name: '本期标题', type: 'text' }, { name: '说明', type: 'text' },
  { name: '收集中', type: 'checkbox' },
  { name: '截单时间', type: 'datetime', style: { format: 'yyyy-MM-dd HH:mm' } },
  { name: '联系说明', type: 'text' },
];
const demos = [
  ['DEMO-001', '纯牛奶（演示）', '250mL × 24盒', '箱', 69.9, '乳品饮料'],
  ['DEMO-002', '鲜鸡蛋（演示）', '30枚', '盒', 29.9, '生鲜冷藏'],
  ['DEMO-003', '黄油可颂（演示）', '12个装', '盒', 39.9, '烘焙点心'],
  ['DEMO-004', '原味酸奶（演示）', '135g × 12杯', '箱', 49.9, '乳品饮料'],
  ['DEMO-005', '混合坚果（演示）', '每日装25g × 30袋', '盒', 89.9, '零食坚果'],
  ['DEMO-006', '香脆海苔（演示）', '2g × 40包', '盒', 39.9, '零食坚果'],
  ['DEMO-007', '冷冻鲜虾（演示）', '1kg装', '袋', 99.9, '生鲜冷藏'],
  ['DEMO-008', '牛肉卷（演示）', '500g × 2盒', '组', 129.9, '生鲜冷藏'],
  ['DEMO-009', '橙汁（演示）', '1L × 2瓶', '组', 29.9, '乳品饮料'],
  ['DEMO-010', '蛋黄酥（演示）', '8枚装', '盒', 49.9, '烘焙点心'],
  ['DEMO-011', '抽纸（演示）', '100抽 × 24包', '箱', 59.9, '日用家庭'],
  ['DEMO-012', '洗衣液（演示）', '3kg装', '瓶', 69.9, '日用家庭'],
];

let state;
try { state = JSON.parse(await readFile(STATE_PATH, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = {}; }
async function checkpoint() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temp = `${STATE_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, STATE_PATH);
}
async function tables() {
  const data = await lark(['base', '+table-list', '--base-token', state.baseToken]);
  return data.items || data.tables || [];
}
async function tableSchema(tableId) {
  const data = await lark(['base', '+table-get', '--base-token', state.baseToken, '--table-id', tableId]);
  return { ...data, ...(data.table || {}) };
}
async function ensureTable(key, tableName, fields) {
  if (state[key]) return state[key];
  const found = (await tables()).find(item => (item.name || item.table_name) === tableName);
  if (found) state[key] = found.id || found.table_id;
  else {
    const data = await lark(['base', '+table-create', '--base-token', state.baseToken, '--name', tableName,
      '--fields', JSON.stringify(fields)], { write: true });
    state[key] = data.table?.id || data.table_id || data.id;
    if (!state[key]) throw new Error(`创建${tableName}未返回表ID；重新运行会按表名恢复。`);
  }
  await checkpoint();
  return state[key];
}
async function ensureFormulaFields(tableId, formulas) {
  // Read the schema before dependent formula creation, including on resumed runs.
  const schema = await tableSchema(tableId);
  const existing = new Set((schema.fields || []).map(field => field.name));
  const missing = formulas.filter(field => !existing.has(field.name));
  if (missing.length) await lark(['base', '+field-create', '--base-token', state.baseToken,
    '--table-id', tableId, '--json', JSON.stringify(missing), '--i-have-read-guide'], { write: true });
}
async function ensureView(tableId, viewName, { group, visible, filter } = {}) {
  const data = await lark(['base', '+view-list', '--base-token', state.baseToken, '--table-id', tableId]);
  let view = (data.items || data.views || []).find(item => item.name === viewName);
  if (!view) {
    const created = await lark(['base', '+view-create', '--base-token', state.baseToken, '--table-id', tableId,
      '--json', JSON.stringify({ name: viewName, type: 'grid' })], { write: true });
    view = created.view || created.views?.[0] || created.items?.[0]?.view || created.items?.[0] || created;
    if (!view.id && !view.view_id) {
      const listed = await lark(['base', '+view-list', '--base-token', state.baseToken, '--table-id', tableId]);
      view = (listed.views || listed.items || []).find(item => item.name === viewName) || {};
    }
  }
  const viewId = view.id || view.view_id;
  if (!viewId) throw new Error(`视图${viewName}未返回ID，请重新运行恢复。`);
  for (const [command, json] of [
    ['+view-set-group', group && { group_config: [{ field: group, desc: false }] }],
    ['+view-set-visible-fields', visible && { visible_fields: visible }],
    ['+view-set-filter', filter],
  ]) if (json) await lark(['base', command, '--base-token', state.baseToken, '--table-id', tableId,
    '--view-id', viewId, '--json', JSON.stringify(json)], { write: true });
}

try {
  if (!state.baseToken) {
    if (state.baseCreationStarted) throw new Error('上次建表结果未确认；请用 lark-cli base +title-resolve --title 山姆代购·本地演示 --as user 确认原表，将 baseToken 写入 .data/setup-state.json 后重跑，避免重复创建。');
    state.baseCreationStarted = new Date().toISOString();
    await checkpoint();
    const data = await lark(['base', '+base-create', '--name', name, '--table-name', '商品表',
      '--fields', JSON.stringify(productFields), '--time-zone', 'Asia/Shanghai'], { write: true });
    state.baseToken = data.base?.base_token;
    state.url = data.base?.url;
    state.productTableId = data.table?.id;
    if (!state.baseToken) throw new Error('新建结果没有 Base ID，请按表名核对后恢复状态。');
    await checkpoint();
  }
  await ensureTable('productTableId', '商品表', productFields);
  await ensureTable('orderTableId', '下单明细', orderFields);
  await ensureTable('settingsTableId', '一期设置', settingsFields);

  await tables();
  const schemas = await Promise.all([state.productTableId, state.orderTableId].map(tableSchema));
  if (schemas[0].name !== '商品表' || schemas[1].name !== '下单明细') throw new Error('表名已变更，请恢复模板表名后初始化公式。');
  const productLookup = output => `[商品表].FILTER(CurrentValue.[商品ID] = [商品ID]).[${output}].FIRST()`;
  const completeness = `AND(NOT(ISBLANK([提交编号])), [预期明细数] > 0, [下单明细].COUNTIF(CurrentValue.[提交编号] = [提交编号]) = [预期明细数], [下单明细].FILTER(CurrentValue.[提交编号] = [提交编号]).[明细编号].LISTCOMBINE().UNIQUE().COUNTA() = [预期明细数], [下单明细].COUNTIF(AND(CurrentValue.[提交编号] = [提交编号], CurrentValue.[同步状态] = "已确认", CurrentValue.[预期明细数] = [预期明细数], CurrentValue.[手机号] = [手机号])) = [预期明细数])`;
  await ensureFormulaFields(state.orderTableId, [
    { name: '当前名称', type: 'formula', expression: productLookup('商品名称') },
    { name: '当前规格', type: 'formula', expression: productLookup('规格') },
    { name: '当前单位', type: 'formula', expression: productLookup('销售单位') },
    { name: '当前单价', type: 'formula', expression: productLookup('单价') },
    { name: '整单完整', type: 'formula', expression: `IF(${completeness}, 1, 0)` },
    { name: '有效数量', type: 'formula', expression: `IF(AND([整单完整], [数量] > 0, [处理状态] != "已取消", [处理状态] != "缺货"), [数量], 0)` },
    { name: '金额', type: 'formula', expression: 'ROUND([当前单价] * [有效数量], 2)' },
  ]);
  // Resume an initial build made before the CLI's numeric-only formula-filter constraint was observed.
  const completeField = (await tableSchema(state.orderTableId)).fields.find(field => field.name === '整单完整');
  if (completeField.expression.replace(/\s/g, '') === completeness.replace(/\s/g, '')) {
    const { id: fieldId, ...definition } = completeField;
    await lark(['base', '+field-update', '--base-token', state.baseToken, '--table-id', state.orderTableId,
      '--field-id', fieldId, '--json', JSON.stringify({ ...definition, expression: `IF(${completeness}, 1, 0)` }),
      '--i-have-read-guide', '--yes'], { write: true });
  }
  await ensureFormulaFields(state.productTableId, [{ name: '采购数量', type: 'formula',
    expression: '[下单明细].FILTER(CurrentValue.[商品ID] = [商品ID]).[有效数量].LISTCOMBINE().SUM()' }]);

  const products = await readRecords(state.baseToken, state.productTableId, ['商品ID']);
  const existingProductIds = new Set(products.map(row => row.fields['商品ID']));
  const missingProducts = demos.filter(item => !existingProductIds.has(item[0]));
  if (missingProducts.length) await lark(['base', '+record-batch-create', '--base-token', state.baseToken,
    '--table-id', state.productTableId, '--json', JSON.stringify({ create_records: missingProducts.map(item => ({
      '商品ID': item[0], '商品名称': item[1], '规格': item[2], '销售单位': item[3], '单价': item[4], '分类': item[5], '在售': true, '排序': demos.findIndex(demo => demo[0] === item[0]) + 1,
    })) })], { write: true });
  const settings = await readRecords(state.baseToken, state.settingsTableId, ['本期标题']);
  if (!settings.length) await lark(['base', '+record-batch-create', '--base-token', state.baseToken,
    '--table-id', state.settingsTableId, '--json', JSON.stringify({ create_records: [{
      '本期标题': '山姆代购 · 本地演示', '说明': '这是本地演示批次：商品、价格与图片均为示例，并非真实山姆报价。补单按本次新增数量追加。',
      '收集中': true, '联系说明': '修改数量、取消或缺货处理，请联系群内代购负责人。',
    }] })], { write: true });

  const businessFields = ['姓名', '手机号', '当前名称', '当前规格', '当前单位', '数量', '处理状态', '当前单价', '金额', '备注', '提交时间'];
  await ensureView(state.productTableId, '采购清单', { visible: [...productFields.map(field => field.name), '采购数量'] });
  await ensureView(state.orderTableId, '按商品采购', { group: '商品ID', visible: ['商品ID', ...businessFields], filter: { conditions: [['有效数量', '>', 0]] } });
  await ensureView(state.orderTableId, '按手机号分发', { group: '手机号', visible: businessFields, filter: { conditions: [['整单完整', '==', 1]] } });
  await ensureView(state.orderTableId, '未同步核查', { visible: [...orderFields.map(field => field.name), '整单完整'], filter: { conditions: [['整单完整', '==', 0]] } });

  const config = await loadConfig();
  const batch = { code, name, baseToken: state.baseToken, productTableId: state.productTableId,
    orderTableId: state.orderTableId, settingsTableId: state.settingsTableId,
    imageUrlTemplate: '/images/{id}/cover.svg', feishuUrl: state.url };
  const current = config.batches.findIndex(item => item.code === code);
  if (current === -1) config.batches.push(batch);
  else if (config.batches[current].baseToken !== batch.baseToken) throw new Error('本期链接已绑定其他表格，拒绝替换。');
  else config.batches[current] = { ...config.batches[current], ...batch };
  config.defaultBatch ||= code;
  await saveConfig(config);
  state.complete = true;
  await checkpoint();
  const finalProducts = await readRecords(state.baseToken, state.productTableId, ['商品ID']);
  const finalSettings = await readRecords(state.baseToken, state.settingsTableId, ['本期标题']);
  console.log(JSON.stringify({ ok: true, url: state.url, batchCode: code, products: finalProducts.length,
    settings: finalSettings.length, configPath: resolve(DATA_DIR, 'batches.json'), localUrl: `http://127.0.0.1:3001/b/${code}` }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'SETUP_FAILED', message: error.message, operation: error.operation,
    statePath: STATE_PATH, action: '保留已建表格和初始化进度，修复后重跑 npm run setup:feishu。' }, null, 2));
  process.exitCode = 1;
}
