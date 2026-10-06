import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyOverrides, emptyProgress } from './normalize'
import type { Progress } from './types'

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

let calls: Call[]
let respond: (call: Call) => Response

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** Fresh module per test: the api keeps the last ETag in module state. */
async function loadApi() {
  vi.resetModules()
  return import('./api')
}

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? 'GET',
        url,
        headers: { ...(init.headers as Record<string, string>) },
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      calls.push(call)
      return respond(call)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const withStep = (id: string): Progress => ({ ...emptyProgress(), quests: { Q: { steps: [id], items: [] } } })

describe('progress ETag', () => {
  it('sends the ETag of the last GET as If-Match and remembers the new one', async () => {
    const { api } = await loadApi()
    respond = (c) => (c.method === 'GET' ? json(200, emptyProgress(), { ETag: '"v1"' }) : json(200, c.body, { ETag: '"v2"' }))

    await api.progress()
    await api.saveProgress(withStep('Q:s:1'))
    await api.saveProgress(withStep('Q:s:2'))

    expect(calls.map((c) => c.headers['If-Match'])).toEqual([undefined, '"v1"', '"v2"'])
    expect(calls[1]!.headers['Content-Type']).toBe('application/json')
  })

  it('also sends If-Match on the keepalive flush', async () => {
    const { api } = await loadApi()
    respond = (c) => (c.method === 'GET' ? json(200, emptyProgress(), { ETag: '"v1"' }) : json(200, c.body))
    await api.progress()
    await api.saveProgress(emptyProgress(), { keepalive: true })
    const init = vi.mocked(fetch).mock.calls[1]![1]!
    expect(init.keepalive).toBe(true)
    expect(calls[1]!.headers).toEqual({ 'If-Match': '"v1"', 'Content-Type': 'application/json' })
  })

  it('sends no If-Match before anything was read', async () => {
    const { api } = await loadApi()
    respond = (c) => json(200, c.body, { ETag: '"v1"' })
    await api.saveProgress(emptyProgress())
    expect(calls[0]!.headers['If-Match']).toBeUndefined()
  })

  it('turns a 409 into a ProgressConflictError with the copy on disk, and adopts its ETag', async () => {
    const { api, ProgressConflictError } = await loadApi()
    const onDisk = withStep('Q:s:other-tab')
    respond = (c) => {
      if (c.method === 'GET') return json(200, emptyProgress(), { ETag: '"v1"' })
      if (c.headers['If-Match'] === '"v1"') return json(409, { error: 'Voortgang is elders gewijzigd', progress: onDisk }, { ETag: '"v9"' })
      return json(200, c.body, { ETag: '"v10"' })
    }

    await api.progress()
    const err = await api.saveProgress(withStep('Q:s:mine')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProgressConflictError)
    expect((err as InstanceType<typeof ProgressConflictError>).name).toBe('ProgressConflictError')
    expect((err as InstanceType<typeof ProgressConflictError>).progress).toEqual(onDisk)
    expect((err as Error).message).toBe('Voortgang is elders gewijzigd')

    await api.saveProgress(withStep('Q:s:merged'))
    expect(calls[2]!.headers['If-Match']).toBe('"v9"')
  })

  it('reports other errors with the server message', async () => {
    const { api } = await loadApi()
    respond = () => json(400, { error: 'Ongeldige voortgang' })
    await expect(api.saveProgress(emptyProgress())).rejects.toThrow('Ongeldige voortgang')
    respond = () => new Response('<html>oops</html>', { status: 502 })
    await expect(api.progress()).rejects.toThrow('HTTP 502')
  })
})

describe('other requests', () => {
  it('sends If-Match with the overrides revision from GET /api/data', async () => {
    const { api } = await loadApi()
    respond = (c) =>
      c.method === 'GET' ? json(200, { ready: true }, { 'X-Overrides-ETag': '"o1"' }) : json(200, c.body, { ETag: '"o2"' })
    await api.data()
    await api.saveOverrides(emptyOverrides())
    await api.saveOverrides(emptyOverrides())
    expect(calls.map((c) => c.headers['If-Match'])).toEqual([undefined, '"o1"', '"o2"'])
  })

  it('marks every write as JSON, GETs carry no content type', async () => {
    const { api } = await loadApi()
    respond = () => json(200, { running: false, log: [] })
    await api.startSync()
    await api.syncStatus()
    expect(calls[0]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {} })
    expect(calls[1]!.headers).toEqual({})
  })
})

describe('server endpoints', () => {
  const status = { mode: 'app', local: true, live: false, port: 5199, urls: [], devices: [] }

  it('uses the shared contract paths and bodies', async () => {
    const { api } = await loadApi()
    respond = (c) => json(c.url === '/api/server/stop' ? 202 : 200, c.url === '/api/server/stop' ? { ok: true } : status)
    await api.serverStatus()
    await api.setLive(true)
    await api.createPairing()
    await api.createPairing('android')
    await api.certificateQr()
    await api.certificateQr('android')
    await api.revokeDevice('dev-1')
    await expect(api.stopServer()).resolves.toEqual({ ok: true })
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', '/api/server', undefined],
      ['POST', '/api/server/live', { on: true }],
      ['POST', '/api/server/pairing', {}],
      ['POST', '/api/server/pairing', { phone: 'android' }],
      ['GET', '/api/server/certificate-qr', undefined],
      ['GET', '/api/server/certificate-qr?phone=android', undefined],
      ['POST', '/api/server/devices/revoke', { id: 'dev-1' }],
      ['POST', '/api/server/stop', {}],
    ])
    for (const c of calls.filter((c) => c.method === 'POST')) expect(c.headers['Content-Type']).toBe('application/json')
  })

  it('passes the Dutch error of the server on', async () => {
    const { api } = await loadApi()
    respond = () => json(409, { error: 'Poort 5199 is al in gebruik' })
    await expect(api.setLive(true)).rejects.toThrow('Poort 5199 is al in gebruik')
  })
})

describe('an unpaired phone', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reloads once on 401, so the server shows its pairing page', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const { api } = await loadApi()
    respond = () => json(401, { error: 'Koppel dit apparaat eerst' })
    await expect(api.data()).rejects.toThrow('Koppel dit apparaat eerst')
    await expect(api.progress()).rejects.toThrow('Koppel dit apparaat eerst')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload for other errors', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const { api } = await loadApi()
    respond = () => json(403, { error: 'Dit kan alleen op de Mac zelf' })
    await expect(api.setLive(true)).rejects.toThrow('Dit kan alleen op de Mac zelf')
    expect(reload).not.toHaveBeenCalled()
  })
})
