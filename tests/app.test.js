import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp } from './helpers/harness.js';

let ctx;

test.before(async () => {
  ctx = await createTestApp();
});

test.after(async () => {
  await ctx.cleanup();
});

test('GET /api/healthz：不需要登录，返回 db 状态', async () => {
  const res = await ctx.client.call('GET', '/api/healthz');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
});

test('未知 /api 路由：404 JSON（不能落到 SPA 兜底）', async () => {
  const res = await ctx.client.call('GET', '/api/does-not-exist');
  assert.equal(res.statusCode, 404);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.json().error, 'NOT_FOUND');
});

test('静态托管：web/dist 存在时返回 index.html，前端路由回退到 SPA', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ssb-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="app"></div>', 'utf8');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("ok")', 'utf8');

  const app = await createTestApp({ webDist: dist });
  try {
    const root = await app.client.call('GET', '/');
    assert.equal(root.statusCode, 200);
    assert.match(root.headers['content-type'], /text\/html/);
    assert.match(root.body, /id="app"/);

    const asset = await app.client.call('GET', '/assets/app.js');
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /console\.log/);

    const spa = await app.client.call('GET', '/board/42');
    assert.equal(spa.statusCode, 200);
    assert.match(spa.body, /id="app"/, '前端路由应回退 index.html');

    const missingAsset = await app.client.call('GET', '/assets/not-there.js');
    assert.equal(missingAsset.statusCode, 404, '缺失静态资源不能回退成 HTML');
  } finally {
    await app.cleanup();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('CORS 无关：同源访问，未设置跨域头', async () => {
  const res = await ctx.client.call('GET', '/api/healthz');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
