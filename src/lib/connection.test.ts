import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OFFLINE_HEADER,
  earlier,
  isRemoteHost,
  onConnectionEvent,
  parseTime,
  pollDelay,
  reportConnection,
  type ConnectionEvent,
} from './connection'
import { emptyProgress } from './normalize'

describe('pollDelay', () => {
  it('starts at 5 s and doubles up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 20].map(pollDelay)).toEqual([5000, 10_000, 20_000, 30_000, 30_000, 30_000])
    expect(pollDelay(-3)).toBe(5000)
  })
})

describe('times', () => {
  it('parses an ISO time or gives null', () => {
    expect(parseTime('2026-09-29T08:00:00.000Z')).toBe('2026-09-29T08:00:00.000Z')
    expect(parseTime('')).toBeNull()
    expect(parseTime(null)).toBeNull()
    expect(parseTime('gisteren')).toBeNull()
  })

  it('keeps the earlier of two times', () => {
    expect(earlier('2026-09-29T08:00:00.000Z', '2026-09-29T09:00:00.000Z')).toBe('2026-09-29T08:00:00.000Z')
    expect(earlier(null, '2026-09-29T09:00:00.000Z')).toBe('2026-09-29T09:00:00.000Z')
    expect(earlier('2026-09-29T09:00:00.000Z', null)).toBe('2026-09-29T09:00:00.000Z')
  })
})

describe('isRemoteHost', () => {
  it('is false on the Mac itself and true over the network', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'app.localhost', undefined, '']) expect(isRemoteHost(host)).toBe(false)
    for (const host of ['MacBook-Pro-van-Joost.local', '192.168.1.20']) expect(isRemoteHost(host)).toBe(true)
  })
})

describe('events', () => {
  it('reaches every listener until it unsubscribes, and a throwing listener breaks nothing', () => {
    const seen: ConnectionEvent[] = []
    const off = onConnectionEvent((e) => seen.push(e))
    const offBad = onConnectionEvent(() => {
      throw new Error('boom')
    })
    reportConnection({ type: 'failed' })
    off()
    offBad()
    reportConnection({ type: 'reached' })
    expect(seen).toEqual([{ type: 'failed' }])
  })
})

describe('api and the service worker', () => {
  let events: ConnectionEvent[]
  let off: () => void
  let respond: () => Promise<Response>

  /** Fresh module per test: the api keeps ETags in module state. */
  async function loadApi() {
    vi.resetModules()
    const connection = await import('./connection')
    events = []
    off = connection.onConnectionEvent((e) => events.push(e))
    return { ...(await import('./api')), OfflineCopy: connection.OfflineCopyError }
  }

  const offlineCopy = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json', [OFFLINE_HEADER]: '2026-09-29T08:00:00.000Z', ...headers },
    })

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond()),
    )
  })
  afterEach(() => {
    off?.()
    vi.unstubAllGlobals()
  })

  it('reports an answer from the server', async () => {
    const { api } = await loadApi()
    respond = async () => new Response(JSON.stringify(emptyProgress()), { status: 200, headers: { ETag: '"r1"' } })
    await api.progress()
    expect(events).toEqual([{ type: 'reached' }])
  })

  it('reports a request that got no answer and still throws it', async () => {
    const { api } = await loadApi()
    respond = async () => {
      throw new TypeError('Load failed')
    }
    await expect(api.data()).rejects.toThrow('Load failed')
    expect(events).toEqual([{ type: 'failed' }])
  })

  it('takes an offline copy only when asked to', async () => {
    const { api, OfflineCopy } = await loadApi()
    respond = async () => offlineCopy({ ready: true })
    await expect(api.data({ acceptOffline: true })).resolves.toEqual({ ready: true })
    await expect(api.data()).rejects.toBeInstanceOf(OfflineCopy)
    expect(events).toEqual([
      { type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: true },
      { type: 'offline-copy', at: '2026-09-29T08:00:00.000Z', used: false },
    ])
  })

  it('never takes the ETag of an offline copy it refused', async () => {
    const { api } = await loadApi()
    const calls: RequestInit[] = []
    vi.mocked(fetch).mockImplementation(async (_url, init = {}) => {
      calls.push(init)
      return respond()
    })
    respond = async () => new Response(JSON.stringify(emptyProgress()), { status: 200, headers: { ETag: '"live"' } })
    await api.progress()
    respond = async () => offlineCopy(emptyProgress(), { ETag: '"old"' })
    await expect(api.progress()).rejects.toMatchObject({ name: 'OfflineCopyError' })
    respond = async () => new Response(JSON.stringify(emptyProgress()), { status: 200, headers: { ETag: '"live2"' } })
    await api.saveProgress(emptyProgress())
    expect((calls[2]!.headers as Record<string, string>)['If-Match']).toBe('"live"')
  })
})
