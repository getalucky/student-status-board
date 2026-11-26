import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api, ApiError } from '@/lib/api'

export interface AuthUser {
  name: string
}

function normalizeMe(payload: unknown): AuthUser | null {
  if (!payload || typeof payload !== 'object') {
    return payload === null ? null : { name: '老师' }
  }
  const record = payload as Record<string, unknown>
  if (record.authenticated === false) return null
  if (record.user === null) return null
  if (record.user && typeof record.user === 'object') {
    const user = record.user as Record<string, unknown>
    return { name: typeof user.name === 'string' && user.name ? user.name : '老师' }
  }
  return { name: '老师' }
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null)
  const initialized = ref(false)
  const checking = ref(false)
  const loggingIn = ref(false)
  const isAuthenticated = computed(() => user.value !== null)

  async function fetchMe(): Promise<void> {
    try {
      const data = await api.get<unknown>('/me')
      user.value = normalizeMe(data)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        user.value = null
      } else {
        user.value = null
        throw error
      }
    }
  }

  async function check(): Promise<void> {
    if (checking.value) return
    checking.value = true
    try {
      await fetchMe()
    } catch {
      // 服务器不可达时按未登录处理，登录页会展示具体错误
    } finally {
      initialized.value = true
      checking.value = false
    }
  }

  async function login(password: string): Promise<void> {
    loggingIn.value = true
    try {
      await api.post('/auth/login', { password })
      await fetchMe()
      initialized.value = true
    } finally {
      loggingIn.value = false
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.post('/auth/logout')
    } finally {
      clearSession()
    }
  }

  function clearSession(): void {
    user.value = null
    initialized.value = true
  }

  return {
    user,
    initialized,
    checking,
    loggingIn,
    isAuthenticated,
    check,
    login,
    logout,
    clearSession,
  }
})
