import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncJobs } from '../server/sync-jobs.js';

test('duplicate sync clicks share one job; failures never report completion', async () => {
  const jobs = new SyncJobs();
  let release;
  const first = jobs.start('products', () => new Promise(resolve => { release = resolve; }));
  const duplicate = jobs.start('products', () => { throw new Error('must not run'); });
  assert.equal(first.id, duplicate.id);
  await Promise.resolve();
  release({ status: 'success' });
  await jobs.waitForIdle();
  assert.equal(jobs.get(first.id).status, 'completed');
  const failed = jobs.start('products', () => ({ status: 'error', error: '读取失败，原商品保留。' }));
  await jobs.waitForIdle();
  assert.equal(jobs.get(failed.id).status, 'failed');
  assert.equal(jobs.get(failed.id).error.message, '读取失败，原商品保留。');
});

test('read-only connection checks can report incompatible schemas without losing their details', async () => {
  const jobs = new SyncJobs();
  const result = { status: 'error', checks: { orders: { status: 'error', missingFields: ['团购ID'] } } };
  const check = jobs.start('feishu-check', () => result, { acceptErrorResult: true });
  await jobs.waitForIdle();
  assert.equal(jobs.get(check.id).status, 'completed');
  assert.deepEqual(jobs.get(check.id).result, result);
});
