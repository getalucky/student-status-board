import type { TagCategory, TagMeta } from '@/types'
import vocabulary from '../../../shared/vocabulary.json'

export const TAG_GROUPS: Array<{ category: TagCategory; title: string; tags: string[] }> =
  vocabulary.categories.map((group) => ({
    category: group.key as TagCategory,
    title: group.label,
    tags: [...group.tags],
  }))

export const ALL_TAGS: TagMeta[] = TAG_GROUPS.flatMap((group) =>
  group.tags.map((label) => ({ label, category: group.category })),
)

const TAG_MAP = new Map(ALL_TAGS.map((item) => [item.label, item]))

export function tagCategory(label: string): TagCategory {
  return TAG_MAP.get(label)?.category ?? 'unknown'
}

export const WEEKDAYS: Array<{ value: 1 | 2 | 3 | 4 | 5 | 6 | 7; label: string; short: string }> = [
  { value: 1, label: '周一', short: '一' },
  { value: 2, label: '周二', short: '二' },
  { value: 3, label: '周三', short: '三' },
  { value: 4, label: '周四', short: '四' },
  { value: 5, label: '周五', short: '五' },
  { value: 6, label: '周六', short: '六' },
  { value: 7, label: '周日', short: '日' },
]

export function weekdayLabel(value: number | null | undefined): string {
  return WEEKDAYS.find((item) => item.value === value)?.label ?? '未设置'
}

export function todayWeekday(): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const day = new Date().getDay()
  return (day === 0 ? 7 : day) as 1 | 2 | 3 | 4 | 5 | 6 | 7
}
