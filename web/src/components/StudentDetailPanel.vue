<template>
  <div class="detail-panel" :class="{ 'is-mobile': mobile }">
    <header class="detail-header">
      <div v-if="mobile" class="mobile-topbar">
        <el-button text :icon="ArrowLeft" class="back-btn" @click="emit('close')">返回</el-button>
        <el-button text :icon="EditPen" @click="editVisible = true">编辑</el-button>
      </div>
      <div class="detail-heading">
        <div class="detail-title-block">
          <span class="detail-eyebrow">学生详情</span>
          <h2 class="detail-name">{{ current.name }}</h2>
          <p class="detail-sub">
            <span>{{ current.school || '未填写学校' }}</span>
            <span class="dot-sep" aria-hidden="true">·</span>
            <span>{{ weekdayLabel(current.weekday) }}</span>
          </p>
        </div>
        <div v-if="!mobile" class="detail-actions">
          <el-button :icon="EditPen" @click="editVisible = true">编辑</el-button>
          <el-button text circle :icon="Close" aria-label="关闭详情" @click="emit('close')" />
        </div>
      </div>
    </header>

    <div class="detail-body">
      <section class="summary-card" aria-labelledby="tag-section-title">
        <div class="summary-row">
          <div class="summary-label" id="tag-section-title">表现标签</div>
          <div class="summary-tags">
            <TagChips :tags="current.tags" size="md" empty-text="暂无标签" />
          </div>
          <el-button
            text
            class="refresh-tags"
            :icon="Refresh"
            :loading="refreshingTags"
            :disabled="feedbacks.length === 0"
            :title="feedbacks.length === 0 ? '暂无反馈，先添加反馈再刷新标签' : '刷新标签'"
            @click="refreshTags"
            >刷新标签</el-button
          >
        </div>
        <p v-if="current.tags_at" class="tag-updated">更新于 {{ formatDateTime(current.tags_at) }}</p>
        <p v-else class="tag-updated">录入反馈后，系统会从固定词表中自动更新标签</p>
      </section>

      <el-tabs v-model="activeTab" class="detail-tabs">
        <el-tab-pane label="反馈记录" name="feedback">
          <section class="compose-card" aria-labelledby="feedback-compose-title">
            <label id="feedback-compose-title" class="field-label" for="feedback-input">新增反馈</label>
            <el-input
              id="feedback-input"
              v-model="feedbackContent"
              type="textarea"
              :rows="4"
              maxlength="2000"
              show-word-limit
              resize="vertical"
              placeholder="记录这节课的表现，例如：作业完成认真，计算题正确率明显提升，但审题还有些粗心…"
              @keydown.ctrl.enter.prevent="submitFeedback"
            />
            <div class="compose-actions">
              <span class="compose-hint">Ctrl + Enter 快速保存</span>
              <el-button
                type="primary"
                :loading="submittingFeedback"
                :disabled="!feedbackContent.trim()"
                @click="submitFeedback"
                >保存反馈</el-button
              >
            </div>
          </section>

          <div class="section-head">
            <span>历史反馈</span>
            <span class="section-count">{{ feedbacks.length }} 条</span>
          </div>

          <div v-if="loadingFeedbacks" class="detail-loading">
            <el-skeleton :rows="3" animated />
          </div>
          <div v-else-if="!feedbacks.length" class="empty-state">
            <span class="empty-state__title">还没有反馈记录</span>
            <span class="empty-state__hint">每次课后记一条，生成家长反馈时就能直接用</span>
          </div>
          <ol v-else class="feedback-timeline">
            <li v-for="item in feedbacks" :key="item.id" class="timeline-item">
              <span class="timeline-dot" aria-hidden="true" />
              <div class="timeline-card">
                <div class="timeline-head">
                  <div class="timeline-meta">{{ formatDateTime(item.happened_at) }}</div>
                  <el-button
                    text
                    :icon="Delete"
                    class="feedback-delete"
                    :loading="deletingFeedbackId === item.id"
                    aria-label="删除这条反馈"
                    title="删除这条反馈"
                    @click.stop="deleteFeedback(item)"
                    >删除</el-button
                  >
                </div>
                <p class="timeline-content">{{ item.content }}</p>
              </div>
            </li>
          </ol>
        </el-tab-pane>

        <el-tab-pane label="生成家长反馈" name="generate">
          <section class="generate-config">
            <div class="config-row">
              <div class="config-field">
                <label class="field-label" for="weeks-select">参考时间范围</label>
                <el-select id="weeks-select" v-model="weeks" class="weeks-select">
                  <el-option v-for="n in 20" :key="n" :label="`近 ${n} 周`" :value="n" />
                </el-select>
              </div>
              <el-button
                type="primary"
                class="generate-btn"
                :icon="MagicStick"
                :loading="generating"
                :disabled="!llm.configured"
                @click="startGenerate"
                >{{ generating ? '生成中…' : '生成反馈' }}</el-button
              >
            </div>
            <p class="field-hint">按周一至周日切分，只依据所选范围内录入的反馈生成，可直接复制发给家长。</p>
            <el-alert
              v-if="!llm.configured"
              type="info"
              :closable="false"
              show-icon
              title="尚未配置大模型 API"
              description="请先到设置页填写接口地址、API Key 并选择模型。"
            />
          </section>

          <section class="output-card">
            <div class="output-head">
              <span>生成结果</span>
              <div class="output-actions">
                <el-button v-if="generating" text type="danger" @click="stopGenerate">停止</el-button>
                <el-button
                  :icon="CopyDocument"
                  :disabled="!output || generating"
                  @click="copyText(output)"
                  >复制</el-button
                >
              </div>
            </div>
            <div v-if="noRecords" class="no-records">
              <el-icon class="no-records-icon"><Warning /></el-icon>
              <p class="no-records-title">本周无记录，建议调整参考时间范围</p>
              <p class="no-records-hint">把周数调大一些，或先补充这周的反馈再生成。</p>
            </div>
            <div v-else-if="errorText" class="generate-error">{{ errorText }}</div>
            <pre v-else-if="output" class="output-text">{{ output }}<span v-if="generating" class="stream-caret" /></pre>
            <div v-else class="output-placeholder">
              选择参考范围后点「生成反馈」，内容会在这里逐字出现
            </div>
          </section>

          <div class="section-head">
            <span>最近生成</span>
            <span class="section-count">最多保留 5 条</span>
          </div>
          <div v-if="loadingGenerations" class="detail-loading">
            <el-skeleton :rows="2" animated />
          </div>
          <div v-else-if="!generations.length" class="empty-state">
            <span class="empty-state__title">暂无生成记录</span>
            <span class="empty-state__hint">生成后的反馈会自动保存在这里</span>
          </div>
          <ul v-else class="generation-list">
            <li v-for="item in generations" :key="item.id" class="generation-item">
              <div class="generation-meta">
                <span>{{ formatDateTime(item.created_at) }}</span>
                <span class="generation-weeks">近 {{ item.weeks }} 周</span>
                <el-button
                  text
                  :icon="CopyDocument"
                  class="history-copy"
                  @click.stop="copyText(item.content)"
                  >复制</el-button
                >
                <el-button
                  text
                  :icon="Delete"
                  class="history-delete"
                  :loading="deletingGenerationId === item.id"
                  aria-label="删除这条生成记录"
                  title="删除这条生成记录"
                  @click.stop="deleteGeneration(item)"
                  >删除</el-button
                >
              </div>
              <p class="generation-content">{{ item.content }}</p>
            </li>
          </ul>
        </el-tab-pane>
      </el-tabs>

      <footer class="detail-danger">
        <el-button :icon="Download" :loading="exportingStudent" @click="exportStudent"
          >导出该学生</el-button
        >
        <el-button type="danger" plain :icon="Delete" @click="confirmDelete">删除学生</el-button>
        <span class="danger-hint">反馈记录与生成历史将一并删除，请谨慎操作</span>
      </footer>
    </div>

    <StudentFormDialog v-model="editVisible" :student="current" @saved="onSaved" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft,
  Close,
  CopyDocument,
  Delete,
  Download,
  EditPen,
  MagicStick,
  Refresh,
  Warning,
} from '@element-plus/icons-vue'
import TagChips from '@/components/TagChips.vue'
import StudentFormDialog from '@/components/StudentFormDialog.vue'
import { api, errorMessage, ApiError } from '@/lib/api'
import { downloadBackup } from '@/lib/backup'
import { formatDateTime } from '@/lib/format'
import { streamGenerate } from '@/lib/sse'
import { weekdayLabel } from '@/lib/tags'
import { useLlmSettingsStore } from '@/stores/llm'
import { useStudentsStore } from '@/stores/students'
import type { Feedback, Generation, Student } from '@/types'

