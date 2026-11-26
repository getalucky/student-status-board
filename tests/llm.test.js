import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp } from './helpers/harness.js';
import { startMockLlm } from './helpers/mock-llm.js';

let ctx;
let mock;

test.before(async () => {
  mock = await startMockLlm();
  ctx = await createTestApp();
  const login = await ctx.login();
  assert.equal(login.statusCode, 200);
});

test.beforeEach(() => {
  mock.state.requests.length = 0;
  mock.state.modelsStatus = 200;
  mock.state.chatStatus = 200;
  mock.state.delayMs = 0;
});

test.after(async () => {
  await ctx.cleanup();
  await mock.close();
});

const creds = () => ({ base_url: mock.baseUrl, api_key: 'sk-test-key' });

test('LLM 超时配置默认值：探测 10s、标签 chat 60s', () => {
  assert.equal(ctx.cfg.llmTimeoutMs, 10_000);
  assert.equal(ctx.cfg.llmChatTimeoutMs, 60_000);
});

test('POST /llm/models：代理 GET /models，返回模型列表', async () => {
  const res = await ctx.client.call('POST', '/api/llm/models', creds());
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  assert.deepEqual(body.models.map((m) => m.id), ['mock-small', 'mock-large']);
  assert.equal(body.allow_manual_model, true, '探测失败可手填模型名的兜底标记');

  const upstreamReq = mock.requests.find((r) => r.url.endsWith('/models'));
  assert.equal(upstreamReq.headers.authorization, 'Bearer sk-test-key');
});

test('POST /llm/models：凭据也可走请求头（x-llm-* URL 编码）', async () => {
  const res = await ctx.client.call(
    'POST',
    '/api/llm/models',
    {},
    {
      'x-llm-base-url': encodeURIComponent(mock.baseUrl),
      'x-llm-api-key': encodeURIComponent('sk-header-key'),
    },
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().models.map((m) => m.id), ['mock-small', 'mock-large']);
  const upstreamReq = mock.requests.find((r) => r.url.endsWith('/models'));
  assert.equal(upstreamReq.headers.authorization, 'Bearer sk-header-key');
});

test('POST /llm/models：上游 500 → 502 LLM_UPSTREAM', async () => {
  mock.state.modelsStatus = 500;
  const res = await ctx.client.call('POST', '/api/llm/models', creds());
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'LLM_UPSTREAM');
});

test('POST /llm/test：发 ping 验证模型可用', async () => {
  mock.state.chatReply = 'pong';
  const res = await ctx.client.call('POST', '/api/llm/test', {
    ...creds(),
    model: 'mock-small',
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.content, 'pong');
  assert.equal(body.model, 'mock-small');

  const chatReq = mock.requests.find((r) => r.url.includes('/chat/completions'));
  assert.equal(chatReq.body.stream, false);
  assert.ok(JSON.stringify(chatReq.body.messages).includes('ping'));
});

test('POST /llm/test：上游 401 → 502，错误里带上游状态', async () => {
  mock.state.chatStatus = 401;
  const res = await ctx.client.call('POST', '/api/llm/test', { ...creds(), model: 'mock-small' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'LLM_UPSTREAM');
});

test('POST /llm/models：缺 base_url / api_key → 400', async () => {
  for (const payload of [{}, { base_url: mock.baseUrl }, { api_key: 'x' }]) {
    const res = await ctx.client.call('POST', '/api/llm/models', payload);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'VALIDATION_ERROR');
  }
});

test('api_key 不落盘：临时数据目录里搜不到明文 key', async () => {
  await ctx.client.call('POST', '/api/llm/models', creds());
  const files = fs.readdirSync(ctx.dataDir, { recursive: true }).map(String);
  for (const file of files) {
    const full = path.join(ctx.dataDir, file);
    if (!fs.statSync(full).isFile()) continue;
    const content = fs.readFileSync(full, 'utf8');
    assert.ok(!content.includes('sk-test-key'), `${file} 里不应出现 api_key`);
  }
});

test('SSRF：生产模式拒绝 http / 回环 / 内网 / 元数据地址', async () => {
  const strict = await createTestApp({ allowInsecureLlm: false });
  try {
    await strict.login();
    const cases = [
      { base_url: 'http://127.0.0.1:11434/v1', api_key: 'x' }, // 非 https
      { base_url: 'https://127.0.0.1:11434/v1', api_key: 'x' }, // 回环
      { base_url: 'https://localhost/v1', api_key: 'x' },
      { base_url: 'https://10.0.0.8/v1', api_key: 'x' },
      { base_url: 'https://192.168.1.5/v1', api_key: 'x' },
      { base_url: 'https://169.254.169.254/latest', api_key: 'x' }, // 云元数据
      { base_url: 'https://[::1]/v1', api_key: 'x' },
      { base_url: 'https://[::ffff:127.0.0.1]/v1', api_key: 'x' }, // IPv4-mapped 回环
      { base_url: 'https://[::ffff:7f00:1]/v1', api_key: 'x' }, // IPv4-mapped 十六进制写法
      { base_url: 'https://172.16.3.4/v1', api_key: 'x' },
      { base_url: 'https://100.64.0.1/v1', api_key: 'x' }, // CGNAT / Tailscale 段
    ];
    for (const payload of cases) {
      const res = await strict.client.call('POST', '/api/llm/models', payload);
      assert.equal(res.statusCode, 400, `${payload.base_url} 应被拒`);
      assert.ok(
        ['INSECURE_BASE_URL', 'FORBIDDEN_BASE_URL', 'INVALID_BASE_URL'].includes(res.json().error),
        `实际 error=${res.json().error}`,
      );
    }

    // 非 http(s) 协议
    const ftp = await strict.client.call('POST', '/api/llm/models', {
      base_url: 'ftp://example.com/v1',
      api_key: 'x',
    });
    assert.equal(ftp.statusCode, 400);

    // 非法 URL
    const garbage = await strict.client.call('POST', '/api/llm/models', {
      base_url: 'not a url',
      api_key: 'x',
    });
    assert.equal(garbage.statusCode, 400);
    assert.equal(garbage.json().error, 'INVALID_BASE_URL');
  } finally {
    await strict.cleanup();
  }
});

test('LLM 请求超时：超时时间到返回 502', async () => {
  const timeoutApp = await createTestApp({ llmTimeoutMs: 150 });
  try {
    await timeoutApp.login();
    mock.state.delayMs = 800;
    const res = await timeoutApp.client.call('POST', '/api/llm/models', {
      base_url: mock.baseUrl,
      api_key: 'sk-test-key',
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, 'LLM_UPSTREAM');
    assert.match(res.json().message, /超时|失败/);
  } finally {
    mock.state.delayMs = 0;
    await timeoutApp.cleanup();
  }
});
