import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../server/local-store.js';
import { loadFeishuSource } from '../server/feishu-source.js';

test('schema maintenance reads the current database configuration rather than an old bootstrap destination', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sam-feishu-source-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const previous = { code: 'demo', baseToken: 'old-base', orderTableId: 'old-table' };
  const config = { defaultBatch: 'demo', batches: [previous] };
  assert.deepEqual(await loadFeishuSource({ dataDir, config }), previous);
  const store = new LocalStore({ path: join(dataDir, 'orders.sqlite') });
  t.after(() => store.close());
  assert.deepEqual(await loadFeishuSource({ dataDir, config }), previous);
  const current = { baseToken: 'current-base', productTableId: 'current-products', orderTableId: 'current-orders' };
  store.setMeta('exportSource', current);
  assert.deepEqual(await loadFeishuSource({ dataDir, config }), current);
});
