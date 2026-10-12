import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directories = ['dist', 'server', 'scripts', 'ops'];
const rootFiles = ['package.json', 'package-lock.json', 'README.md'];
const forbiddenDirectories = new Set(['node_modules', 'test', 'tests', 'test-results', '__tests__']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function excluded(path) {
  const parts = path.split('/');
  if (parts.some(part => part.startsWith('.') || forbiddenDirectories.has(part))) return true;
  const name = parts.at(-1);
  return name === '验收记录.md' || /\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm))?$|\.(?:key|pem|p12|pfx)$/i.test(name)
    || (parts[0] === 'scripts' && /^(?:smoke|test)(?:[._-]|$)/i.test(name));
}

async function collectFiles(root, relative, files) {
  if (excluded(relative)) return;
  const info = await lstat(join(root, relative));
  if (info.isSymbolicLink()) throw new Error(`发布文件不能是符号链接：${relative}`);
  if (info.isDirectory()) {
    for (const entry of (await readdir(join(root, relative))).sort()) await collectFiles(root, `${relative}/${entry}`, files);
  } else if (info.isFile()) files.push(relative);
  else throw new Error(`发布目录包含不支持的文件：${relative}`);
}

export async function packageRelease({ root = projectRoot, commit = process.env.GITHUB_SHA } = {}) {
  root = resolve(root);
  if (!commit) {
    const result = await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
    commit = result.stdout.trim();
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('发布版本必须为 GITHUB_SHA 或当前 Git HEAD 的完整提交编号。');
  commit = commit.toLowerCase();
  const files = [];
  for (const directory of directories) {
    const info = await lstat(join(root, directory));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`缺少发布目录或目录类型无效：${directory}`);
    await collectFiles(root, directory, files);
  }
  for (const file of rootFiles) await collectFiles(root, file, files);
  files.sort();
  if (!files.includes('dist/index.html') || !files.includes('server/index.js') || !files.includes('ops/deploy-release.sh')) {
    throw new Error('请先构建前端，并确保服务入口和 ops/deploy-release.sh 已存在。');
  }
  const outputDirectory = join(root, '.artifacts');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputInfo = await lstat(outputDirectory);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error('发布输出目录类型无效。');
  const stem = `sam-group-buy-${commit}`;
  const archivePath = join(outputDirectory, `${stem}.tar.gz`);
  const manifestPath = join(outputDirectory, `${stem}.manifest.json`);
  const staging = await mkdtemp(join(outputDirectory, '.staging-'));
  try {
    const entries = [];
    // Copy a fixed snapshot before hashing and archiving, so concurrent edits
    // cannot make the manifest describe different bytes from the release.
    for (const path of files) {
      const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error(`发布文件类型已变化：${path}`);
        const content = await handle.readFile();
        const destination = join(staging, path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
        const mode = info.mode & 0o777;
        await writeFile(destination, content, { mode });
        entries.push({ path, bytes: content.length, sha256: hash(content), mode });
      } finally { await handle.close(); }
    }
    const fileList = join(staging, 'archive-files.txt');
    await writeFile(fileList, `${files.join('\0')}\0`);
    const stagedArchive = join(staging, `${stem}.tar.gz`);
    await execute('tar', ['--format=ustar', '-czf', stagedArchive, '-C', staging, '--null', '-T', fileList], {
      env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 1024 * 1024,
    });
    const archive = await readFile(stagedArchive);
    const manifest = { version: 1, commit, createdAt: new Date().toISOString(),
      archive: { name: `${stem}.tar.gz`, bytes: archive.length, sha256: hash(archive) }, files: entries };
    const stagedManifest = join(staging, `${stem}.manifest.json`);
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(stagedArchive, archivePath);
    await rename(stagedManifest, manifestPath);
    return { archivePath, manifestPath, commit, files: entries.length, sha256: manifest.archive.sha256 };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await packageRelease(), null, 2)); }
  catch (error) { console.error(`发布包创建失败：${error.message}`); process.exitCode = 1; }
}
