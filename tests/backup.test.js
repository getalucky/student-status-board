import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTestApp, resetData } from './helpers/harness.js';

const BACKUP_SCHEMA = 'student-status-board/backup';
const LLM_KEY = '{{SECRET_bk7p4q2m}}';

let ctx;

async function createStudent(payload) {
  const res = await ctx.client.call('POST', '/api/students', payload);
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function makeBackup(students) {
  return {
    schema: BACKUP_SCHEMA,
    version: 1,
    exported_at: Date.now(),
    students,
  };
}

test.before(async () => {
  ctx = await createTestApp();
  const login = await ctx.login();
  assert.equal(login.statusCode, 200);
});

test.beforeEach(() => {
  resetData(ctx.app);
});

test.after(async () => {
  await ctx.cleanup();
});

test('单学生导出：结构、时间排序、最近 5 条生成历史、无 Key', async () => {
  const student = await createStudent({ name: '导出学生', school: '实验小学', weekday: 2 });
  ctx.app.students.setTags(student.id, ['状态稳定', '专注度高'], 1_700_000_000_000);

  // 两条反馈：后写的 happened_at 更晚，导出应按发生时间从早到晚
  await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '较早的反馈',
    happened_at: Date.parse('2026-11-01T10:00:00+08:00'),
  });
  await ctx.client.call('POST', `/api/students/${student.id}/feedbacks`, {
    content: '较晚的反馈',
    happened_at: Date.parse('2026-11-02T10:00:00+08:00'),
  });

  // 直接插 6 条生成历史，导出只应保留最近 5 条（created_at desc）
  const insertGen = ctx.app.db.prepare(
    'INSERT INTO generations (student_id, content, weeks, created_at) VALUES (?, ?, ?, ?)',
  );
  for (let i = 1; i <= 6; i += 1) {
    insertGen.run(student.id, `历史${i}`, 1, 1_700_000_000_000 + i * 1000);
  }

  const res = await ctx.client.call('GET', `/api/backup/export?studentId=${student.id}`);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.match(
    res.headers['content-disposition'],
    /^attachment; filename="student-status-board-\d{4}-\d{2}-\d{2}\.json"$/,
  );

  const body = res.json();
  assert.equal(body.schema, BACKUP_SCHEMA);
  assert.equal(body.version, 1);
  assert.equal(typeof body.exported_at, 'number');
  assert.equal(body.students.length, 1);

  const exported = body.students[0];
  assert.equal(exported.name, '导出学生');
  assert.equal(exported.school, '实验小学');
  assert.equal(exported.weekday, 2);
  assert.deepEqual(exported.tags, ['状态稳定', '专注度高']);
  assert.equal(exported.tags_at, 1_700_000_000_000);
  assert.equal('id' in exported, false);
  assert.deepEqual(exported.feedbacks.map((f) => f.content), ['较早的反馈', '较晚的反馈']);
  assert.deepEqual(exported.generations.map((g) => g.content), ['历史6', '历史5', '历史4', '历史3', '历史2']);
  assert.equal(JSON.stringify(body).includes(LLM_KEY), false);
  assert.equal(JSON.stringify(body).includes('api_key'), false);
});

test('全量导出：包含所有学生，按 weekday/sort 返回', async () => {
  await createStudent({ name: '周一甲', weekday: 1 });
  await createStudent({ name: '周三乙', weekday: 3 });
  await createStudent({ name: '周一丙', weekday: 1 });

  const res = await ctx.client.call('GET', '/api/backup/export');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.students.length, 3);
  assert.deepEqual(body.students.map((s) => s.name), ['周一甲', '周一丙', '周三乙']);
});

test('导出不含模型设置/API Key；单个学生不存在 404', async () => {
  await ctx.client.call('PUT', '/api/llm/config', {
    base_url: 'http://127.0.0.1:65535/v1',
    model: 'mock-small',
    api_key: LLM_KEY,
  });
  const res = await ctx.client.call('GET', '/api/backup/export');
  assert.equal(res.statusCode, 200);
  const text = res.body;
  assert.equal(text.includes(LLM_KEY), false);
  assert.equal(text.includes('llm_config'), false);
  assert.equal(text.includes('base_url'), false);

  const missing = await ctx.client.call('GET', '/api/backup/export?studentId=999999');
  assert.equal(missing.statusCode, 404);
});

