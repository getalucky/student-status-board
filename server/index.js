#!/usr/bin/env node
/**
 * 服务入口：node server/index.js
 * 环境变量：PORT（默认 3210）、HOST（默认 127.0.0.1）、DATA_DIR、DB_PATH、
 *          SESSION_COOKIE_NAME、COOKIE_SECURE、LLM_ALLOW_INSECURE（仅测试）等。
 */
import { buildApp } from './app.js';

const app = await buildApp();

try {
  await app.listen({ host: app.cfg.host, port: app.cfg.port });
  console.log(`[student-status-board] listening on http://${app.cfg.host}:${app.cfg.port}`);
  console.log(`[student-status-board] data dir: ${app.cfg.dataDir}`);
} catch (err) {
  // logger 可能被 LOG_HTTP 关掉，启动失败必须给 NSSM 的 stderr 留痕
  console.error('[student-status-board] failed to start:', err);
  process.exitCode = 1;
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  });
}
