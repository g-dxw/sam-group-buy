import { randomUUID } from 'node:crypto';
import { FeishuRepository } from './feishu-repository.js';
import { lark, readRecords, normalizeRecords } from './lark.js';

const locks = new WeakMap();
const PRODUCT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;
const STATUSES = ['待采购', '已买到', '缺货', '已领取', '已取消'];
export const EXPORT_FIELDS = ['明细编号', '提交编号', '团购ID', '小区/群名称', '期次', '手机号', '姓名', '商品ID', '数量', '备注', '处理状态', '提交时间', '同步状态', '预期明细数', '同步商品名称', '同步规格', '同步销售单位', '同步单价', '同步金额', '数据版本'];
const NUMBER_FIELDS = new Set(['数量', '预期明细数', '同步单价', '同步金额', '数据版本']);
class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function text(value) {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text ?? item?.name ?? '').join('');
  return value == null ? '' : String(value);
}
function timestamp(value) {
  if (typeof value === 'string' && /^\d{12,}$/.test(value)) value = Number(value);
  return new Date(value).getTime();
}
function same(row, desired, confirmed = false) {
  if (!row) return false;
  for (const [key, value] of Object.entries(desired)) {
    if (key === '同步状态') continue;
    const actual = row.fields[key];
    if (NUMBER_FIELDS.has(key) ? Number(actual) !== value : key === '提交时间' ? timestamp(actual) !== timestamp(value) : text(actual) !== text(value)) return false;
  }
  return !confirmed || text(row.fields['同步状态']) === '已确认';
}
const chunked = (items, size = 200) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export class FeishuSync {
  constructor({ store, sourceConfig, repository = new FeishuRepository(), larkCall = lark, readRecordsCall = readRecords, backoffMs = [500, 1500, 3000, 5000], createBatchViews = true }) {
    Object.assign(this, { store, sourceConfig, repository, larkCall, readRecordsCall, backoffMs, createBatchViews });
    if (!locks.has(store)) locks.set(store, new Map());
    this.locks = locks.get(store);
  }
  singleFlight(key, work) {
    if (this.locks.has(key)) return this.locks.get(key);
    const job = Promise.resolve().then(work).finally(() => this.locks.delete(key));
    this.locks.set(key, job);
    return job;
  }
  source() {
    const source = this.sourceConfig || this.store.getMeta('exportSource');
    if (!source?.baseToken || !source.productTableId || !source.orderTableId) throw new SyncError('SOURCE_NOT_CONFIGURED', '尚未配置飞书商品源和订单导出表。');
    return source;
  }
  syncProducts() {
    return this.singleFlight('products', async () => {
      const old = this.store.getMeta('feishu-products') || {};
      try {
        const source = this.source();
        const products = await this.repository.readProducts(source);
        if (!Array.isArray(products)) throw new SyncError('PRODUCTS_INVALID', '飞书商品读取未完成，保留当前商品库。');
        const ids = new Set();
        for (const product of products) {
          if (!PRODUCT_ID.test(product.id || '') || ids.has(product.id) || !product.name?.trim() || !product.spec?.trim() || !product.unit?.trim()
            || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0 || product.priceCents > 100_000_000 || typeof product.onSale !== 'boolean') {
            throw new SyncError('PRODUCTS_INVALID', '飞书商品有重复编号、缺少资料或价格不合法；本地商品库未更新。');
          }
          ids.add(product.id);
        }
        const lastSyncedAt = new Date().toISOString();
        const imported = this.store.importProducts(products, { source, lastSyncedAt });
        const counts = imported?.counts || imported || {};
        const result = { status: 'success', counts: { added: counts.added || 0, updated: counts.updated || 0,
          offSale: counts.offSale ?? counts.offline ?? counts.disabled ?? 0, total: products.length }, lastSyncedAt, error: null };
        this.store.setMeta('feishu-products', result);
        return result;
      } catch (error) {
        const result = { status: 'error', counts: { added: 0, updated: 0, offSale: 0, total: 0 }, lastSyncedAt: old.lastSyncedAt || null,
          error: { code: String(error.code || 'PRODUCT_SYNC_FAILED'), message: error instanceof SyncError ? error.message : '同步商品失败，请检查飞书授权或稍后重试；本地商品库保留。' } };
        this.store.setMeta('feishu-products', result);
        return result;
      }
    });
  }
  syncOrders(code) { return this.singleFlight(`orders:${code}`, () => this.exportOrders(code)); }

  fields(batch, line) {
    const product = line.product || {};
    const priceCents = line.priceCents ?? product.priceCents;
    const amountCents = line.amountCents ?? (['已取消', '缺货'].includes(line.status) ? 0 : priceCents * line.quantity);
    return { '明细编号': line.lineId, '提交编号': line.submissionId, '团购ID': batch.code,
      '小区/群名称': batch.communityName || line.communityName, '期次': batch.periodLabel || line.periodLabel || `第${batch.periodNumber}期`,
      '手机号': line.phone, '姓名': line.name, '商品ID': line.productId, '数量': line.quantity, '备注': line.note || '',
      '处理状态': [line.status], '提交时间': line.submittedAt, '同步状态': ['待确认'], '预期明细数': line.expectedLines,
      '同步商品名称': line.productName ?? product.name, '同步规格': line.spec ?? product.spec,
      '同步销售单位': line.unit ?? product.unit, '同步单价': priceCents / 100, '同步金额': amountCents / 100,
      '数据版本': line.revision ?? line.version };
  }
  validateSnapshot(batch, lines) {
    const ids = new Set();
    const groups = new Map();
    for (const line of lines) {
      const desired = this.fields(batch, line);
      if (!line.lineId || ids.has(line.lineId) || !line.submissionId || !PRODUCT_ID.test(line.productId || '')
        || line.batchCode && line.batchCode !== batch.code || !Number.isSafeInteger(line.quantity) || line.quantity < 0
        || !STATUSES.includes(line.status) || !Number.isSafeInteger(desired['数据版本']) || desired['数据版本'] < 1
        || !Number.isSafeInteger(line.expectedLines) || line.expectedLines < 1 || !Number.isFinite(timestamp(line.submittedAt))
        || ['同步商品名称', '同步规格', '同步销售单位', '小区/群名称', '期次', '手机号', '姓名'].some(field => typeof desired[field] !== 'string' || !desired[field].trim())
        || !Number.isFinite(desired['同步单价']) || desired['同步单价'] < 0 || !Number.isFinite(desired['同步金额']) || desired['同步金额'] < 0) {
        throw new SyncError('LOCAL_EXPORT_INVALID', '本地订单资料不完整，未写入飞书。');
      }
      ids.add(line.lineId);
      const group = groups.get(line.submissionId) || [];
      group.push(line); groups.set(line.submissionId, group);
    }
    for (const group of groups.values()) if (group.some(line => line.expectedLines !== group.length)) throw new SyncError('LOCAL_EXPORT_INCOMPLETE', '本地整单明细不完整，未写入飞书。');
    return groups;
  }
  async verifySchema(source) {
    const result = await this.larkCall(['base', '+table-get', '--base-token', source.baseToken, '--table-id', source.orderTableId]);
    const fields = new Set((result.fields || result.table?.fields || []).map(field => field.name));
    if (EXPORT_FIELDS.some(field => !fields.has(field))) throw new SyncError('EXPORT_SCHEMA_MISSING', '订单导出表缺少同步字段，请先运行 setup:admin。');
  }
  async remoteRows(source, batch, lines) {
    const found = new Map();
    const chunks = chunked(lines, 199);
    if (!chunks.length) chunks.push([]);
    for (const group of chunks) {
      const filter = { logic: 'or', conditions: [['团购ID', '==', batch.code], ...group.map(line => ['明细编号', '==', line.lineId])] };
      const rows = await this.readRecordsCall(source.baseToken, source.orderTableId, EXPORT_FIELDS, filter);
      for (const row of rows) if (text(row.fields['团购ID']) === batch.code || group.some(line => text(row.fields['明细编号']) === line.lineId)) found.set(row.record_id, row);
    }
    // A persisted remote ID is a hint only; verify its actual line/batch before writing it.
    const storedIds = lines.map(line => line.remoteRecordId).filter(id => id && !found.has(id));
    for (const ids of chunked([...new Set(storedIds)])) {
      const args = ['base', '+record-get', '--base-token', source.baseToken, '--table-id', source.orderTableId];
      for (const id of ids) args.push('--record-id', id);
      for (const field of EXPORT_FIELDS) args.push('--field-id', field);
      const raw = await this.larkCall(args);
      for (const row of normalizeRecords(raw)) found.set(row.record_id, row);
    }
    return [...found.values()];
  }
  indexRemote(batch, lines, rows) {
    const index = new Map();
    const local = new Map(lines.map(line => [line.lineId, line]));
    for (const row of rows) {
      const lineId = text(row.fields['明细编号']);
      if (!local.has(lineId)) continue;
      if (text(row.fields['团购ID']) !== batch.code || text(row.fields['提交编号']) !== local.get(lineId).submissionId || text(row.fields['商品ID']) !== local.get(lineId).productId) {
        throw new SyncError('REMOTE_ID_CONFLICT', '飞书已有同明细编号但归属不一致，停止同步以免覆盖其他团购。');
      }
      if (index.has(lineId) && index.get(lineId).record_id !== row.record_id) throw new SyncError('REMOTE_DUPLICATE', '飞书存在重复明细编号，请先核查，未追加订单。');
      index.set(lineId, row);
    }
    for (const line of lines) if (line.remoteRecordId) {
      const bound = rows.find(row => row.record_id === line.remoteRecordId);
      if (bound && (text(bound.fields['明细编号']) !== line.lineId || text(bound.fields['团购ID']) !== batch.code)) throw new SyncError('REMOTE_ID_CONFLICT', '远端记录ID已属于其他订单，停止同步。');
      if (!bound && !index.has(line.lineId)) throw new SyncError('REMOTE_BOUND_RECORD_MISSING', '已同步记录在飞书暂时不可见或已删除，请核查后重试。');
    }
    const submissions = new Map(lines.map(line => [line.submissionId, line.expectedLines]));
    for (const [submissionId, expected] of submissions) {
      const remote = rows.filter(row => text(row.fields['团购ID']) === batch.code && text(row.fields['提交编号']) === submissionId);
      if (remote.length > expected || remote.some(row => !local.has(text(row.fields['明细编号'])))) throw new SyncError('REMOTE_SUBMISSION_CONFLICT', '飞书整单存在本地没有的明细，停止同步。');
    }
    return index;
  }
  async poll(source, batch, lines, valid) {
    let latest;
    for (let attempt = 0; attempt <= this.backoffMs.length; attempt += 1) {
      latest = this.indexRemote(batch, lines, await this.remoteRows(source, batch, lines));
      if (valid(latest)) return { index: latest, complete: true };
      if (attempt < this.backoffMs.length) await new Promise(resolve => setTimeout(resolve, this.backoffMs[attempt]));
    }
    return { index: latest, complete: false };
  }
  async update(source, entries) {
    for (const group of chunked(entries)) await this.larkCall(['base', '+record-batch-update', '--base-token', source.baseToken,
      '--table-id', source.orderTableId, '--json', JSON.stringify({ update_records: Object.fromEntries(group) })], { write: true });
  }
  async batchView(source, batch) {
    if (!this.createBatchViews) return null;
    const viewName = `${batch.communityName} ${batch.periodLabel || `第${batch.periodNumber}期`} · ${batch.code}`.slice(0, 100);
    const listArgs = ['base', '+view-list', '--base-token', source.baseToken, '--table-id', source.orderTableId];
    let result = await this.larkCall(listArgs);
    let view = (result.views || result.items || []).find(item => item.name === viewName);
    if (!view) {
      await this.larkCall(['base', '+view-create', '--base-token', source.baseToken, '--table-id', source.orderTableId,
        '--json', JSON.stringify({ name: viewName, type: 'grid' })], { write: true });
      result = await this.larkCall(listArgs);
      view = (result.views || result.items || []).find(item => item.name === viewName);
    }
    if (!view) return null;
    const id = view.id || view.view_id;
    await this.larkCall(['base', '+view-set-filter', '--base-token', source.baseToken, '--table-id', source.orderTableId,
      '--view-id', id, '--json', JSON.stringify({ logic: 'and', conditions: [['团购ID', '==', batch.code], ['同步状态', 'intersects', ['已确认']], ['处理状态', 'disjoint', ['已取消', '缺货']], ['数量', '>', 0]] })], { write: true });
    await this.larkCall(['base', '+view-set-visible-fields', '--base-token', source.baseToken, '--table-id', source.orderTableId,
      '--view-id', id, '--json', JSON.stringify({ visible_fields: ['小区/群名称', '期次', '手机号', '姓名', '同步商品名称', '同步规格', '同步销售单位', '数量', '同步单价', '同步金额', '处理状态', '备注', '提交时间'] })], { write: true });
    if (!source.feishuUrl) return null;
    const url = new URL(source.feishuUrl); url.searchParams.set('table', source.orderTableId); url.searchParams.set('view', id);
    return url.toString();
  }
  async exportOrders(code) {
    const key = `feishu-export:${code}`;
    const meta = this.store.getMeta(key) || {};
    meta.pendingCreates ||= {};
    const counts = { created: 0, updated: 0, unchanged: 0, pending: 0 };
    const save = () => this.store.setMeta(key, meta);
    let lines = [];
    const finish = (status, error = null) => {
      if (this.store.getBatch(code)) lines = this.store.listExportLines(code, { onlyDirty: false });
      counts.pending = lines.filter(line => Number(line.revision ?? line.version) > Number(line.syncedRevision ?? line.syncedVersion ?? 0)).length;
      const result = { status, counts, pending: counts.pending, lastSyncedAt: meta.lastSyncedAt || null, error, viewUrl: meta.viewUrl || null };
      Object.assign(meta, result); save(); return result;
    };
    try {
      const source = this.source();
      const batch = this.store.getBatch(code);
      if (!batch) throw new SyncError('BATCH_NOT_FOUND', '本期团购不存在。');
      lines = this.store.listExportLines(code, { onlyDirty: false });
      this.validateSnapshot(batch, lines);
      await this.verifySchema(source);
      const desired = new Map(lines.map(line => [line.lineId, this.fields(batch, line)]));
      let index = this.indexRemote(batch, lines, await this.remoteRows(source, batch, lines));
      for (const line of lines) if (index.has(line.lineId)) delete meta.pendingCreates[line.lineId];
      save();
      const unresolved = lines.filter(line => !index.has(line.lineId) && meta.pendingCreates[line.lineId]?.outcome !== 'settled' && meta.pendingCreates[line.lineId]);
      if (unresolved.length) {
        const checked = await this.poll(source, batch, lines, rows => unresolved.every(line => rows.has(line.lineId)));
        index = checked.index;
        for (const line of unresolved) if (index.has(line.lineId)) delete meta.pendingCreates[line.lineId];
        save();
        if (!checked.complete) return finish('pending', { code: 'REMOTE_WRITE_PENDING', message: '上次新增结果尚未确认；再次同步会先对账，避免重复追加。' });
      }
      for (const group of chunked(lines.filter(line => !index.has(line.lineId)))) {
        const attemptId = randomUUID();
        for (const line of group) meta.pendingCreates[line.lineId] = { attemptId, revision: line.revision ?? line.version, outcome: 'unknown', startedAt: new Date().toISOString() };
        save(); // Persist BEFORE the network request: process death cannot permit a blind retry.
        let created;
        try {
          created = await this.larkCall(['base', '+record-batch-create', '--base-token', source.baseToken, '--table-id', source.orderTableId,
            '--json', JSON.stringify({ create_records: group.map(line => desired.get(line.lineId)) })], { write: true });
        } catch (error) {
          const settled = error.outcome === 'settled' || error.uncertain === false;
          for (const line of group) meta.pendingCreates[line.lineId].outcome = settled ? 'settled' : 'unknown';
          save(); throw error;
        }
        const ids = created?.record_id_list || created?.records?.map(row => row.record_id);
        if (!Array.isArray(ids) || ids.length !== group.length || new Set(ids).size !== ids.length) {
          throw new SyncError('REMOTE_WRITE_UNCONFIRMED', '飞书没有返回全部新增记录ID；保留待确认状态，避免重复追加。');
        }
        group.forEach((line, i) => { meta.pendingCreates[line.lineId].ackRecordId = ids[i]; });
        counts.created += group.length; save();
      }
      let checked = await this.poll(source, batch, lines, rows => lines.every(line => rows.has(line.lineId)));
      index = checked.index;
      if (!checked.complete) return finish('pending', { code: 'REMOTE_WRITE_PENDING', message: '明细已提交，等待飞书完整可见；本地订单不受影响。' });
      for (const line of lines) delete meta.pendingCreates[line.lineId];
      save();
      const changedSubmissions = new Set(lines.filter(line => !same(index.get(line.lineId), desired.get(line.lineId), true)).map(line => line.submissionId));
      const updates = [];
      for (const line of lines) {
        const row = index.get(line.lineId);
        const value = desired.get(line.lineId);
        if (!same(row, value)) counts.updated += 1;
        else if (!changedSubmissions.has(line.submissionId)) counts.unchanged += 1;
        if (changedSubmissions.has(line.submissionId) && (!same(row, value) || text(row.fields['同步状态']) !== '待确认')) updates.push([row.record_id, value]);
      }
      await this.update(source, updates);
      checked = await this.poll(source, batch, lines, rows => lines.every(line => same(rows.get(line.lineId), desired.get(line.lineId))));
      if (!checked.complete) return finish('pending', { code: 'REMOTE_UPDATE_PENDING', message: '订单更新等待飞书确认，请稍后再次同步。' });
      index = checked.index;
      await this.update(source, lines.filter(line => text(index.get(line.lineId).fields['同步状态']) !== '已确认')
        .map(line => [index.get(line.lineId).record_id, { '同步状态': ['已确认'] }]));
      checked = await this.poll(source, batch, lines, rows => lines.every(line => same(rows.get(line.lineId), desired.get(line.lineId), true)));
      if (!checked.complete) return finish('pending', { code: 'REMOTE_CONFIRM_PENDING', message: '飞书整单确认仍在处理中，请稍后再次同步。' });
      for (const line of lines) this.store.markExported(code, line.lineId, line.revision ?? line.version, checked.index.get(line.lineId).record_id);
      meta.lastSyncedAt = new Date().toISOString(); meta.error = null;
      try { meta.viewUrl = await this.batchView(source, batch) || meta.viewUrl || null; } catch { /* View creation is optional; it never invalidates confirmed data. */ }
      lines = this.store.listExportLines(code, { onlyDirty: false });
      return finish(lines.some(line => Number(line.revision ?? line.version) > Number(line.syncedRevision ?? line.syncedVersion ?? 0)) ? 'pending' : 'success');
    } catch (error) {
      const message = error instanceof SyncError ? error.message : '同步订单失败，请检查飞书授权或稍后重试；本地订单保留。';
      for (const line of lines) this.store.markExportError?.(code, line.lineId, message);
      return finish('error', { code: String(error.code || 'ORDER_SYNC_FAILED'), message });
    }
  }
}
export default FeishuSync;
