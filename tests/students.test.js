import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, resetData } from './helpers/harness.js';

let ctx;

test.before(async () => {
  ctx = await createTestApp();
  const res = await ctx.login();
  assert.equal(res.statusCode, 200, '测试前置登录应成功');
});

test.beforeEach(() => {
  resetData(ctx.app);
});

test.after(async () => {
  await ctx.cleanup();
});

const post = (url, payload) => ctx.client.call('POST', url, payload);
const patch = (url, payload) => ctx.client.call('PATCH', url, payload);
const del = (url, payload) => ctx.client.call('DELETE', url, payload);

test('创建学生：姓名必填，学校可空，weekday 1-7', async () => {
  const res = await post('/api/students', { name: ' 张三 ', weekday: 1 });
  assert.equal(res.statusCode, 201);
  const student = res.json();
  assert.equal(student.name, '张三');
  assert.equal(student.school, null);
  assert.equal(student.weekday, 1);
  assert.deepEqual(student.tags, []);
  assert.ok(student.id > 0);
  assert.ok(student.sort > 0);
});

test('创建学生：参数校验（姓名空 / weekday 越界 / 缺 weekday）', async () => {
  for (const payload of [
    { name: '', weekday: 1 },
    { name: '   ', weekday: 1 },
    { name: '李四', weekday: 0 },
    { name: '李四', weekday: 8 },
    { name: '李四', weekday: 2.5 },
    { name: '李四' },
  ]) {
    const res = await post('/api/students', payload);
    assert.equal(res.statusCode, 400, `payload=${JSON.stringify(payload)}`);
    assert.equal(res.json().error, 'VALIDATION_ERROR');
  }
});

test('列表：按 weekday 升序、同栏按 sort 升序', async () => {
  await post('/api/students', { name: '周三生', weekday: 3 });
  await post('/api/students', { name: '周一A', weekday: 1 });
  await post('/api/students', { name: '周一B', weekday: 1 });

  const res = await ctx.client.call('GET', '/api/students');
  assert.equal(res.statusCode, 200);
  const list = res.json();
  assert.deepEqual(
    list.map((s) => `${s.weekday}:${s.name}`),
    ['1:周一A', '1:周一B', '3:周三生'],
  );
  // 同栏内 sort 递增
  const monday = list.filter((s) => s.weekday === 1);
  assert.ok(monday[0].sort < monday[1].sort);

  // 可选 weekday 过滤
  const filtered = await ctx.client.call('GET', '/api/students?weekday=3');
  assert.equal(filtered.json().length, 1);
});

test('编辑：姓名/学校局部更新，未传字段不动', async () => {
  const created = (await post('/api/students', { name: '王五', school: '实验小学', weekday: 2 })).json();

  const res = await patch(`/api/students/${created.id}`, { name: '王五五' });
  assert.equal(res.statusCode, 200);
  const updated = res.json();
  assert.equal(updated.name, '王五五');
  assert.equal(updated.school, '实验小学');
  assert.equal(updated.weekday, 2);

  const cleared = await patch(`/api/students/${created.id}`, { school: null });
  assert.equal(cleared.json().school, null);

  const bad = await patch(`/api/students/${created.id}`, {});
  assert.equal(bad.statusCode, 400);
});

test('改星期：未带 sort 时自动追加到目标栏末尾', async () => {
  const a = (await post('/api/students', { name: 'A', weekday: 1 })).json();
  const target1 = (await post('/api/students', { name: '目标1', weekday: 4 })).json();
  const target2 = (await post('/api/students', { name: '目标2', weekday: 4 })).json();
  assert.ok(target2.sort > target1.sort);

  const moved = await patch(`/api/students/${a.id}`, { weekday: 4 });
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.json().weekday, 4);
  assert.ok(moved.json().sort > target2.sort, '应追加到周四末尾');

  const list = (await ctx.client.call('GET', '/api/students?weekday=4')).json();
  assert.deepEqual(list.map((s) => s.name), ['目标1', '目标2', 'A']);
});

test('拖动换栏：显式 weekday + sort（取前后中点）直接生效', async () => {
  const a = (await post('/api/students', { name: '甲', weekday: 1 })).json();
  const b = (await post('/api/students', { name: '乙', weekday: 1 })).json();
  const c = (await post('/api/students', { name: '丙', weekday: 1 })).json();

  // 把丙拖到甲和乙中间：sort 取两者中点
  const mid = (a.sort + b.sort) / 2;
  const res = await patch(`/api/students/${c.id}`, { weekday: 1, sort: mid });
  assert.equal(res.statusCode, 200);

  const list = (await ctx.client.call('GET', '/api/students?weekday=1')).json();
  assert.deepEqual(list.map((s) => s.name), ['甲', '丙', '乙']);
});

test('详情：不存在返回 404', async () => {
  const res = await ctx.client.call('GET', '/api/students/999999');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'NOT_FOUND');
});

test('删除：必须 confirm:true，否则 400', async () => {
  const created = (await post('/api/students', { name: '待删', weekday: 5 })).json();

  const noConfirm = await del(`/api/students/${created.id}`, {});
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(noConfirm.json().error, 'VALIDATION_ERROR');

  const falseConfirm = await del(`/api/students/${created.id}`, { confirm: false });
  assert.equal(falseConfirm.statusCode, 400);

  // 还在
  assert.equal((await ctx.client.call('GET', `/api/students/${created.id}`)).statusCode, 200);
});

test('删除：事务级联删掉反馈与生成历史', async () => {
  const created = (await post('/api/students', { name: '小明', weekday: 6 })).json();
  const other = (await post('/api/students', { name: '小红', weekday: 6 })).json();

  // 直接通过 repo 造数据（生成历史不依赖 LLM）
  ctx.app.students.addFeedback(created.id, { content: '本周表现不错', happenedAt: Date.now() });
  ctx.app.students.addFeedback(created.id, { content: '作业有点拖拉', happenedAt: Date.now() });
  ctx.app.students.addGeneration(created.id, { content: '家长反馈草稿一', weeks: 1 });
  ctx.app.students.addGeneration(created.id, { content: '家长反馈草稿二', weeks: 2 });
  ctx.app.students.addFeedback(other.id, { content: '别的孩子的记录', happenedAt: Date.now() });

  const res = await del(`/api/students/${created.id}`, { confirm: true });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().deleted, { student: 1, feedbacks: 2, generations: 2 });

  // 学生没了
  assert.equal((await ctx.client.call('GET', `/api/students/${created.id}`)).statusCode, 404);
  // 级联删干净
  assert.equal(ctx.app.db.prepare('SELECT COUNT(*) n FROM feedbacks WHERE student_id = ?').get(created.id).n, 0);
  assert.equal(ctx.app.db.prepare('SELECT COUNT(*) n FROM generations WHERE student_id = ?').get(created.id).n, 0);
  // 别的学生数据不受影响
  assert.equal(ctx.app.db.prepare('SELECT COUNT(*) n FROM feedbacks WHERE student_id = ?').get(other.id).n, 1);
});

test('删除不存在的学生：404', async () => {
  const res = await del('/api/students/999999', { confirm: true });
  assert.equal(res.statusCode, 404);
});
