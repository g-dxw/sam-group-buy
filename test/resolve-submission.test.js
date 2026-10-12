import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Journal } from '../server/journal.js';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/resolve-submission.mjs');
async function fixture(t, { phase = 'reconciling-create', confirmed = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sam-resolve-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID();
  await writeFile(join(directory, 'batches.json'), JSON.stringify({ defaultBatch: 'test', batches: [{ code: 'test', baseToken: 'fixture', orderTableId: 'fixture' }] }));
  const binary = join(directory, 'fake-lark.mjs');
  await writeFile(binary, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,data:{records:${JSON.stringify(confirmed ? [{ record_id: 'r', fields: { 提交编号: id, 明细编号: `${id}:P1`, 商品ID: 'P1', 同步状态: ['已确认'], 数量: 1, 处理状态: ['待采购'] } }] : [])},has_more:false}}));\n`, { mode: 0o700 });
  const journal = new Journal({ path: join(directory, 'submissions.sqlite') });
  journal.insert({ batchCode: 'test', submissionId: id, payloadHash: 'fixture', status: 'reconciling', phase,
    createSettled: false, payload: { phone: '13800000000', items: [{ productId: 'P1', quantity: 1, version: '0'.repeat(64) }] }, submittedAt: new Date().toISOString(), createdAt: Date.now() });
  journal.close();
  const run = () => exec(process.execPath, [script, '--batch', 'test', '--id', id, '--action', 'abandon'], { env: { ...process.env, DATA_DIR: directory, LARK_CLI_BIN: binary } });
  const read = () => { const database = new Journal({ path: join(directory, 'submissions.sqlite') }); const entry = database.get('test', id); database.close(); return entry; };
  return { run, read };
}

test('offline abandon ends only an unconfirmed creation and retains its original payload', async t => {
  const fixtureData = await fixture(t);
  await fixtureData.run();
  const entry = fixtureData.read();
  assert.equal(entry.status, 'failed');
  assert.equal(entry.phase, 'abandoned');
  assert.equal(entry.payload.items[0].quantity, 1);
});
test('offline abandon refuses confirmed remote lines', async t => {
  const fixtureData = await fixture(t, { confirmed: true });
  await assert.rejects(fixtureData.run(), error => /禁止放弃/.test(error.stderr));
  assert.equal(fixtureData.read().status, 'reconciling');
});
test('offline abandon refuses an unknown confirmation phase even with an empty read', async t => {
  const fixtureData = await fixture(t, { phase: 'confirming' });
  await assert.rejects(fixtureData.run(), error => /禁止放弃/.test(error.stderr));
  assert.equal(fixtureData.read().phase, 'confirming');
});
