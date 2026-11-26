import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { Student, StudentPayload, Weekday } from '@/types'

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string')
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }
  return []
}

export function normalizeStudent(raw: unknown): Student {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const weekday = Number(record.weekday)
  return {
    id: Number(record.id),
    name: typeof record.name === 'string' ? record.name : '',
    school: typeof record.school === 'string' && record.school ? record.school : null,
    weekday: (weekday >= 1 && weekday <= 7 ? weekday : 1) as Weekday,
    sort: Number.isFinite(Number(record.sort)) ? Number(record.sort) : 0,
    tags: normalizeTags(record.tags ?? record.tags_json),
    tags_at: record.tags_at == null ? null : Number(record.tags_at),
    created_at: Number(record.created_at) || 0,
    updated_at: Number(record.updated_at) || 0,
  }
}

function extractList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.students)) return record.students
    if (Array.isArray(record.data)) return record.data
    if (Array.isArray(record.items)) return record.items
  }
  return []
}

function extractStudent(payload: unknown): Student | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (record.student && typeof record.student === 'object') {
    return normalizeStudent(record.student)
  }
  if ('id' in record) return normalizeStudent(record)
  return null
}

export const useStudentsStore = defineStore('students', () => {
  const students = ref<Student[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  const sortedStudents = computed(() =>
    [...students.value].sort((a, b) => {
      if (a.weekday !== b.weekday) return a.weekday - b.weekday
      if (a.sort !== b.sort) return a.sort - b.sort
      return a.id - b.id
    }),
  )

  function sortLocal(): void {
    students.value = [...students.value].sort((a, b) => {
      if (a.weekday !== b.weekday) return a.weekday - b.weekday
      if (a.sort !== b.sort) return a.sort - b.sort
      return a.id - b.id
    })
  }

  function findById(id: number): Student | undefined {
    return students.value.find((item) => item.id === id)
  }

  async function fetchAll(): Promise<void> {
    loading.value = true
    try {
      const data = await api.get<unknown>('/students')
      students.value = extractList(data).map(normalizeStudent).filter((item) => item.id > 0)
      sortLocal()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function create(payload: StudentPayload): Promise<Student | null> {
    const data = await api.post<unknown>('/students', payload)
    const student = extractStudent(data)
    if (student && student.id > 0) {
      students.value.push(student)
      sortLocal()
      return student
    }
    await fetchAll()
    return students.value.find((item) => item.name === payload.name && item.weekday === payload.weekday) ?? null
  }

  async function update(id: number, payload: Partial<StudentPayload>): Promise<Student | null> {
    const data = await api.patch<unknown>(`/students/${id}`, payload)
    const student = extractStudent(data)
    if (student && student.id > 0) {
      mergeLocal(student)
      return student
    }
    await fetchAll()
    return findById(id) ?? null
  }

  async function remove(id: number): Promise<void> {
    await api.delete(`/students/${id}`, { confirm: true })
    students.value = students.value.filter((item) => item.id !== id)
  }

  function mergeLocal(student: Student): void {
    const index = students.value.findIndex((item) => item.id === student.id)
    if (index >= 0) {
      students.value[index] = { ...students.value[index], ...student }
    } else {
      students.value.push(student)
    }
    sortLocal()
  }

  function patchLocal(id: number, patch: Partial<Student>): void {
    const index = students.value.findIndex((item) => item.id === id)
    if (index >= 0) {
      students.value[index] = { ...students.value[index], ...patch }
      sortLocal()
    }
  }

  function reset(): void {
    students.value = []
    loaded.value = false
  }

  return {
    students,
    loading,
    loaded,
    sortedStudents,
    fetchAll,
    create,
    update,
    remove,
    mergeLocal,
    patchLocal,
    findById,
    reset,
  }
})
