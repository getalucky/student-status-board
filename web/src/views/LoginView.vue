<template>
  <div class="login-page">
    <main class="login-shell">
      <section class="login-intro" aria-hidden="true">
        <span class="intro-eyebrow">学生状态 · 课后反馈</span>
        <h1 class="intro-title">每一节课的<br />小变化，都值得被记住</h1>
        <p class="intro-text">记录课堂表现，自动整理表现标签，一键生成可以直接发给家长的反馈。</p>
        <ul class="intro-points">
          <li>按星期查看每个学生的状态</li>
          <li>反馈记录沉淀成清晰的时间线</li>
          <li>按 1～20 周范围生成家长反馈</li>
        </ul>
      </section>

      <section class="login-card" aria-labelledby="login-title">
        <div class="card-brand">
          <span class="brand-mark" aria-hidden="true">
            <span class="brand-mark-line" />
            <span class="brand-mark-line" />
            <span class="brand-mark-line" />
          </span>
          <span class="brand-name">学生状态看板</span>
        </div>

        <h2 id="login-title" class="login-title">登录</h2>
        <p class="login-subtitle">输入密码进入你的课后反馈工作台</p>

        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="submit">
          <el-form-item label="登录密码" prop="password">
            <el-input
              v-model="form.password"
              type="password"
              show-password
              size="large"
              placeholder="请输入登录密码"
              autocomplete="current-password"
              :prefix-icon="Lock"
              :disabled="loading"
              @keyup.enter="submit"
            />
          </el-form-item>

          <el-alert
            v-if="uninitialized"
            class="login-alert"
            type="warning"
            :closable="false"
            show-icon
            title="服务器尚未初始化"
          >
            <p class="init-hint">
              请先在服务器上运行 <code>npm run init</code> 设置登录密码，再刷新本页。
            </p>
          </el-alert>
          <el-alert
            v-else-if="errorText"
            class="login-alert"
            type="error"
            :closable="false"
            show-icon
            :title="errorText"
          />

          <el-button type="primary" class="login-submit" size="large" :loading="loading" @click="submit">
            进入看板
          </el-button>
        </el-form>

        <p class="login-footer">数据保存在你自己的服务器上，只有你能看到</p>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Lock } from '@element-plus/icons-vue'
import { ApiError, errorMessage } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const formRef = ref<FormInstance>()
const form = reactive({ password: '' })
const loading = ref(false)
const errorText = ref('')
const uninitialized = ref(false)

const rules: FormRules = {
  password: [{ required: true, message: '请输入登录密码', trigger: 'blur' }],
}

async function submit() {
  if (loading.value) return
  errorText.value = ''
  uninitialized.value = false
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  try {
    await auth.login(form.password)
    ElMessage.success('欢迎回来')
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await router.replace(redirect.startsWith('/') ? redirect : '/')
  } catch (error) {
    const message = errorMessage(error)
    if (
      message.includes('未初始化') ||
      message.includes('npm run init') ||
      message.includes('NOT_INITIALIZED') ||
      (error instanceof ApiError && error.code === 'NOT_INITIALIZED')
    ) {
      uninitialized.value = true
    } else if (error instanceof ApiError && error.status === 401) {
      errorText.value = '密码不正确，请重试'
    } else if (error instanceof ApiError && error.status === 429) {
      errorText.value = '尝试次数过多，请稍后再试'
    } else {
      errorText.value = message
    }
    form.password = ''
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  background:
    radial-gradient(1200px 600px at 12% -10%, rgba(47, 111, 118, 0.14), transparent 60%),
    radial-gradient(900px 500px at 100% 110%, rgba(53, 95, 138, 0.1), transparent 55%),
    var(--color-bg);
}

.login-shell {
  width: 100%;
  max-width: 980px;
  display: grid;
  grid-template-columns: 1fr 420px;
  gap: var(--space-12);
  align-items: center;
}

.login-intro {
  padding: var(--space-8) var(--space-4);
}

.intro-eyebrow {
  display: inline-block;
  font-size: var(--text-xs);
  letter-spacing: 0.18em;
  color: var(--color-primary-700);
  margin-bottom: var(--space-5);
}

.intro-title {
  font-size: clamp(32px, 3.6vw, 44px);
  line-height: 1.32;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--color-text);
}

.intro-text {
  margin-top: var(--space-5);
  max-width: 420px;
  font-size: var(--text-md);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.intro-points {
  margin-top: var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.intro-points li {
  position: relative;
  padding-left: 20px;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.intro-points li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary-400);
}

.login-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  padding: var(--space-8);
}

.card-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-8);
}

.brand-mark {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--color-primary-600);
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 3px;
  padding: 0 7px;
}

.brand-mark-line {
  display: block;
  height: 2px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.92);
}

.brand-mark-line:nth-child(1) {
  width: 11px;
}

.brand-mark-line:nth-child(2) {
  width: 16px;
}

.brand-mark-line:nth-child(3) {
  width: 8px;
}

.brand-name {
  font-size: var(--text-sm);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
}

.login-title {
  font-size: var(--text-2xl);
  font-weight: 600;
  color: var(--color-text);
}

.login-subtitle {
  margin: var(--space-2) 0 var(--space-6);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.login-alert {
  margin-bottom: var(--space-4);
}

.init-hint {
  margin-top: 4px;
  font-size: var(--text-xs);
  line-height: 1.6;
}

.init-hint code {
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: rgba(0, 0, 0, 0.06);
  font-family: var(--font-mono);
  font-size: 12px;
}

.login-submit {
  width: 100%;
  margin-top: var(--space-2);
}

.login-footer {
  margin-top: var(--space-6);
  text-align: center;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

@media (max-width: 900px) {
  .login-shell {
    grid-template-columns: 1fr;
    max-width: 430px;
    gap: 0;
  }

  .login-intro {
    display: none;
  }

  .login-card {
    padding: var(--space-6);
  }
}

@media (max-width: 480px) {
  .login-page {
    padding: var(--space-4);
    align-items: flex-start;
    padding-top: 12vh;
  }
}
</style>
