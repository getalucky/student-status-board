/**
 * 运行配置：环境变量 + 可选覆盖。
 *
 * 关键约定：
 * - 所有路径在启动时一次性解析成绝对路径，运行期不再读 env（方便测试另起实例）。
 * - data/config.json 只放账号密码哈希（argon2id），业务数据在 SQLite。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DAY_MS = 24 * 60 * 60 * 1000;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUTHY.has(String(value).trim().toLowerCase());
}

/**
 * Cookie Secure 三态：auto / true / false。
 * auto：由请求实际协议决定，HTTPS（含 Tailscale 反代的 X-Forwarded-Proto）加 Secure，
 * 局域网 HTTP 不加，这样同一进程同时支持两种入口。
 */
function resolveCookieSecure(value) {
  if (value === undefined || value === null || value === '') return true;
  const text = String(value).trim().toLowerCase();
  if (text === 'auto') return 'auto';
  return toBool(text, true);
}

/**
 * @param {object} [overrides]
 * @param {string} [overrides.dataDir]     数据目录（DB 与 config.json 都放这里）
 * @param {string} [overrides.dbPath]      直接指定 SQLite 文件（测试用 :memory:）
 * @param {string} [overrides.configPath]  直接指定账号配置文件
 * @param {boolean} [overrides.allowInsecureLlm] 允许 http / 内网 base_url（仅测试）
 * @param {number} [overrides.loginRateMax]      登录窗口内允许次数
 * @param {number} [overrides.loginRateWindowMs] 登录限流窗口
 * @param {number} [overrides.sessionTtlMs]      会话有效期（滑动）
 * @param {number} [overrides.llmTimeoutMs]      探测/测试请求超时（/models、/llm/test）
 * @param {number} [overrides.llmChatTimeoutMs]  普通 chat 请求超时（标签计算等）
 * @param {number} [overrides.llmStreamTimeoutMs] 流式请求首包/空闲超时
 * @param {boolean} [overrides.logger]           是否开 pino
 */
export function resolveConfig(overrides = {}) {
  const env = process.env;
  const dataDir = path.resolve(
    overrides.dataDir ?? env.DATA_DIR ?? path.join(PROJECT_ROOT, 'data'),
  );

  const dbPath = overrides.dbPath
    ? (overrides.dbPath === ':memory:' ? ':memory:' : path.resolve(overrides.dbPath))
    : path.resolve(env.DB_PATH ?? path.join(dataDir, 'app.db'));

  const configPath = overrides.configPath
    ? path.resolve(overrides.configPath)
    : path.resolve(env.CONFIG_PATH ?? path.join(dataDir, 'config.json'));

  return {
    projectRoot: PROJECT_ROOT,
    dataDir,
    dbPath,
    configPath,
    webDist: path.resolve(overrides.webDist ?? env.WEB_DIST ?? path.join(PROJECT_ROOT, 'web', 'dist')),
    host: overrides.host ?? env.HOST ?? '127.0.0.1',
    port: toInt(overrides.port ?? env.PORT, 3210),
    // 会话：httpOnly + Secure + SameSite=Lax，30 天滑动
    sessionTtlMs: toInt(overrides.sessionTtlMs ?? env.SESSION_TTL_MS, 30 * DAY_MS),
    // 滑动续期阈值：剩余寿命少于这个值才重新写库/写 Cookie，避免每请求都写盘
    sessionRefreshBelowMs: toInt(overrides.sessionRefreshBelowMs ?? env.SESSION_REFRESH_BELOW_MS, 29 * DAY_MS),
    // 登录限流：默认 5 次 / 分钟 / IP
    loginRateMax: toInt(overrides.loginRateMax ?? env.LOGIN_RATE_MAX, 5),
    loginRateWindowMs: toInt(overrides.loginRateWindowMs ?? env.LOGIN_RATE_WINDOW_MS, 60 * 1000),
    // 大模型
    // 探测/测试接口：要求快，默认 10s
    llmTimeoutMs: toInt(overrides.llmTimeoutMs ?? env.LLM_TIMEOUT_MS, 10 * 1000),
    // 标签计算等普通 chat 请求：模型常思考超过 10s，默认 60s
    llmChatTimeoutMs: toInt(overrides.llmChatTimeoutMs ?? env.LLM_CHAT_TIMEOUT_MS, 60 * 1000),
    llmStreamTimeoutMs: toInt(overrides.llmStreamTimeoutMs ?? env.LLM_STREAM_TIMEOUT_MS, 90 * 1000),
    // 仅测试/本地 mock 用：放开 https 与内网地址校验（生产必须 false）
    allowInsecureLlm: overrides.allowInsecureLlm !== undefined
      ? Boolean(overrides.allowInsecureLlm)
      : toBool(env.LLM_ALLOW_INSECURE, false),
    logger: overrides.logger !== undefined ? overrides.logger : true,
    // logger 开着时：LOG_HTTP=true 记录每个请求（info），否则只记 warn/error（默认）
    logLevel: overrides.logLevel ?? env.LOG_LEVEL ?? (toBool(env.LOG_HTTP, false) ? 'info' : 'warn'),
    // 会话 Cookie
    cookieName: overrides.cookieName ?? env.SESSION_COOKIE_NAME ?? DEFAULT_COOKIE_NAME,
    // auto：请求走 HTTPS 时加 Secure，局域网 HTTP 时不加；也可强制 true/false
    cookieSecure: resolveCookieSecure(overrides.cookieSecure ?? env.COOKIE_SECURE),
    // 生成历史保留条数
    generationKeep: toInt(overrides.generationKeep ?? env.GENERATION_KEEP, 5),
    // 喂给模型的最近反馈条数
    feedbackContextSize: toInt(overrides.feedbackContextSize ?? env.FEEDBACK_CONTEXT_SIZE, 10),
  };
}

export const DEFAULT_COOKIE_NAME = 'ssb_sid';

/** 读 data/config.json（不存在返回 null） */
export function readAccountConfig(cfg, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(cfg.configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) return null;
    throw err;
  }
}

/** 写 data/config.json（0600 尽力而为，Windows 上等价于仅当前用户 ACL） */
export function writeAccountConfig(cfg, patch, fsImpl = fs) {
  const dir = path.dirname(cfg.configPath);
  fsImpl.mkdirSync(dir, { recursive: true });
  const current = readAccountConfig(cfg, fsImpl) ?? {};
  const next = { ...current, ...patch };
  const tmp = `${cfg.configPath}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fsImpl.renameSync(tmp, cfg.configPath);
  return next;
}
