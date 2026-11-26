<template>
  <div class="app-page settings-page">
    <AppHeader />

    <main class="page-main settings-main">
      <div class="settings-heading">
        <h1 class="page-title">设置</h1>
        <p class="page-subtitle">配置大模型接口，用于自动生成表现标签与家长反馈</p>
      </div>

      <el-alert
        v-if="insecureHttp"
        class="settings-alert"
        type="warning"
        :closable="false"
        show-icon
        title="当前是 HTTP"
        description="提交 Key 会以明文经过局域网，正式使用请走 Tailscale HTTPS。"
      />

      <section class="settings-card" aria-labelledby="llm-settings-title">
        <header class="card-head">
          <div class="card-icon" aria-hidden="true">
            <el-icon><Key /></el-icon>
          </div>
          <div class="card-head-text">
            <h2 id="llm-settings-title" class="card-title">模型服务</h2>
            <p class="card-desc">支持 OpenAI 兼容接口，接口地址必须使用 https。</p>
          </div>
          <span v-if="serverHasKey" class="status-pill status-pill--ok">已加密同步到服务器</span>
        </header>

        <el-alert
          v-if="restoreError"
          class="settings-alert"
          type="warning"
          :closable="false"
          show-icon
          :title="restoreError"
        />

        <el-form label-position="top" class="settings-form" @submit.prevent="saveSettings">
          <el-form-item label="接口地址 base_url" :error="baseUrlError">
            <el-input
              v-model="baseUrl"
              placeholder="https://api.example.com/v1"
              autocomplete="off"
              spellcheck="false"
              :disabled="saving"
            />
            <p class="field-hint">填到 /v1 这一级即可，系统会请求 /models 与 /chat/completions。</p>
          </el-form-item>

          <el-form-item label="API Key" :error="keyError">
            <el-input
              v-model="apiKey"
              type="password"
              show-password
              :placeholder="serverHasKey ? '已保存在服务器，留空不修改' : 'sk-...'"
              autocomplete="new-password"
              spellcheck="false"
              :disabled="saving"
            />
            <p class="field-hint">
              {{
                serverHasKey
                  ? '已在服务器加密保存；留空沿用，填写则替换。'
                  : '保存后使用 AES-256-GCM 加密存入服务器数据库，不再保存在浏览器。'
              }}
            </p>
          </el-form-item>

          <el-form-item label="模型" :error="modelError">
            <div class="model-row">
              <el-select
                v-if="!manualMode"
                v-model="model"
                class="model-select"
                filterable
                allow-create
                default-first-option
                placeholder="先探测模型，或直接输入模型名"
                :loading="probing"
                :disabled="saving"
              >
                <el-option v-for="item in models" :key="item.id" :label="item.label" :value="item.id" />
              </el-select>
              <el-input
                v-else
                v-model="model"
                class="model-select"
                placeholder="手动填写模型名，例如 gpt-4o-mini"
                autocomplete="off"
                spellcheck="false"
                :disabled="saving"
              />
              <el-button class="probe-btn" :loading="probing" :disabled="saving || !canProbe" @click="probeModels">
                探测模型
              </el-button>
            </div>
            <div class="model-hint-row">
              <span class="probe-message" :class="{ 'is-error': probeFailed }">{{ probeMessage }}</span>
              <el-button link type="primary" class="manual-toggle" @click="toggleManual">
                {{ manualMode ? '从列表选择' : '探测失败？手动填写模型名' }}
              </el-button>
            </div>
          </el-form-item>
        </el-form>

        <div class="settings-actions">
          <el-button type="primary" :loading="saving" @click="saveSettings">保存设置</el-button>
          <el-button :loading="testing" :disabled="saving || !canProbe" @click="testModel">测试连接</el-button>
        </div>

        <el-alert
          v-if="testResult"
          class="test-result"
          :type="testResult.type"
          :title="testResult.title"
          :description="testResult.description"
          show-icon
          :closable="false"
        />
      </section>

      <section class="settings-card backup-card" aria-labelledby="backup-title">
        <header class="card-head">
          <div class="card-icon card-icon--muted" aria-hidden="true">
            <el-icon><Download /></el-icon>
          </div>
          <div class="card-head-text">
            <h2 id="backup-title" class="card-title">备份与恢复</h2>
            <p class="card-desc">导出全部数据，或从 JSON 备份文件导入。</p>
          </div>
        </header>

        <template v-if="isDesktop">
          <div class="backup-block">
            <div class="backup-section-title">导出</div>
            <div class="backup-file-row">
              <el-button :icon="Download" :loading="exportingAll" @click="exportAll">导出全部</el-button>
              <span class="backup-hint">导出全部学生、反馈记录和生成历史</span>
            </div>
          </div>

          <div class="backup-divider" />

          <div class="backup-block">
            <div class="backup-section-title">导入</div>
            <input
              ref="fileInput"
              class="hidden-file-input"
              type="file"
              accept=".json,application/json"
              @change="handleFileChange"
            />
            <div class="backup-file-row">
              <el-button :icon="Document" :disabled="importing" @click="chooseFile">选择 JSON 备份文件</el-button>
              <span class="backup-file-name">{{ selectedFile ? selectedFile.name : '未选择文件' }}</span>
            </div>
            <p v-if="parseErrorMessage" class="backup-error">{{ parseErrorMessage }}</p>

            <div v-if="displaySummary" class="backup-summary">
              <div class="backup-summary-item">
                <span>学生</span>
                <strong>{{ displaySummary.students }}</strong>
              </div>
              <div class="backup-summary-item">
                <span>反馈</span>
                <strong>{{ displaySummary.feedbacks }}</strong>
              </div>
              <div class="backup-summary-item">
                <span>生成</span>
                <strong>{{ displaySummary.generations }}</strong>
              </div>
              <div class="backup-summary-item backup-summary-time">
                <span>导出时间</span>
                <strong>
                  {{ displaySummary.exportedAt ? formatDateTime(displaySummary.exportedAt) : '未提供' }}
                </strong>
              </div>
            </div>

            <div v-if="preview && preview.conflicts.length" class="backup-conflicts">
              <div class="backup-conflicts-head">
                <span class="backup-field-label">
                  发现 {{ preview.conflicts.length }} 名同名同校学生
                </span>
                <span class="backup-conflict-actions">
                  <el-button link type="primary" :disabled="importing" @click="setAllDecisions('new')"
                    >全部新建</el-button
                  >
                  <el-button
                    link
                    type="primary"
                    :disabled="importing"
                    @click="setAllDecisions('overwrite')"
                    >全部覆盖</el-button
                  >
                </span>
              </div>
              <ul class="backup-conflict-list">
                <li v-for="item in preview.conflicts" :key="item.index" class="backup-conflict-item">
                  <div class="backup-conflict-text">
                    <strong>{{ item.name }}</strong>
                    <span>
                      {{ item.school || '未填写学校' }} · 现有反馈
                      {{ item.existing.feedbacks }} 条 / 生成 {{ item.existing.generations }} 条
                    </span>
                  </div>
                  <el-radio-group v-model="decisions[item.index]" :disabled="importing">
                    <el-radio value="new">新建</el-radio>
                    <el-radio value="overwrite">覆盖</el-radio>
                  </el-radio-group>
                </li>
              </ul>
              <el-checkbox v-if="anyOverwrite" v-model="confirmOverwrite" class="backup-confirm">
                我确认覆盖所选学生的反馈与生成历史
              </el-checkbox>
            </div>
            <p v-else-if="preview" class="backup-hint backup-no-conflict">
              没有同名同校冲突，将全部按新建导入。
            </p>

            <div class="backup-actions">
              <el-button
                type="primary"
                :icon="Upload"
                :loading="importing"
                :disabled="!preview || importing || previewing"
                @click="importBackup"
                >导入备份</el-button
              >
              <span class="backup-hint">导入前会校验文件、列出冲突，并自动备份当前数据</span>
            </div>
          </div>
        </template>

        <div v-else class="backup-mobile-tip">
          <p>手机端暂未开放备份导入导出，请在电脑端操作</p>
        </div>
      </section>

      <section class="settings-card security-card" aria-labelledby="security-title">
        <header class="card-head">
          <div class="card-icon card-icon--muted" aria-hidden="true">
            <el-icon><Lock /></el-icon>
          </div>
          <div class="card-head-text">
            <h2 id="security-title" class="card-title">密钥安全</h2>
            <p class="card-desc">Key 加密同步到服务器，所有登录设备自动使用。</p>
          </div>
        </header>
        <ul class="security-list">
          <li>API Key 使用 AES-256-GCM 加密保存在服务器数据库，登录的所有设备自动同步。</li>
          <li>浏览器不再保存明文 Key；保存成功后只保留接口地址和模型名。</li>
          <li>密码重置后需要重新填写一次 API Key。</li>
          <li>模型请求由服务器转发，Key 不写入日志。</li>
        </ul>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, Download, Key, Lock, Upload } from '@element-plus/icons-vue'
