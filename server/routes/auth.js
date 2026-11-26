/**
 * 认证路由：/api/auth/login、/api/auth/logout、/api/me
 * 登录限流 5 次/分（技术方案 §5），由 @fastify/rate-limit 按 IP 计数。
 */
import { readAccountConfig } from '../config.js';
import {
  assertAccountInitialized,
  clearSessionCookie,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';
import { parseOrThrow, unauthorized } from '../lib/errors.js';
import { loginSchema } from '../lib/schemas.js';

export default async function authRoutes(app) {
  const { cfg } = app;

  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: cfg.loginRateMax,
          timeWindow: cfg.loginRateWindowMs,
        },
      },
    },
    async (req, reply) => {
      const { password } = parseOrThrow(loginSchema, req.body, '登录参数');
      const account = assertAccountInitialized(readAccountConfig(cfg));
      const ok = await verifyPassword(account.passwordHash, password);
      if (!ok) {
        throw unauthorized('密码错误', 'INVALID_PASSWORD');
      }
      const session = app.sessions.create();
      setSessionCookie(reply, cfg, session.token, session.expiresAt);
      return { ok: true, expiresAt: session.expiresAt };
    },
  );

  // 登出：要求有效会话（技术方案 §5「除登录外都要求会话 Cookie」）
  app.post('/auth/logout', { preHandler: app.authenticate }, async (req, reply) => {
    app.sessions.destroy(req.session.token);
    clearSessionCookie(reply, cfg);
    return { ok: true };
  });

  app.get('/me', { preHandler: app.authenticate }, async (req) => ({
    authenticated: true,
    expiresAt: req.session.expiresAt,
  }));

  // 便于前端判断是「密码错」还是「服务没初始化」，登录失败分支用得上
  app.get('/auth/status', async () => {
    const account = readAccountConfig(cfg);
    return {
      initialized: Boolean(account && account.passwordHash),
      sessionTtlDays: Math.round(cfg.sessionTtlMs / (24 * 60 * 60 * 1000)),
      loginRateMax: cfg.loginRateMax,
      loginRateWindowMs: cfg.loginRateWindowMs,
    };
  });
}
