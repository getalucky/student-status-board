/**
 * 请求体 / 路径参数的 zod 校验（zod v4）。路由里只做 parseOrThrow。
 */
import { z } from 'zod';
import { badRequest } from './errors.js';

/** 备份导出：studentId 可选，导出单个学生 */
export const backupExportQuerySchema = z.object({
  studentId: z.coerce.number().int('studentId 必须是整数').positive('studentId 必须是正整数').optional(),
});

/** 备份导入：data 具体结构由 server/lib/backup.js 校验（错误码 INVALID_BACKUP） */
export const backupImportSchema = z.object({
  data: z.any(),
  conflict: z.enum(['new', 'overwrite'], { message: 'conflict 只能是 new 或 overwrite' }).optional(),
  decisions: z
    .array(
      z.object({
        index: z.number().int('decisions.index 必须是整数').min(0, 'decisions.index 不能为负'),
        action: z.enum(['new', 'overwrite'], {
          message: 'decisions.action 只能是 new 或 overwrite',
        }),
      }),
    )
    .optional(),
  confirm_overwrite: z.boolean().optional(),
});

/** 备份导入预览：只校验并列出冲突，不写库 */
export const backupPreviewSchema = z.object({
  data: z.any(),
});

export const idParamSchema = z.object({
  id: z.coerce.number().int('id 必须是整数').positive('id 必须是正整数'),
});

/** /students/:id/generations/:generationId */
export const studentGenerationParamSchema = z.object({
  id: z.coerce.number().int('id 必须是整数').positive('id 必须是正整数'),
  generationId: z.coerce
    .number()
    .int('generationId 必须是整数')
    .positive('generationId 必须是正整数'),
});

/** /students/:id/feedbacks/:feedbackId */
export const studentFeedbackParamSchema = z.object({
  id: z.coerce.number().int('id 必须是整数').positive('id 必须是正整数'),
  feedbackId: z.coerce
    .number()
    .int('feedbackId 必须是整数')
    .positive('feedbackId 必须是正整数'),
});

export const loginSchema = z.object({
  password: z.string().min(1, '密码不能为空').max(256, '密码过长'),
});

const studentName = z
  .string()
  .trim()
  .min(1, '姓名不能为空')
  .max(50, '姓名最多 50 个字');

const schoolName = z
  .union([z.string().trim().max(100, '学校最多 100 个字'), z.null()])
  .optional();

const weekday = z.coerce
  .number()
  .int('weekday 必须是整数')
  .min(1, 'weekday 只能是 1~7')
  .max(7, 'weekday 只能是 1~7');

export const studentCreateSchema = z.object({
  name: studentName,
  school: schoolName,
  weekday,
});

