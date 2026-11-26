import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, resetData } from './helpers/harness.js';
import { startMockLlm } from './helpers/mock-llm.js';
import { parseSseBody } from '../server/lib/sse.js';
import { endOfWeek, startOfWeek } from '../server/lib/time.js';

let ctx;
let mock;
let student;

const llmBody = () => ({
  llm: { base_url: mock.baseUrl, api_key: 'sk-test-key', model: 'mock-small' },
});

async function addFeedback(content, happenedAt) {
  const res = await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content,
    happened_at: happenedAt,
    // 不带 llm：避免触发标签调用，专心测生成
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().feedback;
}

async function generate(weeks, extra = {}) {
  return ctx.client.call('POST', `/api/students/${student.id}/generate`, {
    weeks,
    ...llmBody(),
    ...extra,
  });
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
  mock.state.failNextChat = 0;
  mock.state.streamMode = 'sse';
  mock.state.reasoningText = '';
  mock.state.finishReason = 'stop';
  const res = await ctx.client.call('POST', '/api/students', { name: '生成测试', weekday: 3 });
  student = res.json();
});

test.after(async () => {
  await ctx.cleanup();
  await mock.close();
});

test('weeks 参数：只接受 1~20 整数', async () => {
  for (const weeks of [0, 21, -1, 1.5, 'abc']) {
    const res = await generate(weeks);
    assert.equal(res.statusCode, 400, `weeks=${weeks}`);
    assert.equal(res.json().error, 'VALIDATION_ERROR');
  }
});

test('区间无记录：409 NO_RECORDS，message 含提示语', async () => {
  const res = await generate(1);
  assert.equal(res.statusCode, 409);
  assert.match(res.headers['content-type'], /application\/json/);
  const body = res.json();
  assert.equal(body.error, 'NO_RECORDS');
  assert.ok(body.message.includes('本周无记录，建议调整参考时间范围'), `实际 message=${body.message}`);
  assert.ok(body.range && body.range.from < body.range.to);
});

test('生成成功：SSE start/delta/done，落库并返回完整内容', async () => {
  await addFeedback('课堂发言积极，作业完成质量高', Date.now());

  const res = await generate(1);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);

  const events = parseSseBody(res.body);
  const names = events.map((e) => e.event);
  assert.equal(names[0], 'start');
  assert.ok(names.filter((n) => n === 'delta').length >= 3, '应有多个 delta 事件');
  assert.equal(names.at(-1), 'done');

  const start = events[0].data;
  assert.equal(start.weeks, 1);
  assert.equal(start.feedbacks, 1);
  assert.equal(start.from, startOfWeek(Date.now()));
  assert.equal(start.to, endOfWeek(Date.now()));

  const done = events.at(-1).data;
  assert.ok(done.id > 0);
  assert.equal(done.weeks, 1);
  assert.equal(done.content, mock.state.chatReply);

  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.equal(text, mock.state.chatReply, 'delta 拼接应等于 done.content');

  // 落库
  const history = (await ctx.client.call('GET', `/api/students/${student.id}/generations`)).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].content, mock.state.chatReply);
  assert.equal(history[0].weeks, 1);

  // 请求体确实带上了区间内反馈
  const chatReq = mock.requests.filter((r) => r.url.includes('/chat/completions')).at(-1);
  const userPrompt = chatReq.body.messages.find((m) => m.role === 'user').content;
  assert.ok(userPrompt.includes('课堂发言积极'), '提示词应包含反馈原文');
  assert.equal(chatReq.body.stream, true);
  assert.equal(chatReq.body.model, 'mock-small');
  assert.equal(chatReq.body.max_tokens, 4096, '推理模型需要更大的输出预算');
});

test('推理模型：delta.reasoning 不进入正文，只拼 content', async () => {
  await addFeedback('需要推理模型的记录', Date.now());
  mock.state.reasoningText = '这是模型内部的思考过程，绝不应该出现在给家长的反馈里。';
  mock.state.chatReply = '真正的家长反馈内容。';

  const res = await generate(1);
  assert.equal(res.statusCode, 200);
  const events = parseSseBody(res.body);
  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.at(-1).data.content, '真正的家长反馈内容。');

  const deltaText = events
    .filter((e) => e.event === 'delta')
    .map((e) => e.data.text)
    .join('');
  assert.equal(deltaText, '真正的家长反馈内容。');
  assert.ok(!res.body.includes('思考过程'), 'reasoning 不应出现在 SSE 正文里');
});