const props = withDefaults(
  defineProps<{
    student: Student
    mobile?: boolean
  }>(),
  { mobile: false },
)

const emit = defineEmits<{
  close: []
  deleted: [id: number]
}>()

const store = useStudentsStore()
const llm = useLlmSettingsStore()

const current = computed(() => store.findById(props.student.id) ?? props.student)
const activeTab = ref<'feedback' | 'generate'>('feedback')
const editVisible = ref(false)

const feedbacks = ref<Feedback[]>([])
const loadingFeedbacks = ref(false)
const feedbackContent = ref('')
const submittingFeedback = ref(false)
const refreshingTags = ref(false)
const deletingFeedbackId = ref<number | null>(null)

const generations = ref<Generation[]>([])
const loadingGenerations = ref(false)
const deletingGenerationId = ref<number | null>(null)
const exportingStudent = ref(false)
const weeks = ref(1)
const generating = ref(false)
const output = ref('')
const errorText = ref('')
const noRecords = ref(false)
let controller: AbortController | null = null

function extractArray(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as unknown[]
    }
    if (Array.isArray(record.data)) return record.data
  }
  return []
}

function normalizeFeedback(raw: unknown): Feedback {
  const record = (raw ?? {}) as Record<string, unknown>
  return {
    id: Number(record.id) || 0,
    student_id: Number(record.student_id) || props.student.id,
    content: typeof record.content === 'string' ? record.content : '',
    happened_at: Number(record.happened_at) || 0,
  }
}

