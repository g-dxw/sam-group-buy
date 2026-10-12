import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { loadConfig } from './config.js';
import { FeishuRepository } from './feishu-repository.js';
import { DomainError } from './order-service.js';
import { LocalStore } from './local-store.js';
import { LocalService } from './local-service.js';
import { FeishuSync } from './feishu-sync.js';
import { FeishuConfigService } from './feishu-config.js';
import { AdminAuth } from './admin-auth.js';
import { SyncJobs } from './sync-jobs.js';
import { initializeLocalData } from './bootstrap-local.js';
import { acquireRuntimeLock } from './runtime-lock.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || resolve(projectRoot, '.data'));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const releaseLock = await acquireRuntimeLock(dataDir);
process.on('exit', releaseLock);
const store = new LocalStore({ path: resolve(dataDir, 'orders.sqlite') });
const repository = new FeishuRepository();
const service = new LocalService({ store });
const auth = await new AdminAuth({ dataDir, password: process.env.ADMIN_PASSWORD }).initialize();
const jobs = new SyncJobs();
const dev = process.argv.includes('--dev');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const config = await loadConfig();
if (!config.batches?.length) {
  console.error('还没有接入批次。请先运行 npm run setup:feishu。');
  store.close();
  process.exit(1);
}
await initializeLocalData({ store, repository, config, dataDir });
const sync = new FeishuSync({ store, repository });
const feishuConfig = new FeishuConfigService({ store });
function shareOrigin() {
  if (process.env.PUBLIC_BASE_URL) {
    const value = new URL(process.env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(value.protocol)) throw new Error('PUBLIC_BASE_URL 需要使用 HTTP 或 HTTPS。');
    return value.origin;
  }
  const addresses = Object.values(networkInterfaces()).flat().filter(item => item.family === 'IPv4' && !item.internal);
  const lan = addresses.find(item => /^192\.168\./.test(item.address)) || addresses[0];
  return `http://${host === '0.0.0.0' && lan ? lan.address : host}:${port}`;
}

const rates = new Map();
const normalizeIP = value => value?.replace(/^::ffff:/, '') || '';
const trustedProxies = new Set((process.env.TRUSTED_PROXY_IPS || '').split(',').map(value => normalizeIP(value.trim())).filter(Boolean));
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function errorResponse(res, error) {
  if (res.headersSent) return res.destroy();
  const known = error instanceof DomainError || (Number.isInteger(error.status) && error.code);
  if (error.code === 'BATCH_NOT_FOUND') {
    return sendJson(res, 404, { error: { code: error.code, message: '没有找到这一期的收集页面。' } });
  }
  if (known) {
    return sendJson(res, error.status, {
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
  }
  console.error(`[${new Date().toISOString()}] 请求未完成：${error.code || error.name || 'unknown'}`);
  return sendJson(res, 503, { error: { code: 'SERVICE_UNAVAILABLE', message: '暂时无法完成操作，请稍后重试。' } });
}

function rateLimit(req, action) {
  const now = Date.now();
  const peer = normalizeIP(req.socket.remoteAddress);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim();
  const clientIP = trustedProxies.has(peer) && isIP(forwarded) ? forwarded : peer;
  const key = `${clientIP}:${action}`;
  const limit = action === 'order' ? 30 : 60;
  let entry = rates.get(key);
  if (!entry || now - entry.start >= 60_000) entry = { start: now, count: 0 };
  entry.count += 1;
  rates.set(key, entry);
  if (entry.count > limit) throw new DomainError(429, 'TOO_MANY_REQUESTS', '操作有些频繁，请稍后再试。');
  if (rates.size > 1000) {
    for (const [k, v] of rates) if (now - v.start >= 60_000) rates.delete(k);
  }
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new DomainError(415, 'JSON_REQUIRED', '请使用 JSON 提交数据。');
  }
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.headers.host; } catch {}
    if (!sameOrigin) throw new DomainError(403, 'ORIGIN_NOT_ALLOWED', '请从本期页面提交。');
  }
  const parts = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) throw new DomainError(413, 'REQUEST_TOO_LARGE', '一次提交的内容过多。');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new DomainError(400, 'INVALID_JSON', '提交数据格式不正确。'); }
}

