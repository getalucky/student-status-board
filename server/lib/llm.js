/**
 * OpenAI 兼容接口客户端（技术方案 §6.4）。
 *
 * 安全要点：
 * - base_url 必须 https（LLM_ALLOW_INSECURE=1 时放开，仅本地测试用）
 * - 拒绝内网 / 回环 / 保留地址（防 SSRF），域名会先解析再校验
 * - api_key 只在内存里拼请求头，不落盘、不打日志
 * - 所有请求都有超时；错误统一映射成 502 LLM_UPSTREAM
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError, badRequest, upstream } from './errors.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'kubernetes.default',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet'];

function isBlockedIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true; // 198.51.100.0/24
  if (a === 203 && b === 0) return true; // 203.0.113.0/24
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped：::ffff:1.2.3.4 与十六进制写法 ::ffff:7f00:1 都要还原成 IPv4 再判
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('ff')) return true; // multicast
  if (lower.startsWith('2001:db8')) return true; // 文档地址
  return false;
}

/** 该 IP 是否属于「不该被代理访问」的地址段 */
export function isBlockedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true; // 不是合法 IP 一律拒
}

async function resolveHostAddresses(hostname, timeoutMs = 2000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), timeoutMs);
  });
  try {
    const result = await Promise.race([dns.lookup(hostname, { all: true }), timeout]);
    return Array.isArray(result) ? result.map((r) => r.address) : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 校验并规整 base_url。
 * @param {unknown} raw
 * @param {{allowInsecure?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} 去掉末尾斜杠的地址
 */
export async function assertAllowedBaseUrl(raw, opts = {}) {
  const allowInsecure = Boolean(opts.allowInsecure);
  if (typeof raw !== 'string' || !raw.trim()) {
    throw badRequest('base_url 不能为空', 'INVALID_BASE_URL');
  }
  const trimmed = raw.trim();
  if (trimmed.length > 2048) {
    throw badRequest('base_url 过长', 'INVALID_BASE_URL');
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw badRequest('base_url 不是合法的 URL', 'INVALID_BASE_URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('base_url 只支持 http/https', 'INVALID_BASE_URL');
  }
  if (url.protocol === 'http:' && !allowInsecure) {
    throw badRequest('base_url 必须使用 https', 'INSECURE_BASE_URL');
  }

  let hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw badRequest('base_url 缺少主机名', 'INVALID_BASE_URL');
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);

  if (!allowInsecure) {
    if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
      throw badRequest('base_url 不允许指向本机或内网地址', 'FORBIDDEN_BASE_URL');
    }
    if (net.isIP(hostname)) {
      if (isBlockedIp(hostname)) {
        throw badRequest('base_url 不允许指向本机或内网地址', 'FORBIDDEN_BASE_URL');
      }
    } else {
      let addresses;
      try {
        addresses = await resolveHostAddresses(hostname, opts.timeoutMs ?? 2000);
      } catch {
        throw badRequest('base_url 域名无法解析', 'INVALID_BASE_URL');
      }
      if (!addresses.length) throw badRequest('base_url 域名无法解析', 'INVALID_BASE_URL');
      if (addresses.some((addr) => isBlockedIp(addr))) {
        throw badRequest('base_url 解析到内网地址，已拒绝', 'FORBIDDEN_BASE_URL');
      }
    }
  }

  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/+$/, '');
}

