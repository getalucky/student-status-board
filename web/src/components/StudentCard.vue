<template>
  <article
    class="student-card"
    role="button"
    tabindex="0"
    :data-id="student.id"
    :aria-label="`查看 ${student.name} 的详情`"
    @click="$emit('click')"
    @keydown.enter.prevent="$emit('click')"
    @keydown.space.prevent="$emit('click')"
  >
    <div class="card-top">
      <h3 class="card-name" :title="student.name">{{ student.name }}</h3>
    </div>
    <p class="card-school" :class="{ 'is-empty': !student.school }">
      {{ student.school || '未填写学校' }}
    </p>
    <TagChips class="card-tags" :tags="student.tags" :max="3" empty-text="暂无标签" />
  </article>
</template>

<script setup lang="ts">
import type { Student } from '@/types'
import TagChips from '@/components/TagChips.vue'

defineProps<{ student: Student }>()
defineEmits<{ click: [] }>()
</script>

<style scoped>
.student-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 11px 12px 12px;
  box-shadow: var(--shadow-xs);
  cursor: pointer;
  min-height: 82px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  user-select: none;
}

.student-card:hover {
  border-color: var(--color-primary-300);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}

.student-card:active {
  transform: translateY(0);
}

.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}

.card-name {
  font-size: var(--text-base);
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-school {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-school.is-empty {
  color: var(--color-text-tertiary);
}

.card-tags {
  margin-top: var(--space-2);
  display: flex;
}
</style>
