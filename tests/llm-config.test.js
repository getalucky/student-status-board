import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers/harness.js';
import { startMockLlm } from './helpers/mock-llm.js';
import { writeAccountConfig } from '../server/config.js';
import { hashPassword } from '../server/auth.js';

const SERVER_KEY = 'sk-server-secret-123456';
const REQUEST_KEY = 'sk-request-secret-abcdef';

let ctx;
let mock;

async function putConfig(overrides = {}) {
  return ctx.client.call('PUT', '/api/llm/config', {
    base_url: mock.baseUrl,
    model: 'mock-small',
    api_key: SERVER_KEY,
    ...overrides,
  });
}

function rowsOfConfig() {
  return ctx.app.db.prepare("SELECT value, updated_at FROM app_settings WHERE key = 'llm_config'").get();
}

test.before(async () => {
  mock = await startMockLlm();
  ctx = await createTestApp();
  const login = await ctx.login();
  assert.equal(login.statusCode, 200);
});

test.beforeEach(() => {
  ctx.app.db.exec('DELETE FROM app_settings; DELETE FROM students; DELETE FROM feedbacks; DELETE FROM generations;');
  mock.state.requests.length = 0;
  mock.state.chatReply = 'pong';
  mock.state.tagReply = '{"tags":["状态稳定","专注度高"]}';
  mock.state.delayMs = 0;
});

test.after(async () => {
  await ctx.cleanup();
  await mock.close();
});

test('GET /llm/config：未配置时返回安全空结构', async () => {
  const res = await ctx.client.call('GET', '/api/llm/config');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    configured: false,
    base_url: null,
    model: null,
    has_key: false,
    updated_at: null,
  });
});

test('PUT /llm/config：保存成功并返回公开结构（不含 api_key）', async () => {
  const res = await putConfig();
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, true);
  assert.equal(body.base_url, mock.baseUrl);
  assert.equal(body.model, 'mock-small');
  assert.equal(body.has_key, true);
  assert.equal(typeof body.updated_at, 'number');
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'api_key'), false);
  assert.deepEqual(Object.keys(body).sort(), ['base_url', 'configured', 'has_key', 'model', 'updated_at']);
  assert.equal(JSON.stringify(body).includes(SERVER_KEY), false);

  const got = await ctx.client.call('GET', '/api/llm/config');
  assert.equal(got.json().has_key, true);
  assert.equal(JSON.stringify(got.json()).includes(SERVER_KEY), false);
});

test('数据库里只存 AES-GCM 密文，不含明文 key / base_url', async () => {
  await putConfig();
  const row = rowsOfConfig();
  assert.ok(row, 'app_settings 应有 llm_config');
  assert.equal(row.value.includes(SERVER_KEY), false);
  assert.equal(row.value.includes(mock.baseUrl), false);

  const payload = JSON.parse(row.value);
  assert.deepEqual(Object.keys(payload).sort(), ['data', 'iv', 'tag', 'v']);
  assert.equal(payload.v, 1);
  assert.ok(Buffer.from(payload.iv, 'base64').length >= 12);
  assert.ok(Buffer.from(payload.tag, 'base64').length >= 16);
  assert.ok(Buffer.from(payload.data, 'base64').length > 0);
});

test('PUT 时 api_key 留空：保留旧 Key，模型接口不带凭据也能调用', async () => {
  await putConfig();
  const updated = await putConfig({ model: 'mock-large', api_key: '' });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().model, 'mock-large');
  assert.equal(updated.json().has_key, true);

  const res = await ctx.client.call('POST', '/api/llm/test', {});
  assert.equal(res.statusCode, 200);
  const req = mock.requests.filter((r) => r.url.includes('/chat/completions')).at(-1);
  assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
  assert.equal(req.body.model, 'mock-large');

  // /llm/models 同样不需要请求带凭据
  const models = await ctx.client.call('POST', '/api/llm/models', {});
  assert.equal(models.statusCode, 200);
  const modelReq = mock.requests.filter((r) => r.url.endsWith('/models')).at(-1);
  assert.equal(modelReq.headers.authorization, `Bearer ${SERVER_KEY}`);
});

test('请求凭据优先：请求里的 api_key 覆盖服务器已存 Key', async () => {
  await putConfig();
  const res = await ctx.client.call('POST', '/api/llm/models', { api_key: REQUEST_KEY });
  assert.equal(res.statusCode, 200);
  const req = mock.requests.find((r) => r.url.endsWith('/models'));
  assert.equal(req.headers.authorization, `Bearer ${REQUEST_KEY}`);
});