function normalizeGeneration(raw: unknown): Generation {
  const record = (raw ?? {}) as Record<string, unknown>
  return {
    id: Number(record.id) || 0,
    student_id: Number(record.student_id) || props.student.id,
    content: typeof record.content === 'string' ? record.content : '',
    weeks: Number(record.weeks) || 0,
    created_at: Number(record.created_at) || 0,
  }
}

async function loadFeedbacks() {
  loadingFeedbacks.value = true
  try {
    const data = await api.get<unknown>(`/students/${props.student.id}/feedbacks`)
    feedbacks.value = extractArray(data, ['feedbacks'])
      .map(normalizeFeedback)
      .filter((item) => item.id > 0)
      .sort((a, b) => b.happened_at - a.happened_at)
  } catch (error) {
    ElMessage.error(`反馈记录加载失败：${errorMessage(error)}`)
  } finally {
    loadingFeedbacks.value = false
  }
}

async function loadGenerations() {
  loadingGenerations.value = true
  try {
    const data = await api.get<unknown>(`/students/${props.student.id}/generations`)
    generations.value = extractArray(data, ['generations'])
      .map(normalizeGeneration)
      .filter((item) => item.id > 0)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5)
  } catch (error) {
    ElMessage.error(`生成历史加载失败：${errorMessage(error)}`)
  } finally {
    loadingGenerations.value = false
  }
}

async function submitFeedback() {
  const content = feedbackContent.value.trim()
  if (!content || submittingFeedback.value) return
  submittingFeedback.value = true
  try {
    const response = await api.post<Record<string, unknown>>(
      `/students/${props.student.id}/feedbacks`,
      { content, ...llm.credentialPayload() },
      { headers: llm.headers() },
    )
    feedbackContent.value = ''
    ElMessage.success('反馈已保存')
    await Promise.all([loadFeedbacks(), store.fetchAll()])
    if (response && response.tags_updated === false) {
      const reasonText =
        typeof response.message === 'string' && response.message.trim()
          ? response.message
          : typeof response.reason === 'string' && response.reason.trim()
            ? response.reason
            : ''
      ElMessage.warning(
        reasonText
          ? `反馈已保存，但标签更新失败：${reasonText}`
          : '反馈已保存，但标签更新失败，可点「刷新标签」重试',
      )
    }
  } catch (error) {
    ElMessage.error(`反馈保存失败：${errorMessage(error)}`)
  } finally {
    submittingFeedback.value = false
  }
}

