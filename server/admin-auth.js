import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DomainError } from './order-service.js';

const COOKIE = 'sam_admin_session';
const digest = value => createHash('sha256').update(value).digest('hex');

export class AdminAuth {
  constructor({ dataDir, password, now = Date.now, ttlMs = 12 * 60 * 60 * 1000 }) {
    this.dataDir = dataDir;
    this.password = password;
    this.now = now;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.attempts = new Map();
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const authPath = resolve(this.dataDir, 'admin-auth.json');
    if (this.password) {
      if (this.password.length < 8) throw new Error('ADMIN_PASSWORD 至少需要 8 个字符。');
      this.credentials = this.makeCredentials(this.password);
      return this;
    }
    try {
      const credentials = JSON.parse(await readFile(authPath, 'utf8'));
      if (credentials.version !== 1 || !/^[0-9a-f]{32}$/.test(credentials.salt)
        || !/^[0-9a-f]{128}$/.test(credentials.hash)) throw new Error('后台密码文件格式不正确。');
      this.credentials = credentials;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const initialPassword = randomBytes(12).toString('base64url');
      this.credentials = this.makeCredentials(initialPassword);
      // Owner-only local file; never return a password from a public API.
      await writeFile(resolve(this.dataDir, 'admin-initial-password.txt'), `${initialPassword}\n`, { mode: 0o600 });
      await writeFile(authPath, `${JSON.stringify(this.credentials)}\n`, { mode: 0o600 });
    }
    return this;
  }

  makeCredentials(password) {
    const salt = randomBytes(16).toString('hex');
    return { version: 1, salt, hash: scryptSync(password, salt, 64).toString('hex') };
  }

  session(req) {
    const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE}=`));
    const token = cookie?.slice(COOKIE.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = digest(token);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= this.now()) { this.sessions.delete(key); return null; }
    return session;
  }

  require(req) {
    if (!this.session(req)) throw new DomainError(401, 'ADMIN_LOGIN_REQUIRED', '请先登录管理后台。');
  }

  login(req, password, secure = false) {
    const peer = req.socket.remoteAddress || 'unknown';
    const now = this.now();
    let attempts = this.attempts.get(peer);
    if (!attempts || now - attempts.start > 15 * 60 * 1000) attempts = { start: now, count: 0 };
    attempts.count++;
    this.attempts.set(peer, attempts);
    if (attempts.count > 10) throw new DomainError(429, 'ADMIN_LOGIN_LIMIT', '密码尝试过多，请 15 分钟后再试。');
    if (typeof password !== 'string' || password.length > 256
      || !timingSafeEqual(scryptSync(password || '', this.credentials.salt, 64), Buffer.from(this.credentials.hash, 'hex'))) {
      throw new DomainError(401, 'ADMIN_PASSWORD_INVALID', '后台密码不正确。');
    }
    this.attempts.delete(peer);
    for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(digest(token), { expiresAt: now + this.ttlMs });
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.ttlMs / 1000)}${secure ? '; Secure' : ''}`;
  }

  logout(req, secure = false) {
    const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE}=`));
    if (cookie) this.sessions.delete(digest(cookie.slice(COOKIE.length + 1)));
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}