import AppHeader from '@/components/AppHeader.vue'
import { api, errorMessage, ApiError } from '@/lib/api'
import { normalizeBaseUrl, normalizeModels, validateBaseUrl } from '@/lib/llm'
import {
  downloadBackup,
  parseBackupText,
  previewBackup,
  BackupParseError,
  type BackupPreview,
  type BackupSummary,
} from '@/lib/backup'
import { formatDateTime } from '@/lib/format'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useLlmSettingsStore } from '@/stores/llm'
import { useStudentsStore } from '@/stores/students'
import type { LlmModel } from '@/types'

const llm = useLlmSettingsStore()
const students = useStudentsStore()
const isDesktop = useMediaQuery('(min-width: 768px)')

const baseUrl = ref('')
const apiKey = ref('')
const model = ref('')
const baseUrlError = ref('')
const keyError = ref('')
const modelError = ref('')
const models = ref<LlmModel[]>([])
const manualMode = ref(false)
const probing = ref(false)
const saving = ref(false)
const testing = ref(false)
const probeMessage = ref('')
const probeFailed = ref(false)
const hydrated = ref(false)
const testResult = ref<{
  type: 'success' | 'error' | 'warning'
  title: string
  description?: string
} | null>(null)

const fileInput = ref<HTMLInputElement>()
const selectedFile = ref<File | null>(null)
const summary = ref<BackupSummary | null>(null)
const preview = ref<BackupPreview | null>(null)
const decisions = ref<Record<number, 'new' | 'overwrite'>>({})
const confirmOverwrite = ref(false)
const exportingAll = ref(false)
const importing = ref(false)
const previewing = ref(false)
const parseErrorMessage = ref('')

