/**
 * 大模型设置页两个接口（技术方案 §6.4）。
 *
 * - POST /api/llm/models：后端代理 GET {base_url}/models，超时 10s
 * - POST /api/llm/test  ：发一条极小 chat 请求验证模型可用
 * key 只在本次请求里转发，不落盘、不打日志；base_url 走 https + 拒绝内网（SSRF）。
 */
import { parseOrThrow } from '../lib/errors.js';
import { buildPingMessages } from '../lib/prompts.js';
import {
  llmConfigSaveSchema,
  llmCredentialSchema,
  llmTestSchema,
  readLlmFields,
} from '../lib/schemas.js';

export default async function llmRoutes(app) {
  const auth = { preHandler: app.authenticate };

  // ---------- 服务器端保存的模型配置（加密落库，所有设备共用） ----------
  app.get('/llm/config', auth, async () => app.llmStore.getPublic());

  app.put('/llm/config', auth, async (req) => {
    const payload = parseOrThrow(llmConfigSaveSchema, req.body, '大模型配置');
    return app.llmStore.save(payload);
  });

  app.delete('/llm/config', auth, async () => {
    app.llmStore.clear();
    return { ok: true };
  });

  // ---------- 代理调用：请求凭据优先，缺的字段用服务器配置补齐 ----------
  app.post('/llm/models', auth, async (req) => {
    const merged = app.llmStore.resolve(readLlmFields(req.body, req.headers));
    const payload = parseOrThrow(llmCredentialSchema, merged, '大模型配置');
    const { models, baseUrl } = await app.llm.listModels({
      baseUrl: payload.base_url,
      apiKey: payload.api_key,
      timeoutMs: app.cfg.llmTimeoutMs,
    });
    return {
      ok: true,
      base_url: baseUrl,
      count: models.length,
      models,
      // 探测失败时前端可退回手填模型名
      allow_manual_model: true,
    };
  });

  app.post('/llm/test', auth, async (req) => {
    const merged = app.llmStore.resolve(readLlmFields(req.body, req.headers));
    const payload = parseOrThrow(llmTestSchema, merged, '大模型测试参数');
    const result = await app.llm.chat({
      baseUrl: payload.base_url,
      apiKey: payload.api_key,
      model: payload.model,
      messages: buildPingMessages(),
      temperature: 0,
      maxTokens: 16,
      timeoutMs: app.cfg.llmTimeoutMs,
    });
    return {
      ok: true,
      model: result.model,
      content: result.content.trim(),
      // 前端设置页会把 message 当作「连接成功」的描述展示
      message: result.content.trim() || '模型响应正常',
    };
  });
}