async function api(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { status: 'ok', database: { connected: true }, feishu: { mode: 'manual', configured: true } });
  }
  if (url.pathname.startsWith('/api/admin/')) return adminApi(req, res, url);
  const match = url.pathname.match(/^\/api\/batches\/([^/]+)\/(catalog|orders|query|submissions\/([^/]+))$/);
  if (!match) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '没有找到这个接口。' } });
  const batch = service.getBatch(decodeURIComponent(match[1]));
  const endpoint = match[2];
  if (endpoint === 'catalog' && req.method === 'GET') {
    return sendJson(res, 200, await service.getCatalog(batch));
  }
  if (endpoint === 'orders' && req.method === 'POST') {
    rateLimit(req, 'order');
    const result = await service.submit(batch, await readJson(req));
    return sendJson(res, ['pending', 'processing', 'reconciling'].includes(result.status) ? 202 : 200, result);
  }
  if (endpoint === 'query' && req.method === 'POST') {
    rateLimit(req, 'query');
    const body = await readJson(req);
    return sendJson(res, 200, await service.queryOrders(batch, body.phone));
  }
  if (endpoint.startsWith('submissions/') && req.method === 'GET') {
    return sendJson(res, 200, await service.getSubmission(batch, decodeURIComponent(match[3])));
  }
  return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '此操作不支持该请求方式。' } });
}

async function adminApi(req, res, url) {
  const endpoint = url.pathname.slice('/api/admin/'.length);
  const peer = normalizeIP(req.socket.remoteAddress);
  const secure = Boolean(req.socket.encrypted || (trustedProxies.has(peer) && req.headers['x-forwarded-proto'] === 'https'));
  if (endpoint === 'session' && req.method === 'GET') return sendJson(res, 200, { authenticated: Boolean(auth.session(req)) });
  if (endpoint === 'login' && req.method === 'POST') {
    const body = await readJson(req);
    res.setHeader('Set-Cookie', auth.login(req, body.password, secure));
    return sendJson(res, 200, { authenticated: true });
  }
  auth.require(req);
  if (endpoint === 'logout' && req.method === 'POST') {
    await readJson(req);
    res.setHeader('Set-Cookie', auth.logout(req, secure));
    return sendJson(res, 200, { authenticated: false });
  }
  if (endpoint === 'overview' && req.method === 'GET') return sendJson(res, 200, { ...service.overview(), shareOrigin: shareOrigin(), feishuUrl: store.getMeta('exportSource')?.feishuUrl });
  if (endpoint === 'products' && req.method === 'GET') return sendJson(res, 200, service.listProducts());
  if (endpoint === 'feishu/config' && req.method === 'GET') return sendJson(res, 200, feishuConfig.get());
  if (endpoint === 'feishu/config' && req.method === 'PUT') {
    const body = await readJson(req);
    if ([...jobs.active.keys()].some(key => key === 'products' || key.startsWith('orders:') || key === 'feishu-save')) {
      throw new DomainError(409, 'FEISHU_CONFIG_BUSY', '正在同步或保存飞书配置，请完成后再修改配置。');
    }
    return sendJson(res, 202, jobs.start('feishu-save', () => feishuConfig.save(body)));
  }
  if (endpoint === 'feishu/inspect' && req.method === 'POST') {
    const body = await readJson(req);
    rateLimit(req, 'feishu-inspect');
    return sendJson(res, 202, jobs.start(`feishu-inspect:${JSON.stringify(body)}`, () => feishuConfig.inspect(body)));
  }
  if (endpoint === 'feishu/check' && req.method === 'POST') {
    const body = await readJson(req);
    rateLimit(req, 'feishu-check');
    // An incompatible schema is a useful check result, not a failed sync job.
    return sendJson(res, 202, jobs.start(`feishu-check:${JSON.stringify(body)}`, () => feishuConfig.check(body), { acceptErrorResult: true }));
  }
  if (endpoint === 'communities' && req.method === 'POST') return sendJson(res, 201, service.createCommunity(await readJson(req)));
  if (endpoint === 'batches' && req.method === 'POST') return sendJson(res, 201, service.createBatch(await readJson(req)));
  if (endpoint === 'stats' && req.method === 'GET') {
    const codes = (url.searchParams.get('codes') || '').split(',').filter(Boolean);
    if (codes.length > 200) throw new DomainError(400, 'INVALID_BATCHES', '一次最多查看 200 期。');
    return sendJson(res, 200, service.getStats(codes));
  }
  if (endpoint === 'sync/products' && req.method === 'POST') {
    await readJson(req);
    if (jobs.active.has('feishu-save')) throw new DomainError(409, 'FEISHU_CONFIG_BUSY', '正在保存飞书配置，请完成后再同步。');
    return sendJson(res, 202, jobs.start('products', () => sync.syncProducts()));
  }
  const jobMatch = endpoint.match(/^jobs\/([a-zA-Z0-9-]+)$/);
  if (jobMatch && req.method === 'GET') return sendJson(res, 200, jobs.get(jobMatch[1]));
  const batchMatch = endpoint.match(/^batches\/([^/]+)(?:\/(sync\/orders|orders\/([^/]+)))?$/);
  if (batchMatch) {
    const code = decodeURIComponent(batchMatch[1]);
    service.getBatch(code);
    if (!batchMatch[2] && req.method === 'PATCH') return sendJson(res, 200, service.updateBatch(code, await readJson(req)));
    if (batchMatch[2] === 'sync/orders' && req.method === 'POST') {
      await readJson(req);
      if (jobs.active.has('feishu-save')) throw new DomainError(409, 'FEISHU_CONFIG_BUSY', '正在保存飞书配置，请完成后再同步。');
      return sendJson(res, 202, jobs.start(`orders:${code}`, () => sync.syncOrders(code)));
    }
    if (batchMatch[3] && req.method === 'PATCH') return sendJson(res, 200, service.updateOrder(code, decodeURIComponent(batchMatch[3]), await readJson(req)));
  }
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '没有找到这个管理操作。' } });
}