const serverHasKey = computed(() => llm.serverHasKey)
const restoreError = computed(() => llm.restoreError)
const insecureHttp = computed(() => {
  if (typeof window === 'undefined' || window.location.protocol !== 'http:') return false
  const hostname = window.location.hostname
  return hostname !== 'localhost' && hostname !== '127.0.0.1'
})

const canProbe = computed(
  () =>
    Boolean(baseUrl.value.trim()) &&
    (Boolean(apiKey.value.trim()) || llm.serverHasKey),
)

const displaySummary = computed(() => {
  if (preview.value) {
    return {
      students: preview.value.students,
      feedbacks: preview.value.feedbacks,
      generations: preview.value.generations,
      exportedAt: preview.value.exportedAt,
    }
  }
  if (summary.value) {
    return {
      students: summary.value.studentCount,
      feedbacks: summary.value.feedbackCount,
      generations: summary.value.generationCount,
      exportedAt: summary.value.exportedAt,
    }
  }
  return null
})

const anyOverwrite = computed(() =>
  Boolean(
    preview.value?.conflicts.some((item) => decisions.value[item.index] === 'overwrite'),
  ),
)

function hydrateFromStore() {
  if (hydrated.value || !llm.initialized) return
  baseUrl.value = llm.baseUrl
  model.value = llm.model
  apiKey.value = ''
  hydrated.value = true
}

watch(
  () => llm.initialized,
  (ready) => {
    if (ready) hydrateFromStore()
  },
  { immediate: true },
)

onMounted(() => {
  if (!llm.initialized) void llm.init()
})

