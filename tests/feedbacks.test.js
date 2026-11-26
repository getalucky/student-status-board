import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, resetData } from './helpers/harness.js';
import { startMockLlm } from './helpers/mock-llm.js';
import { VOCABULARY } from '../server/lib/tags.js';

let ctx;
let mock;
let student;

const llmBody = () => ({
  llm: { base_url: mock.baseUrl, api_key: 'sk-test-key', model: 'mock-small' },
});

async function createStudent(name = '小测') {
  const res = await ctx.client.call('POST', '/api/students', { name, weekday: 2 });
  assert.equal(res.statusCode, 201);
  return res.json();
}

test.before(async () => {
  mock = await startMockLlm();
  ctx = await createTestApp();
  const login = await ctx.login();
  assert.equal(login.statusCode, 200);
});

test.beforeEach(async () => {
  resetData(ctx.app);
  mock.state.requests.length = 0;
  mock.state.tagReply = '{"tags":["状态稳定","专注度高"]}';
  mock.state.failNextChat = 0;
  student = await createStudent();
});

test.after(async () => {
  await ctx.cleanup();
  await mock.close();
});

test('录入反馈：保存 happened_at，并同步更新标签', async () => {
  const happenedAt = Date.parse('2026-11-20T15:30:00+08:00');
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '这周上课很专注，作业也认真完成',
    happened_at: happenedAt,
    ...llmBody(),
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.feedback.content, '这周上课很专注，作业也认真完成');
  assert.equal(body.feedback.happened_at, happenedAt);
  assert.equal(body.tags_updated, true);
  assert.deepEqual(body.tags, ['状态稳定', '专注度高']);

  // 落库到学生卡片
  const detail = (await ctx.client.call('GET', `/api/students/${student.id}`)).json();
  assert.deepEqual(detail.tags, ['状态稳定', '专注度高']);
  assert.ok(detail.tags_at > 0);

  // 发给模型的是「固定词表 + 最近 10 条」
  const tagReq = mock.requests.filter((r) => r.url.includes('/chat/completions')).at(-1);
  const system = tagReq.body.messages.find((m) => m.role === 'system').content;
  assert.ok(system.includes('进步明显'), 'system 应包含固定词表');
  assert.ok(system.includes('情绪波动'));
  assert.equal(tagReq.body.model, 'mock-small');
  assert.equal(tagReq.body.stream, false);
  assert.equal(tagReq.body.max_tokens, 2048, '推理模型思考 token 也算在 max_tokens 内');
});

test('反馈列表：按 happened_at 倒序', async () => {
  const base = Date.parse('2026-11-01T10:00:00+08:00');
  for (let i = 0; i < 3; i += 1) {
    await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
      content: `记录 ${i}`,
      happened_at: base + i * 3600_000,
      ...llmBody(),
    });
  }
  const res = await ctx.client.call('GET', `/api/students/${student.id}/feedbacks`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().map((f) => f.content), ['记录 2', '记录 1', '记录 0']);
});

test('喂模型：只取最近 10 条反馈', async () => {
  for (let i = 1; i <= 12; i += 1) {
    const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
      content: `记录${String(i).padStart(2, '0')}`,
      happened_at: Date.parse('2026-11-01T00:00:00+08:00') + i * 60_000,
      ...llmBody(),
    });
    assert.equal(res.statusCode, 201);
  }
  const tagReqs = mock.requests.filter(
    (r) => r.url.includes('/chat/completions') && r.body?.messages?.[0]?.content?.includes('学情分析'),
  );
  const last = tagReqs.at(-1);
  const prompt = last.body.messages.find((m) => m.role === 'user').content;
  assert.ok(prompt.includes('记录12'), '最新一条要在');
  assert.ok(prompt.includes('记录03'), '第 3 条（倒数第 10）要在');
  assert.ok(!prompt.includes('记录02'), '更早的第 2 条不应出现');
  assert.ok(!prompt.includes('记录01'), '更早的第 1 条不应出现');
});

test('标签校验：词表外丢弃、超过 3 个截断', async () => {
  mock.state.tagReply = '{"tags":["状态稳定","瞎编的标签","专注度高","进步明显","积极性高"]}';
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '表现很好',
    ...llmBody(),
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.tags_updated, true);
  assert.deepEqual(body.tags, ['状态稳定', '专注度高', '进步明显']);
  assert.deepEqual(body.dropped, ['瞎编的标签']);
  assert.equal(body.truncated, true);
});

