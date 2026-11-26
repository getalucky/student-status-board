<template>
  <div class="app-page board-page">
    <AppHeader />

    <main class="page-main board-main">
      <div class="board-toolbar">
        <div class="toolbar-title">
          <h1 class="page-title">学生看板</h1>
          <p class="page-subtitle">按上课星期排布，课后状态一眼看清</p>
        </div>
        <div class="toolbar-actions">
          <el-input
            v-model="keyword"
            class="board-search"
            placeholder="搜索姓名或学校"
            clearable
            :prefix-icon="Search"
            aria-label="搜索学生姓名或学校"
          />
          <el-button
            class="layout-toggle"
            :icon="compactBoard ? Iphone : Monitor"
            :title="compactBoard ? '当前为手机版，点击切换到桌面版' : '当前为桌面版，点击切换到手机版'"
            :aria-label="compactBoard ? '当前为手机版，切换到桌面版' : '当前为桌面版，切换到手机版'"
            @click="toggleLayout"
          >
            {{ compactBoard ? '手机版' : '桌面版' }}
          </el-button>
          <el-button type="primary" class="new-student-btn" :icon="Plus" @click="openCreate()">
            新建学生
          </el-button>
        </div>
      </div>

      <div class="board-summary">
        <span class="summary-total">共 {{ store.students.length }} 名学生</span>
        <span v-if="keyword.trim()" class="summary-filter">筛选出 {{ filteredStudents.length }} 名</span>
        <span v-if="!compactBoard && !keyword.trim()" class="summary-tip">拖动卡片可更换上课星期</span>
        <span v-if="keyword.trim()" class="summary-tip">搜索时已暂停拖动排序</span>
      </div>

      <div v-loading="store.loading && !store.loaded" class="board-area">
        <div v-if="!compactBoard" class="desktop-board">
          <section v-for="day in WEEKDAYS" :key="day.value" class="board-column">
            <header class="column-header">
              <div class="column-title">
                <span class="column-day">{{ day.label }}</span>
                <span class="column-count">{{ grouped[day.value].length }}</span>
              </div>
              <el-button
                text
                circle
                :icon="Plus"
                class="column-add"
                :aria-label="`${day.label}新建学生`"
                @click="openCreate(day.value)"
              />
            </header>
            <div class="column-list" :data-weekday="day.value">
              <StudentCard
                v-for="student in grouped[day.value]"
                :key="student.id"
                :student="student"
                @click="handleCardClick(student)"
              />
              <div v-if="!grouped[day.value].length" class="column-empty">
                {{ keyword.trim() ? '没有匹配的学生' : '暂无学生' }}
              </div>
            </div>
          </section>
        </div>

        <div v-else class="compact-board">
          <div class="weekday-tabs" role="tablist" aria-label="选择星期">
            <button
              v-for="day in WEEKDAYS"
              :key="day.value"
              type="button"
              role="tab"
              class="weekday-tab"
              :class="{ 'is-active': activeWeekday === day.value }"
              :aria-selected="activeWeekday === day.value"
              @click="activeWeekday = day.value"
            >
              <span>{{ day.label }}</span>
              <span class="weekday-tab-count">{{ grouped[day.value].length }}</span>
            </button>
          </div>

          <div class="compact-list-head">
            <span class="compact-list-title">
              {{ weekdayLabel(activeWeekday) }}
              <span class="compact-list-count">{{ grouped[activeWeekday].length }} 名学生</span>
            </span>
            <el-button text :icon="Plus" class="mobile-add-btn" @click="openCreate(activeWeekday)">
              添加
            </el-button>
          </div>

          <div class="compact-card-list">
            <StudentCard
              v-for="student in grouped[activeWeekday]"
              :key="student.id"
              :student="student"
              @click="handleCardClick(student)"
            />
            <div v-if="!grouped[activeWeekday].length" class="empty-state compact-empty">
              <span class="empty-state__title">{{
                keyword.trim() ? '没有匹配的学生' : '这天还没有学生'
              }}</span>
              <span class="empty-state__hint">{{
                keyword.trim() ? '换个姓名或学校关键词试试' : '新建学生后，会显示在对应的星期里'
              }}</span>
              <el-button
                v-if="!keyword.trim()"
                type="primary"
                plain
                :icon="Plus"
                @click="openCreate(activeWeekday)"
                >新建学生</el-button
              >
            </div>
          </div>
        </div>
      </div>
    </main>

    <StudentFormDialog
      v-model="formVisible"
      :student="editingStudent"
      :default-weekday="defaultWeekday"
      @saved="onSaved"
    />

    <StudentDetail
      v-model="detailVisible"
      :student="detailStudent"
      :mobile="compactBoard"
      @deleted="onDeleted"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Iphone, Monitor, Plus, Search } from '@element-plus/icons-vue'
