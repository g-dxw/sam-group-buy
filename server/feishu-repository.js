import { lark, readRecords, LarkError } from './lark.js';
import { loadConfig } from './config.js';

const PRODUCT_FIELDS = ['商品ID', '商品名称', '规格', '销售单位', '单价', '分类', '在售', '排序'];
const ORDER_FIELDS = ['明细编号', '提交编号', '手机号', '姓名', '商品ID', '数量', '备注', '处理状态', '提交时间', '同步状态', '预期明细数'];
const SETTINGS_FIELDS = ['本期标题', '说明', '收集中', '截单时间', '联系说明'];

export function priceCents(value) {
  if (value == null || !['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())
    || !Number.isFinite(Number(value))) throw new LarkError('商品单价未填写或格式不正确，请在飞书修正。', { code: 'CATALOG_PRICE_INVALID' });
  return Math.round(Number(value) * 100);
}

function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text ?? item?.name ?? '').join('');
  if (value && typeof value === 'object') return value.text ?? value.name ?? '';
  return value == null ? '' : String(value);
}
function date(value) {
  if (value == null || value === '') return null;
  const iso = new Date(value);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}
function orderRow(row) {
  const f = row.fields;
  return {
    recordId: row.record_id, lineId: text(f['明细编号']), submissionId: text(f['提交编号']),
    phone: text(f['手机号']), name: text(f['姓名']), productId: text(f['商品ID']),
    quantity: Number(f['数量']), note: text(f['备注']), status: text(f['处理状态']),
    syncStatus: text(f['同步状态']), expectedLines: Number(f['预期明细数']), submittedAt: date(f['提交时间']),
  };
}

export class FeishuRepository {
  async verifyOrderTable(batch) {
    await lark(['base', '+table-get', '--base-token', batch.baseToken, '--table-id', batch.orderTableId]);
  }

  async readProducts(batch) {
    const rows = await readRecords(batch.baseToken, batch.productTableId, PRODUCT_FIELDS);
    return rows.map(({ record_id, fields: f }) => ({
      recordId: record_id, id: text(f['商品ID']), name: text(f['商品名称']), spec: text(f['规格']),
      unit: text(f['销售单位']), priceCents: priceCents(f['单价']),
      category: text(f['分类']), onSale: f['在售'] === true, sort: Number(f['排序']) || 0,
    }));
  }

  async readSettings(batch) {
    const rows = await readRecords(batch.baseToken, batch.settingsTableId, SETTINGS_FIELDS);
    if (rows.length !== 1) throw new LarkError('一期设置需要保留且只保留一行', { code: 'SETTINGS_INVALID' });
    const f = rows[0].fields;
    const cutoffAt = date(f['截单时间']);
    if (f['截单时间'] != null && f['截单时间'] !== '' && cutoffAt === null) {
      throw new LarkError('截单时间格式不正确，请在飞书修正', { code: 'SETTINGS_INVALID' });
    }
    return { title: text(f['本期标题']), description: text(f['说明']), collecting: f['收集中'] === true,
      cutoffAt, contactNote: text(f['联系说明']) };
  }

  async readOrderLines(batch, { phone, submissionId } = {}) {
    const conditions = [];
    if (phone) conditions.push(['手机号', '==', phone]);
    if (submissionId) conditions.push(['提交编号', '==', submissionId]);
    const filter = conditions.length ? { logic: 'and', conditions } : undefined;
    const rows = await readRecords(batch.baseToken, batch.orderTableId, ORDER_FIELDS, filter);
    // Keep equality in the server too: text filters must never expose another phone's order.
    return rows.map(orderRow).filter(row => (!phone || row.phone === phone) && (!submissionId || row.submissionId === submissionId));
  }

  async createOrderLines(batch, lines) {
    if (!lines.length) return [];
    const all = [];
    for (let index = 0; index < lines.length; index += 200) {
      const chunk = lines.slice(index, index + 200);
      const create_records = chunk.map(line => ({
        '明细编号': line.lineId, '提交编号': line.submissionId, '手机号': line.phone, '姓名': line.name,
        '商品ID': line.productId, '数量': line.quantity, '备注': line.note || '',
        '处理状态': [line.status || '待采购'], '提交时间': line.submittedAt,
        '同步状态': ['待确认'], '预期明细数': line.expectedLines,
      }));
      try {
        const result = await lark(['base', '+record-batch-create', '--base-token', batch.baseToken,
          '--table-id', batch.orderTableId, '--json', JSON.stringify({ create_records })], { write: true });
        const ids = result?.record_id_list || result?.records?.map(row => row.record_id);
        if (!Array.isArray(ids) || ids.length !== chunk.length) {
          throw new LarkError('飞书新增响应未确认全部明细', { code: 'LARK_WRITE_INCOMPLETE', uncertain: true });
        }
        all.push(...chunk.map((line, i) => ({ ...line, recordId: ids[i], syncStatus: '待确认' })));
      } catch (error) {
        // A running/timed-out write is never safe to retry blindly; the service reconciles IDs first.
        error.outcome = error instanceof LarkError && error.uncertain === false ? 'settled' : 'unknown';
        if (error.outcome === 'unknown') error.uncertain = true;
        throw error;
      }
    }
    return all;
  }

  async confirmOrderLines(batch, recordIds) {
    for (let index = 0; index < recordIds.length; index += 200) {
      const update_records = Object.fromEntries(recordIds.slice(index, index + 200).map(id => [id, { '同步状态': ['已确认'] }]));
      try {
        await lark(['base', '+record-batch-update', '--base-token', batch.baseToken,
          '--table-id', batch.orderTableId, '--json', JSON.stringify({ update_records })], { write: true });
      } catch (error) {
        error.outcome = error instanceof LarkError && error.uncertain === false ? 'settled' : 'unknown';
        if (error.outcome === 'unknown') error.uncertain = true;
        throw error;
      }
    }
  }

  async health() {
    // This validates user authorization without returning identity or token contents.
    try {
      const config = await loadConfig();
      const batch = config.batches.find(item => item.code === config.defaultBatch) || config.batches[0];
      if (!batch) return { connected: false, identity: 'user', code: 'BATCH_NOT_CONFIGURED' };
      await lark(['base', '+base-get', '--base-token', batch.baseToken]);
      return { connected: true, identity: 'user' };
    } catch (error) {
      return { connected: false, identity: 'user', code: String(error.code || 'LARK_UNAVAILABLE') };
    }
  }
}

export default FeishuRepository;
