/**
 * 备份导出 / 导入（M5）。
 *
 * 导出只含业务数据（学生 / 反馈 / 生成历史），绝不包含大模型 api_key 或 app_settings。
 * 导入先校验，再在一个 better-sqlite3 事务里逐条写入；任何一条不合规或写库失败都整体回滚。
 * 导入前会先把当前库快照到 data/backups/pre-import-*.db，覆盖导入也能找回旧数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError, badRequest } from './errors.js';

export const BACKUP_SCHEMA = 'student-status-board/backup';
export const BACKUP_VERSION = 1;
const MAX_GENERATIONS_EXPORT = 5;

function invalidBackup(message) {
  return new AppError(400, 'INVALID_BACKUP', message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 导出单个学生或全部学生（同一个结构）。
 * @param {ReturnType<import('./students.js').createStudentRepo>} repo
 * @param {{studentId?: number}} [options]
 * @returns {{schema: string, version: number, exported_at: number, students: object[]}}
 */
export function buildBackup(repo, { studentId } = {}) {
  const students = studentId === undefined || studentId === null
    ? repo.list()
    : [repo.mustGet(studentId)];

  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exported_at: Date.now(),
    students: students.map((student) => ({
      name: student.name,
      school: student.school ?? null,
      weekday: student.weekday,
      sort: student.sort,
      tags: [...student.tags],
      tags_at: student.tags_at,
      created_at: student.created_at,
      updated_at: student.updated_at,
      // 反馈按时间从早到晚
      feedbacks: repo
        .feedbacks(student.id)
        .slice()
        .reverse()
        .map((item) => ({ content: item.content, happened_at: item.happened_at })),
      // 生成历史只导最近 5 条（repo.generations 已按 created_at desc, id desc）
      generations: repo
        .generations(student.id, MAX_GENERATIONS_EXPORT)
        .map((item) => ({ content: item.content, weeks: item.weeks, created_at: item.created_at })),
    })),
  };
}

function optionalFiniteNumber(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidBackup(`${label} 必须是数字`);
  }
  return value;
}

function normalizeFeedback(raw, index, studentLabel) {
  const label = `${studentLabel}.feedbacks[${index}]`;
  if (!isPlainObject(raw)) throw invalidBackup(`${label} 必须是对象`);
  if (typeof raw.content !== 'string' || !raw.content.trim()) {
    throw invalidBackup(`${label}.content 必须是非空字符串`);
  }
  if (typeof raw.happened_at !== 'number' || !Number.isFinite(raw.happened_at)) {
    throw invalidBackup(`${label}.happened_at 必须是数字`);
  }
  return { content: raw.content, happened_at: raw.happened_at };
}

function normalizeGeneration(raw, index, studentLabel) {
  const label = `${studentLabel}.generations[${index}]`;
  if (!isPlainObject(raw)) throw invalidBackup(`${label} 必须是对象`);
  if (typeof raw.content !== 'string' || !raw.content.trim()) {
    throw invalidBackup(`${label}.content 必须是非空字符串`);
  }
  if (!Number.isInteger(raw.weeks) || raw.weeks < 1 || raw.weeks > 20) {
    throw invalidBackup(`${label}.weeks 必须是 1~20 的整数`);
  }
  if (typeof raw.created_at !== 'number' || !Number.isFinite(raw.created_at)) {
    throw invalidBackup(`${label}.created_at 必须是数字`);
  }
  return { content: raw.content, weeks: raw.weeks, created_at: raw.created_at };
}

function normalizeStudent(raw, index) {
  const label = `students[${index}]`;
  if (!isPlainObject(raw)) throw invalidBackup(`${label} 必须是对象`);

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw invalidBackup(`${label}.name 必须是非空字符串`);

  if (!Number.isInteger(raw.weekday) || raw.weekday < 1 || raw.weekday > 7) {
    throw invalidBackup(`${label}.weekday 必须是 1~7 的整数`);
  }

  let school = null;
  if (raw.school !== undefined && raw.school !== null) {
    if (typeof raw.school !== 'string') throw invalidBackup(`${label}.school 必须是字符串或 null`);
    school = raw.school.trim() ? raw.school.trim() : null;
  }

  let sort = null;
  if (raw.sort !== undefined && raw.sort !== null) {
    if (typeof raw.sort !== 'number' || !Number.isFinite(raw.sort)) {
      throw invalidBackup(`${label}.sort 必须是数字`);
    }
    sort = raw.sort;
  }

  if (raw.tags !== undefined && !Array.isArray(raw.tags)) {
    throw invalidBackup(`${label}.tags 必须是数组`);
  }
  const tags = [];
  for (const [tagIndex, tag] of (raw.tags ?? []).entries()) {
    if (typeof tag !== 'string') {
      throw invalidBackup(`${label}.tags[${tagIndex}] 必须是字符串`);
    }
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
  }

  const tagsAt = optionalFiniteNumber(raw.tags_at, `${label}.tags_at`, null);
  const createdAt = optionalFiniteNumber(raw.created_at, `${label}.created_at`, null);
  const updatedAt = optionalFiniteNumber(raw.updated_at, `${label}.updated_at`, null);

  if (raw.feedbacks !== undefined && !Array.isArray(raw.feedbacks)) {
    throw invalidBackup(`${label}.feedbacks 必须是数组`);
  }
  if (raw.generations !== undefined && !Array.isArray(raw.generations)) {
    throw invalidBackup(`${label}.generations 必须是数组`);
  }

  const feedbacks = (raw.feedbacks ?? []).map((item, i) => normalizeFeedback(item, i, label));
  const generations = (raw.generations ?? []).map((item, i) => normalizeGeneration(item, i, label));

  return {
    name,
    school,
    weekday: raw.weekday,
    sort,
    tags,
    tags_at: tagsAt,
    created_at: createdAt,
    updated_at: updatedAt,
    feedbacks,
    generations,
  };
}

