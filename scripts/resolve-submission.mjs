import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { DATA_DIR, getBatch } from '../server/config.js';
import { Journal } from '../server/journal.js';
import { FeishuRepository } from '../server/feishu-repository.js';
import { acquireRuntimeLock } from '../server/runtime-lock.js';

const { values } = parseArgs({ options: {
  batch: { type: 'string' }, id: { type: 'string' },
  action: { type: 'string', default: 'inspect' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('先停止服务。用法：npm run resolve:submission -- --batch demo-20261012 --id 提交UUID [--action inspect|abandon]。inspect核查；abandon仅放弃尚未进入确认阶段的提交并解除队头，飞书未确认行保留且不计入采购。');
  process.exit(0);
}
let journal;
let release;
try {
  if (!values.batch || !values.id || !['inspect', 'abandon'].includes(values.action)) throw new Error('需要 --batch、--id 和有效 --action。');
  release = await acquireRuntimeLock(DATA_DIR);
  journal = new Journal({ path: resolve(DATA_DIR, 'submissions.sqlite') });
  const batch = await getBatch(values.batch);
  const entry = journal.get(batch.code, values.id.toLowerCase());
  if (!entry) throw new Error('本地未找到此提交。');
  const rows = await new FeishuRepository().readOrderLines(batch, { submissionId: entry.submissionId });
  const report = { submissionId: entry.submissionId, status: entry.status, phase: entry.phase,
    expectedLines: entry.payload.items.length, remoteLines: rows.length,
    rows: rows.map(row => ({ lineId: row.lineId, productId: row.productId, quantity: row.quantity,
      status: row.status, syncStatus: row.syncStatus })) };
  if (values.action === 'abandon') {
    if (['completed', 'failed'].includes(entry.status)) throw new Error('提交已经是终态，不需要放弃。');
    if (!['ready', 'creating', 'reconciling-create'].includes(entry.phase)
      || rows.some(row => row.syncStatus === '已确认')) {
      throw new Error('已进入确认阶段或存在已确认行，禁止放弃；请恢复服务继续对账，并在飞书核查状态。');
    }
    journal.update(batch.code, entry.submissionId, { status: 'failed', phase: 'abandoned', nextCheckAt: 0,
      error: { code: 'SUBMISSION_ABANDONED', message: '负责人已核查并放弃本次未确认提交，请联系负责人后重新下单。' } });
    report.status = 'failed';
    report.phase = 'abandoned';
    report.action = '未确认数据保留且不计入采购；恢复服务后后续提交继续处理。';
  }
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: error.message }, null, 2));
  process.exitCode = 1;
} finally { journal?.close(); release?.(); }