function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, '')}${suffix}`;
}

function describeNetworkError(err) {
  if (!err) return '未知错误';
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR') {
    return '大模型接口请求超时';
  }
  const cause = err.cause && (err.cause.code || err.cause.message);
  return `大模型接口请求失败：${err.message}${cause ? `（${cause}）` : ''}`;
}

async function readSnippet(res, limit = 300) {
  try {
    const text = await res.text();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return '';
  }
}

/** 把上游非 2xx 响应转成 502 */
async function throwUpstream(res, stage) {
  const snippet = await readSnippet(res);
  throw upstream(`${stage}失败：HTTP ${res.status}${snippet ? ` · ${snippet}` : ''}`, 'LLM_UPSTREAM', {
    upstreamStatus: res.status,
  });
}

export class LlmClient {
  /** @param {ReturnType<import('../config.js').resolveConfig>} cfg */
  constructor(cfg) {
    this.cfg = cfg;
  }

  /** 校验 base_url（异步，需要 DNS） */
  async resolveBaseUrl(baseUrl) {
    return assertAllowedBaseUrl(baseUrl, { allowInsecure: this.cfg.allowInsecureLlm });
  }

  async #request(url, { apiKey, method = 'GET', body, timeoutMs, signal }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        // 不跟随跳转：防止上游 302 到内网地址绕过 SSRF 校验（OpenAI 兼容端点不需要跳转）
        redirect: 'error',
      });
    } catch (err) {
      throw upstream(describeNetworkError(err), 'LLM_UPSTREAM');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * GET {base_url}/models
   * @returns {Promise<{models: {id: string, owned_by?: string, created?: number}[]}>}
   */
  async listModels({ baseUrl, apiKey, timeoutMs } = {}) {
    const base = await this.resolveBaseUrl(baseUrl);
    const res = await this.#request(joinUrl(base, '/models'), {
      apiKey,
      timeoutMs: timeoutMs ?? this.cfg.llmTimeoutMs,
    });
    if (!res.ok) await throwUpstream(res, '获取模型列表');

    let payload;
    try {
      payload = await res.json();
    } catch {
      throw upstream('模型列表返回的不是合法 JSON', 'LLM_UPSTREAM');
    }

    const rawList = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : [];
    const models = rawList
      .map((item) => {
        if (typeof item === 'string') return { id: item };
        if (!item || typeof item !== 'object') return null;
        const id = item.id ?? item.name ?? item.model;
        if (typeof id !== 'string' || !id.trim()) return null;
        return {
          id: id.trim(),
          ...(typeof item.owned_by === 'string' ? { owned_by: item.owned_by } : {}),
          ...(typeof item.created === 'number' ? { created: item.created } : {}),
        };
      })
      .filter(Boolean);

    return { models, baseUrl: base };
  }

  /**
   * 非流式 chat/completions。
   * @returns {Promise<{content: string, model: string, usage?: object}>}
   */
  async chat({ baseUrl, apiKey, model, messages, timeoutMs, maxTokens, temperature } = {}) {
    const base = await this.resolveBaseUrl(baseUrl);
    if (typeof model !== 'string' || !model.trim()) {
      throw badRequest('缺少 model', 'MISSING_MODEL');
    }
    const res = await this.#request(joinUrl(base, '/chat/completions'), {
      apiKey,
      method: 'POST',
      timeoutMs: timeoutMs ?? this.cfg.llmTimeoutMs,
      body: {
        model: model.trim(),
        messages,
        stream: false,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
      },
    });
    if (!res.ok) await throwUpstream(res, '调用模型');

    let payload;
    try {
      payload = await res.json();
    } catch {
      throw upstream('模型返回的不是合法 JSON', 'LLM_UPSTREAM');
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw upstream('模型返回缺少 choices[0].message.content', 'LLM_UPSTREAM');
    }
    return {
      content,
      model: payload?.model ?? model,
      usage: payload?.usage,
      finishReason: payload?.choices?.[0]?.finish_reason ?? null,
    };
  }

  /**
   * 流式 chat/completions（SSE）。逐段回调 onDelta，返回拼接全文。
   * 兼容上游忽略 stream 直接回 JSON 的情况；同时记录 finish_reason，
   * 推理模型的思考 token 在 delta.reasoning 里，不参与正文拼接。
   * @returns {Promise<{content: string, model: string, finishReason: string|null}>}
   */
  async streamChat({ baseUrl, apiKey, model, messages, timeoutMs, maxTokens, temperature, onDelta, signal } = {}) {
    const base = await this.resolveBaseUrl(baseUrl);
    if (typeof model !== 'string' || !model.trim()) {
      throw badRequest('缺少 model', 'MISSING_MODEL');
    }

    const res = await this.#request(joinUrl(base, '/chat/completions'), {
      apiKey,
      method: 'POST',
      timeoutMs: timeoutMs ?? this.cfg.llmStreamTimeoutMs,
      signal,
      body: {
        model: model.trim(),
        messages,
        stream: true,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
      },
    });
    if (!res.ok) await throwUpstream(res, '流式调用模型');

    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    // 上游忽略了 stream：整包 JSON 兜底
    if (contentType.includes('application/json')) {
      let payload;
      try {
        payload = await res.json();
      } catch {
        throw upstream('模型返回的不是合法 JSON', 'LLM_UPSTREAM');
      }
      const content = payload?.choices?.[0]?.message?.content ?? '';
      if (typeof content !== 'string') {
        throw upstream('模型返回缺少 choices[0].message.content', 'LLM_UPSTREAM');
      }
      if (content && onDelta) await onDelta(content);
      return {
        content,
        model: payload?.model ?? model,
        finishReason: payload?.choices?.[0]?.finish_reason ?? null,
      };
    }

    if (!res.body) throw upstream('模型没有返回响应体', 'LLM_UPSTREAM');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let finishReason = null;
    let finished = false;

    const handleLine = async (rawLine) => {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') {
        finished = true;
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return; // 半包/保活噪声，忽略
      }
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      // 推理模型的思考 token 在 delta.reasoning（或 reasoning_content）里，只拼正文 content
      const piece = typeof delta?.content === 'string'
        ? delta.content
        : typeof choice?.message?.content === 'string'
          ? choice.message.content
          : typeof choice?.text === 'string'
            ? choice.text
            : '';
      if (piece) {
        content += piece;
        if (onDelta) await onDelta(piece);
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
        finished = true;
      }
    };

    try {
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          await handleLine(line);
          if (finished) break;
        }
      }
      if (!finished && buffer.trim()) await handleLine(buffer);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw upstream(describeNetworkError(err), 'LLM_UPSTREAM');
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* 已结束 */
      }
    }

    return { content, model, finishReason };
  }
}

export default LlmClient;
