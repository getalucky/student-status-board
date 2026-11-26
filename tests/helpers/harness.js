/**
 * 测试夹具：临时 DATA_DIR + 独立 app 实例 + 带 Cookie 的 inject 客户端。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../server/app.js';
import { hashPassword } from '../../server/auth.js';
import { writeAccountConfig } from '../../server/config.js';

// 测试环境的默认开关：允许 http / 127.0.0.1 的 mock LLM
process.env.LLM_ALLOW_INSECURE = '1';

export const TEST_PASSWORD = 'test-password-123';

export async function createTestApp(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssb-test-'));
  const app = await buildApp({
    dataDir,
    // 显式钉死路径，避免宿主环境里的 DATA_DIR / DB_PATH 污染测试
    dbPath: path.join(dataDir, 'app.db'),
    configPath: path.join(dataDir, 'config.json'),
    allowInsecureLlm: true,
    loginRateMax: 200,
    logger: false,
    ...overrides,
  });

  if (overrides.withAccount !== false) {
    writeAccountConfig(app.cfg, {
      passwordHash: await hashPassword(TEST_PASSWORD),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const client = createClient(app);

  return {
    app,
    cfg: app.cfg,
    dataDir,
    client,
    async login(password = TEST_PASSWORD) {
      const res = await client.call('POST', '/api/auth/login', { password });
      return res;
    },
    async cleanup() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * 带 Cookie 的 inject 封装：自动保存/携带 set-cookie，支持登出清空。
 */
export function createClient(app) {
  let cookie = null;

  async function call(method, url, payload, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;

    const options = { method, url, headers };
    if (payload !== undefined) {
      options.payload = payload;
    }

    const res = await app.inject(options);

    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : [setCookie];
      for (const item of list) {
        const match = /^([^=]+)=([^;]*)/.exec(String(item));
        if (!match) continue;
        const name = match[1];
        const value = match[2];
        const expired = /max-age=0/i.test(String(item)) || /expires=thu, 01 jan 1970/i.test(String(item));
        if (!value || expired) cookie = null;
        else cookie = `${name}=${value}`;
      }
    }
    return res;
  }

  return {
    call,
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    json(res) {
      return JSON.parse(res.body);
    },
  };
}

/** 清空业务表（同一个 app 内跑多个用例时用） */
export function resetData(app) {
  app.db.exec('DELETE FROM generations; DELETE FROM feedbacks; DELETE FROM students;');
}