import Sortable from 'sortablejs'
import AppHeader from '@/components/AppHeader.vue'
import StudentCard from '@/components/StudentCard.vue'
import StudentDetail from '@/components/StudentDetail.vue'
import StudentFormDialog from '@/components/StudentFormDialog.vue'
import { errorMessage } from '@/lib/api'
import { todayWeekday, weekdayLabel, WEEKDAYS } from '@/lib/tags'
import { useStudentsStore } from '@/stores/students'
import type { Student, Weekday } from '@/types'

type LayoutMode = 'auto' | 'desktop' | 'mobile'

const LAYOUT_STORAGE_KEY = 'sb_layout_mode'

function detectPhoneDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const maxTouchPoints = navigator.maxTouchPoints || 0
  const isIpad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)
  const phoneUa = /Android|iPhone|iPod|Windows Phone|Mobile/i.test(ua) && !isIpad
  const smallTouchDevice =
    maxTouchPoints > 1 && Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0) < 768
  return phoneUa || smallTouchDevice
}

function readLayoutMode(): LayoutMode {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (stored === 'desktop' || stored === 'mobile' || stored === 'auto') return stored
  } catch {
    /* localStorage 不可用时退回自动 */
  }
  return 'auto'
}

const store = useStudentsStore()
const deviceIsPhone = detectPhoneDevice()
const layoutMode = ref<LayoutMode>(readLayoutMode())
const compactBoard = computed(
  () => layoutMode.value === 'mobile' || (layoutMode.value === 'auto' && deviceIsPhone),
)

function toggleLayout() {
  layoutMode.value = compactBoard.value ? 'desktop' : 'mobile'
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, layoutMode.value)
  } catch {
    /* 无痕模式等场景忽略持久化失败，当前会话仍然生效 */
  }
}

const keyword = ref('')
const activeWeekday = ref<Weekday>(todayWeekday())

const formVisible = ref(false)
const editingStudent = ref<Student | null>(null)
const defaultWeekday = ref<Weekday>(1)

const detailVisible = ref(false)
const detailStudent = ref<Student | null>(null)

let sortableInstances: Sortable[] = []
let suppressClickUntil = 0

const filteredStudents = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return store.sortedStudents
  return store.sortedStudents.filter(
    (student) =>
      student.name.toLowerCase().includes(query) ||
      (student.school ?? '').toLowerCase().includes(query),
  )
})

const grouped = computed<Record<number, Student[]>>(() => {
  const map: Record<number, Student[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] }
  for (const student of filteredStudents.value) {
    const day = Number(student.weekday)
    if (map[day]) map[day].push(student)
  }
  return map
})

function destroySortables() {
  for (const instance of sortableInstances) instance.destroy()
  sortableInstances = []
}

function initSortables() {
  destroySortables()
  if (compactBoard.value || keyword.value.trim()) return
  const lists = document.querySelectorAll<HTMLElement>('.desktop-board .column-list')
  lists.forEach((list) => {
    const instance = Sortable.create(list, {
      group: 'student-board',
      animation: 160,
      draggable: '.student-card',
      ghostClass: 'student-card--ghost',
      chosenClass: 'student-card--chosen',
      dragClass: 'student-card--drag',
      forceFallback: false,
      onStart() {
        document.body.classList.add('is-dragging-card')
      },
      onEnd(evt) {
        document.body.classList.remove('is-dragging-card')
        void handleDragEnd(evt)
      },
    })
    sortableInstances.push(instance)
  })
}

async function handleDragEnd(evt: Sortable.SortableEvent) {
  const to = evt.to as HTMLElement | null
  const item = evt.item as HTMLElement | null
  if (!to || !item) return
  const weekday = Number(to.dataset.weekday) as Weekday
  const id = Number(item.dataset.id)
  if (!weekday || !id) return

  suppressClickUntil = Date.now() + 350

  const cards = Array.from(to.querySelectorAll<HTMLElement>(':scope > .student-card'))
  const index = cards.indexOf(item)
  const prevEl = index > 0 ? cards[index - 1] : null
  const nextEl = index >= 0 && index < cards.length - 1 ? cards[index + 1] : null
  const sortOf = (el: HTMLElement | null): number | undefined => {
    if (!el) return undefined
    return store.findById(Number(el.dataset.id))?.sort
  }
  const prevSort = sortOf(prevEl)
  const nextSort = sortOf(nextEl)

  let sort: number
  if (prevSort !== undefined && nextSort !== undefined) {
    sort = (prevSort + nextSort) / 2
  } else if (prevSort !== undefined) {
    sort = prevSort + 1
  } else if (nextSort !== undefined) {
    sort = nextSort - 1
  } else {
    sort = 0
  }

  const previous = store.findById(id)
  if (!previous) return
  store.patchLocal(id, { weekday, sort })

  try {
    await store.update(id, { weekday, sort })
  } catch (error) {
    ElMessage.error(`调整星期失败：${errorMessage(error)}`)
    await store.fetchAll()
    await nextTick()
    initSortables()
  }
}

