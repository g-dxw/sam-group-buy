import { createHash } from 'node:crypto';
import { lark } from './lark.js';
import { DomainError } from './order-service.js';
import { EXPORT_FIELDS } from './feishu-sync.js';

const REVISION_KEY = 'feishu-config-revision';
const CHECK_KEY = 'feishu-config-last-check';
const CONFIG_KEYS = ['feishuUrl', 'baseToken', 'productTableId', 'orderTableId'];
const TOKEN = /^[A-Za-z0-9]{10,128}$/;
const TABLE_ID = /^tbl[A-Za-z0-9]{3,125}$/;
const PRODUCT_SCHEMA = { 商品ID: 'text', 商品名称: 'text', 规格: 'text', 销售单位: 'text', 单价: 'number', 分类: 'text', 在售: 'checkbox', 排序: 'number' };
const NUMBER_FIELDS = new Set(['数量', '预期明细数', '同步单价', '同步金额', '数据版本']);
const OPTIONS = { 处理状态: ['待采购', '已买到', '缺货', '已领取', '已取消'], 同步状态: ['待确认', '已确认'] };
const ORDER_SCHEMA = Object.fromEntries(EXPORT_FIELDS.map(name => [name,
  NUMBER_FIELDS.has(name) ? 'number' : name === '提交时间' ? 'datetime' : OPTIONS[name] ? 'select' : 'text']));

function invalid(message = '请填写有效的飞书多维表格链接或 Base Token。') {
  return new DomainError(400, 'FEISHU_CONFIG_INVALID', message);
}
function inputObject(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !keys.includes(key))) throw invalid('飞书配置包含不支持的字段。');
}
function revisionValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid('配置版本无效，请刷新配置后重试。');
  return value;
}
function officialBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw invalid();
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  const hostname = url.hostname.toLowerCase();
  const official = ['feishu.cn', 'larksuite.com', 'larkoffice.com'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  const validHost = hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  const path = url.pathname.match(/^\/base\/([A-Za-z0-9]{10,128})\/?$/);
  if (!official || !validHost || url.protocol !== 'https:' || url.username || url.password || url.port || !path) throw invalid();
  return { feishuUrl: `${url.origin}/base/${path[1]}`, baseToken: path[1] };
}
function baseInput(input) {
  const url = input.feishuUrl == null || input.feishuUrl === '' ? null : officialBaseUrl(input.feishuUrl);
  const token = input.baseToken == null || input.baseToken === '' ? url?.baseToken : input.baseToken;
  if (typeof token !== 'string' || !TOKEN.test(token.trim())) throw invalid();
  const baseToken = token.trim();
  if (url && url.baseToken !== baseToken) throw invalid('链接与 Base Token 不一致。');
  return { baseToken, feishuUrl: url?.feishuUrl || null };
}
function normalizeConfig(input) {
  inputObject(input, [...CONFIG_KEYS, 'revision']);
  if (Object.hasOwn(input, 'revision')) revisionValue(input.revision);
  const base = baseInput(input);
  for (const key of ['productTableId', 'orderTableId']) {
    if (typeof input[key] !== 'string' || !TABLE_ID.test(input[key])) throw invalid('请选择有效的商品表和订单表。');
  }
  if (input.productTableId === input.orderTableId) throw invalid('商品表和订单表需要分别选择。');
  return { ...base, productTableId: input.productTableId, orderTableId: input.orderTableId };
}
function projectConfig(source = {}) {
  let feishuUrl = '';
  try { feishuUrl = officialBaseUrl(source.feishuUrl).feishuUrl; } catch {}
  return { feishuUrl, baseToken: TOKEN.test(source.baseToken || '') ? source.baseToken : '',
    productTableId: TABLE_ID.test(source.productTableId || '') ? source.productTableId : '',
    orderTableId: TABLE_ID.test(source.orderTableId || '') ? source.orderTableId : '' };
}
function schemaFields(result) {
  const fields = result?.fields || result?.table?.fields;
  if (!Array.isArray(fields)) throw new DomainError(503, 'FEISHU_CONFIG_RESPONSE_INVALID', '暂时无法确认飞书表结构，请稍后重试。');
  return fields;
}
function missingFields(fields, definitions) {
  const grouped = new Map();
  for (const field of fields) {
    const name = field?.name;
    if (typeof name !== 'string') continue;
    const list = grouped.get(name) || [];
    list.push(field); grouped.set(name, list);
  }
  const missing = [];
  for (const [name, type] of Object.entries(definitions)) {
    const matches = grouped.get(name) || [];
    if (!matches.length) { missing.push(name); continue; }
    if (matches.length !== 1) { missing.push(`${name}（字段名称重复）`); continue; }
    const field = matches[0];
    if (field.type !== type) { missing.push(`${name}（需 ${type} 类型）`); continue; }
    if (type === 'select') {
      if (field.multiple === true || field.dynamic_options_source) { missing.push(`${name}（需固定选项的单选字段）`); continue; }
      const options = new Set((field.options || []).map(option => typeof option === 'string' ? option : option?.name));
      const absent = OPTIONS[name].filter(option => !options.has(option));
      if (absent.length) missing.push(`${name}（缺少选项：${absent.join('、')}）`);
    }
  }
  return missing;
}
function safeName(value) { return typeof value === 'string' ? value.slice(0, 200) : ''; }
function fingerprint(source) {
  return createHash('sha256').update(JSON.stringify([source?.baseToken || '', source?.orderTableId || ''])).digest('hex').slice(0, 24);
}
function notChecked() { return { status: 'skipped', message: '尚未检查。' }; }
function storedCheck(value, config) {
  if (value?.status !== 'success' || !Number.isFinite(Date.parse(value.checkedAt))
    || CONFIG_KEYS.some(key => value.config?.[key] !== config[key])
    || ['base', 'products', 'orders'].some(key => value.checks?.[key]?.status !== 'success')) return null;
  // Rebuild the public projection rather than returning arbitrary persisted metadata.
  return { status: 'success', config, checkedAt: new Date(value.checkedAt).toISOString(),
    checks: { base: { status: 'success', message: '多维表格可读取。' },
      products: { status: 'success', message: '必需字段及类型检查通过。', missingFields: [] },
      orders: { status: 'success', message: '必需字段及类型检查通过。', missingFields: [] } },
    message: '连接与表结构检查通过；未验证写入权限。' };
}
function publicCheckError(error) {
  if (error instanceof DomainError) return { code: error.code, message: error.message };
  return { code: 'FEISHU_CONFIG_CHECK_FAILED', message: '无法读取飞书配置，请检查用户授权、表格访问权限或网络后重试。' };
}

