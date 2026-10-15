#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# This script runs as the dedicated service user. Root setup owns the runtime,
# systemd unit and the two narrowly scoped sudo permissions.
fail() { printf 'Deployment failed: %s\n' "$1" >&2; exit 1; }
[[ $# -eq 3 ]] || fail 'expected absolute archive, absolute manifest, and commit SHA'
archive=$1
manifest=$2
release_sha=$(printf '%s' "$3" | tr 'A-F' 'a-f')
[[ $release_sha =~ ^[0-9a-f]{40}$ ]] || fail 'invalid commit SHA'
[[ $archive = /* && $manifest = /* ]] || fail 'artifact paths must be absolute'
deploy_root=${DEPLOY_ROOT:-/srv/apps/sam-group-buy}
[[ $deploy_root = /* && $deploy_root != / && $deploy_root != *$'\n'* ]] || fail 'invalid deployment root'
export PATH="$deploy_root/runtime/node/bin:$PATH"
[[ $(id -u) != 0 && $(id -un) = sam-group-buy ]] || fail 'run as the non-root sam-group-buy user'
for tool in node npm flock sudo; do command -v "$tool" >/dev/null || fail 'required deployment tool is missing'; done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || fail 'Node 24 or newer is required'

# Validate and extract the fixed ustar snapshot ourselves. No tar entry is ever
# passed to a filesystem extractor before its type, path and hash are checked.
release_op() {
  node --input-type=module - "$@" <<'NODE'
import { constants, closeSync, openSync, readFileSync, lstatSync, statSync, realpathSync,
  mkdirSync, writeFileSync, chmodSync, renameSync, symlinkSync, readlinkSync, unlinkSync,
  readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join, basename, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseEnv } from 'node:util';

const [action, rootInput, ...args] = process.argv.slice(2);
const SHA = /^[0-9a-f]{40}$/;
const HEX = /^[0-9a-f]{64}$/;
const documentationFiles = new Set(['doc/README.md', 'doc/usage.md', 'doc/pricing-and-portions.md',
  'doc/feishu.md', 'doc/maintenance.md', 'doc/deployment.md', 'doc/sams-browser.md']);
const root = resolve(rootInput || '');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const abort = () => { throw new Error('deployment validation failed'); };
function exists(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function directory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)) abort();
}
function privateFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) abort();
}
function checkRoot() {
  if (rootInput !== root || root === '/' || /[\x00-\x1f\x7f]/.test(root) || realpathSync(root) !== root) abort();
  directory(root);
}
function readRegular(path, limit) {
  if (!path.startsWith('/') || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) abort();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = readFileSync(fd);
    if (bytes.length > limit) abort();
    return bytes;
  } finally { closeSync(fd); }
}
function allowed(path) {
  if (typeof path !== 'string' || !path || path.length > 255 || /[\\\x00-\x1f\x7f]/.test(path)
    || posix.normalize(path) !== path || path.startsWith('/') || path.endsWith('/')) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part.startsWith('.') || ['node_modules', 'test', 'tests', 'test-results', '__tests__'].includes(part))) return false;
  const name = parts.at(-1);
  if (name === '验收记录.md' || /\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm))?$|\.(?:key|pem|p12|pfx)$/i.test(name)
    || (parts[0] === 'scripts' && /^(?:smoke|test)(?:[._-]|$)/i.test(name))) return false;
  if (parts[0] === 'doc') return documentationFiles.has(path);
  return parts.length === 1 ? ['package.json', 'package-lock.json', 'README.md'].includes(path)
    : ['dist', 'server', 'scripts', 'ops'].includes(parts[0]);
}
function validateManifest(value, sha) {
  const keys = (object, allowedKeys) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).every(key => allowedKeys.includes(key));
  if (!SHA.test(sha) || !keys(value, ['version', 'commit', 'createdAt', 'archive', 'files'])
    || value.version !== 1 || value.commit !== sha || !Number.isFinite(Date.parse(value.createdAt))
    || !keys(value.archive, ['name', 'bytes', 'sha256']) || value.archive.name !== `sam-group-buy-${sha}.tar.gz`
    || !Number.isSafeInteger(value.archive.bytes) || value.archive.bytes < 1 || value.archive.bytes > 256 * 1024 * 1024
    || !HEX.test(value.archive.sha256 || '') || !Array.isArray(value.files) || !value.files.length || value.files.length > 10000) abort();
  const entries = new Map();
  for (const entry of value.files) {
    if (!keys(entry, ['path', 'bytes', 'sha256', 'mode']) || !allowed(entry.path) || entries.has(entry.path)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 256 * 1024 * 1024
      || !HEX.test(entry.sha256 || '') || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) abort();
    entries.set(entry.path, entry);
  }
  for (const path of ['dist/index.html', 'server/index.js', 'scripts/backup-local.mjs', 'ops/deploy-release.sh', 'package.json', 'package-lock.json', 'README.md']) {
    if (!entries.has(path)) abort();
  }
  if (!(entries.get('ops/deploy-release.sh').mode & 0o111)) abort();
  return entries;
}
function tarFiles(archive, entries) {
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  if (tar.length % 512) abort();
  const files = new Map();
  const string = (header, start, length) => {
    const value = header.subarray(start, start + length);
    const nul = value.indexOf(0);
    return value.subarray(0, nul < 0 ? value.length : nul).toString('utf8');
  };
  const octal = (header, start, length) => {
    const text = header.subarray(start, start + length).toString('ascii').replace(/\0/g, '').trim();
    if (!/^[0-7]+$/.test(text)) abort();
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value)) abort();
    return value;
  };
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) abort();
      ended = true; break;
    }
    const checksum = octal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== checksum || string(header, 257, 6) !== 'ustar' || ![0, 48].includes(header[156]) || string(header, 157, 100)) abort();
    const prefix = string(header, 345, 155);
    const path = `${prefix ? `${prefix}/` : ''}${string(header, 0, 100)}`;
    const expected = entries.get(path), size = octal(header, 124, 12), mode = octal(header, 100, 8);
    if (!allowed(path) || !expected || files.has(path) || size !== expected.bytes || mode !== expected.mode) abort();
    offset += 512;
    if (offset + size > tar.length) abort();
    const content = tar.subarray(offset, offset + size);
    if (hash(content) !== expected.sha256) abort();
    files.set(path, content);
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || files.size !== entries.size) abort();
  return files;
}
function release(sha) {
  if (!SHA.test(sha)) abort();
  const path = join(root, 'releases', sha);
  directory(path);
  if (realpathSync(path) !== path) abort();
  return path;
}
function linkSha(name) {
  const path = join(root, name), info = exists(path);
  if (!info) return '';
  if (!info.isSymbolicLink()) abort();
  const target = resolve(root, readlinkSync(path));
  const sha = basename(target);
  if (target !== join(root, 'releases', sha)) abort();
  release(sha); return sha;
}
function replaceLink(name, sha) {
  const path = join(root, name), existing = exists(path);
  if (existing && !existing.isSymbolicLink()) abort();
  if (!sha) { if (existing) unlinkSync(path); return; }
  const target = release(sha), temporary = join(root, `.${name}-${randomUUID()}`);
  try { symlinkSync(target, temporary); renameSync(temporary, path); }
  finally { if (exists(temporary)) unlinkSync(temporary); }
}
function stagePath(path, sha) {
  const parent = join(root, 'incoming', sha);
  if (!SHA.test(sha) || dirname(path) !== parent || !/^stage-[0-9a-f-]{36}$/.test(basename(path))) abort();
  directory(parent); directory(path);
  return path;
}
function readyRelease(path, sha, entries) {
  directory(path);
  if (readFileSync(join(path, '.ready'), 'utf8').trim() !== sha) abort();
  if (!lstatSync(join(path, '.env')).isSymbolicLink() || readlinkSync(join(path, '.env')) !== join(root, 'shared', '.env')) abort();
  const stored = JSON.parse(readFileSync(join(path, '.release-manifest.json'), 'utf8'));
  const original = validateManifest(stored, sha);
  if (original.size !== entries.size) abort();
  for (const [name, entry] of entries) {
    const previous = original.get(name), file = join(path, name);
    if (!previous || ['bytes', 'sha256', 'mode'].some(key => previous[key] !== entry[key])) abort();
    const bytes = readRegular(file, 256 * 1024 * 1024);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256 || (lstatSync(file).mode & 0o777) !== entry.mode) abort();
  }
}
try {
  checkRoot();
  if (action === 'init') {
    for (const relative of ['releases', 'shared', 'shared/data', 'shared/backups', 'incoming']) {
      const path = join(root, relative);
      if (!exists(path)) mkdirSync(path, { mode: 0o700 });
      directory(path);
    }
    privateFile(join(root, 'shared', '.env'));
    const lock = join(root, '.deploy.lock');
    if (!exists(lock)) { const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd); }
    privateFile(lock);
    linkSha('current'); linkSha('previous');
  } else if (action === 'port') {
    const env = parseEnv(readFileSync(join(root, 'shared', '.env'), 'utf8'));
    const port = env.PORT ?? process.env.PORT ?? '3001';
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) abort();
    console.log(Number(port));
  } else if (action === 'state') {
    if (!['current', 'previous'].includes(args[0])) abort();
    console.log(linkSha(args[0]));
  } else if (action === 'prepare') {
    const [sha, archivePath, manifestPath] = args;
    const rawManifest = readRegular(manifestPath, 4 * 1024 * 1024);
    const value = JSON.parse(rawManifest.toString('utf8'));
    const entries = validateManifest(value, sha);
    const archive = readRegular(archivePath, 256 * 1024 * 1024);
    if (archive.length !== value.archive.bytes || hash(archive) !== value.archive.sha256) abort();
    const files = tarFiles(archive, entries);
    const target = join(root, 'releases', sha);
    if (exists(target)) { readyRelease(release(sha), sha, entries); console.log(target); }
    else {
      const incoming = join(root, 'incoming', sha);
      if (!exists(incoming)) mkdirSync(incoming, { mode: 0o700 });
      directory(incoming);
      const staging = join(incoming, `stage-${randomUUID()}`);
      mkdirSync(staging, { mode: 0o700 });
      try {
        for (const [path, content] of files) {
          const destination = join(staging, path);
          mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
          writeFileSync(destination, content, { flag: 'wx', mode: entries.get(path).mode });
          chmodSync(destination, entries.get(path).mode);
        }
        writeFileSync(join(staging, '.release-manifest.json'), rawManifest, { mode: 0o600, flag: 'wx' });
        symlinkSync(join(root, 'shared', '.env'), join(staging, '.env'));
        console.log(staging);
      } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
    }
  } else if (action === 'publish') {
    const [sha, path] = args;
    stagePath(path, sha);
    const target = join(root, 'releases', sha);
    if (exists(target)) abort();
    writeFileSync(join(path, '.ready'), `${sha}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(path, target);
  } else if (action === 'switch') {
    const [sha, old] = args;
    release(sha);
    if (linkSha('current') !== old) abort();
    replaceLink('previous', old);
    replaceLink('current', sha);
  } else if (action === 'restore') {
    replaceLink('current', args[0]); replaceLink('previous', args[1]);
  } else if (action === 'discard-stage') {
    if (exists(args[1])) rmSync(stagePath(args[1], args[0]), { recursive: true, force: true });
  } else if (action === 'discard-release') {
    const sha = args[0];
    if (linkSha('current') !== sha && linkSha('previous') !== sha && exists(join(root, 'releases', sha))) rmSync(release(sha), { recursive: true, force: true });
  } else if (action === 'cleanup') {
    const sha = args[0], keep = new Set([linkSha('current'), linkSha('previous')].filter(Boolean));
    const releases = readdirSync(join(root, 'releases')).filter(name => SHA.test(name)).map(name => {
      const path = release(name); return { sha: name, time: statSync(join(path, '.ready')).mtimeMs };
    }).sort((a, b) => b.time - a.time);
    const extra = releases.find(item => !keep.has(item.sha));
    if (extra) keep.add(extra.sha);
    for (const item of releases) if (!keep.has(item.sha)) rmSync(release(item.sha), { recursive: true, force: true });
    const incoming = join(root, 'incoming', sha);
    if (!SHA.test(sha)) abort();
    if (exists(incoming)) { directory(incoming); rmSync(incoming, { recursive: true, force: true }); }
  } else abort();
} catch { console.error('Deployment filesystem or artifact validation failed.'); process.exitCode = 1; }
NODE
}

release_op init "$deploy_root" || fail 'deployment directories or private environment are invalid'
exec 9>"$deploy_root/.deploy.lock"
flock -w 55 9 || fail 'another deployment holds the lock'
# Recheck state after acquiring the lock; the preceding deployment may have changed it.
release_op init "$deploy_root" || fail 'deployment state is invalid'
port=$(release_op port "$deploy_root") || fail 'invalid configured health port'
prior_current=$(release_op state "$deploy_root" current) || fail 'invalid current release'
prior_previous=$(release_op state "$deploy_root" previous) || fail 'invalid previous release'
candidate=''
published=0
switched=0
committed=0
finish() {
  status=$?
  trap - EXIT
  if [[ $status -ne 0 && $switched -eq 1 && $committed -eq 0 ]]; then
    printf 'Deployment failed; restoring the previous release.\n' >&2
    if release_op restore "$deploy_root" "$prior_current" "$prior_previous"; then
      sudo -n /usr/bin/systemctl restart sam-group-buy.service >/dev/null 2>&1 || printf 'Rollback restart failed; manual service inspection is required.\n' >&2
    else
      printf 'Rollback link restoration failed; manual service inspection is required.\n' >&2
    fi
  fi
  if [[ $status -ne 0 && $published -eq 1 ]]; then
    release_op discard-release "$deploy_root" "$release_sha" >/dev/null 2>&1 || true
  fi
  if [[ -n $candidate && $candidate != "$deploy_root/releases/$release_sha" ]]; then
    release_op discard-stage "$deploy_root" "$release_sha" "$candidate" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap finish EXIT
candidate=$(release_op prepare "$deploy_root" "$release_sha" "$archive" "$manifest") || fail 'artifact did not pass validation'
release_dir="$deploy_root/releases/$release_sha"
if [[ $candidate != "$release_dir" ]]; then
  (cd "$candidate" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts >/dev/null 2>&1) || fail 'production dependency installation failed'
  release_op publish "$deploy_root" "$release_sha" "$candidate" || fail 'release publication failed'
  published=1
fi
if [[ $prior_current != "$release_sha" ]]; then
  if [[ -n $prior_current ]]; then
    backup_name="$(date -u +%Y%m%dT%H%M%SZ)-${release_sha}-$$"
    DATA_DIR="$deploy_root/shared/data" node "$deploy_root/releases/$prior_current/scripts/backup-local.mjs" "$deploy_root/shared/backups/$backup_name" >/dev/null 2>&1 || fail 'online database backup failed'
  fi
  switched=1
  release_op switch "$deploy_root" "$release_sha" "$prior_current" || fail 'atomic release switch failed'
  sudo -n /usr/bin/systemctl restart sam-group-buy.service >/dev/null 2>&1 || fail 'service restart failed'
fi
sudo -n /usr/bin/systemctl is-active --quiet sam-group-buy.service >/dev/null 2>&1 || fail 'service is not active'
node --input-type=module - "$port" <<'NODE' || fail 'loopback health check failed'
const port = Number(process.argv[2]);
const configured = process.env.DEPLOY_HEALTH_ATTEMPTS || '15';
if (!/^\d+$/.test(configured) || Number(configured) < 1 || Number(configured) > 30) process.exit(1);
for (let attempt = 0; attempt < Number(configured); attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    const text = await response.text();
    const body = text.length <= 65536 ? JSON.parse(text) : null;
    if (response.status === 200 && body?.status === 'ok' && body?.database?.connected === true) process.exit(0);
  } catch {}
  if (attempt + 1 < Number(configured)) await new Promise(resolve => setTimeout(resolve, 1000));
}
process.exit(1);
NODE
committed=1
release_op cleanup "$deploy_root" "$release_sha" >/dev/null 2>&1 || printf 'Deployment succeeded; old release cleanup requires inspection.\n' >&2
printf 'Deployment succeeded: %s\n' "$release_sha"
