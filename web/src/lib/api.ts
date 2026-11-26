export interface ApiErrorPayload {
  message?: string
  error?: string
  code?: string
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly payload?: ApiErrorPayload

  constructor(status: number, message: string, code?: string, payload?: ApiErrorPayload) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  query?: Record<string, string | number | boolean | null | undefined>
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = '/api'
  const url = path.startsWith('/') ? `${base}${path}` : `${base}/${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  }
  const search = params.toString()
  return search ? `${url}?${search}` : url
}

function extractMessage(payload: ApiErrorPayload | null, status: number): string {
  const raw = payload?.message ?? payload?.error
  if (typeof raw === 'string' && raw.trim()) {
    const map: Record<string, string> = {
      Unauthorized: '登录已过期，请重新登录',
      'Invalid password': '密码不正确',
      'Not Found': '请求的内容不存在',
      'Internal Server Error': '服务器开小差了，请稍后重试',
      'Bad Request': '请求参数有误',
    }
    return map[raw] ?? raw
  }
  if (status === 401) return '登录已过期，请重新登录'
  if (status === 403) return '没有权限执行此操作'
  if (status === 404) return '请求的内容不存在'
  if (status === 429) return '操作太频繁，请稍后再试'
  if (status >= 500) return '服务器开小差了，请稍后重试'
  return `请求失败（${status}）`
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers ?? {}) }
  let body: BodyInit | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }

  let res: Response
  try {
    res = await fetch(buildUrl(path, options.query), {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      credentials: 'include',
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, '无法连接服务器，请检查网络或服务是否已启动')
  }

  if (res.status === 401 && path !== '/auth/login') {
    window.dispatchEvent(new CustomEvent('app:unauthorized'))
  }

  const payload = await parseBody(res)

  if (!res.ok) {
    const data = (payload && typeof payload === 'object' ? payload : null) as ApiErrorPayload | null
    const rawCode = data?.code ?? data?.error
    const code =
      typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]*$/.test(rawCode) ? rawCode : undefined
    throw new ApiError(res.status, extractMessage(data, res.status), code, data ?? undefined)
  }

  return payload as T
}

function withMethod(method: string) {
  return <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}) =>
    request<T>(path, { ...options, method, body })
}

export const api = {
  get: <T>(path: string, options: Omit<RequestOptions, 'body'> = {}) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: withMethod('POST'),
  patch: withMethod('PATCH'),
  put: withMethod('PUT'),
  delete: withMethod('DELETE'),
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return '未知错误'
}