async function deleteFeedback(item: Feedback) {
  if (deletingFeedbackId.value !== null) return
  try {
    await ElMessageBox.confirm(
      '删除后不可恢复，确定删除这条反馈记录吗？',
      '删除反馈',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }

  deletingFeedbackId.value = item.id
  try {
    const response = await api.delete<Record<string, unknown>>(
      `/students/${props.student.id}/feedbacks/${item.id}`,
      { confirm: true },
    )
    feedbacks.value = feedbacks.value.filter((row) => row.id !== item.id)
    await store.fetchAll()
    if (response?.tags_cleared === true) {
      ElMessage.success('已删除，最后一条反馈删完后标签也一并清空')
    } else {
      ElMessage.success('反馈已删除')
    }
  } catch (error) {
    ElMessage.error(`删除失败：${errorMessage(error)}`)
  } finally {
    deletingFeedbackId.value = null
  }
}

async function refreshTags() {
  if (feedbacks.value.length === 0) {
    ElMessage.warning('该学生还没有反馈记录，先添加反馈再刷新标签')
    return
  }
  if (refreshingTags.value) return
  if (!llm.configured) {
    ElMessage.warning('请先在设置页配置大模型 API')
    return
  }
  refreshingTags.value = true
  try {
    const response = await api.post<Record<string, unknown>>(
      `/students/${props.student.id}/tags/refresh`,
      { ...llm.credentialPayload() },
      { headers: llm.headers() },
    )
    const tags = Array.isArray(response?.tags)
      ? response.tags.filter((item): item is string => typeof item === 'string')
      : []
    if (response?.tags_updated === true) {
      store.patchLocal(props.student.id, { tags, tags_at: Date.now() })
      ElMessage.success('标签已刷新')
    } else if (response?.tags_updated === false) {
      const reason =
        typeof response.message === 'string' && response.message
          ? response.message
          : '没有生成新的有效标签，已保留原有标签'
      ElMessage.warning(reason)
    } else if (tags.length) {
      store.patchLocal(props.student.id, { tags })
      ElMessage.success('标签已刷新')
    } else {
      ElMessage.success('标签已刷新')
    }
    await store.fetchAll()
  } catch (error) {
    ElMessage.error(`标签刷新失败：${errorMessage(error)}`)
  } finally {
    refreshingTags.value = false
  }
}

async function startGenerate() {
  if (generating.value) return
  if (!llm.configured) {
    ElMessage.warning('请先在设置页配置大模型 API')
    return
  }
  if (!Number.isInteger(weeks.value) || weeks.value < 1 || weeks.value > 20) {
    ElMessage.warning('参考周数需在 1 到 20 之间')
    return
  }

  output.value = ''
  errorText.value = ''
  noRecords.value = false
  generating.value = true
  controller = new AbortController()
  let doneReceived = false

  try {
    await streamGenerate(
      props.student.id,
      weeks.value,
      {
        onDelta: (text) => {
          output.value += text
        },
        onDone: () => {
          doneReceived = true
        },
        onError: (error) => {
          errorText.value = error.message
        },
      },
      { signal: controller.signal, headers: llm.headers(), credentials: llm.credentialPayload() },
    )
    if (doneReceived && !errorText.value && output.value.trim()) {
      ElMessage.success('生成完成')
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (output.value.trim()) ElMessage.info('已停止生成，已生成的内容仍可复制')
    } else if (error instanceof ApiError && (error.code === 'NO_RECORDS' || error.status === 409)) {
      noRecords.value = true
    } else {
      errorText.value = errorMessage(error)
    }
  } finally {
    generating.value = false
    controller = null
    if (!errorText.value && !noRecords.value && !output.value.trim()) {
      errorText.value = '生成结果为空，请调整范围后重试'
    }
    void loadGenerations()
  }
}

function stopGenerate() {
  controller?.abort()
  generating.value = false
}

async function copyText(text: string) {
  if (!text) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      throw new Error('clipboard unavailable')
    }
    ElMessage.success('已复制，可直接发给家长')
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      ElMessage.success('已复制，可直接发给家长')
    } catch {
      ElMessage.error('复制失败，请手动选择文本复制')
    }
  }
}

