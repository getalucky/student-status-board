/**
 * 反馈录入与标签（技术方案 §5 / §6.2）。
 *
 * - 保存反馈必定成功（除非参数/学生不存在），标签更新是尽力而为：
 *   模型不可用 / 输出不在词表 ⇒ 保留旧标签并返回 tags_updated:false
 * - 手动刷新（/tags/refresh）才把上游故障作为错误返回
 */
import { badRequest, parseOrThrow } from '../lib/errors.js';
import {
  feedbackCreateSchema,
  idParamSchema,
  readLlmFields,
  studentFeedbackParamSchema,
} from '../lib/schemas.js';
import { isCredentialComplete, requireCredential } from '../lib/llm-store.js';
import { computeTags } from '../lib/tagging.js';
import { parseHappenedAt } from '../lib/time.js';

export default async function feedbackRoutes(app) {
  const repo = app.students;
  const auth = { preHandler: app.authenticate };

  app.get('/students/:id/feedbacks', auth, async (req) => {
    const { id } = parseOrThrow(idParamSchema, req.params, '路径参数');
    repo.mustGet(id);
    return repo.feedbacks(id);
  });

  app.delete('/students/:id/feedbacks/:feedbackId', auth, async (req) => {
    const { id, feedbackId } = parseOrThrow(
      studentFeedbackParamSchema,
      req.params,
      '路径参数',
    );
    if (!req.body || req.body.confirm !== true) {
      throw badRequest('删除反馈需要二次确认：请传 confirm: true', 'CONFIRM_REQUIRED');
    }
    const student = repo.mustGet(id);
    const result = repo.deleteFeedback(student.id, feedbackId);
    const fresh = repo.mustGet(id);
    return {
      ok: true,
      deleted: result.deleted,
      remaining: result.remaining,
      tags_cleared: result.tags_cleared,
      tags: fresh.tags,
      tags_at: fresh.tags_at,
    };
  });

  app.post('/students/:id/feedbacks', auth, async (req, reply) => {
    const { id } = parseOrThrow(idParamSchema, req.params, '路径参数');
    const payload = parseOrThrow(feedbackCreateSchema, req.body, '反馈参数');
    const student = repo.mustGet(id);

    const feedback = repo.addFeedback(id, {
      content: payload.content,
      happenedAt: parseHappenedAt(payload.happened_at),
    });

    // 请求凭据优先，缺的字段用服务器保存的配置补齐
    const merged = app.llmStore.resolve(readLlmFields(req.body, req.headers));
    const credential = isCredentialComplete(merged, { needModel: true }) ? merged : null;
    const tagResult = await computeTags({
      llm: app.llm,
      repo,
      cfg: app.cfg,
      student,
      credential,
    });

    if (tagResult.reason === 'INVALID_TAGS') {
      req.log.warn({ raw: tagResult.raw_preview }, '模型标签输出不在词表内');
    }

    reply.code(201);
    return {
      feedback,
      tags: tagResult.tags,
      tags_updated: tagResult.tags_updated,
      ...(tagResult.tags_at !== undefined ? { tags_at: tagResult.tags_at } : {}),
      ...(tagResult.reason ? { reason: tagResult.reason } : {}),
      ...(tagResult.message ? { message: tagResult.message } : {}),
      ...(tagResult.raw_preview !== undefined ? { raw_preview: tagResult.raw_preview } : {}),
      ...(tagResult.echoed_vocabulary ? { echoed_vocabulary: true } : {}),
      ...(tagResult.dropped?.length ? { dropped: tagResult.dropped } : {}),
      ...(tagResult.truncated ? { truncated: true } : {}),
    };
  });

  app.post('/students/:id/tags/refresh', auth, async (req) => {
    const { id } = parseOrThrow(idParamSchema, req.params, '路径参数');
    const student = repo.mustGet(id);
    const credential = requireCredential(
      app.llmStore.resolve(readLlmFields(req.body, req.headers)),
      { needModel: true },
    );

    const result = await computeTags(
      { llm: app.llm, repo, cfg: app.cfg, student, credential },
      { throwOnLlmError: true },
    );

    if (result.reason === 'INVALID_TAGS') {
      req.log.warn({ raw: result.raw_preview }, '模型标签输出不在词表内');
    }

    return {
      tags: result.tags,
      tags_updated: result.tags_updated,
      ...(result.tags_at !== undefined ? { tags_at: result.tags_at } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(result.raw_preview !== undefined ? { raw_preview: result.raw_preview } : {}),
      ...(result.echoed_vocabulary ? { echoed_vocabulary: true } : {}),
      ...(result.dropped?.length ? { dropped: result.dropped } : {}),
      ...(result.truncated ? { truncated: true } : {}),
    };
  });
}