function validateEnvelope(data) {
  if (!isPlainObject(data)) throw invalidBackup('备份数据必须是对象');
  if (data.schema !== BACKUP_SCHEMA) throw invalidBackup('备份 schema 不匹配');
  if (data.version !== BACKUP_VERSION) throw invalidBackup('不支持的备份版本');
  if (!Array.isArray(data.students)) throw invalidBackup('students 必须是数组');
}

/**
 * 校验整份备份并归一化每个学生（纯函数，不写库）。
 * @returns {{students: object[], exportedAt: number|null}}
 */
export function normalizeBackup(data) {
  validateEnvelope(data);
  const students = data.students.map((student, index) => normalizeStudent(student, index));
  const exportedAt =
    typeof data.exported_at === 'number' && Number.isFinite(data.exported_at)
      ? data.exported_at
      : null;
  return { students, exportedAt };
}

function countExisting(db, studentId) {
  return {
    feedbacks: Number(
      db.prepare('SELECT COUNT(*) AS n FROM feedbacks WHERE student_id = ?').get(studentId).n,
    ),
    generations: Number(
      db.prepare('SELECT COUNT(*) AS n FROM generations WHERE student_id = ?').get(studentId).n,
    ),
  };
}

/**
 * 导入前预览：校验文件，列出同名同校冲突，供前端逐条选择覆盖/新建。
 * @returns {{summary: {students:number, feedbacks:number, generations:number, exported_at:number|null},
 *            conflicts: Array<{index:number, name:string, school:string|null, weekday:number,
 *                              existing:{id:number, feedbacks:number, generations:number}}>}}
 */
export function previewBackup(db, data) {
  const normalized = normalizeBackup(data);
  const find = db.prepare(
    `SELECT * FROM students
      WHERE name = ? AND COALESCE(school, '') = ?
      ORDER BY id ASC LIMIT 1`,
  );

  let feedbacks = 0;
  let generations = 0;
  const conflicts = [];

  normalized.students.forEach((student, index) => {
    feedbacks += student.feedbacks.length;
    generations += student.generations.length;
    const existing = find.get(student.name, student.school ?? '');
    if (existing) {
      const counts = countExisting(db, existing.id);
      conflicts.push({
        index,
        name: student.name,
        school: student.school,
        weekday: student.weekday,
        existing: { id: Number(existing.id), ...counts },
      });
    }
  });

  return {
    summary: {
      students: normalized.students.length,
      feedbacks,
      generations,
      exported_at: normalized.exportedAt,
    },
    conflicts,
  };
}

/**
 * 导入前把当前库快照到 data/backups/pre-import-*.db。
 * 放在数据目录的 backups 下，和每日 SQLite 备份同一处；只保留最近 10 份。
 * @returns {Promise<string|null>} 备份文件绝对路径（:memory: 库返回 null）
 */
export async function snapshotBeforeImport(db, cfg, now = Date.now()) {
  if (!cfg || cfg.dbPath === ':memory:') return null;
  const dir = path.join(cfg.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `pre-import-${stamp}.db`);

  await db.backup(file);

  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^pre-import-.*\.db$/.test(name))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - 10))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    /* 清理旧快照失败不影响导入 */
  }

  return file;
}

