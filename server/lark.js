import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class LarkError extends Error {
  constructor(message, { code = 'LARK_UNAVAILABLE', resourceMissing = false, retryable = false, uncertain = false } = {}) {
    super(message);
    this.name = 'LarkError';
    Object.assign(this, { code, resourceMissing, retryable, uncertain });
  }
}

function parseEnvelope(value) {
  if (!value?.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

// Arguments are passed directly to the binary, never through a shell.
export async function lark(args, { timeout = 45000, write = false } = {}) {
  const argv = [...args, '--as', 'user', '--format', 'json'];
  let result;
  try {
    result = await execFileAsync(process.env.LARK_CLI_BIN || 'lark-cli', argv, {
      timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    });
  } catch (error) {
    const envelope = parseEnvelope(error.stderr) || parseEnvelope(error.stdout);
    const upstream = envelope?.error;
    const code = upstream?.code ?? upstream?.subtype ?? (error.killed ? 'LARK_TIMEOUT' : 'LARK_UNAVAILABLE');
    const message = upstream?.message || (error.killed ? '飞书请求超时' : '暂时无法连接飞书，请检查 lark-cli 用户授权');
    // Permission failures and ambiguous 404s must never be treated as deleted batches.
    // Official BaseTokenNotFound / TableIdNotFound; field/view/record failures are not closed batches.
    const explicitMissing = ['1254040', '1254041'].includes(String(code))
      || /^(?:BaseTokenNotFound|TableIdNotFound)$/.test(upstream?.subtype || message);
    const mapped = new LarkError(message, {
      code, resourceMissing: explicitMissing,
      retryable: error.killed || ['1254290', '1254291', '429', 'LARK_UNAVAILABLE'].includes(String(code)),
      uncertain: write && (error.killed || !upstream || /timeout|timed out|超时|internal|内部错误/i.test(message)),
    });
    mapped.operation = args.slice(0, 2).join(' ');
    throw mapped;
  }
  const envelope = parseEnvelope(result.stdout);
  if (envelope?.ok !== true) {
    throw new LarkError('飞书返回了无法确认的响应', { code: 'LARK_INVALID_RESPONSE', retryable: true, uncertain: write });
  }
  return envelope.data;
}

export async function readRecords(baseToken, tableId, fields = [], filter) {
  const result = [];
  let offset = 0;
  const limit = 200;
  for (let page = 0; page < 10000; page += 1) {
    const args = ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId,
      '--limit', String(limit), '--offset', String(offset)];
    for (const field of fields) args.push('--field-id', field);
    if (filter) args.push('--filter-json', JSON.stringify(filter));
    const data = await lark(args);
    const rows = normalizeRecords(data);
    result.push(...rows);
    const hasMore = data?.has_more ?? data?.hasMore;
    if (hasMore === false || (hasMore === undefined && rows.length < limit)) return result;
    if (!rows.length) throw new LarkError('飞书分页未返回记录，无法确认数据完整', { code: 'LARK_PAGINATION_INCOMPLETE' });
    offset += rows.length;
  }
  throw new LarkError('飞书记录过多，读取未完成', { code: 'LARK_PAGINATION_INCOMPLETE' });
}

export function normalizeRecords(data) {
  if (Array.isArray(data?.records)) return data.records.map(normalizeRecord);
  if (Array.isArray(data?.items)) return data.items.map(normalizeRecord);
  if (Array.isArray(data?.data) && Array.isArray(data?.record_id_list)) {
    if (!Array.isArray(data.fields) || data.data.length !== data.record_id_list.length || data.data.some(row => !Array.isArray(row) || row.length !== data.fields.length)) {
      throw new LarkError('飞书记录矩阵缺少列或记录ID，无法确认完整性', { code: 'LARK_INVALID_RESPONSE' });
    }
    return data.data.map((row, index) => ({
      record_id: data.record_id_list[index],
      fields: Object.fromEntries((data.fields || []).map((name, column) => [name, row[column]])),
    }));
  }
  // The current CLI +record-list returns columns + a row matrix.
  if (Array.isArray(data?.rows)) {
    const columns = (data.columns || data.fields || []).map(col => typeof col === 'string' ? col : (col.name || col.field_name || col.field_id));
    return data.rows.map(row => {
      if (!Array.isArray(row)) return normalizeRecord(row);
      const fields = Object.fromEntries(columns.map((name, index) => [name, row[index]]));
      const recordId = fields.record_id || fields['记录ID'] || fields._record_id;
      delete fields.record_id;
      return { record_id: recordId, fields };
    });
  }
  if (Array.isArray(data)) return data.map(normalizeRecord);
  throw new LarkError('飞书记录响应格式无法识别，无法确认数据完整', { code: 'LARK_INVALID_RESPONSE' });
}

function normalizeRecord(record) {
  if (record.fields) return { record_id: record.record_id || record.id, fields: record.fields };
  const { record_id, id, ...fields } = record;
  return { record_id: record_id || id, fields };
}