test('导入 new：新建学生、反馈、生成历史，sort 追加到目标星期末尾', async () => {
  const existing = await createStudent({ name: '原有学生', weekday: 4 });
  const data = makeBackup([
    {
      name: '导入新生',
      school: '导入学校',
      weekday: 4,
      sort: 0, // new 模式必须忽略此值，按目标栏末尾追加
      tags: ['状态稳定'],
      tags_at: 1_700_000_000_000,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      feedbacks: [
        { content: '导入反馈一', happened_at: 1_700_000_001_000 },
        { content: '导入反馈二', happened_at: 1_700_000_002_000 },
      ],
      generations: [{ content: '导入生成', weeks: 2, created_at: 1_700_000_003_000 }],
    },
  ]);

  const res = await ctx.client.call('POST', '/api/backup/import', { data, conflict: 'new' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.students, 1);
  assert.equal(body.feedbacks, 2);
  assert.equal(body.generations, 1);
  assert.equal(body.overwritten, 0);
  assert.equal(body.created, 1);
  assert.match(body.backup_file, /^data\/backups\/pre-import-/, '导入前应自动快照当前库');

  const list = (await ctx.client.call('GET', '/api/students?weekday=4')).json();
  const imported = list.find((s) => s.name === '导入新生');
  assert.ok(imported);
  assert.equal(imported.school, '导入学校');
  assert.deepEqual(imported.tags, ['状态稳定']);
  assert.ok(imported.sort > existing.sort, 'new 应追加到目标栏末尾');

  const feedbacks = (await ctx.client.call('GET', `/api/students/${imported.id}/feedbacks`)).json();
  assert.deepEqual(feedbacks.map((f) => f.content), ['导入反馈二', '导入反馈一']);
  const generations = (await ctx.client.call('GET', `/api/students/${imported.id}/generations`)).json();
  assert.equal(generations.length, 1);
  assert.equal(generations[0].content, '导入生成');
});

test('导入 overwrite：必须确认；确认后更新信息/标签并替换旧反馈与生成', async () => {
  const old = await createStudent({ name: '覆盖学生', school: null, weekday: 1 });
  ctx.app.students.setTags(old.id, ['旧标签'], 1_600_000_000_000);
  await ctx.client.call('POST', `/api/students/${old.id}/feedbacks`, {
    content: '旧反馈',
    happened_at: 1_600_000_001_000,
  });
  ctx.app.students.addGeneration(old.id, { content: '旧生成', weeks: 1 });

  const data = makeBackup([
    {
      name: '覆盖学生',
      school: '', // school 空字符串与旧数据的 null 视为相同
      weekday: 5,
      sort: 9,
      tags: ['新标签一', '新标签二'],
      tags_at: 1_700_000_000_000,
      created_at: 1_500_000_000_000,
      updated_at: 1_700_000_000_000,
      feedbacks: [{ content: '新反馈', happened_at: 1_700_000_001_000 }],
      generations: [{ content: '新生成', weeks: 3, created_at: 1_700_000_002_000 }],
    },
  ]);

  const noConfirm = await ctx.client.call('POST', '/api/backup/import', {
    data,
    conflict: 'overwrite',
  });
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(noConfirm.json().error, 'CONFIRM_REQUIRED');

  // 未确认前数据不变
  assert.equal(
    (await ctx.client.call('GET', `/api/students/${old.id}/feedbacks`)).json().length,
    1,
  );

  const res = await ctx.client.call('POST', '/api/backup/import', {
    data,
    conflict: 'overwrite',
    confirm_overwrite: true,
  });
  assert.equal(res.statusCode, 200);
  const result = res.json();
  assert.equal(result.ok, true);
  assert.equal(result.overwritten, 1);
  assert.equal(result.created, 0);
  assert.equal(result.students, 1);
  assert.equal(result.feedbacks, 1);
  assert.equal(result.generations, 1);

  const list = (await ctx.client.call('GET', '/api/students')).json();
  assert.equal(list.length, 1, 'overwrite 不能产生重复学生');
  const updated = list[0];
  assert.equal(updated.weekday, 5);
  assert.equal(updated.sort, 9);
  assert.deepEqual(updated.tags, ['新标签一', '新标签二']);

  const feedbacks = (await ctx.client.call('GET', `/api/students/${old.id}/feedbacks`)).json();
  assert.deepEqual(feedbacks.map((f) => f.content), ['新反馈']);
  const generations = (await ctx.client.call('GET', `/api/students/${old.id}/generations`)).json();
  assert.deepEqual(generations.map((g) => g.content), ['新生成']);
});

test('导入校验：版本/schema/学生字段/反馈生成字段非法 → 400 INVALID_BACKUP', async () => {
  const badCases = [
    { schema: 'wrong', version: 1, students: [] },
    { schema: BACKUP_SCHEMA, version: 2, students: [] },
    { schema: BACKUP_SCHEMA, version: 1, students: 'not-array' },
    makeBackup([{ name: '', weekday: 1 }]),
    makeBackup([{ name: '甲', weekday: 8 }]),
    makeBackup([{ name: '甲', weekday: 1, feedbacks: [{ content: 123, happened_at: 1 }] }]),
    makeBackup([{ name: '甲', weekday: 1, feedbacks: [{ content: 'x', happened_at: 'bad' }] }]),
    makeBackup([{ name: '甲', weekday: 1, generations: [{ content: 'x', weeks: 0, created_at: 1 }] }]),
    makeBackup([{ name: '甲', weekday: 1, generations: [{ content: 'x', weeks: 1, created_at: 'bad' }] }]),
  ];

  for (const data of badCases) {
    const res = await ctx.client.call('POST', '/api/backup/import', { data, conflict: 'new' });
    assert.equal(res.statusCode, 400, JSON.stringify(data));
    assert.equal(res.json().error, 'INVALID_BACKUP');
  }
  assert.equal((await ctx.client.call('GET', '/api/students')).json().length, 0);
});

test('导入中途第二条非法：事务回滚，第一条也不入库', async () => {
  const data = makeBackup([
    { name: '第一条合法', weekday: 1, feedbacks: [], generations: [] },
    { name: '第二条非法', weekday: 99, feedbacks: [], generations: [] },
  ]);
  const res = await ctx.client.call('POST', '/api/backup/import', { data, conflict: 'new' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'INVALID_BACKUP');

  const students = (await ctx.client.call('GET', '/api/students')).json();
  assert.equal(students.length, 0, '事务应整体回滚');
});

test('导入：同名同校检测（不同 conflict 行为）', async () => {
  const existing = await createStudent({ name: '同名同校', school: '同一学校', weekday: 1 });
  const data = makeBackup([
    { name: '同名同校', school: '同一学校', weekday: 2, tags: [], feedbacks: [], generations: [] },
  ]);

  // new：即便同名同校也新建一个
  const created = await ctx.client.call('POST', '/api/backup/import', { data, conflict: 'new' });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().created, 1);
  assert.equal(created.json().overwritten, 0);
  assert.equal((await ctx.client.call('GET', '/api/students')).json().length, 2);

  // overwrite：识别冲突并覆盖原学生
  const overwritten = await ctx.client.call('POST', '/api/backup/import', {
    data,
    conflict: 'overwrite',
    confirm_overwrite: true,
  });
  assert.equal(overwritten.statusCode, 200);
  assert.equal(overwritten.json().overwritten, 1);
  assert.equal((await ctx.client.call('GET', '/api/students')).json().length, 2);
});

test('备份接口未登录 401；冲突参数非法 400', async () => {
  const anon = await createTestApp();
  try {
    const exportRes = await anon.client.call('GET', '/api/backup/export');
    assert.equal(exportRes.statusCode, 401);
    const importRes = await anon.client.call('POST', '/api/backup/import', {
      data: makeBackup([]),
      conflict: 'new',
    });
    assert.equal(importRes.statusCode, 401);
  } finally {
    await anon.cleanup();
  }

  const badConflict = await ctx.client.call('POST', '/api/backup/import', {
    data: makeBackup([]),
    conflict: 'replace',
  });
  assert.equal(badConflict.statusCode, 400);
  assert.equal(badConflict.json().error, 'VALIDATION_ERROR');
});

test('导入预览：列出同名同校冲突、现有条数与摘要', async () => {
  const existing = await createStudent({ name: '预览学生', school: '实验小学', weekday: 2 });
  await ctx.client.call('POST', `/api/students/${existing.id}/feedbacks`, { content: '旧反馈' });
  ctx.app.students.addGeneration(existing.id, { content: '旧生成', weeks: 1 });

  const data = makeBackup([
    {
      name: '预览学生',
      school: '实验小学',
      weekday: 2,
      feedbacks: [{ content: '新反馈', happened_at: 1_700_000_001_000 }],
      generations: [],
    },
  ]);

  const res = await ctx.client.call('POST', '/api/backup/preview', { data });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.summary.students, 1);
  assert.equal(body.summary.feedbacks, 1);
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].index, 0);
  assert.equal(body.conflicts[0].name, '预览学生');
  assert.equal(body.conflicts[0].school, '实验小学');
  assert.equal(body.conflicts[0].existing.id, existing.id);
  assert.equal(body.conflicts[0].existing.feedbacks, 1);
  assert.equal(body.conflicts[0].existing.generations, 1);
});