async function deleteGeneration(item: Generation) {
  if (deletingGenerationId.value !== null) return
  try {
    await ElMessageBox.confirm('删除后不可恢复，确定删除这条生成记录吗？', '删除生成记录', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }

  deletingGenerationId.value = item.id
  try {
    await api.delete(`/students/${props.student.id}/generations/${item.id}`, { confirm: true })
    generations.value = generations.value.filter((generation) => generation.id !== item.id)
    ElMessage.success('已删除')
  } catch (error) {
    ElMessage.error(`删除失败：${errorMessage(error)}`)
  } finally {
    deletingGenerationId.value = null
  }
}

async function exportStudent() {
  if (exportingStudent.value) return
  exportingStudent.value = true
  try {
    await downloadBackup({ studentId: props.student.id })
    ElMessage.success('已开始下载学生备份')
  } catch (error) {
    ElMessage.error(`导出失败：${errorMessage(error)}`)
  } finally {
    exportingStudent.value = false
  }
}

async function confirmDelete() {
  try {
    await ElMessageBox.confirm(
      `删除后，该学生的全部反馈记录与生成历史将一并删除，且无法恢复。确定删除「${current.value.name}」吗？`,
      '删除学生',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }
  try {
    await store.remove(current.value.id)
    ElMessage.success('学生已删除')
    emit('deleted', current.value.id)
    emit('close')
  } catch (error) {
    ElMessage.error(`删除失败：${errorMessage(error)}`)
  }
}

function onSaved() {
  activeTab.value = 'feedback'
}

function loadAll() {
  void loadFeedbacks()
  void loadGenerations()
}

onMounted(loadAll)
watch(
  () => props.student.id,
  () => loadAll(),
)

onBeforeUnmount(() => {
  controller?.abort()
})
</script>

<style scoped>
.detail-panel {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-surface);
}

.detail-header {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  padding: var(--space-4) var(--space-6) var(--space-4);
}

.mobile-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: calc(var(--space-1) * -1) calc(var(--space-2) * -1) var(--space-2);
}

.back-btn {
  margin-left: -10px;
}

.detail-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.detail-eyebrow {
  display: block;
  font-size: var(--text-xs);
  letter-spacing: 0.08em;
  color: var(--color-text-tertiary);
  margin-bottom: 2px;
}

.detail-name {
  font-size: var(--text-xl);
  font-weight: 600;
  line-height: 1.3;
  color: var(--color-text);
}

.detail-sub {
  margin-top: 3px;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dot-sep {
  color: var(--color-text-tertiary);
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.detail-body {
  padding: var(--space-6);
  padding-bottom: var(--space-10);
}

.summary-card {
  background: linear-gradient(180deg, var(--color-primary-50), var(--color-surface-soft));
  border: 1px solid var(--color-primary-100);
  border-radius: var(--radius-lg);
  padding: var(--space-4) var(--space-5);
}

.summary-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}

.summary-label {
  flex-shrink: 0;
  width: 64px;
  padding-top: 3px;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
}

.summary-tags {
  flex: 1;
  min-width: 0;
  padding-top: 2px;
}

.refresh-tags {
  flex-shrink: 0;
  color: var(--color-primary-700);
}

.tag-updated {
  margin-top: var(--space-2);
  padding-left: 80px;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.detail-tabs {
  margin-top: var(--space-4);
}

.detail-tabs :deep(.el-tabs__header) {
  margin-bottom: var(--space-4);
}

.detail-tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
  background: var(--color-border);
}

.field-label {
  display: block;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-text);
  margin-bottom: var(--space-2);
}

