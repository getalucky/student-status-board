/**
 * 学生 / 反馈 / 生成历史 的数据访问层（技术方案 §4）。
 * 所有 SQL 集中在这里，路由只做参数校验与编排。
 */
import { notFound } from './errors.js';

function parseTags(json) {
  if (typeof json !== 'string' || !json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** 数据库行 → 对外 DTO（tags_json 展开成 tags 数组） */
export function toStudentDto(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    school: row.school ?? null,
    weekday: Number(row.weekday),
    sort: Number(row.sort),
    tags: parseTags(row.tags_json),
    tags_at: row.tags_at === null || row.tags_at === undefined ? null : Number(row.tags_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function toFeedbackDto(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    student_id: Number(row.student_id),
    content: row.content,
    happened_at: Number(row.happened_at),
  };
}

export function toGenerationDto(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    student_id: Number(row.student_id),
    content: row.content,
    weeks: Number(row.weeks),
    created_at: Number(row.created_at),
  };
}

export function createStudentRepo(db, cfg = {}) {
  const keep = Number.isInteger(cfg.generationKeep) && cfg.generationKeep > 0 ? cfg.generationKeep : 5;

  const s = {
    listAll: db.prepare('SELECT * FROM students ORDER BY weekday ASC, sort ASC, id ASC'),
    listByWeekday: db.prepare('SELECT * FROM students WHERE weekday = ? ORDER BY sort ASC, id ASC'),
    get: db.prepare('SELECT * FROM students WHERE id = ?'),
    maxSort: db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM students WHERE weekday = ?'),
    insert: db.prepare(
      `INSERT INTO students (name, school, weekday, sort, tags_json, tags_at, created_at, updated_at)
       VALUES (@name, @school, @weekday, @sort, '[]', NULL, @now, @now)`,
    ),
    updateName: db.prepare('UPDATE students SET name = ?, updated_at = ? WHERE id = ?'),
    updateSchool: db.prepare('UPDATE students SET school = ?, updated_at = ? WHERE id = ?'),
    updateWeekday: db.prepare('UPDATE students SET weekday = ?, updated_at = ? WHERE id = ?'),
    updateSort: db.prepare('UPDATE students SET sort = ?, updated_at = ? WHERE id = ?'),
    updateTags: db.prepare('UPDATE students SET tags_json = ?, tags_at = ?, updated_at = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM students WHERE id = ?'),

    countFeedbacks: db.prepare('SELECT COUNT(*) AS n FROM feedbacks WHERE student_id = ?'),
    countGenerations: db.prepare('SELECT COUNT(*) AS n FROM generations WHERE student_id = ?'),
    feedbacksDesc: db.prepare(
      'SELECT * FROM feedbacks WHERE student_id = ? ORDER BY happened_at DESC, id DESC',
    ),
    feedbacksRecent: db.prepare(
      'SELECT * FROM feedbacks WHERE student_id = ? ORDER BY happened_at DESC, id DESC LIMIT ?',
    ),
    feedbacksRange: db.prepare(
      `SELECT * FROM feedbacks
        WHERE student_id = ? AND happened_at >= ? AND happened_at <= ?
        ORDER BY happened_at ASC, id ASC`,
    ),
    insertFeedback: db.prepare(
      'INSERT INTO feedbacks (student_id, content, happened_at) VALUES (?, ?, ?)',
    ),
    getFeedback: db.prepare('SELECT * FROM feedbacks WHERE id = ?'),
    deleteFeedback: db.prepare('DELETE FROM feedbacks WHERE id = ? AND student_id = ?'),
    clearTags: db.prepare('UPDATE students SET tags_json = ?, tags_at = NULL, updated_at = ? WHERE id = ?'),

    generationsDesc: db.prepare(
      'SELECT * FROM generations WHERE student_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ),
    insertGeneration: db.prepare(
      'INSERT INTO generations (student_id, content, weeks, created_at) VALUES (?, ?, ?, ?)',
    ),
    trimGenerations: db.prepare(
      `DELETE FROM generations
        WHERE student_id = @studentId
          AND id NOT IN (
            SELECT id FROM generations
             WHERE student_id = @studentId
             ORDER BY created_at DESC, id DESC
             LIMIT @keep
          )`,
    ),
    getGeneration: db.prepare('SELECT * FROM generations WHERE id = ?'),
    deleteGeneration: db.prepare('DELETE FROM generations WHERE id = ? AND student_id = ?'),
  };

  const removeTx = db.transaction((id) => {
    const row = s.get.get(id);
    if (!row) return null;
    const feedbacks = Number(s.countFeedbacks.get(id).n);
    const generations = Number(s.countGenerations.get(id).n);
    s.del.run(id); // 外键 ON DELETE CASCADE 会带走 feedbacks / generations
    return { student: 1, feedbacks, generations };
  });

  const addGenerationTx = db.transaction((studentId, content, weeks, now) => {
    const info = s.insertGeneration.run(studentId, content, weeks, now);
    s.trimGenerations.run({ studentId, keep });
    return Number(info.lastInsertRowid);
  });

  return {
    keep,

    list({ weekday } = {}) {
      const rows = Number.isInteger(weekday) ? s.listByWeekday.all(weekday) : s.listAll.all();
      return rows.map(toStudentDto);
    },

    get(id) {
      return toStudentDto(s.get.get(id));
    },

    /** 不存在直接抛 404，路由里省掉重复判断 */
    mustGet(id, message = '学生不存在') {
      const row = s.get.get(id);
      if (!row) throw notFound(message);
      return toStudentDto(row);
    },

    /** 新建，sort 追加到该星期末尾 */
    create({ name, school = null, weekday, sort }, now = Date.now()) {
      const nextSort = Number.isInteger(sort)
        ? sort
        : Number(s.maxSort.get(weekday).m) + 1;
      const info = s.insert.run({
        name,
        school: school ?? null,
        weekday,
        sort: nextSort,
        now,
      });
      return toStudentDto(s.get.get(Number(info.lastInsertRowid)));
    },

    /**
     * 局部更新。weekday 变了但没给 sort ⇒ 自动追加到目标栏末尾（技术方案 §6.5）。
     * @returns {object|null}
     */
    update(id, patch, now = Date.now()) {
      const current = s.get.get(id);
      if (!current) return null;

      const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);

      if (has('name')) s.updateName.run(patch.name, now, id);
      if (has('school')) s.updateSchool.run(patch.school ?? null, now, id);

      if (has('weekday') && Number(patch.weekday) !== Number(current.weekday)) {
        s.updateWeekday.run(patch.weekday, now, id);
        if (!has('sort')) {
          const nextSort = Number(s.maxSort.get(patch.weekday).m) + 1;
          s.updateSort.run(nextSort, now, id);
        }
      }
      if (has('sort')) s.updateSort.run(patch.sort, now, id);

      return toStudentDto(s.get.get(id));
    },

    /** 事务 + 级联删除，返回各表删除条数 */
    remove(id) {
      return removeTx(id);
    },

    feedbacks(studentId, { limit } = {}) {
      const rows = Number.isInteger(limit)
        ? s.feedbacksRecent.all(studentId, limit)
        : s.feedbacksDesc.all(studentId);
      return rows.map(toFeedbackDto);
    },

    /** 区间内反馈（含首尾），时间升序 */
    feedbacksInRange(studentId, from, to) {
      return s.feedbacksRange.all(studentId, from, to).map(toFeedbackDto);
    },

    addFeedback(studentId, { content, happenedAt }, now = Date.now()) {
      const info = s.insertFeedback.run(studentId, content, happenedAt ?? now);
      return toFeedbackDto(
        db.prepare('SELECT * FROM feedbacks WHERE id = ?').get(Number(info.lastInsertRowid)),
      );
    },

    /** 写标签（空数组表示清空，调用方保证只在有效时调用） */
    setTags(id, tags, now = Date.now()) {
      s.updateTags.run(JSON.stringify(tags), now, now, id);
      return toStudentDto(s.get.get(id));
    },

    generations(studentId, limit = keep) {
      return s.generationsDesc.all(studentId, limit).map(toGenerationDto);
    },

    addGeneration(studentId, { content, weeks }, now = Date.now()) {
      const id = addGenerationTx(studentId, content, weeks, now);
      return toGenerationDto(s.getGeneration.get(id));
    },

    /**
     * 删除单条生成历史；记录不存在或不属于该生都抛 404。
     * @returns {number} 删除条数（1）
     */
    deleteGeneration(studentId, generationId) {
      const info = s.deleteGeneration.run(generationId, studentId);
      if (!info.changes) throw notFound('生成记录不存在');
      return info.changes;
    },

    countGenerations(studentId) {
      return Number(s.countGenerations.get(studentId).n);
    },

    countFeedbacks(studentId) {
      return Number(s.countFeedbacks.get(studentId).n);
    },

    /**
     * 删除单条反馈；记录不存在或不属于该生都抛 404。
     * 删完最后一条时顺带清空标签，避免卡片挂着已无依据的状态。
     * @returns {{deleted:number, remaining:number, tags_cleared:boolean}}
     */
    deleteFeedback(studentId, feedbackId) {
      const info = s.deleteFeedback.run(feedbackId, studentId);
      if (!info.changes) throw notFound('反馈记录不存在');
      const remaining = Number(s.countFeedbacks.get(studentId).n);
      let tagsCleared = false;
      if (remaining === 0) {
        s.clearTags.run('[]', Date.now(), studentId);
        tagsCleared = true;
      }
      return { deleted: info.changes, remaining, tags_cleared: tagsCleared };
    },
  };
}