function buildHeaders(includeModel = true): Record<string, string> {
  const localKey = apiKey.value.trim()
  if (!localKey) return {}
  const headers: Record<string, string> = {
    'x-llm-base-url': encodeURIComponent(normalizeBaseUrl(baseUrl.value)),
    'x-llm-api-key': encodeURIComponent(localKey),
  }
  if (includeModel && model.value.trim()) {
    headers['x-llm-model'] = encodeURIComponent(model.value.trim())
  }
  return headers
}

/** 只有当前表单输入了新 key 时才传给后端；无 key 时由后端使用服务器已存配置。 */
function buildCredentials(includeModel = true): Record<string, string> {
  const localKey = apiKey.value.trim()
  if (!localKey) return {}
  const payload: Record<string, string> = {
    base_url: normalizeBaseUrl(baseUrl.value),
    api_key: localKey,
  }
  if (includeModel && model.value.trim()) {
    payload.model = model.value.trim()
  }
  return payload
}

function validateBaseAndKey(): boolean {
  baseUrlError.value = validateBaseUrl(baseUrl.value) ?? ''
  const hasKey = Boolean(apiKey.value.trim()) || llm.serverHasKey
  keyError.value = hasKey ? '' : '请填写 API Key'
  return !baseUrlError.value && !keyError.value
}

function validateAll(): boolean {
  const baseOk = validateBaseAndKey()
  modelError.value = model.value.trim() ? '' : '请选择或填写模型名'
  return baseOk && !modelError.value
}

async function probeModels() {
  if (probing.value || !validateBaseAndKey()) return
  probing.value = true
  probeMessage.value = ''
  probeFailed.value = false
  testResult.value = null
  try {
    const data = await api.post<unknown>('/llm/models', buildCredentials(false), {
      headers: buildHeaders(false),
    })
    models.value = normalizeModels(data)
    if (models.value.length) {
      if (!model.value.trim()) model.value = models.value[0].id
      probeMessage.value = `探测成功，发现 ${models.value.length} 个模型`
      manualMode.value = false
      modelError.value = ''
    } else {
      probeMessage.value = '接口可用，但没有返回模型列表，请手动填写模型名'
      manualMode.value = true
    }
  } catch (error) {
    probeFailed.value = true
    probeMessage.value = `探测失败：${errorMessage(error)}`
    manualMode.value = true
  } finally {
    probing.value = false
  }
}

async function saveSettings() {
  if (saving.value || !validateAll()) return
  saving.value = true
  try {
    await llm.save({ baseUrl: baseUrl.value, apiKey: apiKey.value, model: model.value })
    baseUrl.value = llm.baseUrl
    model.value = llm.model
    apiKey.value = ''
    keyError.value = ''
    ElMessage.success('设置已保存并同步到服务器')
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    saving.value = false
  }
}

async function testModel() {
  if (testing.value || !validateAll()) return
  testing.value = true
  testResult.value = null
  try {
    const data = await api.post<Record<string, unknown>>('/llm/test', buildCredentials(), {
      headers: buildHeaders(),
    })
    if (data && data.ok === false) {
      throw new Error(typeof data.message === 'string' ? data.message : '模型返回异常')
    }
    const detail =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.content === 'string' && data.content) ||
      (typeof data?.reply === 'string' && data.reply) ||
      '模型响应正常，可以使用。'
    testResult.value = { type: 'success', title: '连接成功', description: detail }
    ElMessage.success('模型可用')
  } catch (error) {
    testResult.value = { type: 'error', title: '连接失败', description: errorMessage(error) }
  } finally {
    testing.value = false
  }
}

function toggleManual() {
  manualMode.value = !manualMode.value
  probeMessage.value = manualMode.value
    ? '手动填写模型名后，点「测试连接」验证是否可用'
    : probeMessage.value
}

function setAllDecisions(action: 'new' | 'overwrite') {
  if (!preview.value) return
  const next: Record<number, 'new' | 'overwrite'> = {}
  for (const item of preview.value.conflicts) next[item.index] = action
  decisions.value = next
  if (action === 'new') confirmOverwrite.value = false
}

function chooseFile() {
  fileInput.value?.click()
}