test('finish_reason=length：LLM_TRUNCATED，SSE error 且不落库', async () => {
  await addFeedback('会被截断的一次生成', Date.now());
  mock.state.chatReply = '只有半截的家长反馈';
  mock.state.finishReason = 'length';

  const res = await generate(1);
  assert.equal(res.statusCode, 200);
  const events = parseSseBody(res.body);
  const last = events.at(-1);
  assert.equal(last.event, 'error');
  assert.equal(last.data.error, 'LLM_TRUNCATED');
  assert.equal(last.data.message, '模型输出达到长度上限，内容不完整，请重试或缩短参考范围');

  const history = (await ctx.client.call('GET', `/api/students/${student.id}/generations`)).json();
  assert.equal(history.length, 0, '截断内容不能写历史');
  const dbCount = ctx.app.db
    .prepare('SELECT COUNT(*) AS n FROM generations WHERE student_id = ?')
    .get(student.id).n;
  assert.equal(dbCount, 0);
});

test('生成历史：最多保留最近 5 条（倒序）', async () => {
  await addFeedback('稳定的一条记录', Date.now());

  for (let i = 1; i <= 7; i += 1) {
    mock.state.chatReply = `第 ${i} 份家长反馈`;
    const res = await generate(1);
    assert.equal(res.statusCode, 200);
    const events = parseSseBody(res.body);
    assert.equal(events.at(-1).event, 'done', `第 ${i} 次生成应成功：${res.body.slice(0, 200)}`);
  }

  const history = (await ctx.client.call('GET', `/api/students/${student.id}/generations`)).json();
  assert.equal(history.length, 5, '接口只返回最近 5 条');
  assert.deepEqual(
    history.map((g) => g.content),
    ['第 7 份家长反馈', '第 6 份家长反馈', '第 5 份家长反馈', '第 4 份家长反馈', '第 3 份家长反馈'],
  );
  const dbCount = ctx.app.db
    .prepare('SELECT COUNT(*) AS n FROM generations WHERE student_id = ?')
    .get(student.id).n;
  assert.equal(dbCount, 5, '数据库里也只留 5 条');
});

test('周区间边界：本周一 00:00 与本周日 23:59:59.999 都算本周', async () => {
  const monday = startOfWeek(Date.now());
  const sundayEnd = endOfWeek(Date.now());
  const beforeMonday = monday - 1;

  // 上周日最后一毫秒（不属于本周）
  await addFeedback('上周日的记录', beforeMonday);
  // 本周一 00:00 整
  await addFeedback('周一零点的记录', monday);
  // 本周日 23:59:59.999
  await addFeedback('周日最后一刻的记录', sundayEnd);

  const res = await generate(1);
  assert.equal(res.statusCode, 200);
  const start = parseSseBody(res.body).find((e) => e.event === 'start');
  assert.equal(start.data.feedbacks, 2, '只应命中本周的两条');

  const chatReq = mock.requests.filter((r) => r.url.includes('/chat/completions')).at(-1);
  const prompt = chatReq.body.messages.find((m) => m.role === 'user').content;
  assert.ok(prompt.includes('周一零点的记录'));
  assert.ok(prompt.includes('周日最后一刻的记录'));
  assert.ok(!prompt.includes('上周日的记录'));
});

test('周区间：weeks=2 时包含上周记录', async () => {
  const monday = startOfWeek(Date.now());
  const lastSunday = monday - 1;
  await addFeedback('上周日的记录', lastSunday);
  await addFeedback('本周一的记录', monday);

  const res = await generate(2);
  assert.equal(res.statusCode, 200);
  const start = parseSseBody(res.body).find((e) => e.event === 'start');
  assert.equal(start.data.feedbacks, 2);
  assert.equal(start.data.from, monday - 7 * 24 * 3600 * 1000);
});

test('上游失败：SSE 返回 error 事件（LLM_UPSTREAM），不落库', async () => {
  await addFeedback('会失败的一次', Date.now());
  mock.state.failNextChat = 1;

  const res = await generate(1);
  assert.equal(res.statusCode, 200);
  const events = parseSseBody(res.body);
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.error, 'LLM_UPSTREAM');

  const history = (await ctx.client.call('GET', `/api/students/${student.id}/generations`)).json();
  assert.equal(history.length, 0, '失败不应写历史');
});

