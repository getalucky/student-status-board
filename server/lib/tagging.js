/**
 * 标签更新（技术方案 §6.2）。
 * 取该生最近 N 条（默认 10）反馈 + 固定词表交给模型，校验后落库。
 * 失败不抛：返回 tags_updated:false + reason，由路由决定是否降级为 200。
 */
import { MAX_TAGS, extractTagArray, isVocabularyEcho, normalizeTags } from './tags.js';
import { buildTagMessages } from './prompts.js';

/**
 * @param {object} deps
 * @param {import('./llm.js').LlmClient} deps.llm
 * @param {ReturnType<import('./students.js').createStudentRepo>} deps.repo
 * @param {{feedbackContextSize: number}} deps.cfg
 * @param {{id:number, name:string, tags:string[]}} deps.student
 * @param {{base_url:string, api_key:string, model?:string}|null} deps.credential
 * @param {{throwOnLlmError?: boolean}} [options] 手动刷新时把上游故障抛出去（502），保存反馈时降级
 * @returns {Promise<{tags:string[], tags_updated:boolean, tags_at?:number|null, reason?:string, dropped?:string[], truncated?:boolean, message?:string}>}
 */
export async function computeTags({ llm, repo, cfg, student, credential }, options = {}) {
  const feedbacks = repo.feedbacks(student.id, { limit: cfg.feedbackContextSize });

  if (!feedbacks.length) {
    return { tags: student.tags, tags_updated: false, reason: 'NO_FEEDBACKS' };
  }
  if (!credential || !credential.model) {
    return { tags: student.tags, tags_updated: false, reason: 'LLM_NOT_CONFIGURED' };
  }

  let content;
  try {
    const messages = buildTagMessages({
      studentName: student.name,
      // repo 返回的是倒序（最新在前），提示词按时间从早到晚更利于模型判断趋势
      feedbacks: [...feedbacks].reverse(),
      maxTags: MAX_TAGS,
    });
    const result = await llm.chat({
      baseUrl: credential.base_url,
      apiKey: credential.api_key,
      model: credential.model,
      messages,
      temperature: 0,
      // 推理模型会把思考 token 计入 max_tokens：给足空间，别让 JSON 被截成 '{"tags":'
      maxTokens: 2048,
      // 标签计算可能很慢：独立于 /models 探测的 10s 超时，默认 60s
      timeoutMs: cfg.llmChatTimeoutMs ?? 60_000,
    });
    content = result.content;
  } catch (err) {
    // 保存反馈时降级（不影响落库）；手动刷新时把错误抛给前端
    if (options.throwOnLlmError) throw err;
    return {
      tags: student.tags,
      tags_updated: false,
      reason: err?.code || 'LLM_UPSTREAM',
      message: err?.message || '标签更新失败',
    };
  }

  const raw = extractTagArray(content);
  const normalized = normalizeTags(raw ?? []);
  // 纯文本兜底被复读词表拦掉时 extractTagArray 返回 null，这里补回「复读」标记
  const echoed = Boolean(normalized.echoedVocabulary || (raw === null && isVocabularyEcho(content)));

  if (!normalized.valid) {
    // 把模型原话带回去（截断 500 字），方便路由打日志排查真实输出
    const preview = typeof content === 'string' ? content.slice(0, 500) : '';
    return {
      tags: student.tags,
      tags_updated: false,
      reason: 'INVALID_TAGS',
      dropped: normalized.dropped,
      raw_preview: preview,
      ...(echoed ? { echoed_vocabulary: true } : {}),
      message: echoed
        ? '模型输出疑似复读词表，已保留旧标签'
        : '模型没有给出词表内的有效标签，已保留旧标签',
    };
  }

  const updated = repo.setTags(student.id, normalized.tags);
  return {
    tags: updated.tags,
    tags_at: updated.tags_at,
    tags_updated: true,
    dropped: normalized.dropped,
    truncated: normalized.truncated,
  };
}