test('标签计算使用独立的 llmChatTimeoutMs，不被 10s 探测超时误杀', async () => {
  // 探测超时压到 100ms、标签 chat 超时 1500ms；mock 延迟 600ms
  // 若 computeTags 误用 llmTimeoutMs，就会超时导致 tags_updated:false
  const slow = await createTestApp({ llmTimeoutMs: 100, llmChatTimeoutMs: 1500 });
  try {
    const login = await slow.login();
    assert.equal(login.statusCode, 200);
    const created = await slow.client.call('POST', '/api/students', { name: '慢标签', weekday: 1 });
    const target = created.json();
    mock.state.delayMs = 600;
    const res = await slow.client.call('POST', `/api/students/${target.id}/feedbacks`, {
      content: '模型思考很久的一条反馈',
      ...llmBody(),
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().tags_updated, true, '应使用 1500ms 的 chat 超时而不是 100ms');
  } finally {
    mock.state.delayMs = 0;
    await slow.cleanup();
  }
});

test('标签计算超过 llmChatTimeoutMs 时降级为 tags_updated:false（反馈仍保存）', async () => {
  const quick = await createTestApp({ llmTimeoutMs: 2000, llmChatTimeoutMs: 150 });
  try {
    await quick.login();
    const created = await quick.client.call('POST', '/api/students', { name: '超时标签', weekday: 1 });
    const target = created.json();
    mock.state.delayMs = 500;
    const res = await quick.client.call('POST', `/api/students/${target.id}/feedbacks`, {
      content: '模型会超时',
      ...llmBody(),
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().tags_updated, false);
    assert.equal(res.json().reason, 'LLM_UPSTREAM');
    assert.ok(res.json().feedback.id > 0);
  } finally {
    mock.state.delayMs = 0;
    await quick.cleanup();
  }
});

test('模型返回纯文本标签也能识别', async () => {
  mock.state.tagReply = '进步明显、专注度高';
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '这周进步很明显，上课也很专注',
    ...llmBody(),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().tags_updated, true);
  assert.deepEqual(res.json().tags, ['进步明显', '专注度高']);
});

test('模型复读完整词表：判无效、保留旧标签、回传 raw_preview', async () => {
  mock.state.tagReply = `可选标签：${VOCABULARY.join('、')}`;
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '这条会触发词表复读',
    ...llmBody(),
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.tags_updated, false);
  assert.equal(body.reason, 'INVALID_TAGS');
  assert.equal(body.echoed_vocabulary, true);
  assert.ok(body.raw_preview.includes(VOCABULARY[0]), 'raw_preview 应带模型原话');
  assert.ok(body.raw_preview.length <= 500);
  assert.deepEqual(body.tags, []);
});

test('标签全部无效：保留旧标签且 tags_updated:false', async () => {
  // 先写一组有效标签
  const first = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '第一次反馈',
    ...llmBody(),
  });
  assert.equal(first.json().tags_updated, true);
  const oldTags = first.json().tags;

  mock.state.tagReply = '{"tags":["完全不存在的标签","另一个瞎编"]}';
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '第二次反馈',
    ...llmBody(),
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.tags_updated, false);
  assert.equal(body.reason, 'INVALID_TAGS');
  assert.deepEqual(body.tags, oldTags);

  const detail = (await ctx.client.call('GET', `/api/students/${student.id}`)).json();
  assert.deepEqual(detail.tags, oldTags, '旧标签必须保留');
});

test('模型输出带代码块 / 前后废话也能解析', async () => {
  mock.state.tagReply = '好的，结果如下：\n```json\n{"tags": ["思维活跃"]}\n```';
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '课堂反应很快',
    ...llmBody(),
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().tags, ['思维活跃']);
  assert.equal(res.json().tags_updated, true);
});

test('标签更新失败不影响反馈保存（上游 500）', async () => {
  mock.state.failNextChat = 1;
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '这次模型会挂掉',
    ...llmBody(),
  });
  assert.equal(res.statusCode, 201, '反馈必须保存成功');
  const body = res.json();
  assert.equal(body.tags_updated, false);
  assert.equal(body.reason, 'LLM_UPSTREAM');
  assert.ok(body.feedback.id > 0);

  const list = (await ctx.client.call('GET', `/api/students/${student.id}/feedbacks`)).json();
  assert.equal(list.length, 1, '反馈已落库');
});