async function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  selectedFile.value = file
  summary.value = null
  preview.value = null
  decisions.value = {}
  parseErrorMessage.value = ''
  confirmOverwrite.value = false
  if (!file) return

  try {
    const text = await file.text()
    const parsed = parseBackupText(text)
    summary.value = parsed

    previewing.value = true
    const result = await previewBackup(parsed.data)
    preview.value = result
    const next: Record<number, 'new' | 'overwrite'> = {}
    for (const item of result.conflicts) next[item.index] = 'new'
    decisions.value = next
  } catch (error) {
    if (error instanceof BackupParseError) {
      if (error.code === 'invalid-json') parseErrorMessage.value = '文件不是合法 JSON'
      else if (error.code === 'version') parseErrorMessage.value = '备份文件版本不支持'
      else parseErrorMessage.value = '备份文件格式不正确'
    } else if (error instanceof ApiError) {
      if (error.code === 'INVALID_BACKUP') {
        parseErrorMessage.value = error.message.includes('版本')
          ? '备份文件版本不支持'
          : '备份文件格式不正确'
      } else {
        parseErrorMessage.value = `备份文件校验失败：${error.message}`
      }
    } else {
      parseErrorMessage.value = '备份文件读取失败'
    }
    ElMessage.error(parseErrorMessage.value)
  } finally {
    previewing.value = false
  }
}

function numericField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function importStats(result: unknown, fallback: BackupSummary) {
  const root =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  const candidates = [root.imported, root.stats, root.result, root].filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  )
  for (const candidate of candidates) {
    const studentCount = numericField(candidate, ['students', 'student_count', 'studentCount'])
    const feedbackCount = numericField(candidate, ['feedbacks', 'feedback_count', 'feedbackCount'])
    const generationCount = numericField(candidate, [
      'generations',
      'generation_count',
      'generationCount',
    ])
    if (studentCount !== undefined || feedbackCount !== undefined || generationCount !== undefined) {
      return {
        students: studentCount ?? fallback.studentCount,
        feedbacks: feedbackCount ?? fallback.feedbackCount,
        generations: generationCount ?? fallback.generationCount,
      }
    }
  }
  return {
    students: fallback.studentCount,
    feedbacks: fallback.feedbackCount,
    generations: fallback.generationCount,
  }
}

async function exportAll() {
  if (exportingAll.value) return
  exportingAll.value = true
  try {
    await downloadBackup()
    ElMessage.success('备份已开始下载')
  } catch (error) {
    ElMessage.error(`导出失败：${errorMessage(error)}`)
  } finally {
    exportingAll.value = false
  }
}

async function importBackup() {
  if (!summary.value || !preview.value || importing.value) return
  if (anyOverwrite.value && !confirmOverwrite.value) {
    ElMessage.error('导入失败：缺少覆盖确认，请勾选确认覆盖')
    return
  }

  const statsFallback = summary.value
  const decisionsPayload = preview.value.conflicts.map((item) => ({
    index: item.index,
    action: decisions.value[item.index] ?? 'new',
  }))

  importing.value = true
  try {
    const result = await api.post<Record<string, unknown>>('/backup/import', {
      data: summary.value.data,
      conflict: 'new',
      ...(decisionsPayload.length ? { decisions: decisionsPayload } : {}),
      ...(anyOverwrite.value ? { confirm_overwrite: true } : {}),
    })
    try {
      await students.fetchAll()
    } catch {
      ElMessage.warning('导入完成，但学生列表刷新失败，请手动刷新页面')
    }
    const stats = importStats(result, statsFallback)
    const backupFile =
      typeof result?.backup_file === 'string' && result.backup_file.trim()
        ? `，已自动备份当前数据到 ${result.backup_file}`
        : ''
    ElMessage.success(
      `导入完成：学生 ${stats.students} 名，反馈 ${stats.feedbacks} 条，生成记录 ${stats.generations} 条${backupFile}`,
    )
    selectedFile.value = null
    summary.value = null
    preview.value = null
    decisions.value = {}
    confirmOverwrite.value = false
    parseErrorMessage.value = ''
    if (fileInput.value) fileInput.value.value = ''
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === 'CONFIRM_REQUIRED' || error.message.includes('确认'))
    ) {
      ElMessage.error('导入失败：缺少覆盖确认')
    } else if (
      error instanceof ApiError &&
      (error.code === 'UNSUPPORTED_VERSION' || error.message.includes('版本'))
    ) {
      ElMessage.error('备份文件版本不支持')
    } else {
      ElMessage.error(`导入失败：${errorMessage(error)}`)
    }
  } finally {
    importing.value = false
  }
}
</script>

