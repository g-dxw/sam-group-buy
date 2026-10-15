import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
const script = resolve('ops/deploy-release.sh');
const sha = number => number.toString(16).padStart(40, '0');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const documentationFiles = ['doc/README.md', 'doc/usage.md', 'doc/pricing-and-portions.md',
  'doc/feishu.md', 'doc/maintenance.md', 'doc/deployment.md', 'doc/sams-browser.md'];
const backupScript = `import { mkdirSync, copyFileSync, appendFileSync, readlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
const destination = process.argv[2];
mkdirSync(destination, { recursive: true, mode: 0o700 });
copyFileSync(join(process.env.DATA_DIR, 'orders.sqlite'), join(destination, 'orders.sqlite'));
appendFileSync(process.env.MOCK_LOG, 'backup:' + basename(readlinkSync(join(process.env.DEPLOY_ROOT, 'current'))) + '\\n');
`;
const files = () => ({
  'dist/index.html': '<html>release</html>', 'server/index.js': 'export {};',
  'scripts/backup-local.mjs': backupScript, 'ops/deploy-release.sh': '#!/bin/bash\nexit 0\n',
  'package.json': '{"name":"release-fixture","version":"1.0.0","private":true}',
  'package-lock.json': '{"name":"release-fixture","lockfileVersion":3,"packages":{}}',
  'README.md': 'Deployment fixture',
  ...Object.fromEntries(documentationFiles.map(path => [path, `Public documentation: ${path}`])),
});
function tar(entries) {
  const parts = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content || ''), header = Buffer.alloc(512);
    const field = (value, offset, length) => {
      const bytes = Buffer.from(value);
      assert.ok(bytes.length <= length);
      bytes.copy(header, offset);
    };
    field(entry.path, 0, 100);
    field(`${(entry.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 8);
    field('0000000\0', 108, 8); field('0000000\0', 116, 8);
    field(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    field('00000000000\0', 136, 12);
    header.fill(32, 148, 156);
    header[156] = (entry.type || '0').charCodeAt(0);
    if (entry.link) field(entry.link, 157, 100);
    field('ustar\0', 257, 6); field('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
async function artifact(context, commit, { source = files(), tarEntries, changeManifest, corrupt } = {}) {
  const entries = Object.entries(source).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({
    path, content, mode: path.endsWith('.sh') ? 0o755 : 0o644,
  }));
  const archive = tar(tarEntries || entries);
  const value = { version: 1, commit, createdAt: '2026-10-12T12:00:00Z',
    archive: { name: `sam-group-buy-${commit}.tar.gz`, bytes: archive.length, sha256: hash(archive) },
    files: entries.map(({ path, content, mode }) => ({ path, bytes: Buffer.byteLength(content), sha256: hash(Buffer.from(content)), mode })) };
  if (changeManifest) changeManifest(value);
  const directory = join(context.root, 'artifacts', commit);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const archivePath = join(directory, `sam-group-buy-${commit}.tar.gz`);
  const manifestPath = join(directory, `sam-group-buy-${commit}.manifest.json`);
  await writeFile(archivePath, corrupt ? Buffer.concat([archive, Buffer.from('tampered')]) : archive);
  await writeFile(manifestPath, JSON.stringify(value));
  return [archivePath, manifestPath, commit];
}
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sam-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deployment = join(root, 'deployment'), bin = join(root, 'mock-bin'), log = join(root, 'actions.log');
  await mkdir(join(deployment, 'shared', 'data'), { recursive: true, mode: 0o700 });
  await mkdir(join(deployment, 'runtime', 'node', 'bin'), { recursive: true, mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  await writeFile(log, '');
  const mocks = {
    id: `#!/bin/sh\nif [ "$1" = '-u' ]; then printf '501\\n'; else printf 'sam-group-buy\\n'; fi\n`,
    flock: `#!/bin/sh\nprintf 'flock:%s\\n' "$*" >> "$MOCK_LOG"\n[ "$MOCK_LOCK_BUSY" != 1 ]\n`,
    npm: `#!/bin/sh\nprintf 'npm:%s\\n' "$*" >> "$MOCK_LOG"\n[ "$MOCK_NPM_FAIL" != 1 ]\n`,
    sudo: `#!/bin/sh
if [ "$1" != '-n' ] || [ "$2" != '/usr/bin/systemctl' ]; then exit 9; fi
case "$3" in
  restart) [ "$4" = sam-group-buy.service ] && [ "$#" = 4 ] || exit 9 ;;
  is-active) [ "$4" = --quiet ] && [ "$5" = sam-group-buy.service ] && [ "$#" = 5 ] || exit 9 ;;
  *) exit 9 ;;
esac
printf 'sudo:%s\\n' "$3" >> "$MOCK_LOG"
exit 0
`,
  };
  for (const [name, content] of Object.entries(mocks)) {
    await writeFile(join(bin, name), content, { mode: 0o755 });
  }
  await symlink(process.execPath, join(deployment, 'runtime', 'node', 'bin', 'node'));
  await symlink(join(bin, 'npm'), join(deployment, 'runtime', 'node', 'bin', 'npm'));
  const allowed = new Set();
  const server = createServer(async (_req, response) => {
    let current;
    try { current = basename(await readlink(join(deployment, 'current'))); } catch {}
    response.writeHead(allowed.has(current) ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: allowed.has(current) ? 'ok' : 'error', database: { connected: allowed.has(current) } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const environment = `PORT="${port}"\nADMIN_PASSWORD="DO-NOT-LOG-PRIVATE"\n`;
  await writeFile(join(deployment, 'shared', '.env'), environment, { mode: 0o600 });
  await writeFile(join(deployment, 'shared', 'data', 'orders.sqlite'), 'PRIVATE-DATABASE', { mode: 0o600 });
  const context = { root, deployment, log, allowed, environment };
  context.run = async (args, extra = {}) => execute('bash', [script, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_ROOT: deployment,
      MOCK_LOG: log, DEPLOY_HEALTH_ATTEMPTS: '1', ...extra }, encoding: 'utf8', timeout: 15000,
  });
  context.actions = () => readFile(log, 'utf8');
  context.current = async () => basename(await readlink(join(deployment, 'current')));
  context.deploy = async commit => { allowed.add(commit); return context.run(await artifact(context, commit)); };
  return context;
}

test('首发与相同SHA重跑：私有env仅链接、依赖禁用scripts、无首次备份或重复安装', async t => {
  const context = await fixture(t), commit = sha(1);
  const result = await context.deploy(commit);
  assert.match(result.stdout, /Deployment succeeded/);
  assert.equal(await context.current(), commit);
  assert.equal(await readlink(join(context.deployment, 'releases', commit, '.env')), join(context.deployment, 'shared', '.env'));
  assert.equal(await readFile(join(context.deployment, 'shared', '.env'), 'utf8'), context.environment);
  for (const path of documentationFiles) {
    assert.equal(await readFile(join(context.deployment, 'releases', commit, path), 'utf8'), files()[path]);
  }
  const first = await context.actions();
  assert.match(first, /flock:-w 55 9/);
  assert.match(first, /npm:ci --omit=dev --no-audit --no-fund --ignore-scripts/);
  assert.equal(first.includes('backup:'), false);
  assert.equal((await readdir(join(context.deployment, 'shared', 'backups'))).length, 0);
  await context.run(await artifact(context, commit));
  const repeated = await context.actions();
  assert.equal(repeated.match(/npm:/g).length, 1);
  assert.equal(repeated.match(/sudo:restart/g).length, 1);
  assert.equal(result.stdout.includes('DO-NOT-LOG-PRIVATE'), false);
});

test('旧发布包缺少doc目录时仍可部署', async t => {
  const context = await fixture(t), commit = sha(1);
  const source = Object.fromEntries(Object.entries(files()).filter(([path]) => !path.startsWith('doc/')));
  context.allowed.add(commit);
  assert.match((await context.run(await artifact(context, commit, { source }))).stdout, /Deployment succeeded/);
  assert.equal(await context.current(), commit);
  assert.equal((await readdir(join(context.deployment, 'releases', commit))).includes('doc'), false);
});

test('升级前在线备份原数据，原子previous/current切换，最多保留三份release', async t => {
  const context = await fixture(t);
  for (const number of [1, 2, 3, 4]) await context.deploy(sha(number));
  assert.equal(await context.current(), sha(4));
  assert.equal(basename(await readlink(join(context.deployment, 'previous'))), sha(3));
  assert.deepEqual((await readdir(join(context.deployment, 'releases'))).sort(), [sha(2), sha(3), sha(4)]);
  const backups = await readdir(join(context.deployment, 'shared', 'backups'));
  assert.equal(backups.length, 3);
  for (const name of backups) assert.equal(await readFile(join(context.deployment, 'shared', 'backups', name, 'orders.sqlite'), 'utf8'), 'PRIVATE-DATABASE');
  const actions = await context.actions();
  assert.match(actions, new RegExp(`backup:${sha(1)}\\nsudo:restart`));
  assert.equal(await readFile(join(context.deployment, 'shared', 'data', 'orders.sqlite'), 'utf8'), 'PRIVATE-DATABASE');
});

test('健康检查失败回滚current和previous并重启旧服务，不删除shared数据', async t => {
  const context = await fixture(t);
  await context.deploy(sha(1)); await context.deploy(sha(2));
  await assert.rejects(context.run(await artifact(context, sha(3))), error => {
    assert.match(error.stderr, /restoring the previous release/);
    assert.equal(`${error.stdout}${error.stderr}`.includes('DO-NOT-LOG-PRIVATE'), false);
    return true;
  });
  assert.equal(await context.current(), sha(2));
  assert.equal(basename(await readlink(join(context.deployment, 'previous'))), sha(1));
  assert.deepEqual((await readdir(join(context.deployment, 'releases'))).sort(), [sha(1), sha(2)]);
  assert.equal((await context.actions()).match(/sudo:restart/g).length, 4);
  assert.equal((await readdir(join(context.deployment, 'shared', 'backups'))).length, 2);
  assert.equal(await readFile(join(context.deployment, 'shared', '.env'), 'utf8'), context.environment);
  assert.equal(await readFile(join(context.deployment, 'shared', 'data', 'orders.sqlite'), 'utf8'), 'PRIVATE-DATABASE');
});

test('sha、manifest hash、越界、隐藏数据、symlink/hardlink和额外tar明细均在安装前拒绝', async t => {
  const context = await fixture(t);
  const normalEntries = Object.entries(files()).map(([path, content]) => ({ path, content, mode: path.endsWith('.sh') ? 0o755 : 0o644 }));
  const attempts = [
    { corrupt: true },
    { changeManifest: value => { value.commit = sha(99); } },
    { changeManifest: value => { value.files[0].sha256 = '0'.repeat(64); } },
    { source: { ...files(), '../outside.txt': 'escape' } },
    { source: { ...files(), 'server/.env': 'SECRET' } },
    { source: { ...files(), 'server/orders.sqlite': 'PRIVATE' } },
    { source: { ...files(), 'doc/验收记录.md': 'PRIVATE' } },
    { source: { ...files(), 'doc/private.md': 'PRIVATE' } },
    { source: { ...files(), 'doc/archive/usage.md': 'PRIVATE' } },
    { tarEntries: [...normalEntries, { path: 'server/extra.js', content: 'extra' }] },
    { tarEntries: normalEntries.map(entry => entry.path === 'server/index.js' ? { ...entry, type: '2', link: '../outside' } : entry) },
    { tarEntries: normalEntries.map(entry => entry.path === 'server/index.js' ? { ...entry, type: '1', link: 'dist/index.html' } : entry) },
    { tarEntries: normalEntries.map(entry => entry.path === 'doc/usage.md' ? { ...entry, type: '2', link: '../README.md' } : entry) },
    { tarEntries: [...normalEntries, normalEntries[0]] },
  ];
  for (const [index, options] of attempts.entries()) await assert.rejects(context.run(await artifact(context, sha(index + 10), options)));
  const args = await artifact(context, sha(40));
  await assert.rejects(context.run([args[0], args[1], '../../invalid']));
  assert.equal((await context.actions()).includes('npm:'), false);
  assert.equal((await context.actions()).includes('sudo:'), false);
  assert.deepEqual(await readdir(join(context.deployment, 'releases')), []);
  assert.equal(await readFile(join(context.deployment, 'shared', '.env'), 'utf8'), context.environment);
});

test('npm失败与锁冲突都不切换服务；current越界链接或可公开读取env拒绝部署', async t => {
  const context = await fixture(t), args = await artifact(context, sha(1));
  await assert.rejects(context.run(args, { MOCK_NPM_FAIL: '1' }));
  assert.deepEqual(await readdir(join(context.deployment, 'releases')), []);
  assert.equal((await context.actions()).includes('sudo:'), false);
  await assert.rejects(context.run(args, { MOCK_LOCK_BUSY: '1' }));
  const before = await context.actions();
  await chmod(join(context.deployment, 'shared', '.env'), 0o644);
  await assert.rejects(context.run(args));
  assert.equal(await context.actions(), before);
  await chmod(join(context.deployment, 'shared', '.env'), 0o600);
  await symlink(context.root, join(context.deployment, 'current'));
  await assert.rejects(context.run(args));
  assert.equal(await readlink(join(context.deployment, 'current')), context.root);
  assert.equal(await readFile(join(context.deployment, 'shared', 'data', 'orders.sqlite'), 'utf8'), 'PRIVATE-DATABASE');
});
