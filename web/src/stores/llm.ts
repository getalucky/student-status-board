import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { decryptText, readStoredSettings, writeStoredSettings } from '@/lib/crypto'
import { normalizeBaseUrl } from '@/lib/llm'

interface ServerConfig {
  configured: boolean
  baseUrl: string
  model: string
  hasKey: boolean
  updatedAt: number | null
}

function readServerConfig(payload: unknown): ServerConfig | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const hasShape = ['configured', 'base_url', 'model', 'has_key'].some((key) => key in record)
  if (!hasShape) return null

  const baseUrl = typeof record.base_url === 'string' ? record.base_url : ''
  const model = typeof record.model === 'string' ? record.model : ''
  const hasKey = Boolean(record.has_key)
  const configured =
    typeof record.configured === 'boolean'
      ? record.configured
      : Boolean(baseUrl.trim() && model.trim() && hasKey)

  return {
    configured,
    baseUrl,
    model,
    hasKey,
    updatedAt: typeof record.updated_at === 'number' ? record.updated_at : null,
  }
}

export const useLlmSettingsStore = defineStore('llm', () => {
  const baseUrl = ref('')
  const model = ref('')
  /** 只有当前页面刚输入、尚未保存的 key；保存成功后立即清空。 */
  const apiKey = ref('')
  const serverHasKey = ref(false)
  const serverConfigured = ref(false)
  const serverUpdatedAt = ref<number | null>(null)
  const initialized = ref(false)
  const loading = ref(false)
  const restoreError = ref('')

  /** 以后端已保存的配置为准。 */
  const configured = computed(() => serverConfigured.value)
  /** 兼容旧调用方；现在等同于后端是否有 Key。 */
  const hasStoredKey = computed(() => serverHasKey.value)

  function applyServerConfig(payload: unknown): boolean {
    const config = readServerConfig(payload)
    if (!config) return false
    serverConfigured.value = config.configured
    baseUrl.value = config.baseUrl
    model.value = config.model
    serverHasKey.value = config.hasKey
    serverUpdatedAt.value = config.updatedAt
    // 服务端配置是唯一来源，浏览器内存里不保留旧 Key。
    apiKey.value = ''
    return true
  }

  async function loadServerConfig(): Promise<void> {
    const data = await api.get<unknown>('/llm/config')
    applyServerConfig(data)
  }

  /** 仅用于把旧版本浏览器本地加密的 Key 迁移到服务器；失败静默。 */
  async function migrateLocalSecret(serverConfigLoaded: boolean): Promise<void> {
    const stored = readStoredSettings()
    if (!stored) return

    if (serverConfigured.value) {
      if (stored.secret) {
        try {
          writeStoredSettings({ ...stored, secret: null, updatedAt: Date.now() })
        } catch {
          /* 清理本地旧密文失败不影响使用 */
        }
      }
      return
    }

    // 服务器还没配置时，用本地地址/模型先把表单填起来。
    if (!baseUrl.value.trim() && stored.baseUrl) baseUrl.value = stored.baseUrl
    if (!model.value.trim() && stored.model) model.value = stored.model

    // GET 都没成功时无法确认服务器是否真的未配置，不能贸然上传覆盖。
    if (!serverConfigLoaded) return
    if (!stored.secret || !stored.baseUrl.trim() || !stored.model.trim()) return

    try {
      const plainKey = await decryptText(stored.secret)
      if (!plainKey) return
      const cleanBase = normalizeBaseUrl(stored.baseUrl)
      const cleanModel = stored.model.trim()
      const data = await api.put<unknown>('/llm/config', {
        base_url: cleanBase,
        model: cleanModel,
        api_key: plainKey,
      })
      const applied = applyServerConfig(data)
      if (!applied) {
        baseUrl.value = cleanBase
        model.value = cleanModel
        serverConfigured.value = true
        serverHasKey.value = true
        serverUpdatedAt.value = Date.now()
        apiKey.value = ''
      }
      writeStoredSettings({
        baseUrl: cleanBase,
        model: cleanModel,
        secret: null,
        updatedAt: Date.now(),
      })
    } catch {
      // 迁移失败静默；本地旧配置保留，下次启动还会再试。
    }
  }

  async function refresh(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      let serverConfigLoaded = false
      try {
        await loadServerConfig()
        serverConfigLoaded = true
      } catch {
        // 未登录 / 网络异常时继续展示本地旧配置，但不上传覆盖服务器。
      }
      await migrateLocalSecret(serverConfigLoaded)
    } finally {
      loading.value = false
      initialized.value = true
    }
  }

  async function init(): Promise<void> {
    if (initialized.value || loading.value) return
    await refresh()
  }

  async function save(input: { baseUrl: string; apiKey: string; model: string }): Promise<void> {
    const cleanBase = normalizeBaseUrl(input.baseUrl)
    const cleanModel = input.model.trim()
    const cleanKey = input.apiKey.trim()
    if (!cleanBase) throw new Error('请填写接口地址')
    if (!cleanModel) throw new Error('请选择或填写模型名')
    if (!cleanKey && !serverHasKey.value) throw new Error('请填写 API Key')

    const payload: Record<string, string> = {
      base_url: cleanBase,
      model: cleanModel,
    }
    if (cleanKey) payload.api_key = cleanKey

    const data = await api.put<unknown>('/llm/config', payload)
    const applied = applyServerConfig(data)
    if (!applied) {
      baseUrl.value = cleanBase
      model.value = cleanModel
      serverConfigured.value = true
      serverHasKey.value = Boolean(cleanKey) || serverHasKey.value
      serverUpdatedAt.value = Date.now()
    }
    apiKey.value = ''
    restoreError.value = ''

    // 本地只保留地址/模型，不再保留任何 Key 密文。
    try {
      writeStoredSettings({
        baseUrl: baseUrl.value || cleanBase,
        model: model.value || cleanModel,
        secret: null,
        updatedAt: Date.now(),
      })
    } catch {
      /* localStorage 不可用时忽略；服务器配置已经生效 */
    }
  }

  /**
   * 模型相关请求的凭据头：只有当前页面刚输入了未保存的 key 才发送。
   * 没有本地 key 时返回空对象，由后端使用服务器已保存的配置。
   */
  function headers(includeModel = true): Record<string, string> {
    const localKey = apiKey.value.trim()
    if (!localKey || !baseUrl.value.trim()) return {}
    const result: Record<string, string> = {
      'x-llm-base-url': encodeURIComponent(normalizeBaseUrl(baseUrl.value)),
      'x-llm-api-key': encodeURIComponent(localKey),
    }
    if (includeModel && model.value.trim()) {
      result['x-llm-model'] = encodeURIComponent(model.value.trim())
    }
    return result
  }

  /** 与 headers 同步的 body 版本；无本地 key 时为空，走后端已存配置。 */
  function credentialPayload(includeModel = true): Record<string, string> {
    const localKey = apiKey.value.trim()
    if (!localKey || !baseUrl.value.trim()) return {}
    const result: Record<string, string> = {
      base_url: normalizeBaseUrl(baseUrl.value),
      api_key: localKey,
    }
    if (includeModel && model.value.trim()) {
      result.model = model.value.trim()
    }
    return result
  }

  return {
    baseUrl,
    model,
    apiKey,
    serverHasKey,
    serverConfigured,
    serverUpdatedAt,
    initialized,
    loading,
    restoreError,
    configured,
    hasStoredKey,
    init,
    refresh,
    save,
    headers,
    credentialPayload,
  }
})