test('服务器未配置时：/llm/models 与 /llm/test 返回 400', async () => {
  for (const [url, body] of [
    ['/api/llm/models', {}],
    ['/api/llm/test', {}],
  ]) {
    const res = await ctx.client.call('POST', url, body);
    assert.equal(res.statusCode, 400, url);
    assert.ok(['LLM_NOT_CONFIGURED', 'VALIDATION_ERROR'].includes(res.json().error));
  }
});

test('首次 PUT 不填 api_key：400 LLM_NOT_CONFIGURED', async () => {
  const res = await putConfig({ api_key: '' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'LLM_NOT_CONFIGURED');
  assert.equal((await ctx.client.call('GET', '/api/llm/config')).json().configured, false);
});

test('配置后不带凭据：反馈标签 / 标签刷新 / 生成 全部可用', async () => {
  await putConfig();

  const created = await ctx.client.call('POST', '/api/students', { name: '配置测试', weekday: 1 });
  const student = created.json();

  // 1) 反馈标签自动更新
  const feedback = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '这周很专注，作业也认真',
  });
  assert.equal(feedback.statusCode, 201);
  assert.equal(feedback.json().tags_updated, true);
  assert.deepEqual(feedback.json().tags, ['状态稳定', '专注度高']);

  // 2) 手动刷新标签
  mock.state.tagReply = '{"tags":["进步明显"]}';
  const refresh = await ctx.client.call('POST', `/api/students/${student.id}/tags/refresh`, {});
  assert.equal(refresh.statusCode, 200);
  assert.equal(refresh.json().tags_updated, true);
  assert.deepEqual(refresh.json().tags, ['进步明显']);

  // 3) 生成家长反馈（SSE）
  mock.state.chatReply = '孩子这段时间状态稳定，作业完成认真。';
  const gen = await ctx.client.call('POST', `/api/students/${student.id}/generate`, { weeks: 1 });
  assert.equal(gen.statusCode, 200);
  assert.match(gen.headers['content-type'], /text\/event-stream/);
  assert.match(gen.body, /event: done/);
});

test('密码变化后旧配置解不开：GET configured=false', async () => {
  const app = await createTestApp();
  try {
    await app.login();
    const saved = await app.client.call('PUT', '/api/llm/config', {
      base_url: mock.baseUrl,
      model: 'mock-small',
      api_key: SERVER_KEY,
    });
    assert.equal(saved.statusCode, 200);

    writeAccountConfig(app.cfg, {
      passwordHash: await hashPassword('new-password-789'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const got = await app.client.call('GET', '/api/llm/config');
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().configured, false);
    assert.equal(got.json().has_key, false);

    const models = await app.client.call('POST', '/api/llm/models', {});
    assert.equal(models.statusCode, 400);
  } finally {
    await app.cleanup();
  }
});

test('DELETE /llm/config：清空后 configured=false，模型接口 400', async () => {
  await putConfig();
  const del = await ctx.client.call('DELETE', '/api/llm/config');
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { ok: true });
  assert.equal(rowsOfConfig(), undefined);
  assert.equal((await ctx.client.call('GET', '/api/llm/config')).json().configured, false);
  assert.equal((await ctx.client.call('POST', '/api/llm/models', {})).statusCode, 400);
});

test('未登录访问配置接口：401', async () => {
  const anon = await createTestApp();
  try {
    for (const [method, url, body] of [
      ['GET', '/api/llm/config', undefined],
      ['PUT', '/api/llm/config', { base_url: mock.baseUrl, model: 'mock-small', api_key: 'x' }],
      ['DELETE', '/api/llm/config', undefined],
    ]) {
      const res = await anon.client.call(method, url, body);
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  } finally {
    await anon.cleanup();
  }
});

test('PUT /llm/config：http / 内网 base_url 被 SSRF 校验拒绝', async () => {
  const strict = await createTestApp({ allowInsecureLlm: false });
  try {
    await strict.login();
    for (const baseUrl of ['http://127.0.0.1:1234/v1', 'https://10.0.0.8/v1']) {
      const res = await strict.client.call('PUT', '/api/llm/config', {
        base_url: baseUrl,
        model: 'mock-small',
        api_key: SERVER_KEY,
      });
      assert.equal(res.statusCode, 400, baseUrl);
      assert.ok(['INSECURE_BASE_URL', 'FORBIDDEN_BASE_URL'].includes(res.json().error));
    }
    const got = await strict.client.call('GET', '/api/llm/config');
    assert.equal(got.json().configured, false);
  } finally {
    await strict.cleanup();
  }
});