export class FeishuConfigService {
  constructor({ store, larkCall = lark }) { Object.assign(this, { store, larkCall }); }

  get() {
    const config = projectConfig(this.store.getMeta('exportSource') || {});
    const lastCheck = storedCheck(this.store.getMeta(CHECK_KEY), config);
    return { config, revision: this.revision(),
      ...(lastCheck ? { lastCheck } : {}) };
  }
  revision() { return revisionValue(this.store.getMeta(REVISION_KEY) ?? 0); }

  async resolveBase(input) {
    const normalized = baseInput(input);
    if (normalized.feishuUrl) {
      const resolved = await this.larkCall(['base', '+url-resolve', '--url', normalized.feishuUrl]);
      if (resolved?.base_token !== normalized.baseToken || !['bitable', 'base'].includes(resolved?.resource_type)) {
        throw invalid('此链接未能解析为有效的多维表格。');
      }
    }
    const result = await this.larkCall(['base', '+base-get', '--base-token', normalized.baseToken]);
    const base = result?.base || result;
    if (!base || typeof base.name !== 'string' || base.base_token && base.base_token !== normalized.baseToken) {
      throw new DomainError(503, 'FEISHU_CONFIG_RESPONSE_INVALID', '暂时无法确认飞书多维表格，请稍后重试。');
    }
    let feishuUrl = normalized.feishuUrl || `https://www.feishu.cn/base/${normalized.baseToken}`;
    if (base.url) {
      const canonical = officialBaseUrl(base.url);
      if (canonical.baseToken !== normalized.baseToken) throw invalid('飞书返回的表格地址不一致。');
      feishuUrl = canonical.feishuUrl;
    }
    return { baseToken: normalized.baseToken, feishuUrl, name: safeName(base.name) };
  }