<style scoped>
.settings-main {
  max-width: 880px;
}

.settings-heading {
  margin-bottom: var(--space-5);
}

.settings-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xs);
  padding: var(--space-6);
}

.settings-card + .settings-card {
  margin-top: var(--space-4);
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.card-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--color-primary-50);
  color: var(--color-primary-700);
  font-size: 18px;
}

.card-icon--muted {
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
}

.card-head-text {
  flex: 1;
  min-width: 0;
}

.card-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.4;
}

.card-desc {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.status-pill {
  flex-shrink: 0;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  font-weight: 500;
}

.status-pill--ok {
  background: var(--color-success-bg);
  color: var(--color-success);
  border: 1px solid var(--color-success-border);
}

.settings-alert {
  margin-bottom: var(--space-4);
}

.settings-form {
  max-width: 620px;
}

.field-hint {
  margin-top: 6px;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--color-text-tertiary);
}

.model-row {
  display: flex;
  gap: var(--space-2);
  width: 100%;
}

.model-select {
  flex: 1;
  min-width: 0;
}

.probe-btn {
  flex-shrink: 0;
}

.model-hint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  margin-top: 6px;
  flex-wrap: wrap;
}

.probe-message {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.probe-message.is-error {
  color: var(--color-danger);
}

.manual-toggle {
  margin-left: auto;
  font-size: var(--text-xs);
  height: auto;
  min-height: 40px;
  padding: 0 4px;
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-top: var(--space-2);
}

.test-result {
  margin-top: var(--space-4);
}

.backup-block {
  min-width: 0;
}

.backup-section-title {
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text);
}

.backup-divider {
  height: 1px;
  margin: var(--space-5) 0;
  background: var(--color-border);
}

.hidden-file-input {
  display: none;
}

.backup-file-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.backup-file-name {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backup-error {
  margin-top: 6px;
  font-size: var(--text-xs);
  color: var(--color-danger);
}

.backup-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(180px, 1.5fr);
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-primary-100);
  border-radius: var(--radius-md);
  background: var(--color-primary-50);
}

.backup-summary-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.backup-summary-item span {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.backup-summary-item strong {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.backup-summary-time strong {
  font-size: var(--text-sm);
  font-weight: 500;
}

.backup-conflict-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-4);
  flex-wrap: wrap;
}

.backup-conflicts {
  margin-top: var(--space-4);
}

.backup-conflicts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-2);
}

.backup-conflict-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.backup-conflict-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.backup-conflict-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-soft);
  flex-wrap: wrap;
}

.backup-conflict-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.backup-conflict-text strong {
  font-size: var(--text-sm);
  color: var(--color-text);
}

.backup-conflict-text span {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.backup-no-conflict {
  display: block;
  margin-top: var(--space-3);
}

.backup-field-label {
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: 500;
}

.backup-confirm {
  margin-top: var(--space-2);
}

.backup-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-5);
  flex-wrap: wrap;
}

.backup-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.backup-mobile-tip {
  padding: var(--space-8) var(--space-4);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-lg);
  background: var(--color-surface-soft);
  text-align: center;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
}

.security-card {
  background: var(--color-surface-soft);
}

.security-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-left: 4px;
}

.security-list li {
  position: relative;
  padding-left: 18px;
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--color-text-secondary);
}

.security-list li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary-300);
}

@media (max-width: 767px) {
  .settings-card {
    padding: var(--space-4);
  }

  .card-head {
    flex-wrap: wrap;
  }

  .model-row {
    flex-direction: column;
  }

  .probe-btn {
    width: 100%;
  }

  .settings-actions {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