export const studentPatchSchema = z
  .object({
    name: studentName.optional(),
    school: schoolName,
    weekday: weekday.optional(),
    sort: z.number().finite('sort 必须是数字').optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.school !== undefined ||
      value.weekday !== undefined ||
      value.sort !== undefined,
    { message: '至少提供 name / school / weekday / sort 之一' },
  );

export const studentDeleteSchema = z.object({
  confirm: z.literal(true, { message: '删除需要二次确认：请传 confirm: true' }),
});

export const feedbackCreateSchema = z.object({
  content: z.string().trim().min(1, '反馈内容不能为空').max(5000, '反馈内容最多 5000 字'),
  // 用户录入时间：epoch 毫秒 / 秒级时间戳 / ISO 字符串，缺省为服务器当前时间
  happened_at: z.union([z.number(), z.string()]).optional(),
});

export const generateSchema = z.object({
  weeks: z.coerce
    .number()
    .int('weeks 必须是整数')
    .min(1, 'weeks 只能是 1~20')
    .max(20, 'weeks 只能是 1~20'),
});

/** base_url + api_key（+ 可选 model）：key 只在内存里转发，不落盘 */
export const llmCredentialSchema = z.object({
  base_url: z.string().trim().min(1, 'base_url 不能为空').max(2048),
  api_key: z.string().trim().min(1, 'api_key 不能为空').max(8192),
  model: z.string().trim().min(1).max(200).optional(),
});

export const llmTestSchema = llmCredentialSchema.extend({
  model: z.string().trim().min(1, '测试需要指定模型名').max(200),
});

/** 服务器端保存 llm 配置：api_key 可留空表示沿用已保存的 Key */
export const llmConfigSaveSchema = z.object({
  base_url: z.string().trim().min(1, 'base_url 不能为空').max(2048),
  model: z.string().trim().min(1, '模型名不能为空').max(200),
  api_key: z.union([z.string().max(8192), z.null()]).optional(),
});

/**
 * llm 凭据的三种传法都兼容：
 * 1. body.llm = {base_url, api_key, model}
 * 2. body 平铺 {base_url, api_key, model}
 * 3. 请求头 x-llm-base-url / x-llm-api-key / x-llm-model（URL 编码，技术方案 §6.4 的原始约定）
 * body 优先，请求头只补缺。
 */
function decodeHeaderValue(value) {
  const raw = String(value);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function pickLlmPayload(body, headers = {}) {
  const payload = {};

  const h = headers ?? {};
  if (h['x-llm-base-url']) payload.base_url = decodeHeaderValue(h['x-llm-base-url']);
  if (h['x-llm-api-key']) payload.api_key = decodeHeaderValue(h['x-llm-api-key']);
  if (h['x-llm-model']) payload.model = decodeHeaderValue(h['x-llm-model']);

  if (body && typeof body === 'object' && body.llm && typeof body.llm === 'object') {
    for (const key of ['base_url', 'api_key', 'model']) {
      if (body.llm[key] !== undefined) payload[key] = body.llm[key];
    }
    if (body.llm.model === undefined && body.model !== undefined) payload.model = body.model;
  } else if (body && typeof body === 'object') {
    for (const key of ['base_url', 'api_key', 'model']) {
      if (body[key] !== undefined) payload[key] = body[key];
    }
  }

  return payload;
}

/** 供 /llm/* 路由：把 body 与请求头合成一份凭据对象，再交给 zod 统一校验 */
export function llmPayloadFrom(body, headers = {}) {
  return pickLlmPayload(body, headers);
}

/**
 * 只取请求里真正提供的凭据字段（trim 后非空），不做完整性校验。
 * 用于「请求凭据优先，缺的字段用服务器配置补齐」。
 */
export function readLlmFields(body, headers = {}) {
  const payload = pickLlmPayload(body, headers);
  const out = {};
  for (const key of ['base_url', 'api_key', 'model']) {
    const value = payload[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) out[key] = trimmed;
    }
  }
  return out;
}

/**
 * 取 llm 凭据；缺字段返回 null（调用方决定是 400 还是「跳过标签更新」）。
 * @param {unknown} body
 * @param {Record<string, unknown>} [headers]
 * @returns {{base_url: string, api_key: string, model?: string}|null}
 */
export function readLlmCredential(body, headers = {}) {
  const parsed = llmCredentialSchema.safeParse(readLlmFields(body, headers));
  return parsed.success ? parsed.data : null;
}

/** 必须带凭据的接口用这个 */
export function requireLlmCredential(body, { needModel = false, headers = {} } = {}) {
  const parsed = llmCredentialSchema.safeParse(readLlmFields(body, headers));
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw badRequest(
      `大模型配置不完整：${details.map((d) => d.path).join('、')}；请在设置页填写 base_url 与 api_key`,
      'LLM_NOT_CONFIGURED',
      { details },
    );
  }
  if (needModel && !parsed.data.model) {
    throw badRequest('缺少模型名，请先在设置页探测或手填模型', 'LLM_NO_MODEL');
  }
  return parsed.data;
}