  async inspect(input) {
    inputObject(input, ['feishuUrl', 'baseToken']);
    // Validate before crossing the CLI boundary; never ask the CLI to resolve arbitrary URLs.
    baseInput(input);
    try {
      const base = await this.resolveBase(input);
      const tables = [];
      const ids = new Set();
      let offset = 0;
      let finished = false;
      for (let page = 0; page < 100; page += 1) {
        const result = await this.larkCall(['base', '+table-list', '--base-token', base.baseToken,
          '--limit', '100', '--offset', String(offset)]);
        const entries = result?.tables || result?.items;
        if (!Array.isArray(entries)) throw new DomainError(503, 'FEISHU_CONFIG_RESPONSE_INVALID', '暂时无法确认飞书表格目录，请稍后重试。');
        for (const entry of entries) {
          const type = entry?.type || entry?.block_type;
          if (!result.tables && !type) throw new DomainError(503, 'FEISHU_CONFIG_RESPONSE_INVALID', '无法确认飞书目录中的表格类型，请稍后重试。');
          if ((type && type !== 'table') || (!result.tables && type !== 'table')) continue;
          const id = entry.id || entry.table_id;
          if (!TABLE_ID.test(id || '') || ids.has(id)) throw new DomainError(503, 'FEISHU_CONFIG_RESPONSE_INVALID', '飞书表格目录不完整，请稍后重试。');
          ids.add(id); tables.push({ id, name: safeName(entry.name) });
        }
        offset += entries.length;
        const hasMore = result.has_more ?? result.hasMore;
        const total = result.total;
        if (hasMore === false || (Number.isSafeInteger(total) && total >= 0 && offset >= total)
          || (hasMore === undefined && !Number.isSafeInteger(total) && entries.length < 100)) { finished = true; break; }
        if (!entries.length) break;
      }
      if (!finished) throw new DomainError(503, 'FEISHU_CONFIG_RESPONSE_INVALID', '飞书表格目录读取未完成，请稍后重试。');
      const checked = [];
      // Bound concurrency: large directories must not fan out hundreds of CLI processes.
      for (let index = 0; index < tables.length; index += 4) {
        checked.push(...await Promise.all(tables.slice(index, index + 4).map(async table => {
          const result = await this.larkCall(['base', '+table-get', '--base-token', base.baseToken, '--table-id', table.id]);
          const fields = schemaFields(result);
          const missingProductFields = missingFields(fields, PRODUCT_SCHEMA);
          const missingOrderFields = missingFields(fields, ORDER_SCHEMA);
          return { ...table, productCompatible: !missingProductFields.length, orderCompatible: !missingOrderFields.length,
            missingProductFields, missingOrderFields };
        })));
      }
      return { base, tables: checked };
    } catch (error) {
      const safe = publicCheckError(error);
      throw new DomainError(error instanceof DomainError ? error.status : 503, safe.code, safe.message);
    }
  }

