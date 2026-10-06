// The service worker (public/sw.js) runs here in a sandbox: a fake `self`, an in-memory Cache
// Storage and a fake network. The script is evaluated as is; its functions come back out.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import source from '../public/sw.js?raw'
import { OFFLINE_TEXT, OFFLINE_TITLE, RETRY_LABEL } from '@/components/offline/texts'
import { OFFLINE_HEADER } from '@/lib/connection'

const ORIGIN = 'https://mac.local:5199'
const at = (path: string) => `${ORIGIN}${path}`

type Key = string | { url: string }
const keyOf = (req: Key) => (typeof req === 'string' ? req : req.url)

class FakeCache {
  readonly entries = new Map<string, Response>()
  async match(req: Key) {
    return this.entries.get(keyOf(req))?.clone()
  }
  async put(req: Key, res: Response) {
    // Like the real one: reads the whole body (so a body used elsewhere throws here).
    const body = await res.arrayBuffer()
    this.entries.set(keyOf(req), new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }))
  }
  async delete(req: Key) {
    return this.entries.delete(keyOf(req))
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }))
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>()
  async open(name: string) {
    let cache = this.stores.get(name)
    if (!cache) this.stores.set(name, (cache = new FakeCache()))
    return cache
  }
  async keys() {
    return [...this.stores.keys()]
  }
  async delete(name: string) {
    return this.stores.delete(name)
  }
  /** Synchronous peek for assertions. */
  entry(name: string, url: string) {
    return this.stores.get(name)?.entries.get(url)
  }
}

interface Sw {
  routeRequest(request: { method: string; mode?: string; url: string }, origin: string): string | null
  isAppRoute(pathname: string): boolean
  assetUrlsIn(html: string, origin: string): string[]
  offlinePageHtml(): string
}

type Handler = (event: any) => void

let caches: FakeCacheStorage
let handlers: Record<string, Handler>
let self: { location: URL; addEventListener(type: string, fn: Handler): void; skipWaiting: Mock; clients: { claim: Mock } }
let network: Mock<(input: unknown, init?: unknown) => Promise<Response>>
let sw: Sw

const SHELL = 'ash-log-shell-v1'
const STATIC = 'ash-log-static-v1'
const IMAGES = 'ash-log-images-v1'
const DATA = 'ash-log-data-v1'

function load() {
  handlers = {}
  caches = new FakeCacheStorage()
  self = {
    location: new URL(at('/sw.js')),
    addEventListener: (type, fn) => (handlers[type] = fn),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  }
  network = vi.fn(async (): Promise<Response> => {
    throw new TypeError('Load failed')
  })
  const run = new Function(
    'self',
    'caches',
    'fetch',
    'setTimeout',
    'clearTimeout',
    `${source}\n;return { routeRequest, isAppRoute, assetUrlsIn, offlinePageHtml }`,
  )
  sw = run(self, caches, (input: unknown, init?: unknown) => network(input, init), globalThis.setTimeout, globalThis.clearTimeout) as Sw
}

const appHtml = '<!doctype html><script type="module" src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/index-def.css">'

function page(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } })
}
const app = (body = appHtml) => page(body, 200, { 'X-Ash-Log-App': '1' })
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } })

/** Dispatches a fetch event; `response` is what the worker answered (undefined: not handled). */
function dispatch(request: { url: string; method?: string; mode?: string }) {
  const waits: Promise<unknown>[] = []
  let response: Promise<Response> | undefined
  handlers.fetch!({
    request: { method: 'GET', mode: 'cors', ...request },
    respondWith: (p: Promise<Response>) => (response = Promise.resolve(p)),
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  })
  // waitUntil may come after a few awaits in the worker: wait for the answer first.
  const settled = async () => {
    await response?.catch(() => undefined)
    await Promise.all(waits)
  }
  return { response, settled }
}

const navigate = (path: string) => dispatch({ url: at(path), mode: 'navigate' })

beforeEach(() => load())
afterEach(() => {
  vi.useRealTimers()
})

