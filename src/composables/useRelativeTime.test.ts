import { describe, expect, it } from 'vitest'
import { formatDateTime, formatDuration, formatRelative, formatRelativeShort } from './useRelativeTime'

// Local-time dates, so the tests do not depend on the machine's time zone.
const now = new Date(2026, 8, 28, 14, 30, 0)
const at = (...args: [number, number, number, number, number]) => new Date(...args)

describe('formatRelative', () => {
  it('says just now within a minute and for future times', () => {
    expect(formatRelative(new Date(now.getTime() - 20_000), now)).toBe('just now')
    expect(formatRelative(new Date(now.getTime() + 60_000), now)).toBe('just now')
  })

  it('counts minutes within the hour', () => {
    expect(formatRelative(new Date(now.getTime() - 60_000), now)).toBe('1 minute ago')
    expect(formatRelative(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 minutes ago')
    expect(formatRelative(new Date(now.getTime() - 59 * 60_000), now)).toBe('59 minutes ago')
  })

  it('uses today and yesterday with the clock time', () => {
    expect(formatRelative(at(2026, 8, 28, 9, 5), now)).toBe('today 09:05')
    expect(formatRelative(at(2026, 8, 27, 23, 59), now)).toBe('yesterday 23:59')
  })

  it('falls back to the date for older times', () => {
    expect(formatRelative(at(2026, 8, 20, 14, 2), now)).toBe('20 Sep 14:02')
    expect(formatRelative(at(2025, 2, 3, 8, 0), now)).toBe('3 Mar 2025 08:00')
  })

  it('accepts ISO strings and returns an empty string for missing or invalid input', () => {
    expect(formatRelative(new Date(now.getTime() - 120_000).toISOString(), now)).toBe('2 minutes ago')
    expect(formatRelative(undefined, now)).toBe('')
    expect(formatRelative('not a date', now)).toBe('')
  })
})

describe('formatDateTime', () => {
  it('formats day month with short English month names and a 24-hour clock', () => {
    expect(formatDateTime(at(2026, 8, 28, 14, 2), now)).toBe('28 Sep 14:02')
    expect(formatDateTime(at(2026, 9, 1, 7, 9), now)).toBe('1 Oct 07:09')
    expect(formatDateTime(null, now)).toBe('')
  })
})

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(12_300)).toBe('12 s')
    expect(formatDuration(185_000)).toBe('3 min 5 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatDuration(undefined)).toBe('')
  })
})

describe('formatRelativeShort', () => {
  it('keeps every step short enough for the header', () => {
    expect(formatRelativeShort(new Date(now.getTime() - 20_000), now)).toBe('just now')
    expect(formatRelativeShort(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 min')
    expect(formatRelativeShort(at(2026, 8, 28, 9, 5), now)).toBe('09:05')
    expect(formatRelativeShort(at(2026, 8, 27, 23, 59), now)).toBe('yesterday')
    expect(formatRelativeShort(at(2026, 8, 20, 14, 2), now)).toBe('20 Sep')
    expect(formatRelativeShort(at(2025, 2, 3, 8, 0), now)).toBe('Mar 2025')
  })

  it('returns an empty string for missing or invalid input', () => {
    expect(formatRelativeShort(undefined, now)).toBe('')
    expect(formatRelativeShort('not a date', now)).toBe('')
  })
})
