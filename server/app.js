/**
 * Fastify 应用装配（不监听端口，便于 app.inject 测试）。
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { resolveConfig } from './config.js';
import { openDatabase, pingDatabase } from './db.js';
import { assertSession, createSessionStore, setSessionCookie } from './auth.js';
import { AppError } from './lib/errors.js';
import { LlmClient } from './lib/llm.js';
import { LlmStore } from './lib/llm-store.js';
import { createStudentRepo } from './lib/students.js';

import authRoutes from './routes/auth.js';
import studentRoutes from './routes/students.js';
import feedbackRoutes from './routes/feedbacks.js';
import generateRoutes from './routes/generate.js';
import llmRoutes from './routes/llm.js';
import backupRoutes from './routes/backup.js';

const API_PREFIX = '/api';

/**
 * @param {object} [overrides] 见 resolveConfig；另可传 cfg 直接复用
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp(overrides = {}) {
  const cfg = overrides.cfg ?? resolveConfig(overrides);
  const db = openDatabase(cfg.dbPath);

  const app = Fastify({
    logger: cfg.logger
      ? {
          level: cfg.logLevel || 'warn',
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.headers["x-llm-key"]',
              'req.headers["x-llm-api-key"]',
            ],
            censor: '[redacted]',
          },
        }
      : false,
    // Tailscale serve 从本机回环反代过来；只信任回环上的 X-Forwarded-For，
    // 避免远程客户端伪造 XFF 绕过登录限流。
    trustProxy: ['127.0.0.1', '::1'],
    bodyLimit: 1024 * 1024,
  });

  app.decorate('cfg', cfg);
  app.decorate('db', db);
  app.decorate('llm', new LlmClient(cfg));
  app.decorate('llmStore', new LlmStore({ db, cfg, llm: app.llm }));
  app.decorate('sessions', createSessionStore(db, cfg));
  app.decorate('students', createStudentRepo(db, cfg));
  app.decorateRequest('session', null);

  await app.register(cookie);

  // 登录限流：全局关，只有登录路由 config.rateLimit 生效
  // 注意 @fastify/rate-limit 是 throw errorResponseBuilder(...) 的返回值，
  // 必须返回带 statusCode 的 Error，否则会被当成未知异常变成 500。
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, context) =>
      new AppError(
        429,
        'RATE_LIMITED',
        `登录尝试过于频繁（上限 ${context.max} 次/分钟），请稍后再试`,
      ),
  });

  /**
   * 会话校验 preHandler：
   * - 无 Cookie / 过期 / 伪造 ⇒ 401
   * - 剩余寿命不足阈值 ⇒ 滑动续期（重写 DB expires_at 与 Cookie）
   */
  app.decorate('authenticate', async function authenticate(req, reply) {
    const token = req.cookies?.[cfg.cookieName] ?? null;
    const session = app.sessions.resolve(token);
    assertSession(session);
    req.session = session;
    if (session.renewed) {
      setSessionCookie(reply, cfg, session.token, session.expiresAt);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'request failed');
      return reply.code(err.statusCode).send(err.toJSON());
    }
    const status =
      Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({
      error: err?.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR'),
      message: status >= 500 ? '服务器内部错误' : err?.message || '请求不合法',
    });
  });

  // 健康检查（不需要登录，供部署脚本 / 冒烟用）
  app.get(`${API_PREFIX}/healthz`, async () => ({
    ok: true,
    db: pingDatabase(db),
    uptime: Math.round(process.uptime()),
  }));

  await app.register(authRoutes, { prefix: API_PREFIX });
  await app.register(studentRoutes, { prefix: API_PREFIX });
  await app.register(feedbackRoutes, { prefix: API_PREFIX });
  await app.register(generateRoutes, { prefix: API_PREFIX });
  await app.register(llmRoutes, { prefix: API_PREFIX });
  await app.register(backupRoutes, { prefix: API_PREFIX });

  // ---------- 前端静态产物（web/dist，Vite 默认输出） ----------
  const indexHtml = path.join(cfg.webDist, 'index.html');
  const hasWebDist = fs.existsSync(indexHtml);
  if (hasWebDist) {
    await app.register(fastifyStatic, {
      root: cfg.webDist,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
      maxAge: 0,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith(API_PREFIX) || req.url === '/api') {
      return reply.code(404).send({
        error: 'NOT_FOUND',
        message: `接口不存在：${req.method} ${req.url.split('?')[0]}`,
      });
    }
    // 静态资源缺失必须 404，不能回 index.html（否则浏览器把 HTML 当 JS 执行）
    if (req.url.startsWith('/assets/')) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '静态资源不存在' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && hasWebDist) {
      // SPA 兜底：前端路由（/board 等）刷新时返回 index.html
      return reply.type('text/html; charset=utf-8').send(fs.createReadStream(indexHtml));
    }
    return reply.code(404).send({ error: 'NOT_FOUND', message: '页面不存在' });
  });

  app.addHook('onClose', async () => {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  });

  await app.ready();
  return app;
}

export default buildApp;
