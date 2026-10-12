import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, loadConfig } from './config.js';

// Maintenance commands must use the same saved destination as the running app.
// Opening read-only never competes for the app's single-writer runtime lock.
export async function loadFeishuSource({ dataDir = DATA_DIR, config } = {}) {
  const path = resolve(dataDir, 'orders.sqlite');
  try {
    await stat(path);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare('SELECT value_json FROM meta WHERE key = ?').get('exportSource');
      if (row) {
        const source = JSON.parse(row.value_json);
        if (source) return source;
      }
    } finally { database.close(); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const legacy = config || await loadConfig();
  return legacy.batches.find(batch => batch.code === legacy.defaultBatch) || legacy.batches[0];
}
