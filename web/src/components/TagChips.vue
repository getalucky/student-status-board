<template>
  <span v-if="tags.length" class="tag-chips" :class="`tag-chips--${size}`">
    <span
      v-for="tag in visibleTags"
      :key="tag"
      class="tag-chip"
      :class="`tag-chip--${tagCategory(tag)}`"
      :title="tag"
      >{{ tag }}</span
    >
    <span v-if="tags.length > max" class="tag-more">+{{ tags.length - max }}</span>
  </span>
  <span v-else-if="emptyText" class="tag-empty">{{ emptyText }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { tagCategory } from '@/lib/tags'

const props = withDefaults(
  defineProps<{
    tags: string[]
    size?: 'sm' | 'md'
    max?: number
    emptyText?: string
  }>(),
  {
    size: 'sm',
    max: 3,
    emptyText: '',
  },
)

const visibleTags = computed(() => props.tags.slice(0, props.max))
</script>

<style scoped>
.tag-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  min-width: 0;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
  font-weight: 500;
}

.tag-chips--sm .tag-chip {
  font-size: 11px;
  padding: 1px 7px;
}

.tag-chips--md .tag-chip {
  font-size: var(--text-xs);
  padding: 3px 10px;
}

.tag-chip--positive {
  background: var(--tag-positive-bg);
  color: var(--tag-positive-text);
  border-color: var(--tag-positive-border);
}

.tag-chip--attention {
  background: var(--tag-attention-bg);
  color: var(--tag-attention-text);
  border-color: var(--tag-attention-border);
}

.tag-chip--status {
  background: var(--tag-status-bg);
  color: var(--tag-status-text);
  border-color: var(--tag-status-border);
}

.tag-chip--unknown {
  background: var(--tag-neutral-bg);
  color: var(--tag-neutral-text);
  border-color: var(--tag-neutral-border);
}

.tag-more {
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding-left: 2px;
}

.tag-empty {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
</style>
