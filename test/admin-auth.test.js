import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAuth } from '../server/admin-auth.js';

test('admin credentials persist; cookies expire and restart invalidates sessions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sam-admin-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 100;
  const auth = await new AdminAuth({ dataDir: dir, now: () => now, ttlMs: 1000 }).initialize();
  const password = (await readFile(join(dir, 'admin-initial-password.txt'), 'utf8')).trim();
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.throws(() => auth.require(req), { code: 'ADMIN_LOGIN_REQUIRED' });
  assert.throws(() => auth.login(req, 'wrong'), { code: 'ADMIN_PASSWORD_INVALID' });
  const cookie = auth.login(req, password);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  req.headers.cookie = cookie.split(';')[0];
  auth.require(req);
  const restarted = await new AdminAuth({ dataDir: dir }).initialize();
  assert.equal(restarted.session(req), null);
  assert.match(restarted.login({ ...req, headers: {} }, password, true), /; Secure$/);
  now = 1100;
  assert.equal(auth.session(req), null);
});

test('admin password guessing is bounded and logout revokes access', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sam-admin-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = await new AdminAuth({ dataDir: dir, password: 'test-admin-password' }).initialize();
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  for (let count = 0; count < 10; count++) assert.throws(() => auth.login(req, 'wrong'), { code: 'ADMIN_PASSWORD_INVALID' });
  assert.throws(() => auth.login(req, 'test-admin-password'), { code: 'ADMIN_LOGIN_LIMIT' });
  const other = { headers: {}, socket: { remoteAddress: '127.0.0.2' } };
  const cookie = auth.login(other, 'test-admin-password');
  other.headers.cookie = cookie.split(';')[0];
  auth.require(other);
  auth.logout(other);
  assert.throws(() => auth.require(other), { code: 'ADMIN_LOGIN_REQUIRED' });
});
