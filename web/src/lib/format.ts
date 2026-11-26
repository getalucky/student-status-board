export function toDate(ts: number | null | undefined): Date | null {
  if (!ts) return null
  const value = ts < 1_000_000_000_000 ? ts * 1000 : ts
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatDateTime(ts: number | null | undefined): string {
  const date = toDate(ts)
  if (!date) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatShortDate(ts: number | null | undefined): string {
  const date = toDate(ts)
  if (!date) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatTime(ts: number | null | undefined): string {
  const date = toDate(ts)
  if (!date) return ''
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function isSameDay(ts: number | null | undefined, date: Date): boolean {
  const target = toDate(ts)
  if (!target) return false
  return (
    target.getFullYear() === date.getFullYear() &&
    target.getMonth() === date.getMonth() &&
    target.getDate() === date.getDate()
  )
}