describe('routing', () => {
  it('handles navigations, build files, images and the two data GETs, nothing else', () => {
    const route = (url: string, method = 'GET', mode = 'cors') => sw.routeRequest({ url, method, mode }, ORIGIN)
    expect(route(at('/quests'), 'GET', 'navigate')).toBe('navigate')
    expect(route(at('/assets/index-abc.js'))).toBe('static')
    expect(route(at('/icons/icon-192.png'))).toBe('image')
    expect(route(at('/wiki-img/tiles/2/1_1.png'), 'GET', 'no-cors')).toBe('image')
    expect(route(at('/api/data'))).toBe('data')
    expect(route(at('/api/progress'))).toBe('data')

    expect(route(at('/api/progress'), 'PUT')).toBeNull()
    expect(route(at('/api/overrides'), 'PUT')).toBeNull()
    expect(route(at('/api/health'))).toBeNull()
    expect(route(at('/api/sync/status'))).toBeNull()
    expect(route(at('/api/server'))).toBeNull()
    expect(route(at('/manifest.webmanifest'))).toBeNull()
    expect(route(at('/sw.js'))).toBeNull()
    expect(route('https://dragonwilds.runescape.wiki/w/Ratcatcher')).toBeNull()
    expect(route('https://maps.runescape.wiki/dw/tiles/0/0_0.png')).toBeNull()
  })

  it('tells app routes from server pages and files', () => {
    for (const p of ['/', '/index.html', '/quests', "/quests/Black%20Knight's%20Fortress", '/map', '/collections', '/kaart', '/verzamelingen']) {
      expect(sw.isAppRoute(p), p).toBe(true)
    }
    for (const p of ['/pair', '/certificate', '/certificate/ash-log.mobileconfig', '/koppel', '/certificaat', '/certificaat/ash-log-ca.crt', '/api/data', '/assets/x.js', '/manifest.webmanifest', '/sw.js']) {
      expect(sw.isAppRoute(p), p).toBe(false)
    }
  })

  it('leaves requests it does not handle to the browser', () => {
    expect(dispatch({ url: at('/api/progress'), method: 'PUT' }).response).toBeUndefined()
    expect(dispatch({ url: at('/api/health') }).response).toBeUndefined()
    expect(dispatch({ url: 'https://example.com/x.js' }).response).toBeUndefined()
    expect(network).not.toHaveBeenCalled()
  })
})