test('导入 decisions：逐条选择覆盖/新建，未确认覆盖则拒绝', async () => {
  const a = await createStudent({ name: '甲同学', school: '同一学校', weekday: 1 });
  const b = await createStudent({ name: '乙同学', school: '同一学校', weekday: 3 });
  ctx.app.students.setTags(a.id, ['旧甲'], 1_600_000_000_000);
  ctx.app.students.setTags(b.id, ['旧乙'], 1_600_000_000_000);

  const data = makeBackup([
    { name: '甲同学', school: '同一学校', weekday: 4, tags: ['新甲'], feedbacks: [], generations: [] },
    { name: '乙同学', school: '同一学校', weekday: 5, tags: ['新乙'], feedbacks: [], generations: [] },
  ]);
  const decisions = [
    { index: 0, action: 'overwrite' },
    { index: 1, action: 'new' },
  ];

  const noConfirm = await ctx.client.call('POST', '/api/backup/import', { data, decisions });
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(noConfirm.json().error, 'CONFIRM_REQUIRED');

  const res = await ctx.client.call('POST', '/api/backup/import', {
    data,
    decisions,
    confirm_overwrite: true,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.overwritten, 1);
  assert.equal(body.created, 1);

  const list = (await ctx.client.call('GET', '/api/students')).json();
  const first = list.find((s) => s.id === a.id);
  assert.equal(first.weekday, 4);
  assert.deepEqual(first.tags, ['新甲']);
  const second = list.filter((s) => s.name === '乙同学');
  assert.equal(second.length, 2, '选择新建应保留旧卡片并追加新卡片');
  assert.ok(second.some((s) => s.id === b.id && s.weekday === 3));
  assert.ok(second.some((s) => s.weekday === 5));
});

test('导入前快照：文件落在 data/backups，内容是导入前的库', async () => {
  const existing = await createStudent({ name: '快照学生', weekday: 6 });
  const data = makeBackup([
    { name: '新学生', school: null, weekday: 6, feedbacks: [], generations: [] },
  ]);

  const res = await ctx.client.call('POST', '/api/backup/import', { data });
  assert.equal(res.statusCode, 200);
  const relative = res.json().backup_file;
  assert.match(relative, /^data\/backups\/pre-import-.*\.db$/);

  const file = path.join(ctx.dataDir, 'backups', path.basename(relative));
  assert.ok(fs.existsSync(file), `快照文件应存在：${file}`);
  const snapshot = new Database(file, { readonly: true });
  try {
    const names = snapshot.prepare('SELECT name FROM students ORDER BY id').all().map((row) => row.name);
    assert.deepEqual(names, ['快照学生'], '快照应是导入前的数据');
  } finally {
    snapshot.close();
  }
  assert.ok(ctx.app.students.get(existing.id));
});
