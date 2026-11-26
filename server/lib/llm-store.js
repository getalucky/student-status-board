/**
 * 服务器端大模型配置存储（单账号，所有设备共用一份）。
 *
 * - 落库形态：app_settings(key='llm_config', value=<密文 JSON>, updated_at)
 * - 加密：AES-256-GCM；密钥 = sha256('llm-config:' + config.json 的 passwordHash)
 *   不额外落密钥文件；密码重置后 passwordHash 变化 ⇒ 旧密文解不开 ⇒ 视作未配置。
 * - 对外只给 getPublic()，绝不返回 api_key。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readAccountConfig } from '../config.js';
import { badRequest, unavailable } from './errors.js';

export const LLM_CONFIG_KEY = 'llm_config';
const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;
const IV_BYTES = 12;

function deriveKey(passwordHash) {
  return createHash('sha256').update(`llm-config:${passwordHash}`, 'utf8').digest();
}

function encryptConfig(value, passwordHash) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(passwordHash), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptConfig(payload, passwordHash) {
  if (!payload || typeof payload !== 'object') throw new Error('bad payload');
  if (Number(payload.v) !== VERSION) throw new Error('unsupported version');
  const iv = Buffer.from(String(payload.iv || ''), 'base64');
  const tag = Buffer.from(String(payload.tag || ''), 'base64');
  const data = Buffer.from(String(payload.data || ''), 'base64');
  const decipher = createDecipheriv(ALGORITHM, deriveKey(passwordHash), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** 凭据是否齐全（base_url + api_key 必需；needModel 时 model 也必需） */
export function isCredentialComplete(credential, { needModel = true } = {}) {
  if (!credential) return false;
  if (!credential.base_url || !credential.api_key) return false;
  if (needModel && !credential.model) return false;
  return true;
}

/** 必须带凭据的路由用这个；区分「未配置」与「缺模型名」，前端好提示 */
export function requireCredential(credential, { needModel = true } = {}) {
  if (!credential || !credential.base_url || !credential.api_key) {
    throw badRequest(
      '大模型未配置：请先在设置页保存 base_url / api_key / model',
      'LLM_NOT_CONFIGURED',
    );
  }
  if (needModel && !credential.model) {
    throw badRequest('缺少模型名，请先在设置页探测或手填模型', 'LLM_NO_MODEL');
  }
  return credential;
}

export class LlmStore {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {ReturnType<import('../config.js').resolveConfig>} deps.cfg
   * @param {import('./llm.js').LlmClient} deps.llm
   */
  constructor({ db, cfg, llm }) {
    this.db = db;
    this.cfg = cfg;
    this.llm = llm;
    this.stmt = {
      get: db.prepare('SELECT value, updated_at FROM app_settings WHERE key = ?'),
      upsert: db.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ),
      delete: db.prepare('DELETE FROM app_settings WHERE key = ?'),
    };
  }

  #passwordHash() {
    const account = readAccountConfig(this.cfg);
    return account && typeof account.passwordHash === 'string' && account.passwordHash
      ? account.passwordHash
      : null;
  }

  #row() {
    return this.stmt.get.get(LLM_CONFIG_KEY) ?? null;
  }

  /**
   * 解密后的内部配置（含 api_key）。只在服务端使用，不要直接返回给客户端。
   * @returns {{base_url: string, model: string|null, api_key: string, updated_at: number}|null}
   */
  get() {
    const row = this.#row();
    if (!row) return null;
    const passwordHash = this.#passwordHash();
    if (!passwordHash) return null;

    try {
      const payload = JSON.parse(row.value);
      const parsed = JSON.parse(decryptConfig(payload, passwordHash));
      if (!parsed || typeof parsed.base_url !== 'string' || !parsed.base_url) return null;
      return {
        base_url: parsed.base_url,
        model: typeof parsed.model === 'string' && parsed.model ? parsed.model : null,
        api_key: typeof parsed.api_key === 'string' ? parsed.api_key : '',
        updated_at: Number(row.updated_at),
      };
    } catch {
      // 密码重置 / 密文损坏 / 版本不认识：一律视为未配置
      return null;
    }
  }

  /** 对外安全结构：永远不含 api_key */
  getPublic() {
    const config = this.get();
    if (!config) {
      return {
        configured: false,
        base_url: null,
        model: null,
        has_key: false,
        updated_at: null,
      };
    }
    return {
      configured: true,
      base_url: config.base_url,
      model: config.model,
      has_key: Boolean(config.api_key),
      updated_at: config.updated_at,
    };
  }

  /**
   * 保存配置。api_key 传空/缺省且已有配置时保留旧 Key。
   * @param {{base_url: string, model: string, api_key?: string}} input
   * @returns {Promise<ReturnType<LlmStore['getPublic']>>}
   */
  async save({ base_url, model, api_key }) {
    // 先做 https / SSRF 校验，非法地址不落库
    const canonicalBaseUrl = await this.llm.resolveBaseUrl(base_url);
    const cleanModel = typeof model === 'string' ? model.trim() : '';
    if (!cleanModel) throw badRequest('缺少模型名', 'LLM_NO_MODEL');

    const existing = this.get();
    const requestedKey = typeof api_key === 'string' ? api_key.trim() : '';
    const finalKey = requestedKey || existing?.api_key || '';
    if (!finalKey) {
      throw badRequest('还没有 API Key，首次配置请填写 api_key', 'LLM_NOT_CONFIGURED');
    }

    const passwordHash = this.#passwordHash();
    if (!passwordHash) {
      throw unavailable('账号未初始化，请先运行 node scripts/init.js 设置登录密码', 'NOT_INITIALIZED');
    }

    const ciphertext = encryptConfig(
      { base_url: canonicalBaseUrl, model: cleanModel, api_key: finalKey },
      passwordHash,
    );
    this.stmt.upsert.run(LLM_CONFIG_KEY, JSON.stringify(ciphertext), Date.now());
    return this.getPublic();
  }

  /** 删除配置（幂等） */
  clear() {
    return this.stmt.delete.run(LLM_CONFIG_KEY).changes > 0;
  }

  /**
   * 请求凭据优先，缺的字段用服务器已存配置补齐。
   * @param {{base_url?: string, api_key?: string, model?: string}} [requested]
   * @returns {{base_url?: string, api_key?: string, model?: string}}
   */
  resolve(requested = {}) {
    const stored = this.get();
    const clean = (value) =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;

    return {
      base_url: clean(requested.base_url) ?? clean(stored?.base_url),
      api_key: clean(requested.api_key) ?? clean(stored?.api_key),
      model: clean(requested.model) ?? clean(stored?.model),
    };
  }
}

export default LlmStore;
