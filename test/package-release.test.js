import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { packageRelease } from '../scripts/package-release.mjs';

const execute = promisify(execFile);
const commit = '1234567890abcdef1234567890abcdef12345678';
const documentationFiles = ['doc/README.md', 'doc/usage.md', 'doc/pricing-and-portions.md',
  'doc/feishu.md', 'doc/maintenance.md', 'doc/deployment.md', 'doc/sams-browser.md'];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sam-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = { 'dist/index.html': '<html>演示</html>', 'dist/assets/app.js': 'console.log("app")',
    'server/index.js': 'console.log("server")', 'scripts/backup-local.mjs': 'export {}',
    'ops/deploy-release.sh': '#!/bin/sh\nexit 0\n', 'package.json': '{"name":"sam-group-buy"}',
    'package-lock.json': '{}', 'README.md': 'Deployment instructions',
    ...Object.fromEntries(documentationFiles.map(path => [path, `Public documentation: ${path}`])) };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, { mode: path.endsWith('.sh') ? 0o755 : 0o644 });
  }
  return { root, files };
}

test('发布包严格白名单，排除凭证数据与验收文件，manifest校验实际tar内容及执行权限', async t => {
  const { root, files } = await fixture(t);
  for (const path of ['.env', '.data/orders.sqlite', 'test-results/screenshot.png', 'node_modules/private.js',
    '验收记录.md', 'scripts/smoke-live.mjs', 'scripts/test-fixture.mjs', 'server/.env', 'ops/private.pem',
    'server/cache/orders.sqlite-wal', 'dist/.data/credentials.json', 'ops/tests/secret.js',
    'doc/验收记录.md', 'doc/private.md', 'doc/archive/usage.md']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'DO-NOT-PUBLISH');
  }
  const result = await packageRelease({ root, commit });
  assert.ok(result.archivePath.endsWith(`.artifacts/sam-group-buy-${commit}.tar.gz`));
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  const archiveBytes = await readFile(result.archivePath);
  assert.equal(manifest.archive.sha256, createHash('sha256').update(archiveBytes).digest('hex'));
  assert.equal(manifest.archive.bytes, archiveBytes.length);
  assert.equal(manifest.commit, commit);
  assert.deepEqual(manifest.files.map(entry => entry.path), Object.keys(files).sort());
  const listed = (await execute('tar', ['-tzf', result.archivePath], { encoding: 'utf8' })).stdout.trim().split('\n');
  assert.deepEqual(listed, Object.keys(files).sort());
  for (const entry of manifest.files) {
    const { stdout } = await execute('tar', ['-xOzf', result.archivePath, entry.path], { encoding: 'buffer' });
    assert.equal(entry.sha256, createHash('sha256').update(stdout).digest('hex'));
    assert.equal(entry.bytes, stdout.length);
  }
  assert.equal(manifest.files.find(entry => entry.path === 'ops/deploy-release.sh').mode & 0o111, 0o111);
});

test('拒绝符号链接外逃、缺少构建产物和不合法版本路径，不读取真实飞书配置', async t => {
  const { root } = await fixture(t);
  await assert.rejects(packageRelease({ root, commit: '../../secret' }), /完整提交编号/);
  const outside = join(root, 'private-secret.txt');
  await writeFile(outside, 'DO-NOT-PUBLISH');
  await symlink(outside, join(root, 'server', 'escape.js'));
  await assert.rejects(packageRelease({ root, commit }), /符号链接/);
  await rm(join(root, 'server', 'escape.js'));
  await rm(join(root, 'doc', 'usage.md'));
  await symlink(outside, join(root, 'doc', 'usage.md'));
  await assert.rejects(packageRelease({ root, commit }), /符号链接.*doc\/usage\.md/);
  await rm(join(root, 'doc', 'usage.md'));
  await assert.rejects(packageRelease({ root, commit }), { code: 'ENOENT' });
  await writeFile(join(root, 'doc', 'usage.md'), 'Public usage documentation');
  await rm(join(root, 'dist', 'index.html'));
  await assert.rejects(packageRelease({ root, commit }), /先构建前端/);
});

test('文档目录不能通过符号链接引用外部目录，白名单文档必须是普通文件', async t => {
  const { root } = await fixture(t);
  await rm(join(root, 'doc', 'usage.md'));
  await mkdir(join(root, 'doc', 'usage.md'));
  await writeFile(join(root, 'doc', 'usage.md', 'private.md'), 'DO-NOT-PUBLISH');
  await assert.rejects(packageRelease({ root, commit }), /发布文件类型无效.*doc\/usage\.md/);
  await rm(join(root, 'doc'), { recursive: true });
  const outside = join(root, 'external-docs');
  await mkdir(outside);
  await symlink(outside, join(root, 'doc'));
  await assert.rejects(packageRelease({ root, commit }), /目录类型无效：doc/);
});
