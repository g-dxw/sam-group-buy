import { parseArgs } from 'node:util';
import { lark, readRecords } from '../server/lark.js';
import { loadConfig, saveConfig, CONFIG_PATH } from '../server/config.js';

const { values } = parseArgs({ options: {
  code: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' },
  'image-url-template': { type: 'string' }, default: { type: 'boolean', default: false }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('用法：npm run connect:batch -- --code weekly-20261019 --url https://...feishu.cn/base/... [--name 本期名称] [--image-url-template https://files.example.com/products/{id}/cover.jpg] [--default]');
  process.exit(0);
}
try {
  if (!values.code || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(values.code)) throw new Error('--code 使用 2～64 位小写英文字母、数字和连字符。');
  if (!values.url) throw new Error('请提供 --url 飞书多维表格链接。');
  const resolved = await lark(['base', '+url-resolve', '--url', values.url]);
  const baseToken = resolved.base_token || resolved.base?.base_token;
  if (!baseToken) throw new Error('链接不是可以接入的飞书多维表格。');
  const data = await lark(['base', '+table-list', '--base-token', baseToken]);
  const tables = data.tables || data.items || [];
  const required = [
    ['productTableId', '商品表', ['商品ID', '商品名称', '规格', '销售单位', '单价', '分类', '在售', '排序', '采购数量']],
    ['orderTableId', '下单明细', ['明细编号', '提交编号', '手机号', '姓名', '商品ID', '数量', '备注', '处理状态', '提交时间', '同步状态', '预期明细数', '当前名称', '当前规格', '当前单位', '当前单价', '整单完整', '有效数量', '金额']],
    ['settingsTableId', '一期设置', ['本期标题', '说明', '收集中', '截单时间', '联系说明']],
  ];
  const config = await loadConfig();
  const existing = config.batches.find(item => item.code === values.code);
  const batch = { code: values.code, name: values.name || existing?.name || values.code, baseToken,
    imageUrlTemplate: values['image-url-template'] || existing?.imageUrlTemplate || '/images/{id}/cover.svg', feishuUrl: values.url };
  if (!batch.imageUrlTemplate.includes('{id}') || !/^(?:https?:\/\/|\/)/.test(batch.imageUrlTemplate)) throw new Error('图片模板须是 HTTP(S) 或本站绝对路径，包含 {id}。');
  for (const [key, name, fields] of required) {
    const matches = tables.filter(table => (table.name || table.table_name) === name);
    if (matches.length !== 1) throw new Error(`需要恰好一张“${name}”，建议从演示模板复制整份多维表格。`);
    batch[key] = matches[0].id || matches[0].table_id;
    const schemaData = await lark(['base', '+table-get', '--base-token', baseToken, '--table-id', batch[key]]);
    const schema = { ...schemaData, ...(schemaData.table || {}) };
    const found = new Map((schema.fields || []).map(field => [field.name, field]));
    const missing = fields.filter(field => !found.has(field));
    if (missing.length) throw new Error(`${name}缺少字段：${missing.join('、')}。请复制完整模板，不会自动修改你提供的表。`);
    const types = name === '商品表'
      ? { '单价': 'number', '在售': 'checkbox', '排序': 'number', '采购数量': 'formula' }
      : name === '下单明细'
        ? { '数量': 'number', '处理状态': 'select', '提交时间': 'datetime', '同步状态': 'select', '预期明细数': 'number', '当前名称': 'formula', '当前规格': 'formula', '当前单位': 'formula', '当前单价': 'formula', '整单完整': 'formula', '有效数量': 'formula', '金额': 'formula' }
        : { '收集中': 'checkbox', '截单时间': 'datetime' };
    for (const field of fields) {
      const expectedType = types[field] || 'text';
      if (found.get(field).type !== expectedType) throw new Error(`${name}的“${field}”必须为 ${expectedType} 类型。`);
    }
    if (name === '下单明细') {
      for (const [field, options] of [['处理状态', ['待采购', '已买到', '缺货', '已领取', '已取消']], ['同步状态', ['待确认', '已确认']]]) {
        const definition = found.get(field);
        const names = new Set((definition.options || []).map(option => option.name));
        if (definition.multiple || options.some(option => !names.has(option))) throw new Error(`${field}必须是模板单选字段并包含规定状态。`);
      }
    }
    if (name === '一期设置') {
      const rows = await readRecords(baseToken, batch[key], ['本期标题']);
      if (rows.length !== 1) throw new Error('一期设置需要保留且只保留一行。');
    }
  }
  if (existing && (existing.baseToken !== baseToken || existing.productTableId !== batch.productTableId || existing.orderTableId !== batch.orderTableId || existing.settingsTableId !== batch.settingsTableId)) {
    throw new Error('这个批次链接已经绑定其他表，禁止替换；请换一个新的 --code，保持旧链接归属。');
  }
  if (existing) Object.assign(existing, batch);
  else config.batches.push(batch);
  if (values.default || !config.defaultBatch) config.defaultBatch = batch.code;
  await saveConfig(config);
  console.log(JSON.stringify({ ok: true, batchCode: batch.code, configPath: CONFIG_PATH, localUrl: `http://127.0.0.1:3001/b/${batch.code}`, feishuUrl: values.url }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'CONNECT_FAILED', message: error.message }, null, 2));
  process.exitCode = 1;
}
