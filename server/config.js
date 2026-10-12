import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = resolve(process.env.DATA_DIR || resolve(projectRoot, '.data'));
export const CONFIG_PATH = resolve(DATA_DIR, 'batches.json');

export async function loadConfig() {
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    if (!Array.isArray(config.batches)) throw new Error('批次配置格式不正确');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return { defaultBatch: null, batches: [] };
    throw error;
  }
}

export async function saveConfig(config) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, CONFIG_PATH);
  return config;
}

export async function getBatch(code) {
  const config = await loadConfig();
  const batch = config.batches.find(item => item.code === (code || config.defaultBatch));
  if (!batch) {
    const error = new Error('本期收集链接不存在');
    error.code = 'BATCH_NOT_FOUND';
    throw error;
  }
  return batch;
}