async function staticFile(req, res, pathname) {
  const root = resolve(projectRoot, 'dist');
  let path;
  try { path = resolve(root, `.${decodeURIComponent(pathname)}`); } catch { return sendJson(res, 400, { error: { code: 'BAD_PATH', message: '地址格式不正确。' } }); }
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '无法访问这个地址。' } });
  if (/^\/b\/[^/]+(?:\/.*)?$/.test(pathname) || /^\/admin(?:\/.*)?$/.test(pathname)) path = resolve(root, 'index.html');
  try {
    const info = await stat(path);
    if (!info.isFile()) throw Object.assign(new Error(), { code: 'ENOENT' });
    const etag = `"${info.size}-${Math.trunc(info.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff', ETag: etag,
    });
    if (req.method === 'HEAD') return res.end();
    res.end(await readFile(path));
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '没有找到这个文件。' } });
    throw error;
  }
}

let vite;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://local.invalid');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/') {
      res.writeHead(302, { Location: `/b/${encodeURIComponent(store.getMeta('defaultBatch'))}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!['GET', 'HEAD'].includes(req.method)) return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持该请求方式。' } });
    if (dev) {
      const decoded = decodeURIComponent(url.pathname);
      const requestPath = decoded.startsWith('/@fs/') ? resolve(decoded.slice('/@fs'.length)) : resolve(projectRoot, `.${decoded}`);
      const fromData = relative(dataDir, requestPath);
      if (!fromData || (!fromData.startsWith('..') && !isAbsolute(fromData))) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '不允许访问私有数据。' } });
      return vite.middlewares(req, res, () => sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在。' } }));
    }
    return await staticFile(req, res, url.pathname);
  } catch (error) { errorResponse(res, error); }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
if (dev) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    configFile: resolve(projectRoot, 'vite.config.js'),
    server: { middlewareMode: true, hmr: { server }, fs: { deny: ['**/.env*', '**/.git/**', '**/.data/**', '**/*.sqlite*', `${dataDir}/**`] } }, appType: 'spa',
  });
}
server.on('error', async (error) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请通过 PORT 指定其它端口。` : `服务无法启动：${error.code || error.name}`);
  await vite?.close();
  store.close();
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`山姆代购： http://${host}:${port}/admin`);
  console.log(process.env.ADMIN_PASSWORD ? '后台使用 ADMIN_PASSWORD 中设置的密码。' : '后台初始密码保存在数据目录的 admin-initial-password.txt。');
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  const timeout = setTimeout(() => process.exit(0), 55_000).unref();
  await jobs.waitForIdle();
  await vite?.close();
  store.close();
  clearTimeout(timeout);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
