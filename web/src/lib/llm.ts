import type { LlmModel } from '@/types'

/** 把模型探测接口的各种返回形态归一成下拉列表。 */
export function normalizeModels(payload: unknown): LlmModel[] {
  let list: unknown = payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    list = record.models ?? record.data ?? record.items ?? payload
  }
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const models: LlmModel[] = []
  for (const item of list) {
    let id = ''
    let label = ''
    if (typeof item === 'string') {
      id = item
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      const candidate = record.id ?? record.name ?? record.model
      if (typeof candidate === 'string') id = candidate
      if (typeof record.label === 'string') label = record.label
    }
    const clean = id.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    models.push({ id: clean, label: label || clean })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function validateBaseUrl(value: string): string | null {
  if (!value.trim()) return '请填写接口地址'
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return '接口地址格式不正确'
  }
  if (url.protocol !== 'https:') return '接口地址必须使用 https://'
  return null
}
