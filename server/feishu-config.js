import { createHash } from 'node:crypto';
import { lark } from './lark.js';
import { DomainError } from './order-service.js';
import { EXPORT_FIELDS, ORDER_FEE_SCHEMA, ORDER_SPLIT_SCHEMA, PRODUCT_SCHEMA, PRODUCT_BACKUP_SCHEMA, productDestination, productBackupArchiveKey } from './feishu-sync.js';

const REVISION_KEY = 'feishu-config-revision';
const CHECK_KEY = 'feishu-config-last-check';
const CONFIG_KEYS = ['feishuUrl', 'baseToken', 'productTableId', 'orderTableId'];
const TOKEN = /^[A-Za-z0-9]{10,128}$/;
const TABLE_ID = /^tbl[A-Za-z0-9]{3,125}$/;
const PRODUCT_EXTRA_SCHEMA = Object.fromEntries(Object.entries(PRODUCT_BACKUP_SCHEMA).filter(([name]) => !Object.hasOwn(PRODUCT_SCHEMA, name)));
const BACKUP_MESSAGE = '本地商品库为主数据；手动备份会新增或更新全部保留商品记录，并补齐图片、来源、版本、定价规则和移除时间字段；单价保存最终售价，定价规则保存参考原价与加价设置（固定加价金额或比例，兼容旧固定售价）。已移除商品保留下架备份，恢复后清空移除时间。连接检查未验证写入权限。';
const FEE_COMPATIBILITY_MESSAGE = '此订单表仅支持零费订单备份；有代购费或非零费率时，请先手动补齐收费字段。本地订单会正常保存。';
const SPLIT_COMPATIBILITY_MESSAGE = '备份拼份订单前，请手动添加唯一的 text 字段「同步拼份信息」，保存拆分规则和成团分配。本地订单会正常保存。';
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
function productSchemaCheck(fields) {
  const presentExtras = Object.fromEntries(Object.entries(PRODUCT_EXTRA_SCHEMA).filter(([name]) => fields.some(field => field.name === name)));
  return { missingFields: missingFields(fields, { ...PRODUCT_SCHEMA, ...presentExtras }),
    fieldsToCreate: Object.keys(PRODUCT_EXTRA_SCHEMA).filter(name => !fields.some(field => field.name === name)) };
}
function orderSchemaCheck(fields) {
  const presentFeeSchema = Object.fromEntries(Object.entries(ORDER_FEE_SCHEMA).filter(([name]) => fields.some(field => field.name === name)));
  const feeErrors = missingFields(fields, presentFeeSchema);
  const missingFeeFields = missingFields(fields, ORDER_FEE_SCHEMA);
  const presentSplitSchema = Object.fromEntries(Object.entries(ORDER_SPLIT_SCHEMA).filter(([name]) => fields.some(field => field.name === name)));
  const splitErrors = missingFields(fields, presentSplitSchema);
  const missingSplitFields = missingFields(fields, ORDER_SPLIT_SCHEMA);
  return { missingFields: [...missingFields(fields, ORDER_SCHEMA), ...feeErrors, ...splitErrors], missingFeeFields,
    feeCompatible: !missingFeeFields.length, missingSplitFields, splitCompatible: !missingSplitFields.length };
}
function storedFeeCheck(value) {
  const missingFeeFields = (Array.isArray(value?.missingFeeFields) ? value.missingFeeFields : Object.keys(ORDER_FEE_SCHEMA))
    .filter(name => Object.hasOwn(ORDER_FEE_SCHEMA, name));
  return { feeCompatible: value?.feeCompatible === true && !missingFeeFields.length, missingFeeFields };
}
function storedSplitCheck(value) {
  const missingSplitFields = (Array.isArray(value?.missingSplitFields) ? value.missingSplitFields : Object.keys(ORDER_SPLIT_SCHEMA))
    .filter(name => Object.hasOwn(ORDER_SPLIT_SCHEMA, name));
  return { splitCompatible: value?.splitCompatible === true && !missingSplitFields.length, missingSplitFields };
}
function orderCompatibilityMessage(value) {
  return ['必需字段及类型检查通过。', value.feeCompatible ? '' : FEE_COMPATIBILITY_MESSAGE,
    value.splitCompatible ? '' : SPLIT_COMPATIBILITY_MESSAGE].join('');
}
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
      products: { status: 'success', message: '商品备份目标的必需字段及类型检查通过。', missingFields: [],
        fieldsToCreate: (value.checks.products.fieldsToCreate || []).filter(name => Object.hasOwn(PRODUCT_EXTRA_SCHEMA, name)) },
      orders: { status: 'success', message: orderCompatibilityMessage({ ...storedFeeCheck(value.checks.orders), ...storedSplitCheck(value.checks.orders) }),
        missingFields: [], ...storedFeeCheck(value.checks.orders), ...storedSplitCheck(value.checks.orders) } },
    writeMode: 'manual_one_way_backup', message: BACKUP_MESSAGE };
}
function publicCheckError(error) {
  if (error instanceof DomainError) return { code: error.code, message: error.message };
  return { code: 'FEISHU_CONFIG_CHECK_FAILED', message: '无法读取飞书配置，请检查用户授权、表格访问权限或网络后重试。' };
}

export class FeishuConfigService {
  constructor({ store, larkCall = lark }) { Object.assign(this, { store, larkCall }); }

