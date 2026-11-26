/**
 * SSE 输出（Fastify v5 必须 reply.hijack() 后直接写 reply.raw）。
 *
 * 事件契约（前端按 event 名分支）：
 *   event: start  data: {weeks, from, to, feedbacks: n}
 *   event: delta  data: {text}
 *   event: done   data: {id, content, weeks, created_at}
 *   event: error  data: {error, message}
 * 另发 `: ping` 注释行做保活。
 */

const KEEPALIVE_MS = 15000;

/**
 * 接管响应并开始 SSE。
 * @param {import('fastify').FastifyReply} reply
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.keepAliveMs] 0 关闭保活
 */
export function openSse(reply, opts = {}) {
  reply.hijack();
  const res = reply.raw;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 反代（Tailscale / nginx）别缓冲
    'X-Accel-Buffering': 'no',
    ...(opts.headers || {}),
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);

  let closed = false;
  let keepAlive = null;

  const rawWrite = (chunk) => {
    if (closed || res.writableEnded || res.destroyed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  const keepAliveMs = opts.keepAliveMs ?? KEEPALIVE_MS;
  if (keepAliveMs > 0) {
    keepAlive = setInterval(() => rawWrite(': ping\n\n'), keepAliveMs);
    if (typeof keepAlive.unref === 'function') keepAlive.unref();
  }

  res.on('close', () => {
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
  });

  return {
    get closed() {
      return closed || res.writableEnded || res.destroyed;
    },
    send(event, data) {
      return rawWrite(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
    },
    comment(text) {
      return rawWrite(`: ${text}\n\n`);
    },
    end(finalEvent, finalData) {
      if (finalEvent) rawWrite(`event: ${finalEvent}\ndata: ${JSON.stringify(finalData ?? null)}\n\n`);
      if (keepAlive) clearInterval(keepAlive);
      if (!res.writableEnded && !res.destroyed) res.end();
      closed = true;
    },
  };
}

/**
 * 解析 SSE 响应体（测试用）：返回 [{event, data}]，data 已 JSON.parse（失败则保留原文）。
 * @param {string} body
 */
export function parseSseBody(body) {
  const events = [];
  const chunks = String(body ?? '').split('\n\n');
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 保留原文 */
    }
    events.push({ event, data });
  }
  return events;
}
