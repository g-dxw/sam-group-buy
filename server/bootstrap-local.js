import { copyFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { completeGroup } from './order-service.js';

export function markLegacyExportsPending(store) {
  if (store.getMeta('localExportSchemaVersion') === 1) return;
  store.transaction(() => {
    for (const batch of store.listBatches()) {
      if (store.getMeta(`legacySource:${batch.code}`) && !store.getMeta(`feishu-export:${batch.code}`)?.lastSyncedAt) store.requestFullExport(batch.code);
    }
    store.setMeta('localExportSchemaVersion', 1);
  });
}

export async function initializeLocalData({ store, repository, config, dataDir }) {
  if (store.getMeta('localInitialized')) { markLegacyExportsPending(store); return; }
  const source = config.batches.find(batch => batch.code === config.defaultBatch) || config.batches[0];
  if (!source) throw new Error('请先接入飞书商品库。');
  const journalPath = resolve(dataDir, 'submissions.sqlite');
  try {
    await stat(journalPath);
    const old = new DatabaseSync(journalPath, { readOnly: true });
    try {
      const unfinished = old.prepare("SELECT count(*) AS total FROM submissions WHERE status NOT IN ('completed','failed')").get().total;
      if (unfinished) throw new Error('旧版还有未确认订单，请先完成核对，再迁移本地数据库。');
    } finally { old.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const backupDir = resolve(dataDir, 'backup-before-local-database');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  for (const name of ['batches.json', 'submissions.sqlite', 'submissions.sqlite-wal', 'submissions.sqlite-shm']) {
    try { await copyFile(resolve(dataDir, name), resolve(backupDir, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const products = await repository.readProducts(source);
  const imports = [];
  for (const batch of config.batches) {
    const [settings, rows] = await Promise.all([repository.readSettings(batch), repository.readOrderLines(batch)]);
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.submissionId)) groups.set(row.submissionId, []);
      groups.get(row.submissionId).push(row);
    }
    if ([...groups.values()].some(lines => !completeGroup(lines))) {
      throw new Error('飞书存在未完整确认的旧订单，请先核查后再迁移，原数据已保留。');
    }
    imports.push({ batch, settings, rows });
  }
  // Finish all remote reads before committing: a failed import leaves the old
  // data untouched and can be retried without guessing at half-loaded data.
  store.transaction(() => {
    store.importProducts(products, { source, lastSyncedAt: new Date().toISOString() });
    for (const { batch, settings, rows } of imports) {
      store.importLegacyBatch(batch, {
        ...settings, communityName: batch.communityName || (batch.code === 'demo-20261012' ? '演示群' : batch.name || '原有团购'),
        periodNumber: 0, periodLabel: '演示期',
      }, products, rows);
    }
    store.setMeta('exportSource', source);
    store.setMeta('defaultBatch', config.defaultBatch || source.code);
    store.setMeta('localInitialized', true);
    markLegacyExportsPending(store);
  });
}
