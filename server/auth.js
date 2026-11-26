/**
 * 单账号认证（技术方案 §4 / §10）。
 *
 * - 密码用 argon2id 哈希存 data/config.json，不进数据库
 * - 会话：随机 token 存 sessions 表，Cookie 名默认 ssb_sid
 * - Cookie 属性：httpOnly + Secure + SameSite=Lax，30 天滑动过期
 */
import { randomBytes } from 'node:crypto';
import argon2 from '@node-rs/argon2';
import { unauthorized, unavailable } from './lib/errors.js';

export const ARGON2_OPTIONS = Object.freeze({
  algorithm: argon2.Algorithm?.Argon2id ?? 2,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

export function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * 会话存取。
 * @param {import('better-sqlite3').Database} db
 * @param {{sessionTtlMs: number, sessionRefreshBelowMs: number}} cfg
 */
export function createSessionStore(db, cfg) {
  const stmt = {
    insert: db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)'),
    find: db.prepare('SELECT token, expires_at FROM sessions WHERE token = ?'),
    renew: db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?'),
    del: db.prepare('DELETE FROM sessions WHERE token = ?'),
    sweep: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

  return {
    /** 新建会话，返回 {token, expiresAt} */
    create(now = Date.now()) {
      const token = createSessionToken();
      const expiresAt = now + cfg.sessionTtlMs;
      stmt.insert.run(token, expiresAt);
      stmt.sweep.run(now); // 顺手清理过期会话
      return { token, expiresAt };
    },

    /**
     * 校验会话；剩余寿命不足阈值时自动续期（滑动过期）。
     * @returns {{token: string, expiresAt: number, renewed: boolean} | null}
     */
    resolve(token, now = Date.now()) {
      if (!token || typeof token !== 'string') return null;
      const row = stmt.find.get(token);
      if (!row) return null;
      if (Number(row.expires_at) <= now) {
        stmt.del.run(token);
        return null;
      }
      const remaining = Number(row.expires_at) - now;
      if (remaining < cfg.sessionRefreshBelowMs) {
        const expiresAt = now + cfg.sessionTtlMs;
        stmt.renew.run(expiresAt, token);
        return { token, expiresAt, renewed: true };
      }
      return { token, expiresAt: Number(row.expires_at), renewed: false };
    },

    destroy(token) {
      if (!token) return false;
      return stmt.del.run(token).changes > 0;
    },

    sweep(now = Date.now()) {
      return stmt.sweep.run(now).changes;
    },

    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    },
  };
}

function cookieSecure(reply, cfg) {
  if (cfg.cookieSecure === 'auto') {
    return reply.request?.protocol === 'https';
  }
  return Boolean(cfg.cookieSecure);
}

/** 写会话 Cookie（滑动时重写，顺带续 maxAge） */
export function setSessionCookie(reply, cfg, token, expiresAt) {
  const maxAge = Math.floor(cfg.sessionTtlMs / 1000);
  reply.setCookie(cfg.cookieName, token, {
    path: '/',
    httpOnly: true,
    secure: cookieSecure(reply, cfg),
    sameSite: 'lax',
    expires: new Date(expiresAt),
    // Max-Age 必须是正数：0 会被浏览器当作删除 Cookie（短 TTL 测试时尤其明显）
    ...(maxAge >= 1 ? { maxAge } : {}),
  });
}

export function clearSessionCookie(reply, cfg) {
  reply.clearCookie(cfg.cookieName, {
    path: '/',
    httpOnly: true,
    secure: cookieSecure(reply, cfg),
    sameSite: 'lax',
  });
}

/** 账号还没初始化时给出可操作提示 */
export function assertAccountInitialized(accountConfig) {
  if (!accountConfig || typeof accountConfig.passwordHash !== 'string' || !accountConfig.passwordHash) {
    throw unavailable('账号未初始化，请先运行 node scripts/init.js 设置登录密码', 'NOT_INITIALIZED');
  }
  return accountConfig;
}

/** 未登录统一 401 */
export function assertSession(session) {
  if (!session) throw unauthorized();
  return session;
}
