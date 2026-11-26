<template>
  <el-drawer
    v-if="!isMobile"
    v-model="visible"
    :with-header="false"
    size="620px"
    class="student-detail-drawer"
    destroy-on-close
    append-to-body
  >
    <StudentDetailPanel
      v-if="student"
      :student="student"
      @close="close"
      @deleted="(id) => emit('deleted', id)"
    />
  </el-drawer>

  <Teleport to="body">
    <transition name="mobile-detail-slide">
      <section
        v-if="isMobile && visible && student"
        class="mobile-detail-page"
        role="dialog"
        aria-modal="true"
        :aria-label="`${student.name} 的学生详情`"
      >
        <StudentDetailPanel
          :student="student"
          mobile
          @close="close"
          @deleted="(id) => emit('deleted', id)"
        />
      </section>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import StudentDetailPanel from '@/components/StudentDetailPanel.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import type { Student } from '@/types'

const props = defineProps<{
  modelValue: boolean
  student: Student | null
  /** 与看板布局模式保持一致；不传时退回按视口判断 */
  mobile?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  deleted: [id: number]
}>()

const mediaIsMobile = useMediaQuery('(max-width: 767px)')
const isMobile = computed(() => props.mobile ?? mediaIsMobile.value)

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

function close() {
  visible.value = false
}

watch(
  () => props.modelValue,
  (open) => {
    document.body.style.overflow = open && isMobile.value ? 'hidden' : ''
  },
)

watch(isMobile, (mobile) => {
  if (!props.modelValue) return
  document.body.style.overflow = mobile ? 'hidden' : ''
})

onBeforeUnmount(() => {
  document.body.style.overflow = ''
})
</script>

<style scoped>
.mobile-detail-page {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--color-surface);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.mobile-detail-slide-enter-active,
.mobile-detail-slide-leave-active {
  transition: transform 0.24s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.mobile-detail-slide-enter-from,
.mobile-detail-slide-leave-to {
  transform: translateX(100%);
}
</style>

<style>
.student-detail-drawer .el-drawer__body {
  padding: 0;
  overflow-y: auto;
}

@media (max-width: 900px) {
  .student-detail-drawer {
    width: min(620px, 92vw) !important;
  }
}
</style>