  async check(input) {
    const checkedAt = new Date().toISOString();
    const checks = { base: notChecked(), products: notChecked(), orders: notChecked() };
    let config = null;
    try {
      const normalized = normalizeConfig(input);
      config = { ...normalized, feishuUrl: normalized.feishuUrl || '' };
      const base = await this.resolveBase(normalized);
      config.feishuUrl = base.feishuUrl;
      checks.base = { status: 'success', message: '多维表格可读取。' };
      const results = await Promise.allSettled([
        this.larkCall(['base', '+table-get', '--base-token', config.baseToken, '--table-id', config.productTableId]),
        this.larkCall(['base', '+table-get', '--base-token', config.baseToken, '--table-id', config.orderTableId]),
      ]);
      for (const [index, key, definitions] of [[0, 'products', PRODUCT_SCHEMA], [1, 'orders', ORDER_SCHEMA]]) {
        const result = results[index];
        if (result.status !== 'fulfilled') { checks[key] = { status: 'error', message: '无法读取此表，请检查访问权限或表 ID。' }; continue; }
        try {
          const missing = missingFields(schemaFields(result.value), definitions);
          checks[key] = { status: missing.length ? 'error' : 'success',
            message: missing.length ? '表结构不兼容，请补齐字段或选择另一张表。' : '必需字段及类型检查通过。', missingFields: missing };
        } catch { checks[key] = { status: 'error', message: '暂时无法确认此表的结构，请稍后重试。' }; }
      }
      if ([checks.products, checks.orders].some(result => result.status !== 'success')) {
        return { status: 'error', code: 'FEISHU_CONFIG_SCHEMA_INVALID', config, checkedAt, checks, message: '商品表或订单表未通过检查，当前配置保留。' };
      }
      return { status: 'success', config, checkedAt, checks, message: '连接与表结构检查通过；未验证写入权限。' };
    } catch (error) {
      const safe = publicCheckError(error);
      if (checks.base.status !== 'success') checks.base = { status: 'error', message: safe.message };
      return { status: 'error', code: safe.code, config, checkedAt, checks, message: safe.message };
    }
  }

  exportMetadata(prefix = 'feishu-export:') {
    return this.store.db.prepare('SELECT key,value_json FROM meta WHERE key LIKE ?').all(`${prefix}%`).map(row => {
      try { return { key: row.key, value: JSON.parse(row.value_json) }; }
      catch { throw new DomainError(409, 'FEISHU_CONFIG_PENDING_EXPORT', '存在无法确认的订单同步状态，请先核查后再切换订单表。'); }
    });
  }
  assertNoPendingCreates(entries) {
    if (entries.some(entry => entry.value?.pendingCreates && Object.keys(entry.value.pendingCreates).length)) {
      throw new DomainError(409, 'FEISHU_CONFIG_PENDING_EXPORT', '存在尚未确认的飞书新增记录，请先完成订单同步核查，再切换订单表。');
    }
  }
  async save(input) {
    normalizeConfig(input);
    const expectedRevision = revisionValue(input.revision);
    if (expectedRevision !== this.revision()) throw new DomainError(409, 'FEISHU_CONFIG_REVISION_CONFLICT', '飞书配置已更新，请刷新后再保存。');
    const checked = await this.check(input);
    if (checked.status !== 'success') throw new DomainError(400, checked.code || 'FEISHU_CONFIG_CHECK_FAILED', checked.message, { checks: checked.checks });
    return this.store.transaction(() => {
      if (expectedRevision !== this.revision()) throw new DomainError(409, 'FEISHU_CONFIG_REVISION_CONFLICT', '飞书配置已更新，请刷新后再保存。');
      const oldSource = this.store.getMeta('exportSource') || {};
      const changedDestination = oldSource.baseToken !== checked.config.baseToken || oldSource.orderTableId !== checked.config.orderTableId;
      let markedPending = 0;
      if (changedDestination) {
        const entries = this.exportMetadata();
        this.assertNoPendingCreates(entries);
        this.assertNoPendingCreates(this.exportMetadata(`feishu-export-archive:${fingerprint(checked.config)}:`));
        const oldFingerprint = fingerprint(oldSource);
        for (const { key, value } of entries) {
          const code = key.slice('feishu-export:'.length);
          this.store.setMeta(`feishu-export-archive:${oldFingerprint}:${code}`, value);
          this.store.db.prepare('DELETE FROM meta WHERE key=?').run(key);
        }
        markedPending = this.store.db.prepare('SELECT count(*) AS total FROM order_lines').get().total;
        this.store.db.exec('UPDATE order_lines SET remote_record_id=NULL,synced_revision=0,export_error=NULL');
      }
      const revision = expectedRevision + 1;
      const source = { ...oldSource, ...checked.config };
      this.store.setMeta('exportSource', source);
      this.store.setMeta(REVISION_KEY, revision);
      this.store.setMeta(CHECK_KEY, checked);
      return { status: 'success', config: projectConfig(source), revision, changedDestination, markedPending };
    });
  }
}

export default FeishuConfigService;
