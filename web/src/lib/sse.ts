import { ApiError } from '@/lib/api'

export interface SseHandlers {
  onDelta: (text: string) => void
  onDone: (payload: unknown) => void
  onError: (error: Error) => void
}

export interface StreamOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  /** 大模型凭据（后端从 body 读取）；与请求头是同一份数据的两种传法。 */
  credentials?: Record<string, string>
}

interface ParsedEvent {
  event: string
  data: unknown
  raw: string
}

function parseEventBlock(block: string): ParsedEvent | null {
  const lines = block.split('\n')
  let event = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    if (field === 'data') dataLines.push(value)
  }

  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  if (raw === '[DONE]') return { event: 'done', data: null, raw }
  try {
    return { event, data: JSON.parse(raw), raw }
  } catch {
    return { event, data: raw, raw }
  }
}

function pickText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const candidate = record.text ?? record.delta ?? record.content ?? record.chunk
    if (typeof candidate === 'string') return candidate
  }
  return ''
}

function pickMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data.trim()) return data
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const candidate = record.message ?? record.error ?? record.detail
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return fallback
}

/**
 * POST /api/students/:id/generate 并以 SSE 解析流式响应（event: delta / done / error）。
 */
export async function streamGenerate(
  studentId: number,
  weeks: number,
  handlers: SseHandlers,
  options: StreamOptions = {},
): Promise<void> {
  let res: Response
  try {
    res = await fetch(`/api/students/${studentId}/generate`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(options.headers ?? {}),
      },
      body: JSON.stringify({ weeks, ...(options.credentials ?? {}) }),
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, '无法连接服务器，请检查网络或服务是否已启动')
  }

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('app:unauthorized'))
  }

  if (!res.ok) {
    let payload: Record<string, unknown> | null = null
    try {
      payload = (await res.json()) as Record<string, unknown>
    } catch {
      payload = null
    }
    const message =
      (typeof payload?.message === 'string' && payload.message) ||
      (typeof payload?.error === 'string' && payload.error) ||
      (res.status === 409 ? '本周无记录，建议调整参考时间范围' : `生成失败（${res.status}）`)
    const rawCode = payload?.code ?? payload?.error
    const code =
      typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]*$/.test(rawCode) ? rawCode : undefined
    throw new ApiError(res.status, message, code, payload ?? undefined)
  }

  if (!res.body) {
    throw new ApiError(0, '浏览器不支持流式读取，请换用新版浏览器')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let finished = false
  let receivedAny = false

  const dispatch = (block: string) => {
    const parsed = parseEventBlock(block)
    if (!parsed) return
    if (parsed.event === 'delta') {
      const text = pickText(parsed.data)
      if (text) {
        receivedAny = true
        handlers.onDelta(text)
      }
      return
    }
    if (parsed.event === 'done' || parsed.event === 'complete') {
      finished = true
      handlers.onDone(parsed.data)
      return
    }
    if (parsed.event === 'error') {
      finished = true
      handlers.onError(new ApiError(0, pickMessage(parsed.data, '生成失败，请稍后重试')))
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        dispatch(block)
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) dispatch(buffer.trim())
  } finally {
    reader.releaseLock()
  }

  if (!finished && receivedAny) {
    handlers.onDone(null)
  }
}