.compose-card {
  background: var(--color-surface-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
}

.compose-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.compose-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: var(--space-6) 0 var(--space-3);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text);
}

.section-count {
  font-weight: 400;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.detail-loading {
  padding: var(--space-3) 0;
}

.feedback-timeline {
  position: relative;
  padding-left: 22px;
}

.feedback-timeline::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 10px;
  bottom: 10px;
  width: 1px;
  background: var(--color-border);
}

.timeline-item {
  position: relative;
  padding-bottom: var(--space-3);
}

.timeline-item:last-child {
  padding-bottom: 0;
}

.timeline-dot {
  position: absolute;
  left: -22px;
  top: 9px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--color-surface);
  border: 2px solid var(--color-primary-300);
}

.timeline-item:first-child .timeline-dot {
  border-color: var(--color-primary-500);
  background: var(--color-primary-100);
}

.timeline-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  box-shadow: var(--shadow-xs);
}

.timeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: 4px;
}

.timeline-meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.feedback-delete {
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--color-danger);
}

.timeline-content {
  font-size: var(--text-base);
  color: var(--color-text);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  word-break: break-word;
}

.generate-config {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  background: var(--color-surface-soft);
}

.config-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.config-field {
  flex: 1;
  min-width: 160px;
}

.weeks-select {
  width: 140px;
}

.generate-btn {
  flex-shrink: 0;
}

.field-hint {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.generate-config .el-alert {
  margin-top: var(--space-3);
}

.output-card {
  margin-top: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--color-surface);
}

.output-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
  background: var(--color-surface-soft);
  border-bottom: 1px solid var(--color-border);
  font-size: var(--text-sm);
  font-weight: 500;
}

.output-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.output-text {
  margin: 0;
  padding: var(--space-4);
  min-height: 160px;
  max-height: 420px;
  overflow-y: auto;
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text);
}

.output-placeholder {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  text-align: center;
}

.stream-caret {
  display: inline-block;
  width: 2px;
  height: 1.1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--color-primary-500);
  animation: caret-blink 1s step-end infinite;
}

@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}

.no-records {
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: var(--space-6);
  text-align: center;
  background: var(--color-warning-bg);
}

.no-records-icon {
  font-size: 22px;
  color: var(--color-warning);
}

.no-records-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--color-warning);
}

.no-records-hint {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.generate-error {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  color: var(--color-danger);
  background: var(--color-danger-bg);
  font-size: var(--text-sm);
  text-align: center;
}

.generation-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.generation-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  background: var(--color-surface);
}

.generation-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.generation-weeks {
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--color-primary-50);
  color: var(--color-primary-700);
}

.history-copy {
  margin-left: auto;
}

.history-delete {
  color: var(--color-danger);
}

.generation-content {
  margin-top: 4px;
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
}

.detail-danger {
  margin-top: var(--space-8);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.danger-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

/* 手机整页 */
.detail-panel.is-mobile {
  min-height: 100vh;
  min-height: 100dvh;
}

.detail-panel.is-mobile .detail-header {
  padding: calc(var(--space-2) + env(safe-area-inset-top)) var(--space-4) var(--space-3);
}

.detail-panel.is-mobile .detail-body {
  padding: var(--space-4);
  padding-bottom: calc(var(--space-10) + env(safe-area-inset-bottom));
}

.detail-panel.is-mobile .summary-row {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.detail-panel.is-mobile .summary-label {
  width: 100%;
  padding-top: 0;
}

.detail-panel.is-mobile .summary-tags {
  flex: 1;
  padding-top: 0;
}

.detail-panel.is-mobile .tag-updated {
  padding-left: 0;
}

.detail-panel.is-mobile .detail-name {
  font-size: var(--text-lg);
}

.detail-panel.is-mobile .config-row {
  flex-direction: column;
  align-items: stretch;
}

.detail-panel.is-mobile .weeks-select {
  width: 100%;
}

.detail-panel.is-mobile .generate-btn {
  width: 100%;
}

@media (max-width: 767px) {
  .compose-actions {
    flex-direction: column-reverse;
    align-items: stretch;
  }

  .compose-hint {
    text-align: right;
  }
}
</style>
