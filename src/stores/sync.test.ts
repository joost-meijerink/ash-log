// @vitest-environment jsdom
// The sync store on a phone that loses its Mac: no sync starts while read-only, and a sync that
// kept running on the Mac is followed again once it answers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reportConnection } from '@/lib/connection'
import { useConnectionStore } from './connection'
import { useSyncStore } from './sync'

const calls: string[] = []
let macUp = false
let syncRunning = false

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  calls.length = 0
  macUp = false
  syncRunning = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (!macUp) throw new TypeError('Load failed')
      if (url === '/api/sync/status') return new Response(JSON.stringify({ running: syncRunning, log: ['bezig'] }), { status: 200 })
      if (url === '/api/health') return new Response(JSON.stringify({ ok: true, mode: 'app' }), { status: 200 })
      // Data and progress reloads on reconnect: not what this test looks at.
      return new Response(JSON.stringify({ error: 'niet in deze test' }), { status: 500 })
    }),
  )
})

afterEach(() => {
  useConnectionStore().stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function offlinePhone() {
  const connection = useConnectionStore()
  connection.remote = true
  connection.start()
  reportConnection({ type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true })
  expect(connection.readOnly).toBe(true)
  return connection
}

describe('sync while the Mac cannot be reached', () => {
  it('never starts a sync in read-only mode', async () => {
    offlinePhone()
    const sync = useSyncStore()
    await sync.start()
    expect(sync.running).toBe(false)
    expect(calls.filter((c) => c.startsWith('POST /api/sync'))).toEqual([])
  })

  it('follows a sync that kept running on the Mac once it answers again', async () => {
    const connection = offlinePhone()
    const sync = useSyncStore()
    sync.error = 'Load failed'
    macUp = true
    syncRunning = true
    await connection.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.readOnly).toBe(false)
    expect(calls).toContain('GET /api/sync/status')
    expect(sync.running).toBe(true)
    expect(sync.error).toBeNull()
  })
})
