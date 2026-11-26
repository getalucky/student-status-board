<template>
  <router-view />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLlmSettingsStore } from '@/stores/llm'

const router = useRouter()
const auth = useAuthStore()
const llm = useLlmSettingsStore()

function handleUnauthorized() {
  const auth = useAuthStore()
  auth.clearSession()
  const current = router.currentRoute.value
  if (current.path !== '/login') {
    router.push({ path: '/login', query: { redirect: current.fullPath } })
  }
}

onMounted(() => {
  window.addEventListener('app:unauthorized', handleUnauthorized)
})

// 登录页不请求配置；登录成功（或已有会话）后从服务器同步一次。
watch(
  () => auth.user,
  (user) => {
    if (user) void llm.refresh()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('app:unauthorized', handleUnauthorized)
})
</script>
