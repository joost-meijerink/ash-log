// Dutch date formatting: 'zojuist', '5 min geleden', 'vandaag 14:02', 'gisteren 09:15', '28 sep 14:02'.
// A compact variant ('5 min', '14:02', 'gisteren', '28 sep') is for tight spots like the header.

import { useIntervalFn, useNow } from '@vueuse/core'
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

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
 * Absolute Dutch date: '28 sep 14:02', or '28 sep 2025 14:02' outside the current year.
 * Returns '' for missing or invalid input.
 */
export function formatDateTime(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input)
  if (!d) return ''
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${clock(d)}`
}

/**
 * Relative Dutch time. Under a minute (or in the future): 'zojuist'. Under an hour: 'N min geleden'.
 * Same day: 'vandaag 14:02'. Day before: 'gisteren 14:02'. Older: formatDateTime().
 * Returns '' for missing or invalid input.
 */
export function formatRelative(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input)
  if (!d) return ''
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return 'zojuist'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min geleden`
  if (sameDay(d, now)) return `vandaag ${clock(d)}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `gisteren ${clock(d)}`
  return formatDateTime(d, now)
}

/**
 * Compact relative time for tight spots: 'zojuist', '5 min', '14:02' (today), 'gisteren',
 * '28 sep' (this year), 'sep 2025'. Returns '' for missing or invalid input.
 */
export function formatRelativeShort(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input)
  if (!d) return ''
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return 'zojuist'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`
  if (sameDay(d, now)) return clock(d)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return 'gisteren'
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Duration in Dutch: '850 ms', '12 s', '3 min 5 s'. */
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
