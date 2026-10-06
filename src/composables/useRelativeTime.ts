// English date formatting (day month, 24-hour clock, as en-GB): 'just now', '5 minutes ago',
// 'today 14:02', 'yesterday 09:15', '28 Sep 14:02'. A compact variant ('5 min', '14:02',
// 'yesterday', '28 Sep') is for tight spots like the header.

import { useIntervalFn, useNow } from '@vueuse/core'
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type DateInput = string | number | Date | null | undefined

function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined || input === '') return null
  const date = input instanceof Date ? input : new Date(input)
  return Number.isNaN(date.getTime()) ? null : date
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/**
 * Absolute date: '28 Sep 14:02', or '28 Sep 2025 14:02' outside the current year.
 * Returns '' for missing or invalid input.
 */
export function formatDateTime(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input)
  if (!d) return ''
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${clock(d)}`
}

/**
 * Relative time. Under a minute (or in the future): 'just now'. Under an hour: 'N minutes ago'.
 * Same day: 'today 14:02'. Day before: 'yesterday 14:02'. Older: formatDateTime().
 * Returns '' for missing or invalid input.
 */
export function formatRelative(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input)
  if (!d) return ''
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000)
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  }
  if (sameDay(d, now)) return `today ${clock(d)}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `yesterday ${clock(d)}`
  return formatDateTime(d, now)
}

/**
 * Compact relative time for tight spots: 'just now', '5 min', '14:02' (today), 'yesterday',
 * '28 Sep' (this year), 'Sep 2025'. Returns '' for missing or invalid input.
 */
export function formatRelativeShort(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input)
  if (!d) return ''
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`
  if (sameDay(d, now)) return clock(d)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return 'yesterday'
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Duration: '850 ms', '12 s', '3 min 5 s'. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const rest = s % 60
  return rest ? `${Math.floor(s / 60)} min ${rest} s` : `${Math.floor(s / 60)} min`
}

/**
 * Live relative time that re-renders every 30 seconds.
 * `relative` is formatRelative(), `short` is formatRelativeShort() and `absolute` is
 * formatDateTime() (handy for a title attribute).
 */
export function useRelativeTime(source: MaybeRefOrGetter<DateInput>): {
  relative: ComputedRef<string>
  short: ComputedRef<string>
  absolute: ComputedRef<string>
} {
  const now = useNow({ scheduler: (cb) => useIntervalFn(cb, 30_000) })
  return {
    relative: computed(() => formatRelative(toValue(source), now.value)),
    short: computed(() => formatRelativeShort(toValue(source), now.value)),
    absolute: computed(() => formatDateTime(toValue(source), now.value)),
  }
}
