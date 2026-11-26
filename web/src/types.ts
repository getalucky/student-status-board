export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface Student {
  id: number
  name: string
  school: string | null
  weekday: Weekday
  sort: number
  tags: string[]
  tags_at: number | null
  created_at: number
  updated_at: number
}

export interface Feedback {
  id: number
  student_id: number
  content: string
  happened_at: number
}

export interface Generation {
  id: number
  student_id: number
  content: string
  weeks: number
  created_at: number
}

export interface StudentPayload {
  name: string
  school?: string | null
  weekday: Weekday
  sort?: number
}

export interface LlmModel {
  id: string
  label?: string
}

export type TagCategory = 'positive' | 'attention' | 'status' | 'unknown'

export interface TagMeta {
  label: string
  category: TagCategory
}
