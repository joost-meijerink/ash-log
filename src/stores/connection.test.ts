// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reportConnection } from '@/lib/connection'
import { emptyProgress, normalizeProgress } from '@/lib/normalize'
import type { Progress } from '@/lib/types'
import { BLIP_RELOAD_MS, useConnectionStore } from './connection'
import { useProgressStore } from './progress'

/** Health checks the store made, as epoch ms. */
let healthCalls: number[]
/** The Mac answers /api/health. */
let macUp: boolean

function stubHealth() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/api/health') throw new Error(`unexpected ${url}`)
      healthCalls.push(Date.now())
      if (!macUp) throw new TypeError('Load failed')
      return new Response(JSON.stringify({ ok: true, mode: 'app' }), { status: 200 })
    }),
  )
}

function startRemote() {
  const connection = useConnectionStore()
  connection.remote = true
  connection.start()
  return connection
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  healthCalls = []
  macUp = false
  stubHealth()
})

afterEach(() => {
  useConnectionStore().stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('offline detection', () => {
  it('double-checks a failed request before calling the Mac unreachable', async () => {
    const connection = startRemote()
    reportConnection({ type: 'failed' })
    expect(connection.state).toBe('checking')
    expect(connection.offline).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(healthCalls).toHaveLength(1)
    expect(connection.state).toBe('offline')
    expect(connection.offline).toBe(true)
    expect(connection.readOnly).toBe(true)
    expect(connection.nextCheckAt).toBe(Date.now() + 5000)
  })

  it('stays online after a blip the health check does not confirm', async () => {
    macUp = true
    const connection = startRemote()
    reportConnection({ type: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state).toBe('online')
    expect(connection.readOnly).toBe(false)
  })

  it('goes offline at once on an offline copy from the service worker, with its time', async () => {
    const connection = startRemote()
    reportConnection({ type: 'offline-copy', at: '2026-09-29T09:00:00.000Z', used: true })
    reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
    reportConnection({ type: 'offline-copy', at: '2026-09-29T07:00:00.000Z', used: false })
    expect(connection.state).toBe('offline')
    expect(healthCalls).toHaveLength(0)
    // The oldest copy the app actually took.
    expect(connection.knownAt).toBe('2026-09-29T08:00:00.000Z')
  })

  it('knows when the Mac last answered', async () => {
    const connection = startRemote()
    reportConnection({ type: 'reached' })
    const reached = connection.lastReachedAt
    expect(reached).toBe(new Date().toISOString())
    reportConnection({ type: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.knownAt).toBe(reached)
  })

  it('goes offline at once when the phone itself loses its network', async () => {
    const connection = startRemote()
    window.dispatchEvent(new Event('offline'))
    expect(connection.state).toBe('offline')
  })

  it('does nothing on the Mac itself', async () => {
    const connection = useConnectionStore()
    expect(connection.remote).toBe(false)
    connection.start()
    reportConnection({ type: 'failed' })
    reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connection.state).toBe('online')
    expect(connection.readOnly).toBe(false)
    expect(healthCalls).toHaveLength(0)
  })
})

describe('polling', () => {
  it('polls /api/health after 5 s, then 10, 20 and every 30 s', async () => {
    const connection = startRemote()
    reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
    const t0 = Date.now()
    await vi.advanceTimersByTimeAsync(5000 + 10_000 + 20_000 + 30_000 + 30_000)
    expect(healthCalls.map((t) => t - t0)).toEqual([5000, 15_000, 35_000, 65_000, 95_000])
    expect(connection.state).toBe('offline')
  })

  it('checks at once when you come back to the page, and restarts the backoff', async () => {
    startRemote()
    reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
    await vi.advanceTimersByTimeAsync(5000 + 10_000 + 20_000)
    expect(healthCalls).toHaveLength(3)
    const back = Date.now()
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    // Focus and visibilitychange together: one check.
    expect(healthCalls).toEqual([expect.any(Number), expect.any(Number), expect.any(Number), back])
    await vi.advanceTimersByTimeAsync(5000)
    expect(healthCalls).toHaveLength(5)
  })

  it('checks at once when the phone is back online', async () => {
    const connection = startRemote()
    window.dispatchEvent(new Event('offline'))
    macUp = true
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(healthCalls).toHaveLength(1)
    expect(connection.state).toBe('online')
  })

  it('stops polling when stopped', async () => {
    const connection = startRemote()
    reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
    connection.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(healthCalls).toHaveLength(0)
  })
})

describe('recovery', () => {
  it('leaves read-only on its own and runs the reconnect handlers once', async () => {
    const connection = startRemote()
    const handler = vi.fn()
    connection.onReconnect(handler)
    reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
    connection.browse()
    expect(connection.browsing).toBe(true)

    macUp = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(connection.state).toBe('online')
    expect(connection.readOnly).toBe(false)
    expect(connection.browsing).toBe(false)
    expect(connection.knownAt).toBeNull()
    expect(handler).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(healthCalls).toHaveLength(1)
  })

  it('reconnects when any request gets through', async () => {
    const connection = startRemote()
    const handler = vi.fn()
    connection.onReconnect(handler)
    reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
    reportConnection({ type: 'reached' })
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state).toBe('online')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('retries on request, and the retry button waits for the answer', async () => {
    const connection = startRemote()
    reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
    macUp = true
    const retry = connection.retry()
    expect(connection.checking).toBe(true)
    await expect(retry).resolves.toBe(true)
    expect(connection.checking).toBe(false)
    expect(connection.state).toBe('online')
  })

  it('reloads after a blip, but never more often than every few seconds', async () => {
    macUp = true
    const connection = startRemote()
    const handler = vi.fn()
    connection.onReconnect(handler)
    reportConnection({ type: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    reportConnection({ type: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handler).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BLIP_RELOAD_MS)
    reportConnection({ type: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

describe('progress across a lost connection', () => {
  // A fake Mac behind the real api client: progress.json with an ETag, If-Match and 409.
  let disk: { progress: Progress; rev: number }
  let puts: { ifMatch?: string; body: Progress }[]

  const etag = () => `"r${disk.rev}"`

  beforeEach(() => {
    disk = { progress: emptyProgress(), rev: 1 }
    puts = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (!macUp) throw new TypeError('Load failed')
        if (url === '/api/health') return new Response('{"ok":true}', { status: 200 })
        expect(url).toBe('/api/progress')
        const headers = (init.headers ?? {}) as Record<string, string>
        if ((init.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(disk.progress), { status: 200, headers: { ETag: etag() } })
        }
        const body = JSON.parse(String(init.body)) as Progress
        puts.push({ ifMatch: headers['If-Match'], body })
        if (headers['If-Match'] && headers['If-Match'] !== etag()) {
          return new Response(JSON.stringify({ error: 'Progress was changed elsewhere', progress: disk.progress }), {
            status: 409,
            headers: { ETag: etag() },
          })
        }
        disk.progress = normalizeProgress(body)
        disk.rev++
        return new Response(JSON.stringify(disk.progress), { status: 200, headers: { ETag: etag() } })
      }),
    )
  })

  it('keeps a checkmark that could not be saved, refuses new ones offline and sends it once the Mac is back', async () => {
    macUp = true
    const connection = startRemote()
    const progress = useProgressStore()
    await progress.load()
    expect(progress.canEdit).toBe(true)

    // The Mac goes to sleep just as a step is ticked.
    macUp = false
    progress.toggleStep('Ratcatcher', 'Ratcatcher:s:1')
    await vi.advanceTimersByTimeAsync(500)
    expect(connection.state).toBe('offline')
    expect(progress.canEdit).toBe(false)
    expect(puts).toHaveLength(0)

    // Read-only: nothing changes.
    progress.toggleStep('Ratcatcher', 'Ratcatcher:s:2')
    progress.togglePoint('lore:1:1')
    progress.setVaultDone('vault', true)
    progress.toggleReward('reward')
    expect(progress.state.quests.Ratcatcher!.steps).toEqual(['Ratcatcher:s:1'])
    expect(progress.state.points).toEqual({})

    // Meanwhile the Mac got a change from elsewhere.
    disk.progress = { ...emptyProgress(), points: { 'lore:9:9': { foundAt: '2026-09-29T07:00:00.000Z' } } }
    disk.rev++

    macUp = true
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(500)
    expect(connection.state).toBe('online')
    expect(progress.canEdit).toBe(true)
    // Merged onto the newer copy, sent with its ETag: nothing overwritten.
    expect(puts.at(-1)!.ifMatch).toBe('"r2"')
    expect(disk.progress.quests.Ratcatcher!.steps).toEqual(['Ratcatcher:s:1'])
    expect(Object.keys(disk.progress.points)).toEqual(['lore:9:9'])
    expect(progress.state).toEqual(disk.progress)
    expect(progress.error).toBeNull()
    // No second save of the same thing.
    await vi.advanceTimersByTimeAsync(2000)
    expect(puts).toHaveLength(1)
  })

  it('just reloads when nothing was waiting', async () => {
    macUp = true
    const connection = startRemote()
    const progress = useProgressStore()
    await progress.load()
    macUp = false
    reportConnection({ type: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state).toBe('offline')
    // A retry from the header while offline leaves an error behind.
    await progress.load()
    expect(progress.error).toBe('Load failed')
    disk.progress = { ...emptyProgress(), rewards: { r: { at: '2026-09-29T07:00:00.000Z' } } }
    disk.rev++
    macUp = true
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(500)
    expect(progress.state.rewards).toEqual({ r: { at: '2026-09-29T07:00:00.000Z' } })
    expect(progress.error).toBeNull()
    expect(puts).toHaveLength(0)
  })
})