test('请求里不带大模型配置：反馈照存，tags_updated:false', async () => {
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '没配模型也要能记',
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().tags_updated, false);
  assert.equal(res.json().reason, 'LLM_NOT_CONFIGURED');
});

test('反馈参数校验 / 学生不存在', async () => {
  const empty = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, { content: '   ' });
  assert.equal(empty.statusCode, 400);

  const badTime = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '时间格式不对',
    happened_at: '昨天下午',
  });
  assert.equal(badTime.statusCode, 400);
  assert.equal(badTime.json().error, 'INVALID_HAPPENED_AT');

  const missing = await ctx.client.call('POST', '/api/students/999999/feedbacks', { content: 'x' });
  assert.equal(missing.statusCode, 404);
});

test('手动刷新标签：成功', async () => {
  await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '基础有点薄弱，但很努力',
    // 不带 llm ⇒ 保存时标签没更新
  });

  mock.state.tagReply = '{"tags":["基础薄弱","积极性高"]}';
  const res = await ctx.client.call('POST', `/api/students/${student.id}/tags/refresh`, llmBody());
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.tags_updated, true);
  assert.deepEqual(body.tags, ['基础薄弱', '积极性高']);
});

test('手动刷新标签：没有反馈时返回 NO_FEEDBACKS', async () => {
  const res = await ctx.client.call('POST', `/api/students/${student.id}/tags/refresh`, llmBody());
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tags_updated, false);
  assert.equal(res.json().reason, 'NO_FEEDBACKS');
});

test('手动刷新标签：上游失败返回 502 LLM_UPSTREAM', async () => {
  await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, { content: '有记录' });
  mock.state.failNextChat = 1;
  const res = await ctx.client.call('POST', `/api/students/${student.id}/tags/refresh`, llmBody());
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'LLM_UPSTREAM');
});

test('手动刷新标签：缺 llm 配置返回 400 LLM_NOT_CONFIGURED', async () => {
  const res = await ctx.client.call('POST', `/api/students/${student.id}/tags/refresh`, {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'LLM_NOT_CONFIGURED');
});

test('删除反馈：必须带 confirm，删完最后一条同时清空标签', async () => {
  const created = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '这条待删除',
    ...llmBody(),
  });
  assert.equal(created.statusCode, 201);
  const feedback = created.json().feedback;
  assert.deepEqual(created.json().tags, ['状态稳定', '专注度高']);

  const noConfirm = await ctx.client.call(
    'DELETE',
    `/api/students/${student.id}/feedbacks/${feedback.id}`,
  );
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(noConfirm.json().error, 'CONFIRM_REQUIRED');

  const res = await ctx.client.call(
    'DELETE',
    `/api/students/${student.id}/feedbacks/${feedback.id}`,
    { confirm: true },
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.deleted, 1);
  assert.equal(body.remaining, 0);
  assert.equal(body.tags_cleared, true);
  assert.deepEqual(body.tags, []);

  const list = await ctx.client.call('GET', `/api/students/${student.id}/feedbacks`);
  assert.deepEqual(list.json(), []);
  const detail = (await ctx.client.call('GET', `/api/students/${student.id}`)).json();
  assert.deepEqual(detail.tags, []);
  assert.equal(detail.tags_at, null);
});

test('删除反馈：只允许删本学生的记录，跨学生 404', async () => {
  const created = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '属于第一个学生',
  });
  const feedback = created.json().feedback;
  const other = await createStudent('另一个学生');

  const cross = await ctx.client.call(
    'DELETE',
    `/api/students/${other.id}/feedbacks/${feedback.id}`,
    { confirm: true },
  );
  assert.equal(cross.statusCode, 404);
  assert.equal(cross.json().error, 'NOT_FOUND');

  const ok = await ctx.client.call(
    'DELETE',
    `/api/students/${student.id}/feedbacks/${feedback.id}`,
    { confirm: true },
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().deleted, 1);
  assert.equal(ok.json().remaining, 0);
});
