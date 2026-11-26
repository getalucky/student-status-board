import { api, ApiError } from '@/lib/api'

export type BackupParseErrorCode = 'invalid-json' | 'invalid-format' | 'version'

export class BackupParseError extends Error {
  readonly code: BackupParseErrorCode

  constructor(code: BackupParseErrorCode, message: string) {
    super(message)
    this.name = 'BackupParseError'
    this.code = code
  }
}

export interface BackupSummary {
  data: unknown
  version: string
  studentCount: number
  feedbackCount: number
  generationCount: number
  exportedAt: number | null
}

export interface BackupConflict {
  index: number
  name: string
  school: string | null
  weekday: number
  existing: {
    id: number
    feedbacks: number
    generations: number
  }
}

export interface BackupPreview {
  students: number
  feedbacks: number
  generations: number
  exportedAt: number | null
  conflicts: BackupConflict[]
}

function isSupportedVersion(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  const normalized = String(value).trim().toLowerCase()
  return normalized === '1' || normalized === '1.0' || normalized === 'v1'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function countNested(students: unknown[], key: 'feedbacks' | 'generations'): number {
  let total = 0
  for (const student of students) {
    const record = asRecord(student)
    if (record && Array.isArray(record[key])) total += record[key].length
  }
  return total
}

function readExportedAt(payload: Record<string, unknown>): number | null {
  const meta = asRecord(payload.meta)
  const value =
    payload.exported_at ??
    payload.exportedAt ??
    payload.created_at ??
    meta?.exported_at ??
    meta?.exportedAt
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

/**
 * 解析备份 JSON 并生成导入确认摘要。
 * 兼容 students 内嵌 feedbacks/generations，以及顶层单独反馈/生成数组两种结构。
 */
export function parseBackupText(text: string): BackupSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BackupParseError('invalid-json', '文件不是合法 JSON')
  }

  const root = asRecord(parsed)
  if (!root) {
    throw new BackupParseError('invalid-format', '备份文件格式不正确')
  }

  const nestedData = asRecord(root.data)
  const payload = nestedData && Array.isArray(nestedData.students) ? nestedData : root
  const versionValue = payload.version ?? root.version ?? payload.format_version ?? root.format_version
  if (!isSupportedVersion(versionValue)) {
    throw new BackupParseError('version', '备份文件版本不支持')
  }

  const studentsRaw = payload.students
  if (!Array.isArray(studentsRaw)) {
    throw new BackupParseError('invalid-format', '备份文件缺少学生数据')
  }

  const feedbacksTop = Array.isArray(payload.feedbacks) ? payload.feedbacks.length : null
  const generationsTop = Array.isArray(payload.generations) ? payload.generations.length : null

  return {
    data: parsed,
    version: versionValue === undefined || versionValue === null ? '' : String(versionValue),
    studentCount: studentsRaw.length,
    feedbackCount: feedbacksTop ?? countNested(studentsRaw, 'feedbacks'),
    generationCount: generationsTop ?? countNested(studentsRaw, 'generations'),
    exportedAt: readExportedAt(payload) ?? readExportedAt(root),
  }
}

/** POST /api/backup/preview：服务端校验文件并列出同名同校冲突。 */
export async function previewBackup(data: unknown): Promise<BackupPreview> {
  const payload = await api.post<unknown>('/backup/preview', { data })
  const root = asRecord(payload) ?? {}
  const summary = asRecord(root.summary) ?? {}
  const conflictsRaw = Array.isArray(root.conflicts) ? root.conflicts : []

  const conflicts: BackupConflict[] = []
  for (const raw of conflictsRaw) {
    const record = asRecord(raw)
    const existing = asRecord(record?.existing)
    if (!record || !existing) continue
    conflicts.push({
      index: Number(record.index) || 0,
      name: typeof record.name === 'string' ? record.name : '',
      school: typeof record.school === 'string' ? record.school : null,
      weekday: Number(record.weekday) || 0,
      existing: {
        id: Number(existing.id) || 0,
        feedbacks: Number(existing.feedbacks) || 0,
        generations: Number(existing.generations) || 0,
      },
    })
  }

  return {
    students: Number(summary.students) || 0,
    feedbacks: Number(summary.feedbacks) || 0,
    generations: Number(summary.generations) || 0,
    exportedAt:
      typeof summary.exported_at === 'number' && Number.isFinite(summary.exported_at)
        ? summary.exported_at
        : null,
    conflicts,
  }
}

export function parseContentDispositionFilename(header: string | null): string | null {  if (!header) return null
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* 编码异常时继续尝试 filename= */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  if (plain?.[1]) {
    const value = plain[1].trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}

function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'student-status-board-备份.json'
}

/** GET /api/backup/export 并用浏览器下载附件。 */
export async function downloadBackup(options: { studentId?: number } = {}): Promise<void> {
  const query = options.studentId ? `?studentId=${encodeURIComponent(String(options.studentId))}` : ''
  let response: Response
  try {
    response = await fetch(`/api/backup/export${query}`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
  } catch {
    throw new ApiError(0, '无法连接服务器，请稍后重试')
  }

  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('app:unauthorized'))
  }

  if (!response.ok) {
    let payload: Record<string, unknown> | null = null
    try {
      payload = (await response.json()) as Record<string, unknown>
    } catch {
      payload = null
    }
    const message =
      (typeof payload?.message === 'string' && payload.message) ||
      (typeof payload?.error === 'string' && payload.error) ||
      `导出失败（${response.status}）`
    throw new ApiError(response.status, message, typeof payload?.code === 'string' ? payload.code : undefined, payload ?? undefined)
  }

  const blob = await response.blob()
  const filename = safeFilename(
    parseContentDispositionFilename(response.headers.get('content-disposition')) ??
      'student-status-board-备份.json',
  )

  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500)
}