describe('navigations', () => {
  it('passes the answer through and keeps a real app page under / without the query', async () => {
    network.mockResolvedValue(app())
    const { response, settled } = navigate('/quests?device=secret-token')
    const res = await response!
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(appHtml)
    await settled()
    const kept = caches.entry(SHELL, at('/'))!
    expect(await kept.text()).toBe(appHtml)
    expect(kept.headers.get('X-Ash-Log-Cached-At')).toBeTruthy()
    expect([...caches.stores.get(SHELL)!.entries.keys()]).toEqual([at('/')])
  })

  it('never keeps the pairing page, the certificate page or an error page', async () => {
    for (const res of [page('<p>Pair this device</p>', 200), page('Unknown host', 403), page('broken', 500)]) {
      network.mockResolvedValueOnce(res)
      const { response, settled } = navigate('/')
      await response
      await settled()
    }
    expect(caches.entry(SHELL, at('/'))).toBeUndefined()
  })

  it('opens the kept app when the Mac does not answer', async () => {
    network.mockResolvedValue(app())
    await navigate('/').settled()
    network.mockRejectedValue(new TypeError('Load failed'))
    const res = await navigate('/map?device=abc').response!
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(appHtml)
    expect(res.headers.get('X-Ash-Log-Cached-At')).toBeNull()
  })

  it('opens the kept app after a few seconds when the Mac is slow', async () => {
    vi.useFakeTimers()
    load()
    await caches.open(SHELL).then((c) => c.put(at('/'), app()))
    network.mockReturnValue(new Promise(() => {}))
    const { response } = navigate('/quests')
    let done = false
    void response!.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(3900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(await (await response!).text()).toBe(appHtml)
  })

  it('shows its own page when nothing is kept yet', async () => {
    const res = await navigate('/quests').response!
    expect(res.status).toBe(503)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain(OFFLINE_TITLE)
    expect(html).toContain(OFFLINE_TEXT)
    expect(html).toContain(RETRY_LABEL)
    expect(html).toContain('location.reload()')
    expect(html).toContain('#15120e')
  })

  it('never opens the kept app for a server page such as /pair', async () => {
    network.mockResolvedValue(app())
    await navigate('/').settled()
    network.mockRejectedValue(new TypeError('Load failed'))
    const res = await navigate('/pair?code=123456').response!
    expect(res.status).toBe(503)
    expect(await res.text()).toContain(OFFLINE_TITLE)
  })

  it('forgets the kept app and data when this phone was unpaired (401)', async () => {
    network.mockResolvedValueOnce(app())
    await navigate('/').settled()
    network.mockResolvedValueOnce(json({ quests: [] }))
    await dispatch({ url: at('/api/data') }).settled()
    expect(caches.entry(SHELL, at('/'))).toBeDefined()

    network.mockResolvedValueOnce(page('<p>Pair this device</p>', 401))
    const { response, settled } = navigate('/')
    expect((await response!).status).toBe(401)
    await settled()
    expect(caches.entry(SHELL, at('/'))).toBeUndefined()
    expect(caches.stores.has(DATA)).toBe(false)
  })
})

describe('data', () => {
  const data = () => dispatch({ url: at('/api/data') })

  it('answers from the network and keeps the last good copy', async () => {
    network.mockResolvedValue(json({ ready: true }, 200, { 'X-Overrides-ETag': '"o1"' }))
    const { response, settled } = data()
    const res = await response!
    expect(await res.json()).toEqual({ ready: true })
    expect(res.headers.get(OFFLINE_HEADER)).toBeNull()
    await settled()
    const kept = caches.entry(DATA, at('/api/data'))!
    expect(kept.headers.get('X-Overrides-ETag')).toBe('"o1"')
    expect(Date.parse(kept.headers.get('X-Ash-Log-Cached-At')!)).not.toBeNaN()
  })

  it('hands out the kept copy, marked with the time it was kept, when the Mac is away', async () => {
    network.mockResolvedValue(json(emptyProgressLike(), 200, { ETag: '"r7"' }))
    await dispatch({ url: at('/api/progress') }).settled()
    const keptAt = caches.entry(DATA, at('/api/progress'))!.headers.get('X-Ash-Log-Cached-At')

    network.mockRejectedValue(new TypeError('Load failed'))
    const res = await dispatch({ url: at('/api/progress') }).response!
    expect(res.status).toBe(200)
    expect(res.headers.get(OFFLINE_HEADER)).toBe(keptAt)
    expect(res.headers.get('ETag')).toBe('"r7"')
    expect(res.headers.get('X-Ash-Log-Cached-At')).toBeNull()
    expect(await res.json()).toEqual(emptyProgressLike())
  })

  it('hands out the kept copy when the Mac is too slow', async () => {
    vi.useFakeTimers()
    load()
    await caches.open(DATA).then((c) => c.put(at('/api/data'), json({ old: true }, 200, { 'X-Ash-Log-Cached-At': '2026-09-29T08:00:00.000Z' })))
    network.mockReturnValue(new Promise(() => {}))
    const { response } = data()
    await vi.advanceTimersByTimeAsync(6100)
    const res = await response!
    expect(res.headers.get(OFFLINE_HEADER)).toBe('2026-09-29T08:00:00.000Z')
  })

  it('gives up on the data much sooner right after a navigation found no Mac', async () => {
    vi.useFakeTimers()
    load()
    await caches.open(SHELL).then((c) => c.put(at('/'), app()))
    await caches.open(DATA).then((c) => c.put(at('/api/data'), json({ old: true }, 200, { 'X-Ash-Log-Cached-At': '2026-09-29T08:00:00.000Z' })))
    // The Mac sleeps: nothing answers, nothing fails either.
    network.mockReturnValue(new Promise(() => {}))
    const nav = navigate('/')
    await vi.advanceTimersByTimeAsync(4100)
    expect(await (await nav.response!).text()).toBe(appHtml)

    const { response } = data()
    let done = false
    void response!.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(1600)
    expect(done).toBe(true)
    expect((await response!).headers.get(OFFLINE_HEADER)).toBe('2026-09-29T08:00:00.000Z')
  })

  it('waits the full time again once the Mac answered', async () => {
    vi.useFakeTimers()
    load()
    await caches.open(DATA).then((c) => c.put(at('/api/data'), json({ old: true }, 200, { 'X-Ash-Log-Cached-At': '2026-09-29T08:00:00.000Z' })))
    network.mockRejectedValueOnce(new TypeError('Load failed'))
    await dispatch({ url: at('/api/data') }).response
    network.mockResolvedValueOnce(json({ fresh: true }))
    await dispatch({ url: at('/api/data') }).settled()

    network.mockReturnValue(new Promise(() => {}))
    const { response } = data()
    let done = false
    void response!.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(4200)
    expect(done).toBe(true)
  })

  it('fails like the network when nothing is kept', async () => {
    await expect(data().response!).rejects.toThrow('Load failed')
  })

  it('never keeps a 403 or a 500, and a 401 forgets what was kept', async () => {
    network.mockResolvedValueOnce(json({ ok: 1 }))
    await data().settled()
    for (const status of [403, 500, 503]) {
      network.mockResolvedValueOnce(json({ error: 'x' }, status))
      const { response, settled } = data()
      expect((await response!).status).toBe(status)
      await settled()
    }
    expect(await caches.entry(DATA, at('/api/data'))!.json()).toEqual({ ok: 1 })

    network.mockResolvedValueOnce(json({ error: 'Pair this device first' }, 401))
    const { response, settled } = data()
    expect((await response!).status).toBe(401)
    await settled()
    expect(caches.entry(DATA, at('/api/data'))).toBeUndefined()
  })

  it('never answers a 401 with an old copy', async () => {
    network.mockResolvedValueOnce(json({ ok: 1 }))
    await data().settled()
    network.mockResolvedValueOnce(json({ error: 'Pair this device first' }, 401))
    const res = await data().response!
    expect(res.status).toBe(401)
    expect(res.headers.get(OFFLINE_HEADER)).toBeNull()
  })
})

function emptyProgressLike() {
  return { version: 1, quests: {}, points: {}, vaults: {}, rewards: {} }
}

describe('files', () => {
  it('serves build files from the cache once kept, without asking the network', async () => {
    network.mockResolvedValue(new Response('console.log(1)', { status: 200, headers: { 'Content-Type': 'text/javascript' } }))
    const first = dispatch({ url: at('/assets/index-abc.js') })
    expect(await (await first.response!).text()).toBe('console.log(1)')
    await first.settled()

    network.mockRejectedValue(new TypeError('Load failed'))
    const again = await dispatch({ url: at('/assets/index-abc.js') }).response!
    expect(await again.text()).toBe('console.log(1)')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('keeps map tiles and icons as they are viewed, but not a 404', async () => {
    network.mockResolvedValueOnce(new Response('png', { status: 200, headers: { 'Content-Type': 'image/png' } }))
    await dispatch({ url: at('/wiki-img/tiles/2/1_1.png'), mode: 'no-cors' }).settled()
    network.mockResolvedValueOnce(new Response('', { status: 404 }))
    const missing = dispatch({ url: at('/wiki-img/tiles/2/9_9.png'), mode: 'no-cors' })
    expect((await missing.response!).status).toBe(404)
    await missing.settled()
    expect(caches.entry(IMAGES, at('/wiki-img/tiles/2/1_1.png'))).toBeDefined()
    expect(caches.entry(IMAGES, at('/wiki-img/tiles/2/9_9.png'))).toBeUndefined()
  })

  it('trims build files by last use, never a file the app still uses (Safari keeps a replaced entry in place)', async () => {
    const day = 24 * 60 * 60 * 1000
    const stampedFile = (body: string, at: number) =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/javascript', 'X-Ash-Log-Cached-At': new Date(at).toISOString() } })
    const staticCache = await caches.open(STATIC)
    // Kept first, unchanged for many builds: first in cache.keys().
    await staticCache.put(at('/assets/shared.js'), stampedFile('shared', Date.now() - 30 * day))
    for (let i = 0; i < 200; i++) await staticCache.put(at(`/assets/old-${i}.js`), stampedFile(`old ${i}`, Date.now() - 10 * day))

    // The app loads the shared file again: served from the cache and stamped anew.
    const hit = dispatch({ url: at('/assets/shared.js') })
    expect(await (await hit.response!).text()).toBe('shared')
    await hit.settled()
    expect(network).not.toHaveBeenCalled()
    expect(Date.now() - Date.parse(caches.entry(STATIC, at('/assets/shared.js'))!.headers.get('X-Ash-Log-Cached-At')!)).toBeLessThan(day)
    expect((await staticCache.keys())[0]!.url).toBe(at('/assets/shared.js'))

    // A fresh app page trims: one file too many, and it is an old one.
    network.mockResolvedValueOnce(app())
    await navigate('/').settled()
    const left = (await staticCache.keys()).map((k) => k.url)
    expect(left).toHaveLength(200)
    expect(left).toContain(at('/assets/shared.js'))
  })

  it('keeps the files the page lists in a cache message', async () => {
    network.mockImplementation(async (url) => new Response(`file ${url}`, { status: 200 }))
    const waits: Promise<unknown>[] = []
    handlers.message!({
      data: { type: 'cache', urls: [at('/assets/QuestsView-1.js'), '/assets/font.woff2', at('/api/data'), 'https://evil.example/x.js', '/icons/icon-192.png'] },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })
    await Promise.all(waits)
    expect(caches.entry(STATIC, at('/assets/QuestsView-1.js'))).toBeDefined()
    expect(caches.entry(STATIC, at('/assets/font.woff2'))).toBeDefined()
    expect(caches.entry(IMAGES, at('/icons/icon-192.png'))).toBeDefined()
    expect(network.mock.calls.map((c) => c[0])).toEqual([at('/assets/QuestsView-1.js'), at('/assets/font.woff2'), at('/icons/icon-192.png')])
  })
})

describe('lifecycle', () => {
  it('takes over at once and keeps the app and its entry files on install', async () => {
    network.mockImplementation(async (url) => (url === at('/') ? app() : new Response(`file ${url}`, { status: 200 })))
    const waits: Promise<unknown>[] = []
    handlers.install!({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    expect(self.skipWaiting).toHaveBeenCalled()
    expect(caches.entry(SHELL, at('/'))).toBeDefined()
    expect(caches.entry(STATIC, at('/assets/index-abc.js'))).toBeDefined()
    expect(caches.entry(STATIC, at('/assets/index-def.css'))).toBeDefined()
  })

  it('installs even when the Mac cannot be reached', async () => {
    const waits: Promise<unknown>[] = []
    handlers.install!({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await expect(Promise.all(waits)).resolves.toBeDefined()
    expect(caches.entry(SHELL, at('/'))).toBeUndefined()
  })

  it('drops caches of older versions only, and claims the open pages', async () => {
    await caches.open('ash-log-shell-v0')
    await caches.open('ash-log-data-v0')
    await caches.open(DATA)
    await caches.open('someone-else')
    const waits: Promise<unknown>[] = []
    handlers.activate!({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    expect((await caches.keys()).sort()).toEqual([DATA, IMAGES, STATIC, 'someone-else'].sort())
    expect(self.clients.claim).toHaveBeenCalled()
  })

  it('finds the entry files in index.html', () => {
    expect(sw.assetUrlsIn(appHtml + '<link rel="modulepreload" href="/assets/vendor-1.js"><a href="https://x.example/assets/y.js">', ORIGIN)).toEqual([
      at('/assets/index-abc.js'),
      at('/assets/index-def.css'),
      at('/assets/vendor-1.js'),
    ])
  })
})

describe('texts', () => {
  it('shows the same title, text and button as the app', () => {
    const html = sw.offlinePageHtml()
    expect(html).toContain(`<h1>${OFFLINE_TITLE}</h1>`)
    expect(html).toContain(`<p>${OFFLINE_TEXT}</p>`)
    expect(html).toContain(`>${RETRY_LABEL}</button>`)
    expect(html).not.toMatch(/—/)
  })
})