  get() {
    const source = this.store.getMeta('exportSource') || {};
    const config = projectConfig(source);
    const lastCheck = storedCheck(this.store.getMeta(CHECK_KEY), config);
    return { config, revision: this.revision(), writeMode: 'manual_one_way_backup',
      orderScope: source.orderScope === 'shared' ? 'shared' : 'community',
      groupTablesCreatedAutomatically: source.orderScope !== 'shared',
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
          const productCheck = productSchemaCheck(fields);
          const missingProductFields = productCheck.missingFields;
          const orderCheck = orderSchemaCheck(fields);
          const missingOrderFields = orderCheck.missingFields;
          return { ...table, productCompatible: !missingProductFields.length, orderCompatible: !missingOrderFields.length,
            missingProductFields, missingOrderFields, productBackupFieldsToCreate: productCheck.fieldsToCreate,
            feeCompatible: orderCheck.feeCompatible, missingFeeFields: orderCheck.missingFeeFields,
            splitCompatible: orderCheck.splitCompatible, missingSplitFields: orderCheck.missingSplitFields };
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
          const fields = schemaFields(result.value);
          const productCheck = key === 'products' ? productSchemaCheck(fields) : null;
          const orderCheck = key === 'orders' ? orderSchemaCheck(fields) : null;
          const missing = productCheck?.missingFields || orderCheck?.missingFields || missingFields(fields, definitions);
          checks[key] = { status: missing.length ? 'error' : 'success',
            message: missing.length ? '表结构不兼容，请补齐字段或选择另一张表。' : key === 'products'
              ? '商品备份目标检查通过；首次备份会补齐缺少的备份字段。' : orderCompatibilityMessage(orderCheck),
            missingFields: missing, ...(productCheck ? { fieldsToCreate: productCheck.fieldsToCreate } : {}),
            ...(orderCheck ? { feeCompatible: orderCheck.feeCompatible, missingFeeFields: orderCheck.missingFeeFields,
              splitCompatible: orderCheck.splitCompatible, missingSplitFields: orderCheck.missingSplitFields } : {}) };
        } catch { checks[key] = { status: 'error', message: '暂时无法确认此表的结构，请稍后重试。' }; }
      }
      if ([checks.products, checks.orders].some(result => result.status !== 'success')) {
        return { status: 'error', code: 'FEISHU_CONFIG_SCHEMA_INVALID', config, checkedAt, checks, message: '商品备份表或订单导出表未通过检查，当前配置保留。' };
      }
      return { status: 'success', config, checkedAt, checks, writeMode: 'manual_one_way_backup', message: BACKUP_MESSAGE };
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
  pinLegacyDestinations(source) {
    if (!source.baseToken || !source.orderTableId) return;
    const entries = new Map(this.exportMetadata().map(({ key, value }) => [key, value]));
    for (const row of this.store.db.prepare('SELECT DISTINCT batch_code FROM order_lines WHERE remote_record_id IS NOT NULL').all()) {
      const key = `feishu-export:${row.batch_code}`;
      if (!entries.has(key)) entries.set(key, {});
    }
    for (const [key, meta] of entries) {
      if (meta.destination) continue;
      this.store.setMeta(key, { ...meta, destination: { baseToken: source.baseToken, orderTableId: source.orderTableId },
        scope: 'legacy', tableName: '历史订单表', feishuUrl: source.feishuUrl || null });
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
      const historicalOrderTableChanged = oldSource.orderTableId !== checked.config.orderTableId;
      const changedDestination = oldSource.baseToken !== checked.config.baseToken
        || oldSource.orderScope === 'shared' && historicalOrderTableChanged;
      const changedProductDestination = productDestination(oldSource) !== productDestination(checked.config);
      let markedPending = 0;
      if (changedDestination) {
        const entries = this.exportMetadata();
        this.assertNoPendingCreates(entries);
        this.assertNoPendingCreates(this.exportMetadata(`feishu-export-archive:${fingerprint(checked.config)}:`));
        markedPending = this.store.db.prepare('SELECT count(*) AS total FROM order_lines').get().total;
      }
      // Keep the exact old destination until that period is explicitly synced.
      // Changing the reference table must never reassign another group's records.
      this.pinLegacyDestinations(oldSource);
      const revision = expectedRevision + 1;
      const source = { ...oldSource, ...checked.config, orderScope: oldSource.orderScope === 'shared' ? 'shared' : 'community' };
      let productsMarkedPending = 0;
      if (changedProductDestination) {
        const previous = this.store.getMeta('feishu-product-backup');
        if (previous?.destination) this.store.setMeta(productBackupArchiveKey(previous.destination), previous);
        const destination = productDestination(source);
        const archived = this.store.getMeta(productBackupArchiveKey(destination));
        // Preserve unresolved creates when returning to a target; they must be reconciled before any retry.
        const records = Object.fromEntries(Object.entries(archived?.records || {}).map(([id, record]) => [id, { ...record, revision: 0 }]));
        productsMarkedPending = this.store.listProducts({ includeRemoved: true }).length;
        this.store.setMeta('feishu-product-backup', { destination, records, status: 'pending',
          counts: { created: 0, updated: 0, unchanged: 0, total: productsMarkedPending, backedUp: 0, pending: productsMarkedPending },
          pending: productsMarkedPending, lastSyncedAt: archived?.lastSyncedAt || null, error: null });
      }
      this.store.setMeta('exportSource', source);
      this.store.setMeta(REVISION_KEY, revision);
      this.store.setMeta(CHECK_KEY, checked);
      return { status: 'success', config: projectConfig(source), revision, changedDestination, markedPending, historicalOrderTableChanged,
        orderScope: source.orderScope, groupTablesCreatedAutomatically: source.orderScope === 'community',
        changedProductDestination, productsMarkedPending, writeMode: 'manual_one_way_backup' };
    });
  }
}

export default FeishuConfigService;