test('上游忽略 stream 直接回 JSON：仍能生成', async () => {
  await addFeedback('兼容性测试', Date.now());
  mock.state.streamMode = 'json';
  mock.state.chatReply = '整包 JSON 返回的家长反馈内容。';

  const res = await generate(1);
  assert.equal(res.statusCode, 200);
  const events = parseSseBody(res.body);
  const done = events.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.content, '整包 JSON 返回的家长反馈内容。');
});

test('JSON 兜底同样记录 finish_reason：length 仍报 LLM_TRUNCATED', async () => {
  await addFeedback('JSON 兜底截断测试', Date.now());
  mock.state.streamMode = 'json';
  mock.state.finishReason = 'length';
  mock.state.chatReply = '半截内容';

  const res = await generate(1);
  assert.equal(res.statusCode, 200);
  const events = parseSseBody(res.body);
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.error, 'LLM_TRUNCATED');
  const history = (await ctx.client.call('GET', `/api/students/${student.id}/generations`)).json();
  assert.equal(history.length, 0);
});

test('删除生成历史：缺 confirm 返回 400 CONFIRM_REQUIRED', async () => {
  const gen = ctx.app.students.addGeneration(student.id, { content: '待删除的历史', weeks: 1 });

  for (const body of [undefined, {}, { confirm: false }, { confirm: 'true' }]) {
    const res = await ctx.client.call(
      'DELETE',
      `/api/students/${student.id}/generations/${gen.id}`,
      body,
    );
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, 'CONFIRM_REQUIRED');
  }

  const history = (await ctx.client.call('GET', `/api/students/${student.id}/generations`)).json();
  assert.equal(history.length, 1, '未确认时不能删');
});

test('删除生成历史：confirm 后成功删除，列表少一条', async () => {
  const first = ctx.app.students.addGeneration(student.id, { content: '第一条', weeks: 1 });
  const second = ctx.app.students.addGeneration(student.id, { content: '第二条', weeks: 2 });

  const res = await ctx.client.call(
    'DELETE',
    `/api/students/${student.id}/generations/${first.id}`,
    { confirm: true },
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, deleted: 1 });

  const history = (await ctx.client.call('GET', `/api/students/${student.id}/generations`)).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].id, second.id);

  // 再删一次已不存在的记录 → 404
  const again = await ctx.client.call(
    'DELETE',
    `/api/students/${student.id}/generations/${first.id}`,
    { confirm: true },
  );
  assert.equal(again.statusCode, 404);
});

test('删除生成历史：不能删别的学生的记录', async () => {
  const other = (await ctx.client.call('POST', '/api/students', { name: '别的学生', weekday: 4 })).json();
  const gen = ctx.app.students.addGeneration(other.id, { content: '别的学生的历史', weeks: 1 });

  const res = await ctx.client.call(
    'DELETE',
    `/api/students/${student.id}/generations/${gen.id}`,
    { confirm: true },
  );
  assert.equal(res.statusCode, 404);

  const otherHistory = (await ctx.client.call('GET', `/api/students/${other.id}/generations`)).json();
  assert.equal(otherHistory.length, 1, '别人的记录不能被删');
});

test('删除生成历史：学生不存在 404；未登录 401', async () => {
  const missing = await ctx.client.call(
    'DELETE',
    `/api/students/999999/generations/1`,
    { confirm: true },
  );
  assert.equal(missing.statusCode, 404);

  const gen = ctx.app.students.addGeneration(student.id, { content: '鉴权测试', weeks: 1 });
  const anon = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/students/${student.id}/generations/${gen.id}`,
    headers: { 'content-type': 'application/json' },
    payload: { confirm: true },
  });
  assert.equal(anon.statusCode, 401);
});

test('生成：缺模型名 / 缺凭据 → 400（不进 SSE）', async () => {
  await addFeedback('有记录', Date.now());

  const noModel = await ctx.client.call('POST', `/api/students/${student.id}/generate`, {
    weeks: 1,
    llm: { base_url: mock.baseUrl, api_key: 'sk-test-key' },
  });
  assert.equal(noModel.statusCode, 400);
  assert.equal(noModel.json().error, 'LLM_NO_MODEL');

  const noCred = await ctx.client.call('POST', `/api/students/${student.id}/generate`, { weeks: 1 });
  assert.equal(noCred.statusCode, 400);
  assert.equal(noCred.json().error, 'LLM_NOT_CONFIGURED');
});

test('生成：学生不存在 404', async () => {
  const res = await ctx.client.call('POST', '/api/students/999999/generate', {
    weeks: 1,
    ...llmBody(),
  });
  assert.equal(res.statusCode, 404);
});