function normalizeDecisions(decisions, studentCount) {
  if (decisions === undefined || decisions === null) return new Map();
  if (!Array.isArray(decisions)) {
    throw badRequest('decisions 必须是数组', 'VALIDATION_ERROR');
  }
  const map = new Map();
  for (const raw of decisions) {
    if (!isPlainObject(raw)) {
      throw badRequest('decisions 每一项必须是 {index, action} 对象', 'VALIDATION_ERROR');
    }
    const index = raw.index;
    if (!Number.isInteger(index) || index < 0 || index >= studentCount) {
      throw badRequest(`decisions.index 超出范围：${String(raw.index)}`, 'VALIDATION_ERROR');
    }
    if (raw.action !== 'new' && raw.action !== 'overwrite') {
      throw badRequest('decisions.action 只能是 new 或 overwrite', 'VALIDATION_ERROR');
    }
    if (map.has(index)) {
      throw badRequest(`decisions.index 重复：${index}`, 'VALIDATION_ERROR');
    }
    map.set(index, raw.action);
  }
  return map;
}

/**
 * 导入备份。
 * @param {object} params
 * @param {import('better-sqlite3').Database} params.db
 * @param {unknown} params.data
 * @param {'new'|'overwrite'} [params.conflict] 默认策略（没有 decisions 覆盖时用）
 * @param {Array<{index:number, action:'new'|'overwrite'}>} [params.decisions] 逐条选择
 * @param {boolean} [params.confirmOverwrite]
 * @returns {{students:number, feedbacks:number, generations:number, overwritten:number, created:number}}
 */
export function importBackup(
  { db, data, conflict = 'new', decisions, confirmOverwrite = false },
  now = Date.now(),
) {
  const normalized = normalizeBackup(data);
  if (conflict !== 'new' && conflict !== 'overwrite') {
    throw badRequest('conflict 只能是 new 或 overwrite', 'VALIDATION_ERROR');
  }
  const decisionMap = normalizeDecisions(decisions, normalized.students.length);

  const actions = normalized.students.map(
    (_, index) => decisionMap.get(index) ?? conflict,
  );
  if (actions.includes('overwrite') && confirmOverwrite !== true) {
    throw badRequest('覆盖导入需要二次确认：请传 confirm_overwrite: true', 'CONFIRM_REQUIRED');
  }

  const stmt = {
    findStudent: db.prepare(
      `SELECT * FROM students
        WHERE name = ? AND COALESCE(school, '') = ?
        ORDER BY id ASC LIMIT 1`,
    ),
    maxSort: db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM students WHERE weekday = ?'),
    insertStudent: db.prepare(
      `INSERT INTO students (name, school, weekday, sort, tags_json, tags_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateStudent: db.prepare(
      `UPDATE students
          SET name = ?, school = ?, weekday = ?, sort = ?, tags_json = ?, tags_at = ?, created_at = ?, updated_at = ?
        WHERE id = ?`,
    ),
    deleteFeedbacks: db.prepare('DELETE FROM feedbacks WHERE student_id = ?'),
    deleteGenerations: db.prepare('DELETE FROM generations WHERE student_id = ?'),
    insertFeedback: db.prepare(
      'INSERT INTO feedbacks (student_id, content, happened_at) VALUES (?, ?, ?)',
    ),
    insertGeneration: db.prepare(
      'INSERT INTO generations (student_id, content, weeks, created_at) VALUES (?, ?, ?, ?)',
    ),
  };

  const run = db.transaction(() => {
    const stats = {
      students: 0,
      feedbacks: 0,
      generations: 0,
      overwritten: 0,
      created: 0,
    };

    for (let index = 0; index < normalized.students.length; index += 1) {
      const student = normalized.students[index];
      const existing = stmt.findStudent.get(student.name, student.school ?? '');
      const action = actions[index];

      let studentId;
      if (action === 'overwrite' && existing) {
        studentId = Number(existing.id);
        stmt.updateStudent.run(
          student.name,
          student.school,
          student.weekday,
          student.sort ?? existing.sort,
          JSON.stringify(student.tags),
          student.tags_at,
          student.created_at ?? existing.created_at,
          student.updated_at ?? now,
          studentId,
        );
        stmt.deleteFeedbacks.run(studentId);
        stmt.deleteGenerations.run(studentId);
        stats.overwritten += 1;
      } else {
        // new（或没有同名同校可覆盖）：sort 追加到目标星期末尾
        const nextSort = Number(stmt.maxSort.get(student.weekday).m) + 1;
        const createdAt = student.created_at ?? now;
        const info = stmt.insertStudent.run(
          student.name,
          student.school,
          student.weekday,
          nextSort,
          JSON.stringify(student.tags),
          student.tags_at,
          createdAt,
          student.updated_at ?? createdAt,
        );
        studentId = Number(info.lastInsertRowid);
        stats.created += 1;
      }

      for (const feedback of student.feedbacks) {
        stmt.insertFeedback.run(studentId, feedback.content, feedback.happened_at);
      }
      for (const generation of student.generations) {
        stmt.insertGeneration.run(
          studentId,
          generation.content,
          generation.weeks,
          generation.created_at,
        );
      }

      stats.students += 1;
      stats.feedbacks += student.feedbacks.length;
      stats.generations += student.generations.length;
    }

    return stats;
  });

  return run();
}
