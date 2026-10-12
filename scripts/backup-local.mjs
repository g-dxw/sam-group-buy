import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from '../server/config.js';

const destination = resolve(process.argv[2] || resolve(DATA_DIR, 'backups', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(destination, { recursive: true, mode: 0o700 });
const database = new DatabaseSync(resolve(DATA_DIR, 'orders.sqlite'), { readOnly: true });
try { await backup(database, resolve(destination, 'orders.sqlite')); }
finally { database.close(); }
await chmod(resolve(destination, 'orders.sqlite'), 0o600);
for (const name of ['batches.json', 'admin-auth.json', 'admin-initial-password.txt']) {
  try { await copyFile(resolve(DATA_DIR, name), resolve(destination, name)); await chmod(resolve(destination, name), 0o600); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log(`数据库备份已保存：${destination}`);
