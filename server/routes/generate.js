/**
 * 家长反馈生成（技术方案 §6.3 / §6.1）。
 *
 * POST /api/students/:id/generate
 *   body: {weeks: 1..20, llm?:{base_url, api_key, model}} 或平铺 base_url/api_key/model
 *   区间无反馈 ⇒ 409 NO_RECORDS（JSON，不进 SSE）
 *   有反馈 ⇒ SSE 流式：start → delta* → done（落库，保留最近 5 条）/ error
 *
 * GET /api/students/:id/generations ⇒ 最近 5 条（倒序）
 * DELETE /api/students/:id/generations/:generationId ⇒ 单条删除，需 confirm:true
 */
import { AppError, badRequest, conflict, parseOrThrow, upstream } from '../lib/errors.js';
import { buildGenerateMessages } from '../lib/prompts.js';
import {
  generateSchema,
  idParamSchema,
  readLlmFields,
  studentGenerationParamSchema,
} from '../lib/schemas.js';
import { requireCredential } from '../lib/llm-store.js';
import { openSse } from '../lib/sse.js';
import { weekRange } from '../lib/time.js';

export default async function generateRoutes(app) {
  const repo = app.students;
  const auth = { preHandler: app.authenticate };

  app.get('/students/:id/generations', auth, async (req) => {
    const { id } = parseOrThrow(idParamSchema, req.params, '路径参数');
    repo.mustGet(id);
    return repo.generations(id, app.cfg.generationKeep);
  });

  app.delete('/students/:id/generations/:generationId', auth, async (req) => {
    const { id, generationId } = parseOrThrow(
      studentGenerationParamSchema,
      req.params,
      '路径参数',
    );
    if (!req.body || req.body.confirm !== true) {
      throw badRequest('删除生成记录需要二次确认：请传 confirm: true', 'CONFIRM_REQUIRED');
    }
    const student = repo.mustGet(id);
    const deleted = repo.deleteGeneration(student.id, generationId);
    return { ok: true, deleted };
  });

  app.post('/students/:id/generate', auth, async (req, reply) => {
    const { id } = parseOrThrow(idParamSchema, req.params, '路径参数');
    // weeks 越界 / 非整数：zod 直接 400（技术方案 §6.1）
    const { weeks } = parseOrThrow(generateSchema, req.body, '生成参数');
    const student = repo.mustGet(id);

    const range = weekRange(weeks, Date.now());
    const feedbacks = repo.feedbacksInRange(student.id, range.from, range.to);

    if (!feedbacks.length) {
      // 先判空再要凭据：没记录就是 409，提示语要给到用户
      throw conflict('本周无记录，建议调整参考时间范围', 'NO_RECORDS', {
        range: { weeks, from: range.from, to: range.to },
        hint: '可以把参考时间范围调大（例如 2~4 周），或先补充这段时间的反馈记录',
      });
    }

    const credential = requireCredential(
      app.llmStore.resolve(readLlmFields(req.body, req.headers)),
      { needModel: true },
    );

    // 先把 base_url 校验完（SSRF / https），失败仍是普通 JSON 400
    await app.llm.resolveBaseUrl(credential.base_url);

    const sse = openSse(reply);
    const abort = new AbortController();
    const onClientClose = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.on('close', onClientClose);

    sse.send('start', {
      weeks,
      from: range.from,
      to: range.to,
      feedbacks: feedbacks.length,
    });

    try {
      const messages = buildGenerateMessages({
        studentName: student.name,
        school: student.school,
        range,
        feedbacks,
      });

      let streamed = '';
      const result = await app.llm.streamChat({
        baseUrl: credential.base_url,
        apiKey: credential.api_key,
        model: credential.model,
        messages,
        temperature: 0.4,
        // 推理模型的思考 token 也占 max_tokens，给足空间避免正文被截断
        maxTokens: 4096,
        signal: abort.signal,
        onDelta: async (delta) => {
          streamed += delta;
          sse.send('delta', { text: delta });
        },
      });

      if (result.finishReason === 'length') {
        // 推理模型的 max_tokens 含思考 token；被截断的内容不能当成功落库
        throw upstream(
          '模型输出达到长度上限，内容不完整，请重试或缩短参考范围',
          'LLM_TRUNCATED',
          { finishReason: 'length' },
        );
      }

      const content = (result.content || streamed).trim();
      if (!content) throw upstream('模型返回内容为空', 'LLM_EMPTY');

      const saved = repo.addGeneration(student.id, { content, weeks }, Date.now());
      sse.end('done', {
        id: saved.id,
        content: saved.content,
        weeks: saved.weeks,
        created_at: saved.created_at,
      });
    } catch (err) {
      const code = err instanceof AppError ? err.code : err?.code || 'INTERNAL_ERROR';
      const message = err instanceof AppError ? err.message : '生成失败，请检查大模型设置后重试';
      req.log.error({ err }, 'generate failed');
      sse.end('error', { error: code, message });
    } finally {
      reply.raw.off('close', onClientClose);
    }

    return reply;
  });
}
