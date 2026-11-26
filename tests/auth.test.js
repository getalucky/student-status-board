import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers/harness.js';

let ctx;

test.before(async () => {
  ctx = await createTestApp({ loginRateMax: 200 });
});

test.after(async () => {
  await ctx.cleanup();
});

test('登录成功：写入会话 Cookie（httpOnly + Secure + SameSite=Lax + 30 天）', async () => {
  const res = await ctx.login();
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.expiresAt > Date.now());

  const setCookie = res.headers['set-cookie'];
  const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
  assert.match(cookieStr, /ssb_sid=/);
  assert.match(cookieStr, /HttpOnly/i);
  assert.match(cookieStr, /Secure/i);
  assert.match(cookieStr, /SameSite=Lax/i);
  assert.match(cookieStr, /Max-Age=2592000/i);
  assert.match(cookieStr, /Path=\//);

  // 带上 Cookie 再请求 /api/me
  const me = await ctx.client.call('GET', '/api/me');
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().authenticated, true);
});

test('登录失败：密码错 401 INVALID_PASSWORD，且不下发会话', async () => {
  const res = await ctx.client.call('POST', '/api/auth/login', { password: 'wrong-password' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'INVALID_PASSWORD');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('登录参数缺失：400', async () => {
  const res = await ctx.client.call('POST', '/api/auth/login', {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'VALIDATION_ERROR');
});

test('未登录访问受保护接口：401', async () => {
  const fresh = await createTestApp();
  try {
    for (const [method, url] of [
      ['GET', '/api/students'],
      ['POST', '/api/students'],
      ['GET', '/api/me'],
      ['POST', '/api/llm/models'],
    ]) {
      const res = await fresh.client.call(method, url, method === 'GET' ? undefined : {});
      assert.equal(res.statusCode, 401, `${method} ${url} 应 401`);
      assert.equal(res.json().error, 'UNAUTHORIZED');
    }
  } finally {
    await fresh.cleanup();
  }
});

test('登出：会话失效，再用旧 Cookie 访问 401', async () => {
  const res = await ctx.login();
  assert.equal(res.statusCode, 200);

  const out = await ctx.client.call('POST', '/api/auth/logout');
  assert.equal(out.statusCode, 200);
  assert.equal(out.json().ok, true);

  const me = await ctx.client.call('GET', '/api/me');
  assert.equal(me.statusCode, 401);
});

test('伪造 Cookie 不能通过', async () => {
  const fresh = await createTestApp();
  try {
    const res = await fresh.client.call('GET', '/api/students', undefined, {
      cookie: 'ssb_sid=forged-token-123',
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await fresh.cleanup();
  }
});

test('登录限流：超过 5 次/分返回 429', async () => {
  const limited = await createTestApp({ loginRateMax: 3, loginRateWindowMs: 60_000 });
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await limited.client.call('POST', '/api/auth/login', { password: 'bad-password' });
      assert.equal(res.statusCode, 401, `第 ${i + 1} 次应是密码错误`);
    }
    const blocked = await limited.client.call('POST', '/api/auth/login', { password: 'bad-password' });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error, 'RATE_LIMITED');
  } finally {
    await limited.cleanup();
  }
});

test('账号未初始化：503 NOT_INITIALIZED', async () => {
  const fresh = await createTestApp({ withAccount: false });
  try {
    const res = await fresh.client.call('POST', '/api/auth/login', { password: 'whatever' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'NOT_INITIALIZED');
  } finally {
    await fresh.cleanup();
  }
});

test('会话滑动续期：临近过期时重新下发 Cookie', async () => {
  const short = await createTestApp({
    sessionTtlMs: 400,
    sessionRefreshBelowMs: 350,
    loginRateMax: 50,
  });
  try {
    const login = await short.client.call('POST', '/api/auth/login', { password: 'test-password-123' });
    assert.equal(login.statusCode, 200);
    const firstExpiry = login.json().expiresAt;

    await new Promise((resolve) => setTimeout(resolve, 120));
    const me = await short.client.call('GET', '/api/me');
    assert.equal(me.statusCode, 200);
    assert.ok(me.json().expiresAt > firstExpiry, '剩余寿命不足阈值应滑动续期');
    const setCookie = me.headers['set-cookie'];
    assert.ok(setCookie, '续期时应重写 Cookie');
  } finally {
    await short.cleanup();
  }
});
