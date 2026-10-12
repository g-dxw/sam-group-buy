import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export async function acquireRuntimeLock(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = resolve(dataDir, 'service.lock.json');
  const gate = resolve(dataDir, 'service.lock.acquire');
  const owner = JSON.stringify({ pid: process.pid });
  // Every acquisition, including dead-owner recovery, passes this atomic gate.
  // Never automatically remove a gate left by a crash: that could race a live
  // acquisition. It can be removed manually after verifying the service stopped.
  try { await mkdir(gate, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('另一个进程正在取得运行锁。若持续出现，请核查服务已停止后清理 service.lock.acquire。');
  }
  try { for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(owner);
      await file.close();
      return () => {
        try { if (readFileSync(path, 'utf8') === owner) unlinkSync(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new Error('运行锁无法读取，请核查服务已停止后清理 service.lock.json。'); }
      let alive = false;
      try { process.kill(previous.pid, 0); alive = true; }
      catch (check) { if (check.code !== 'ESRCH') alive = true; }
      if (alive) throw new Error('同一数据目录的服务正在运行。请先停止服务，再执行维护或启动另一实例。');
      try { unlinkSync(path); } catch (remove) { if (remove.code !== 'ENOENT') throw remove; }
    }
  }
  throw new Error('无法获得运行锁，请稍后重试。');
  } finally { await rm(gate, { recursive: true, force: true }); }
}
