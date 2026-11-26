/**
 * 统一错误：code 是给前端判分支用的稳定字符串，statusCode 是 HTTP 状态。
 * 约定（技术方案 §5）：401 未登录、404 不存在、409 NO_RECORDS、502 LLM_UPSTREAM。
 */
export class AppError extends Error {
  constructor(statusCode, code, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

export const badRequest = (message, code = 'BAD_REQUEST', extra) => new AppError(400, code, message, extra);
export const unauthorized = (message = '未登录或会话已过期', code = 'UNAUTHORIZED') => new AppError(401, code, message);
export const forbidden = (message = '禁止访问', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (message = '资源不存在', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (message, code = 'CONFLICT', extra) => new AppError(409, code, message, extra);
export const tooMany = (message, code = 'RATE_LIMITED', extra) => new AppError(429, code, message, extra);
export const unavailable = (message, code = 'SERVICE_UNAVAILABLE') => new AppError(503, code, message);
export const upstream = (message = '大模型接口调用失败', code = 'LLM_UPSTREAM', extra) =>
  new AppError(502, code, message, extra);

/**
 * zod 校验：失败统一抛 400，把拍平的 issue 路径塞进 details。
 * @param {import('zod').ZodTypeAny} schema
 * @param {unknown} input
 */
export function parseOrThrow(schema, input, label = '请求参数') {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    const head = details.map((d) => `${d.path} ${d.message}`).join('；');
    throw new AppError(400, 'VALIDATION_ERROR', `${label}不合法：${head}`, { details });
  }
  return result.data;
}