function handleCardClick(student: Student) {
  if (Date.now() < suppressClickUntil) return
  detailStudent.value = student
  detailVisible.value = true
}

function openCreate(day: Weekday = 1) {
  editingStudent.value = null
  defaultWeekday.value = day
  formVisible.value = true
}

function onSaved(student: Student | null) {
  if (student) {
    activeWeekday.value = student.weekday
  }
}

function onDeleted() {
  detailVisible.value = false
  detailStudent.value = null
}

watch(keyword, async () => {
  await nextTick()
  initSortables()
})

watch(compactBoard, async () => {
  await nextTick()
  initSortables()
})

onMounted(async () => {
  try {
    if (!store.loaded) await store.fetchAll()
  } catch (error) {
    ElMessage.error(`学生列表加载失败：${errorMessage(error)}`)
  }
  await nextTick()
  initSortables()
})

onBeforeUnmount(() => {
  destroySortables()
  document.body.classList.remove('is-dragging-card')
})
</script>

<style scoped>
.board-main {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - var(--header-height));
}

.board-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.board-search {
  width: 300px;
}

.layout-toggle {
  color: var(--color-text-secondary);
}

.board-search :deep(.el-input__wrapper) {
  background: var(--color-surface);
}

.board-summary {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  min-height: 20px;
}

.summary-total {
  color: var(--color-text-secondary);
}

.summary-filter {
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--color-primary-50);
  color: var(--color-primary-700);
}

.summary-tip {
  margin-left: auto;
}

.board-area {
  flex: 1;
  min-width: 0;
  margin-top: var(--space-3);
  min-height: 320px;
  overflow-x: auto;
}

.desktop-board {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 10px;
  align-items: stretch;
  min-width: 1120px;
  min-height: calc(100vh - 260px);
}

.board-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--color-surface-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 8px;
}

.column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 8px 4px;
  gap: 4px;
}

.column-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.column-day {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
}

.column-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-tertiary);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

.column-add {
  color: var(--color-text-tertiary);
  width: 40px;
  height: 40px;
  min-height: 40px;
  margin: -4px -2px -4px 0;
}

.column-add:hover {
  color: var(--color-primary-700);
  background: var(--color-primary-50);
}

.column-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 120px;
  border-radius: var(--radius-md);
  transition: background-color 0.15s ease;
}

.column-list:empty {
  min-height: 120px;
}

.column-empty {
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  min-height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  background: rgba(255, 255, 255, 0.45);
}

:deep(.student-card--ghost) {
  opacity: 0.4;
  background: var(--color-primary-50);
  border: 1px dashed var(--color-primary-400);
  box-shadow: none;
}

:deep(.student-card--chosen) {
  cursor: grabbing;
}

:deep(.student-card--drag) {
  transform: rotate(1.5deg);
  box-shadow: var(--shadow-md);
}

.is-dragging-card {
  cursor: grabbing;
}

/* 窄屏标签 + 卡片列表 */
.compact-board {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.weekday-tabs {
  position: sticky;
  top: var(--header-height);
  z-index: 20;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 6px 2px 10px;
  background: var(--color-bg);
  scrollbar-width: none;
}

.weekday-tabs::-webkit-scrollbar {
  display: none;
}

.weekday-tab {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: all 0.15s ease;
}

.weekday-tab:hover {
  border-color: var(--color-primary-300);
  color: var(--color-primary-700);
}

.weekday-tab.is-active {
  background: var(--color-primary-600);
  border-color: var(--color-primary-600);
  color: #fff;
}

.weekday-tab-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 18px;
}

.weekday-tab.is-active .weekday-tab-count {
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
}

.compact-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
}

.compact-list-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text);
}

.compact-list-count {
  margin-left: 8px;
  font-size: var(--text-xs);
  font-weight: 400;
  color: var(--color-text-tertiary);
}

.mobile-add-btn {
  color: var(--color-primary-700);
}

.compact-card-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.compact-empty {
  background: var(--color-surface);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-lg);
}

@media (max-width: 767px) {
  .board-toolbar {
    align-items: stretch;
    flex-direction: column;
    gap: var(--space-3);
  }

  .toolbar-actions {
    width: 100%;
    flex-wrap: wrap;
  }

  .board-search {
    flex: 1 1 100%;
    width: 100%;
  }

  .layout-toggle,
  .new-student-btn {
    flex: 1;
  }

  .summary-tip {
    display: none;
  }

  .desktop-board {
    min-height: 0;
  }
}
</style>
