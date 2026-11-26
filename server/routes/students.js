/**
 * 学生卡片 CRUD（技术方案 §5 / §6.5）。
 * 拖动换栏 = PATCH {weekday, sort}；只给 weekday 时自动追加到目标栏末尾。
 */
import { notFound, parseOrThrow } from '../lib/errors.js';
import {
  idParamSchema,
  studentCreateSchema,
  studentDeleteSchema,
  studentPatchSchema,
} from '../lib/schemas.js';

export default async function studentRoutes(app) {
  const repo = app.students;
  const auth = { preHandler: app.authenticate };

  app.get('/students', auth, async (req) => {
    const raw = req.query?.weekday;
    const weekday = raw === undefined ? undefined : Number(raw);
    return repo.list({
      weekday: Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : undefined,
    });
  });

  app.get('/students/:id', auth, async (req) => {
    const { id } = parseOrThrow(idParamSchema, req.params, '路径参数');
    return repo.mustGet(id);
  });

  app.post('/students', auth, async (req, reply) => {
    const payload = parseOrThrow(studentCreateSchema, req.body, '学生参数');
    const student = repo.create({
      name: payload.name,
      school: payload.school?.trim() ? payload.school.trim() : null,
      weekday: payload.weekday,
    });
    reply.code(201);
    return student;
  });

  app.patch('/students/:id', auth, async (req) => {
    const { id } = parseOrThrow(idParamSchema, req.params, '路径参数');
    const payload = parseOrThrow(studentPatchSchema, req.body, '学生参数');
    // 空字符串统一落成 NULL，避免前端把 '' 当成有效学校
    const patch = { ...payload };
    if (Object.prototype.hasOwnProperty.call(payload, 'school')) {
      patch.school = payload.school?.trim() ? payload.school.trim() : null;
    }
    const updated = repo.update(id, patch);
    if (!updated) throw notFound('学生不存在');
    return updated;
  });

  app.delete('/students/:id', auth, async (req) => {
    const { id } = parseOrThrow(idParamSchema, req.params, '路径参数');
    parseOrThrow(studentDeleteSchema, req.body, '删除确认');
    const deleted = repo.remove(id);
    if (!deleted) throw notFound('学生不存在');
    return { ok: true, deleted };
  });
}
