import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireRuntimeLock } from '../server/runtime-lock.js';

test('runtime lock rejects a second writer and recovers a dead process lock', async () => {
  const path = await mkdtemp(join(tmpdir(), 'sam-lock-'));
  try {
    const release = await acquireRuntimeLock(path);
    await assert.rejects(acquireRuntimeLock(path), /正在运行/);
    release();
    await writeFile(join(path, 'service.lock.json'), JSON.stringify({ pid: 2147483647 }));
    const recovered = await acquireRuntimeLock(path);
    recovered();
  } finally { await rm(path, { recursive: true, force: true }); }
});

test('concurrent dead-owner recovery never permits overlapping writers', async () => {
  const path = await mkdtemp(join(tmpdir(), 'sam-lock-race-'));
  try {
    await writeFile(join(path, 'service.lock.json'), JSON.stringify({ pid: 2147483647 }));
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../server/runtime-lock.js')).href;
    const source = `import {acquireRuntimeLock} from ${JSON.stringify(moduleUrl)};
      import {appendFile} from 'node:fs/promises';
      try {
        const release = await acquireRuntimeLock(${JSON.stringify(path)});
        await appendFile(${JSON.stringify(join(path, 'events'))}, 'acquired\\n');
        await new Promise(resolve=>setTimeout(resolve,300));
        await appendFile(${JSON.stringify(join(path, 'events'))}, 'released\\n');
        release();
      } catch {}`;
    await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source])));
    let active = 0;
    const events = (await readFile(join(path, 'events'), 'utf8')).trim().split('\n');
    for (const event of events) {
      active += event === 'acquired' ? 1 : -1;
      assert(active >= 0 && active <= 1, `overlapping writer: ${events.join(',')}`);
    }
    assert.equal(active, 0);
  } finally { await rm(path, { recursive: true, force: true }); }
});
