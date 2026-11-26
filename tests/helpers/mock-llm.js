/**
 * 本地 mock 的 OpenAI 兼容服务（测试专用）。
 * - GET  /v1/models
 * - POST /v1/chat/completions（stream:true 走 SSE，stream:false 走 JSON）
 *
 * 标签请求（system 里含「学情分析」）返回 tagReply；
 * 生成请求返回 chatReply，按 8 个字符切片流式吐，便于断言多段 delta。
 */
import http from 'node:http';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const DEFAULT_MODELS = [
  { id: 'mock-small', owned_by: 'mock' },
  { id: 'mock-large', owned_by: 'mock' },
];

export async function startMockLlm(options = {}) {
  const state = {
    models: options.models ?? DEFAULT_MODELS,
    tagReply: options.tagReply ?? '{"tags":["状态稳定","专注度高"]}',
    chatReply:
      options.chatReply ??
      '孩子这段时间整体状态稳定，课堂专注度不错，作业完成得比较认真。建议继续保持现有节奏，适当增加一些思维拓展练习。',
    modelsStatus: options.modelsStatus ?? 200,
    chatStatus: options.chatStatus ?? 200,
    streamMode: options.streamMode ?? 'sse', // 'sse' | 'json'
    delayMs: options.delayMs ?? 0,
    failNextChat: options.failNextChat ?? 0,
    /** 推理模型的思考过程；流式时放在 delta.reasoning，不应进入正文 */
    reasoningText: options.reasoningText ?? '',
    /** 最后一段 finish_reason：'stop' | 'length' */
    finishReason: options.finishReason ?? 'stop',
    requests: [],
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { __unparsed: raw };
      }
      state.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });

      if (state.delayMs) await sleep(state.delayMs);

      try {
        if (req.method === 'GET' && /\/models\/?$/.test(req.url || '')) {
          if (state.modelsStatus !== 200) {
            res.writeHead(state.modelsStatus, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'mock models failure' } }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: state.models }));
          return;
        }

        if (req.method === 'POST' && /\/chat\/completions\/?$/.test(req.url || '')) {
          if (state.failNextChat > 0) {
            state.failNextChat -= 1;
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'mock upstream exploded' } }));
            return;
          }
          if (state.chatStatus !== 200) {
            res.writeHead(state.chatStatus, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'mock chat failure' } }));
            return;
          }

          const system = (body?.messages || []).find((m) => m.role === 'system')?.content ?? '';
          const isTagRequest = system.includes('学情分析');
          const reply = isTagRequest ? state.tagReply : state.chatReply;
          const model = body?.model || 'mock-model';

          if (!body?.stream || isTagRequest) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: reply },
                    finish_reason: state.finishReason,
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
              }),
            );
            return;
          }

          if (state.streamMode === 'json') {
            // 模拟上游忽略 stream 参数，直接回整包 JSON
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-mock-json',
                object: 'chat.completion',
                model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: reply },
                    finish_reason: state.finishReason,
                  },
                ],
              }),
            );
            return;
          }

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const pieces = reply.match(/[\s\S]{1,8}/g) ?? [];
          const reasoningPieces = state.reasoningText
            ? state.reasoningText.match(/[\s\S]{1,8}/g) ?? []
            : [];
          for (const piece of reasoningPieces) {
            const payload = {
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { reasoning: piece }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
          for (const piece of pieces) {
            const payload = {
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              model,
              choices: [{ index: 0, delta: {}, finish_reason: state.finishReason }],
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    state,
    requests: state.requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
