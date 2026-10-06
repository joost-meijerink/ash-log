// The app server's request handler behind a test HTTP server that fakes the socket's
// remote address (x-test-remote) and whether it came in over TLS (x-test-secure), plus real
// listeners for the live switch and the one-port http/https split. Every data path points at
// a temp dir, the certificates too. Never touches /data, .local or the wiki.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as paths from '../scripts/sync/paths.ts'
import { APP_HEADER, createAppServer, type AppOptions, type AppServer } from './app.ts'
import { CA_CERT_FILE_NAME, CA_CERT_PATH, PROFILE_PATH } from './certificate-page.ts'
import { CODE_TTL_MS, RATE_LIMIT_MAX } from './pairing.ts'
import { pngHeader } from './test-utils.ts'
import { LocalTls, certNames } from './tls.ts'

vi.mock('../scripts/sync/paths.ts', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'ashenfall-app-'))
  const DATA_DIR = join(root, 'data')
  const WIKI_DIR = join(DATA_DIR, 'wiki')
  const PUBLIC_IMG_DIR = join(root, 'public', 'wiki-img')
  return {
    ROOT: root,
    DATA_DIR,
    WIKI_DIR,
    RAW_CACHE_DIR: join(WIKI_DIR, '.raw'),
    PROGRESS_FILE: join(DATA_DIR, 'progress.json'),
    OVERRIDES_FILE: join(DATA_DIR, 'overrides.json'),
    WIKI_FILES: {
      map: join(WIKI_DIR, 'map.json'),
      quests: join(WIKI_DIR, 'quests.json'),
      vaults: join(WIKI_DIR, 'vaults.json'),
      rewards: join(WIKI_DIR, 'rewards.json'),
      meta: join(WIKI_DIR, 'meta.json'),
      report: join(WIKI_DIR, 'report.json'),
    },
    PUBLIC_IMG_DIR,
    ICONS_DIR: join(PUBLIC_IMG_DIR, 'icons'),
    TILES_DIR: join(PUBLIC_IMG_DIR, 'tiles'),
    FIXTURES_DIR: join(root, 'fixtures'),
  }
})
// No sync and no program to keep the computer awake.
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: vi.fn() }))

const APP_PORT = 5199
const MAC = 'MacBook-Pro-van-Joost.local'
const LAN_IP = '192.168.1.20'
const PHONE_IP = '192.168.1.50'
const LOCAL_HOST = `localhost:${APP_PORT}`
const LAN_HOST = `${MAC.toLowerCase()}:${APP_PORT}`
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'

const root = paths.ROOT
const dist = join(root, 'dist')
const pub = join(root, 'public')
const stateFile = join(root, '.local', 'server.json')

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
  json: any
}

interface CallOptions {
  body?: unknown
  raw?: string
  headers?: Record<string, string>
  /** Fake remote address; loopback by default. */
  from?: string
  /** Pretend the request came in over TLS (the harness itself is plain http). */
  secure?: boolean
  /** Target port and address; the fake-remote test server by default. */
  port?: number
  address?: string
}

let harness: Server
let harnessPort: number
let app: AppServer
/** One CA and server certificate for every app in this file. */
let sharedTls: LocalTls
let clock: number
let stopped: number
let logs: string[]

function call(method: string, path: string, opts: CallOptions = {}): Promise<Reply> {
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const headers: Record<string, string> = {
    host: opts.from ? LAN_HOST : LOCAL_HOST,
    ...(method !== 'GET' && method !== 'HEAD' ? { 'content-type': 'application/json' } : {}),
    ...(opts.from ? { 'x-test-remote': opts.from } : {}),
    ...(opts.secure ? { 'x-test-secure': '1' } : {}),
    ...opts.headers,
  }
  return new Promise((resolve, reject) => {
    const req = request(
      { host: opts.address ?? '127.0.0.1', port: opts.port ?? harnessPort, method, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown
          try {
            json = text ? JSON.parse(text) : undefined
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

interface HttpsReply extends Reply {
  /** The server certificate's subjectAltName, as the client saw it. */
  subjectAltName: string
}

/** A real https request to 127.0.0.1 (SNI localhost), trusting only `ca`. */
function callHttps(port: number, path: string, opts: { ca?: string; headers?: Record<string, string> } = {}): Promise<HttpsReply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path, servername: 'localhost', ca: opts.ca, headers: opts.headers, agent: false },
      (res) => {
        const subjectAltName = (res.socket as TLSSocket).getPeerCertificate().subjectaltname ?? ''
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown
          try {
            json = text ? JSON.parse(text) : undefined
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json, subjectAltName })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** From the phone over https: LAN address, LAN Host header, iPhone user agent, optional cookie. */
const phone = (cookie?: string, extra: Record<string, string> = {}): CallOptions => ({
  from: PHONE_IP,
  secure: true,
  headers: { 'user-agent': IPHONE, ...(cookie ? { cookie } : {}), ...extra },
})

/** The same phone over plain http (an old home-screen icon, a typed http address). */
const plainPhone = (cookie?: string, extra: Record<string, string> = {}): CallOptions => ({ ...phone(cookie, extra), secure: false })

const cookieOf = (reply: Reply) => {
  const raw = reply.headers['set-cookie']
  return (Array.isArray(raw) ? raw[0] : raw) ?? ''
}
const tokenOf = (reply: Reply) => /logboek_device=([^;]+)/.exec(cookieOf(reply))?.[1] ?? ''

function makeApp(extra: Partial<AppOptions> = {}): AppServer {
  return createAppServer({
    port: APP_PORT,
    distDir: dist,
    publicDir: pub,
    iconsDir: join(pub, 'icons'),
    stateFile,
    hostname: () => MAC,
    lanAddresses: () => [LAN_IP],
    now: () => clock,
    log: (line) => logs.push(line),
    onStop: () => stopped++,
    tls: sharedTls,
    // The same answers on every computer the tests run on, whatever LIVE_ADDRESS says.
    platform: 'darwin',
    liveAddress: null,
    ...extra,
  })
}

/** A certificate store that always fails: its folder would have to be inside a file. */
async function failingTls(name: string): Promise<LocalTls> {
  const blocker = join(root, `${name}-file`)
  await writeFile(blocker, 'not a folder')
  return new LocalTls({ dir: join(blocker, 'tls') })
}

/** Creates a code on the Mac and pairs the phone with it; returns the device cookie. */
async function pairPhone(): Promise<{ cookie: string; token: string }> {
  const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code as string
  const res = await call('GET', `/koppel?code=${code}`, phone())
  expect(res.status).toBe(302)
  const token = tokenOf(res)
  return { cookie: `logboek_device=${token}`, token }
}

beforeAll(async () => {
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Logboek</title>')
  await writeFile(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)')
  await writeFile(join(dist, 'assets', 'index-abc123.css'), 'body{}')
  await mkdir(join(pub, 'icons'), { recursive: true })
  await writeFile(join(pub, 'icons', 'icon-192.png'), pngHeader(192, 192))
  await writeFile(join(pub, 'icons', 'apple-touch-icon.png'), pngHeader(180, 180))
  await writeFile(join(pub, 'robots.txt'), 'User-agent: *')
  await mkdir(join(paths.PUBLIC_IMG_DIR, 'icons'), { recursive: true })
  await writeFile(join(paths.PUBLIC_IMG_DIR, 'icons', 'Gold_Ore.png'), pngHeader(64, 64))

  await writeFile(join(pub, 'sw.js'), 'self.addEventListener("fetch", () => {})')

  sharedTls = new LocalTls({ dir: join(root, 'tls') })
  await sharedTls.ensure(certNames(MAC, [LAN_IP]))

  harness = createServer((req, res) => {
    const fake = req.headers['x-test-remote']
    Object.defineProperty(req.socket, 'remoteAddress', { value: typeof fake === 'string' ? fake : '127.0.0.1', configurable: true })
    Object.defineProperty(req.socket, 'encrypted', { value: req.headers['x-test-secure'] === '1' ? true : undefined, configurable: true })
    void app.handle(req, res)
  })
  await new Promise<void>((r) => harness.listen(0, '127.0.0.1', r))
  harnessPort = (harness.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => harness.close(() => r()))
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  clock = Date.parse('2026-09-28T12:00:00Z')
  stopped = 0
  logs = []
  await rm(join(root, '.local'), { recursive: true, force: true })
  await rm(paths.DATA_DIR, { recursive: true, force: true })
  await mkdir(paths.DATA_DIR, { recursive: true })
  // A test may have issued the shared certificate for other addresses.
  await sharedTls.ensure(certNames(MAC, [LAN_IP]))
  app = makeApp()
  await app.pairing.load()
  // Handler tests: pretend live mode is on without binding the network.
  app.listeners.live = true
})

describe('Host header (DNS rebinding)', () => {
  it('refuses a foreign host, also from this Mac', async () => {
    const api = await call('GET', '/api/health', { headers: { host: `evil.example:${APP_PORT}` } })
    expect(api.status).toBe(403)
    expect(api.json).toEqual({ error: 'Onbekende host' })
    const page = await call('GET', '/', { headers: { host: `evil.example:${APP_PORT}` } })
    expect(page.status).toBe(403)
    expect(page.text).toBe('Onbekende host')
    expect((await call('GET', '/api/health', { headers: { host: `localhost:${APP_PORT + 1}` } })).status).toBe(403)
    expect((await call('GET', '/api/health', { headers: { host: 'localhost' } })).status).toBe(403)
  })

  it('accepts localhost, loopback, the Mac name and its LAN address', async () => {
    for (const host of [LOCAL_HOST, `127.0.0.1:${APP_PORT}`, `[::1]:${APP_PORT}`, `${MAC}:${APP_PORT}`, `${LAN_IP}:${APP_PORT}`]) {
      expect((await call('GET', '/api/health', { headers: { host } })).status, host).toBe(200)
    }
  })
})

describe('local requests', () => {
  it('reach everything: health, status with devices, the app', async () => {
    expect((await call('GET', '/api/health')).json).toEqual({ ok: true, mode: 'app' })
    const status = await call('GET', '/api/server')
    expect(status.json).toEqual({
      mode: 'app',
      platform: 'mac',
      local: true,
      live: true,
      port: APP_PORT,
      urls: [`https://${MAC}:${APP_PORT}`, `https://${LAN_IP}:${APP_PORT}`],
      certificateUrl: `http://${MAC}:${APP_PORT}/certificaat`,
      devices: [],
    })
    const progress = await call('GET', '/api/progress')
    expect(progress.status).toBe(200)
    expect(progress.json.version).toBe(1)
  })

  it('treats ::1 and the IPv4-mapped loopback as local', async () => {
    for (const from of ['::1', '::ffff:127.0.0.1']) {
      const res = await call('GET', '/api/server', { from, headers: { host: LOCAL_HOST } })
      expect(res.json.local, from).toBe(true)
    }
  })

  it('shows no urls and no certificate page while not live', async () => {
    app.listeners.live = false
    const status = (await call('GET', '/api/server')).json
    expect(status).toMatchObject({ live: false, urls: [] })
    expect(status).not.toHaveProperty('certificateUrl')
  })

  it('lists only LAN addresses the certificate can hold', async () => {
    app = makeApp({ lanAddresses: () => [LAN_IP, '100.64.0.7', '10.0.0.5'] })
    app.listeners.live = true
    expect((await call('GET', '/api/server')).json.urls).toEqual([
      `https://${MAC}:${APP_PORT}`,
      `https://${LAN_IP}:${APP_PORT}`,
      `https://10.0.0.5:${APP_PORT}`,
    ])
  })

  it('issue a new certificate in the background when a status shows the address changed', async () => {
    let lanList = [LAN_IP]
    app = makeApp({ lanAddresses: () => lanList })
    app.listeners.live = true
    const before = sharedTls.current!.cert
    lanList = ['10.0.0.8']
    expect((await call('GET', '/api/server')).json.urls).toEqual([`https://${MAC}:${APP_PORT}`, `https://10.0.0.8:${APP_PORT}`])
    await vi.waitFor(() => expect(sharedTls.current!.names.ips).toEqual(['127.0.0.1', '10.0.0.8']))
    expect(sharedTls.current!.cert).not.toBe(before)
  })

  it('do not retry a failing certificate on every status poll', async () => {
    app = makeApp({ tls: await failingTls('tls-failing') })
    app.listeners.live = true
    const failures = () => logs.filter((l) => l.startsWith('Certificaat maken mislukt'))
    await call('GET', '/api/server')
    await vi.waitFor(() => expect(failures()).toHaveLength(1))
    await call('GET', '/api/server')
    await call('GET', '/api/server')
    await new Promise((r) => setTimeout(r, 50))
    expect(failures()).toHaveLength(1)
    clock += 5 * 60 * 1000
    await call('GET', '/api/server')
    await vi.waitFor(() => expect(failures()).toHaveLength(2))
  })

  it('work over plain http, without a Secure cookie', async () => {
    const { token } = await pairPhone()
    const res = await call('GET', `/?device=${token}`)
    expect(res.status).toBe(302)
    expect(cookieOf(res)).toMatch(/HttpOnly; SameSite=Lax$/)
  })
})

describe('static files', () => {
  it('serves index.html without caching and with frame protection', async () => {
    const res = await call('GET', '/')
    expect(res.status).toBe(200)
    expect(res.text).toBe('<!doctype html><title>Logboek</title>')
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'")
  })

  it('marks index.html as the app for the service worker, and nothing else', async () => {
    expect(APP_HEADER).toBe('X-Ash-Log-App')
    for (const path of ['/', '/index.html', '/quests', '/kaart?punt=1']) {
      expect((await call('GET', path)).headers['x-ash-log-app'], path).toBe('1')
    }
    const { cookie } = await pairPhone()
    expect((await call('GET', '/', phone(cookie))).headers['x-ash-log-app']).toBe('1')
    for (const [path, opts] of [
      ['/', phone()],
      ['/koppel', phone()],
      ['/certificaat', plainPhone()],
      ['/quests', plainPhone()],
      ['/assets/index-abc123.js', {}],
      ['/api/progress', {}],
      ['/manifest.webmanifest', {}],
      ['/sw.js', {}],
      ['/robots.txt', {}],
    ] as const) {
      expect((await call('GET', path, opts)).headers['x-ash-log-app'], path).toBeUndefined()
    }
    app = makeApp({ distDir: join(root, 'no-dist') })
    const missing = await call('GET', '/')
    expect(missing.status).toBe(503)
    expect(missing.headers['x-ash-log-app']).toBeUndefined()
  })

  it('serves /sw.js without caching, also to a phone that is not paired', async () => {
    for (const opts of [{}, phone()]) {
      const res = await call('GET', '/sw.js', opts)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.text).toContain('addEventListener')
    }
    expect((await call('POST', '/sw.js', { body: {} })).status).toBe(405)
    // Over plain http from the network it is not there (no service worker without https anyway).
    expect((await call('GET', '/sw.js', plainPhone())).status).toBe(403)
    app = makeApp({ publicDir: join(root, 'no-public') })
    expect((await call('GET', '/sw.js')).status).toBe(404)
  })

  it('caches hashed assets for a long time, with the right type', async () => {
    const js = await call('GET', '/assets/index-abc123.js')
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    const css = await call('GET', '/assets/index-abc123.css')
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')
  })

  it('falls back to index.html for app routes, not for missing files', async () => {
    for (const path of ['/quests', '/kaart/iets', '/verzamelingen?x=1']) {
      const res = await call('GET', path)
      expect(res.status, path).toBe(200)
      expect(res.text, path).toContain('<title>Logboek</title>')
    }
    expect((await call('GET', '/assets/missing-123.js')).status).toBe(404)
    expect((await call('GET', '/favicon.ico')).status).toBe(404)
  })

  it('serves public/ files that are not in dist, and /icons and /wiki-img live from public/', async () => {
    const robots = await call('GET', '/robots.txt')
    expect(robots.status).toBe(200)
    expect(robots.text).toBe('User-agent: *')
    const icon = await call('GET', '/icons/icon-192.png')
    expect(icon.status).toBe(200)
    expect(icon.headers['content-type']).toBe('image/png')
    expect((await call('GET', '/icons/nope.png')).status).toBe(404)
    const wiki = await call('GET', '/wiki-img/icons/Gold_Ore.png')
    expect(wiki.status).toBe(200)
    expect(wiki.headers['content-type']).toBe('image/png')
  })

  it('refuses to leave dist, public or icons', async () => {
    await writeFile(join(paths.DATA_DIR, 'progress.json'), '{}')
    for (const path of ['/..%2Fdata%2Fprogress.json', '/assets/..%2F..%2Fdata%2Fprogress.json', '/icons/..%2F..%2Fdata%2Fprogress.json']) {
      const res = await call('GET', path)
      expect(res.status, path).toBe(403)
      expect(res.text).toBe('')
    }
    expect((await call('GET', '/icons/a%00.png')).status).toBe(400)
  })

  it('supports HEAD and refuses other methods on pages', async () => {
    const head = await call('HEAD', '/')
    expect(head.status).toBe(200)
    expect(head.text).toBe('')
    expect((await call('POST', '/quests', { body: {} })).status).toBe(405)
  })

  it('says the app is not built yet when dist is missing', async () => {
    app = makeApp({ distDir: join(root, 'no-dist') })
    const res = await call('GET', '/quests')
    expect(res.status).toBe(503)
    expect(res.text).toMatch(/nog niet gebouwd/)
  })
})

describe('requests from the network without pairing', () => {
  it('get 401 JSON on the API, management included', async () => {
    for (const [method, path] of [
      ['GET', '/api/data'],
      ['GET', '/api/progress'],
      ['GET', '/api/server'],
      ['GET', '/api/health'],
      ['POST', '/api/server/live'],
      ['POST', '/api/server/pairing'],
      ['PUT', '/api/progress'],
    ] as const) {
      const res = await call(method, path, { ...phone(), body: method === 'GET' ? undefined : {} })
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(res.json, `${method} ${path}`).toEqual({ error: 'Koppel dit apparaat eerst' })
    }
  })

  it('get the pairing page for every page path, and nothing of the app', async () => {
    for (const path of ['/', '/quests', '/kaart']) {
      const res = await call('GET', path, phone())
      expect(res.status, path).toBe(401)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.text).toContain('Koppel dit apparaat')
      expect(res.text).toContain('action="/koppel"')
      expect(res.text).not.toContain('<script')
      expect(res.text).not.toContain('Logboek</title>')
    }
    expect((await call('GET', '/assets/index-abc123.js', phone())).status).toBe(401)
    expect((await call('GET', '/wiki-img/icons/Gold_Ore.png', phone())).status).toBe(401)
    expect((await call('GET', '/robots.txt', phone())).status).toBe(401)
  })

  it('may reach the manifest (start_url /), the icons and /koppel', async () => {
    const manifest = await call('GET', '/manifest.webmanifest', phone())
    expect(manifest.status).toBe(200)
    expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8')
    expect(manifest.json.start_url).toBe('/')
    expect((await call('GET', '/icons/apple-touch-icon.png', phone())).status).toBe(200)
    const koppel = await call('GET', '/koppel', phone())
    expect(koppel.status).toBe(200)
    expect(koppel.text).toContain('Koppel dit apparaat')
  })

  it('are dropped while live mode is off', async () => {
    app.listeners.live = false
    await expect(call('GET', '/', phone())).rejects.toThrow(/socket hang up|ECONNRESET/)
  })
})

describe('pairing', () => {
  it('needs live mode and a request from this Mac', async () => {
    app.listeners.live = false
    const off = await call('POST', '/api/server/pairing', { body: {} })
    expect(off.status).toBe(409)
    expect(off.json.error).toBe('Zet eerst Live op wifi aan')
  })

  it('returns a code, its QR code for the https mDNS url and the expiry', async () => {
    const res = await call('POST', '/api/server/pairing', { body: {} })
    expect(res.status).toBe(200)
    expect(res.json.code).toMatch(/^\d{6}$/)
    expect(res.json.url).toBe(`https://${MAC}:${APP_PORT}/koppel?code=${res.json.code}`)
    expect(res.json.qrSvg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(res.json.expiresAt).toBe(new Date(clock + CODE_TTL_MS).toISOString())
  })

  it('puts the LAN address in the QR code for an Android phone, and refuses an unknown phone', async () => {
    const android = await call('POST', '/api/server/pairing', { body: { phone: 'android' } })
    expect(android.status).toBe(200)
    expect(android.json.url).toBe(`https://${LAN_IP}:${APP_PORT}/koppel?code=${android.json.code}`)
    const iphone = await call('POST', '/api/server/pairing', { body: { phone: 'iphone' } })
    expect(iphone.json.url).toBe(`https://${MAC}:${APP_PORT}/koppel?code=${iphone.json.code}`)
    const bad = await call('POST', '/api/server/pairing', { body: { phone: 42 } })
    expect(bad.status).toBe(400)
    // The last good code still works: a bad request makes none.
    expect((await call('GET', `/koppel?code=${iphone.json.code}`, phone())).status).toBe(302)
  })

  it('pairs through the QR link: cookie, redirect, then full access', async () => {
    const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    const res = await call('GET', `/koppel?code=${code}`, phone())
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/')
    const cookie = cookieOf(res)
    expect(cookie).toMatch(/^logboek_device=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Lax; Secure$/)
    const token = tokenOf(res)

    const auth = `logboek_device=${token}`
    expect((await call('GET', '/', phone(auth))).text).toContain('<title>Logboek</title>')
    expect((await call('GET', '/api/progress', phone(auth))).status).toBe(200)
    expect((await call('GET', '/assets/index-abc123.js', phone(auth))).status).toBe(200)

    // Only the hash is on disk.
    const file = await readFile(stateFile, 'utf8')
    expect(file).not.toContain(token)
    expect(file).toContain(createHash('sha256').update(token).digest('hex'))

    const status = await call('GET', '/api/server')
    expect(status.json.devices).toEqual([
      { id: expect.any(String), name: 'iPhone (Safari)', pairedAt: '2026-09-28T12:00:00.000Z', lastSeenAt: '2026-09-28T12:00:00.000Z' },
    ])
  })

  it('uses a code once and lets it expire', async () => {
    const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    expect((await call('GET', `/koppel?code=${code}`, phone())).status).toBe(302)
    const reused = await call('GET', `/koppel?code=${code}`, { ...phone(), from: '192.168.1.51' })
    expect(reused.status).toBe(410)
    expect(reused.text).toContain('Deze code is niet meer geldig')

    const late = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    clock += CODE_TTL_MS
    expect((await call('GET', `/koppel?code=${late}`, phone())).status).toBe(410)
  })

  it('shows wrong codes on the page with 400, and HEAD never uses a code up', async () => {
    const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    const wrong = code === '000000' ? '000001' : '000000'
    const res = await call('GET', `/koppel?code=${wrong}`, phone())
    expect(res.status).toBe(400)
    expect(res.text).toContain('Deze code klopt niet')
    expect((await call('HEAD', `/koppel?code=${code}`, phone())).status).toBe(200)
    expect((await call('GET', `/koppel?code=${code}`, phone())).status).toBe(302)
  })

  it('rate-limits wrong codes per address', async () => {
    const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < RATE_LIMIT_MAX; i++) expect((await call('GET', `/koppel?code=${wrong}`, phone())).status).toBe(400)
    const blocked = await call('GET', `/koppel?code=${code}`, phone())
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    const api = await call('POST', '/api/pair', { ...phone(), body: { code } })
    expect(api.status).toBe(429)
    expect(api.json.error).toMatch(/Te veel pogingen/)
    // Another phone is not blocked.
    expect((await call('GET', `/koppel?code=${code}`, { ...phone(), from: '192.168.1.51' })).status).toBe(302)
  })

  it('accepts typed digits via POST /api/pair (JSON, same origin)', async () => {
    const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    const wrong = await call('POST', '/api/pair', { ...phone(), body: { code: '12345' } })
    expect(wrong.status).toBe(400)
    expect(wrong.json.error).toBe('Typ de zes cijfers van de koppelcode')
    const form = await call('POST', '/api/pair', { ...phone(undefined, { 'content-type': 'application/x-www-form-urlencoded' }), raw: `code=${code}` })
    expect(form.status).toBe(415)
    const foreign = await call('POST', '/api/pair', { ...phone(undefined, { origin: 'http://evil.example' }), body: { code } })
    expect(foreign.status).toBe(403)

    const ok = await call('POST', '/api/pair', { ...phone(undefined, { origin: `https://${MAC.toLowerCase()}:${APP_PORT}` }), body: { code } })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ ok: true })
    expect(cookieOf(ok)).toMatch(/HttpOnly; SameSite=Lax; Secure$/)
    expect((await call('GET', '/api/progress', phone(`logboek_device=${tokenOf(ok)}`))).status).toBe(200)
    expect((await call('POST', '/api/pair', { ...phone(), body: { code } })).status).toBe(410)
  })

  it('sends an already paired phone and this Mac from /koppel to the app without using the code', async () => {
    const { cookie } = await pairPhone()
    const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    const paired = await call('GET', `/koppel?code=${code}`, phone(cookie))
    expect(paired.status).toBe(302)
    expect(paired.headers['set-cookie']).toBeUndefined()
    const mac = await call('GET', `/koppel?code=${code}`)
    expect(mac.status).toBe(302)
    expect((await call('GET', `/koppel?code=${code}`, { ...phone(), from: '192.168.1.51' })).status).toBe(302)
  })

  it('invalidates the code when live mode goes off', async () => {
    const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    // Not bound in handler tests: the switch itself is a no-op here.
    expect((await call('POST', '/api/server/live', { body: { on: false } })).json.live).toBe(false)
    app.listeners.live = true
    expect((await call('GET', `/koppel?code=${code}`, phone())).status).toBe(410)
  })
})

describe('paired devices', () => {
  it('see the status without devices and cannot manage the server (403)', async () => {
    const { cookie } = await pairPhone()
    const status = await call('GET', '/api/server', phone(cookie))
    expect(status.json).toEqual({
      mode: 'app',
      platform: 'mac',
      local: false,
      live: true,
      port: APP_PORT,
      urls: [`https://${MAC}:${APP_PORT}`, `https://${LAN_IP}:${APP_PORT}`],
      certificateUrl: `http://${MAC}:${APP_PORT}/certificaat`,
    })
    expect((await call('GET', '/api/server/certificate-qr', phone(cookie))).status).toBe(403)
    for (const path of ['/api/server/live', '/api/server/pairing', '/api/server/devices/revoke', '/api/server/stop']) {
      const res = await call('POST', path, { ...phone(cookie), body: { on: false, id: 'x' } })
      expect(res.status, path).toBe(403)
      expect(res.json.error).toBe('Dit kan alleen op de Mac zelf')
    }
    expect(stopped).toBe(0)
    expect(app.listeners.live).toBe(true)
  })

  it('get their token as start_url in the manifest; this Mac and strangers get /', async () => {
    const { cookie, token } = await pairPhone()
    expect((await call('GET', '/manifest.webmanifest', phone(cookie))).json.start_url).toBe(`/?device=${token}`)
    expect((await call('GET', '/manifest.webmanifest', phone('logboek_device=nope'))).json.start_url).toBe('/')
    const local = await call('GET', '/manifest.webmanifest')
    expect(local.json.start_url).toBe('/')
    expect(local.headers['cache-control']).toBe('no-store')
    expect(local.json.icons).toEqual([{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }])
  })

  it('log in from the home screen with ?device= and get redirected without it', async () => {
    const { token } = await pairPhone()
    const res = await call('GET', `/?device=${token}`, phone())
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(tokenOf(res)).toBe(token)
    expect(cookieOf(res)).toMatch(/HttpOnly; SameSite=Lax; Secure$/)

    const kept = await call('GET', `/kaart?device=${token}&punt=abc`, phone())
    expect(kept.headers.location).toBe('/kaart?punt=abc')
    const sneaky = await call('GET', `/.//evil.example?device=${token}`, phone())
    expect(sneaky.headers.location).toBe('/evil.example')

    const bad = await call('GET', '/?device=wrong', phone())
    expect(bad.status).toBe(401)
    expect(bad.text).toContain('Koppel dit apparaat')
  })

  it('lose access when unpaired on the Mac', async () => {
    const { cookie } = await pairPhone()
    const id = (await call('GET', '/api/server')).json.devices[0].id
    const res = await call('POST', '/api/server/devices/revoke', { body: { id } })
    expect(res.status).toBe(200)
    expect(res.json.devices).toEqual([])
    expect((await call('GET', '/api/progress', phone(cookie))).status).toBe(401)
    expect((await call('POST', '/api/server/devices/revoke', { body: { id } })).status).toBe(404)
    expect((await call('POST', '/api/server/devices/revoke', { body: {} })).status).toBe(400)
  })

  it('stay paired after a restart', async () => {
    const { cookie } = await pairPhone()
    app = makeApp()
    await app.pairing.load()
    app.listeners.live = true
    expect((await call('GET', '/api/progress', phone(cookie))).status).toBe(200)
  })
})

describe('plain http from the network', () => {
  const HTTPS = `https://${MAC.toLowerCase()}:${APP_PORT}`

  it('serves the certificate page: why, the profile button, the three steps and the https link', async () => {
    const res = await call('GET', '/certificaat', plainPhone())
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.text).toContain('Certificaat installeren')
    expect(res.text).toContain(`href="${PROFILE_PATH}"`)
    expect(res.text).toContain('Profiel gedownload')
    expect(res.text).toContain('Instellingen &gt; Algemeen &gt; Info &gt; Instellingen voor certificaatvertrouwen')
    expect(res.text).toContain(`href="${HTTPS}/"`)
    expect(res.text).toContain(sharedTls.current!.caFingerprint)
    expect(res.text).not.toContain('<script')
    expect(res.text).not.toContain('<img')
    expect(res.text).not.toMatch(/\u2014/)
    expect((await call('HEAD', '/certificaat', plainPhone())).text).toBe('')
    expect((await call('POST', '/certificaat', { ...plainPhone(), body: {} })).status).toBe(405)
  })

  it('links to the address the phone used when the certificate holds it, else to the .local name', async () => {
    const byIp = await call('GET', '/certificaat', { ...plainPhone(), headers: { host: `${LAN_IP}:${APP_PORT}` } })
    expect(byIp.text).toContain(`href="https://${LAN_IP}:${APP_PORT}/"`)
    // The DHCP hostname passes the Host check but is not in the certificate.
    const dhcp = osHostname()
    if (!dhcp.toLowerCase().endsWith('.local') && dhcp.toLowerCase() !== MAC.toLowerCase()) {
      const byName = await call('GET', '/certificaat', { ...plainPhone(), headers: { host: `${dhcp}:${APP_PORT}` } })
      expect(byName.text).toContain(`href="https://${MAC}:${APP_PORT}/"`)
    }
  })

  it('shows an Android phone its own steps first, the iPhone steps one tap away', async () => {
    const res = await call('GET', '/certificaat', { ...plainPhone(), headers: { 'user-agent': ANDROID, host: `${LAN_IP}:${APP_PORT}` } })
    expect(res.status).toBe(200)
    expect(res.headers.vary).toBe('Cookie, User-Agent')
    expect(res.text.indexOf('<section data-phone="android">')).toBeGreaterThan(0)
    expect(res.text).toContain('<details data-phone="iphone">')
    expect(res.text).toContain(`href="${CA_CERT_PATH}" download="${CA_CERT_FILE_NAME}"`)
    expect(res.text).toContain('CA-certificaat')
    expect(res.text).toContain(`href="https://${LAN_IP}:${APP_PORT}/"`)
    const iphone = await call('GET', '/certificaat', plainPhone())
    expect(iphone.text).toContain('<section data-phone="iphone">')
    expect(iphone.text).toContain('<details data-phone="android">')
  })

  it('serves the profile and the CA certificate, never a key', async () => {
    const material = sharedTls.current!
    const profile = await call('GET', PROFILE_PATH, plainPhone())
    expect(profile.status).toBe(200)
    expect(profile.headers['content-type']).toBe('application/x-apple-aspen-config')
    expect(profile.text).toContain('<string>com.apple.security.root</string>')
    expect(profile.text).toContain('<string>nl.ashenfall.ashlog.ca</string>')
    expect(profile.text.replace(/\s+/g, '')).toContain(material.caDer.toString('base64'))

    const crt = await new Promise<{ status: number; type?: string; disposition?: string; body: Buffer }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: harnessPort, path: CA_CERT_PATH, headers: { host: LAN_HOST, 'x-test-remote': PHONE_IP }, agent: false },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], disposition: res.headers['content-disposition'], body: Buffer.concat(chunks) }),
          )
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(crt.status).toBe(200)
    // A plain download: Android keeps it in Downloads and installs it from Settings.
    expect(crt.type).toBe('application/octet-stream')
    expect(crt.disposition).toBe(`attachment; filename="${CA_CERT_FILE_NAME}"`)
    expect(crt.body.equals(material.caDer)).toBe(true)

    for (const path of ['/certificaat/ca.key', '/certificaat/server.key', '/certificaat/', '/certificaat/../tls/ca.key']) {
      const res = await call('GET', path, plainPhone())
      expect(res.text, path).not.toContain('PRIVATE KEY')
      expect(res.status, path).toBe(403)
    }
  })

  it('answers 503 on the certificate paths while there is no certificate', async () => {
    app = makeApp({ tls: new LocalTls({ dir: join(root, 'tls-unused') }) })
    app.listeners.live = true
    const page = await call('GET', '/certificaat', plainPhone())
    expect(page.status).toBe(503)
    expect(page.text).toContain('Het certificaat is er nog niet')
    expect((await call('GET', PROFILE_PATH, plainPhone())).status).toBe(503)
    expect((await call('GET', CA_CERT_PATH, plainPhone())).status).toBe(503)
  })

  it('gets the secure-connection page for everything else, with links and without a redirect', async () => {
    for (const path of ['/', '/quests', '/kaart?punt=a1']) {
      const res = await call('GET', path, plainPhone())
      expect(res.status, path).toBe(403)
      expect(res.headers.location).toBeUndefined()
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.text).toContain('Beveiligde verbinding')
      expect(res.text).toContain('href="/certificaat"')
      expect(res.text).toContain(`href="${HTTPS}${path}"`)
      expect(res.text).not.toContain('Logboek</title>')
      expect(res.text).not.toContain('<script')
    }
    // A protocol-relative path never turns into a link to another host.
    expect((await call('GET', '/.//evil.example/x', plainPhone())).text).toContain(`href="${HTTPS}/evil.example/x"`)
  })

  it('gives nothing of the app, the API or pairing, even with a valid cookie or device token', async () => {
    const { cookie, token } = await pairPhone()
    for (const path of ['/api/progress', '/api/server', '/api/health', '/api/data']) {
      const res = await call('GET', path, plainPhone(cookie))
      expect(res.status, path).toBe(403)
      expect(res.json.error, path).toContain('beveiligde verbinding')
    }
    expect((await call('PUT', '/api/progress', { ...plainPhone(cookie), body: { version: 1 } })).status).toBe(403)
    for (const path of ['/assets/index-abc123.js', '/wiki-img/icons/Gold_Ore.png', '/manifest.webmanifest', '/icons/icon-192.png']) {
      const res = await call('GET', path, plainPhone(cookie))
      expect(res.status, path).toBe(403)
      expect(res.text, path).toBe('')
    }

    // An old home-screen icon starts at /?device=<token>: no cookie, and the token is not echoed.
    const old = await call('GET', `/?device=${token}`, plainPhone())
    expect(old.status).toBe(403)
    expect(old.headers['set-cookie']).toBeUndefined()
    expect(old.text).not.toContain(token)
    expect(old.text).toContain(`href="${HTTPS}/"`)

    // An old QR code over http does not use up the code.
    const code = (await call('POST', '/api/server/pairing', { body: {} })).json.code
    const koppel = await call('GET', `/koppel?code=${code}`, plainPhone())
    expect(koppel.status).toBe(403)
    expect(koppel.headers['set-cookie']).toBeUndefined()
    expect((await call('GET', `/koppel?code=${code}`, phone())).status).toBe(302)
    expect((await call('POST', '/api/pair', { ...plainPhone(), body: { code } })).status).toBe(403)
  })

  it('is dropped while live mode is off, like https', async () => {
    app.listeners.live = false
    await expect(call('GET', '/certificaat', plainPhone())).rejects.toThrow(/socket hang up|ECONNRESET/)
  })

  it('still refuses a foreign Host header first', async () => {
    const res = await call('GET', '/certificaat', { ...plainPhone(), headers: { host: `evil.example:${APP_PORT}` } })
    expect(res.status).toBe(403)
    expect(res.text).toBe('Onbekende host')
  })
})

describe('certificate QR code', () => {
  it('gives this Mac the certificate url and its QR code while live', async () => {
    const res = await call('GET', '/api/server/certificate-qr')
    expect(res.status).toBe(200)
    expect(res.json.url).toBe(`http://${MAC}:${APP_PORT}/certificaat`)
    expect(res.json.qrSvg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect((await call('POST', '/api/server/certificate-qr', { body: {} })).status).toBe(405)
  })

  it('gives an iPhone the LAN address too with LIVE_ADDRESS=ip', async () => {
    app = makeApp({ liveAddress: 'ip' })
    app.listeners.live = true
    const status = (await call('GET', '/api/server')).json
    expect(status.urls).toEqual([`https://${LAN_IP}:${APP_PORT}`, `https://${MAC}:${APP_PORT}`])
    expect(status.certificateUrl).toBe(`http://${LAN_IP}:${APP_PORT}/certificaat`)
    expect((await call('GET', '/api/server/certificate-qr?phone=iphone')).json.url).toBe(`http://${LAN_IP}:${APP_PORT}/certificaat`)
    const code = await call('POST', '/api/server/pairing', { body: { phone: 'iphone' } })
    expect(code.json.url).toBe(`https://${LAN_IP}:${APP_PORT}/koppel?code=${code.json.code}`)
  })

  it('points an Android phone at the LAN address, an iPhone at the .local name', async () => {
    expect((await call('GET', '/api/server/certificate-qr?phone=iphone')).json.url).toBe(`http://${MAC}:${APP_PORT}/certificaat`)
    const android = await call('GET', '/api/server/certificate-qr?phone=android')
    expect(android.status).toBe(200)
    expect(android.json.url).toBe(`http://${LAN_IP}:${APP_PORT}/certificaat`)
    const bad = await call('GET', '/api/server/certificate-qr?phone=nokia')
    expect(bad.status).toBe(400)
    expect(bad.json.error).toBe('Verwacht phone: iphone of android')
  })

  it('needs live mode and this Mac', async () => {
    expect((await call('GET', '/api/server/certificate-qr', phone())).status).toBe(401)
    app.listeners.live = false
    const off = await call('GET', '/api/server/certificate-qr')
    expect(off.status).toBe(409)
    expect(off.json.error).toBe('Zet eerst Live op wifi aan')
  })
})

describe('management from this Mac', () => {
  it('checks the live body and keeps the write checks', async () => {
    expect((await call('POST', '/api/server/live', { body: { on: 'yes' } })).status).toBe(400)
    expect((await call('POST', '/api/server/live', { raw: '{"on":true}', headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await call('POST', '/api/server/live', { body: { on: true }, headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await call('GET', '/api/server/live')).status).toBe(405)
    expect((await call('POST', '/api/server/nope', { body: {} })).status).toBe(404)
  })

  it('stops after answering 202', async () => {
    const res = await call('POST', '/api/server/stop', { body: {} })
    expect(res.status).toBe(202)
    expect(res.json).toEqual({ ok: true })
    await vi.waitFor(() => expect(stopped).toBe(1))
  })
})

describe('on a Windows pc', () => {
  const PC = 'DESKTOP-7Q2LK3M'
  const winApp = (extra: Partial<AppOptions> = {}) => makeApp({ platform: 'win32', hostname: () => PC, ...extra })

  it('reports the platform and points every phone at the LAN address', async () => {
    app = winApp()
    app.listeners.live = true
    const status = (await call('GET', '/api/server')).json
    expect(status.platform).toBe('windows')
    // The address phones get comes first.
    expect(status.urls).toEqual([`https://${LAN_IP}:${APP_PORT}`, `https://${PC}.local:${APP_PORT}`])
    expect(status.certificateUrl).toBe(`http://${LAN_IP}:${APP_PORT}/certificaat`)
    for (const kind of ['iphone', 'android']) {
      expect((await call('GET', `/api/server/certificate-qr?phone=${kind}`)).json.url, kind).toBe(`http://${LAN_IP}:${APP_PORT}/certificaat`)
      const code = await call('POST', '/api/server/pairing', { body: { phone: kind } })
      expect(code.json.url, kind).toBe(`https://${LAN_IP}:${APP_PORT}/koppel?code=${code.json.code}`)
    }
  })

  it('gives every phone the .local name with LIVE_ADDRESS=name', async () => {
    app = winApp({ liveAddress: 'name' })
    app.listeners.live = true
    const status = (await call('GET', '/api/server')).json
    expect(status.urls[0]).toBe(`https://${PC}.local:${APP_PORT}`)
    expect((await call('GET', '/api/server/certificate-qr?phone=android')).json.url).toBe(`http://${PC}.local:${APP_PORT}/certificaat`)
  })

  it('falls back to the .local name without a LAN address', async () => {
    app = winApp({ lanAddresses: () => [] })
    app.listeners.live = true
    expect((await call('GET', '/api/server')).json.certificateUrl).toBe(`http://${PC}.local:${APP_PORT}/certificaat`)
  })

  it('says pc, not Mac, to phones', async () => {
    app = winApp()
    app.listeners.live = true
    const host = { host: `${LAN_IP}:${APP_PORT}` }
    const page = await call('GET', '/certificaat', { ...plainPhone(), headers: { 'user-agent': IPHONE, ...host } })
    expect(page.text).toContain('het certificaat van je pc vertrouwen')
    expect(page.text).not.toMatch(/\bMac\b/)
    const profile = await call('GET', PROFILE_PATH, { ...plainPhone(), headers: host })
    expect(profile.text).toContain('Ash Log op je pc.')
    const plain = await call('GET', '/', { ...plainPhone(), headers: host })
    expect(plain.text).toContain('QR-code op je pc')
    // Paired over the LAN address: the .local name of this test Mac is not one of the pc's names.
    const code = (await call('POST', '/api/server/pairing', { body: { phone: 'android' } })).json.code as string
    const cookie = `logboek_device=${tokenOf(await call('GET', `/koppel?code=${code}`, phone(undefined, host)))}`
    const manage = await call('POST', '/api/server/live', { ...phone(cookie, host), body: { on: false } })
    expect(manage.status).toBe(403)
    expect(manage.json.error).toBe('Dit kan alleen op de pc zelf')
  })

  it('logs pc and the LAN address when live goes on and off', async () => {
    const live = winApp({ port: 0, stayAwake: { start: vi.fn(), stop: vi.fn() } })
    try {
      await live.start()
      const port = live.listeners.port
      const host = { host: `localhost:${port}` }
      await call('POST', '/api/server/live', { port, headers: host, body: { on: true } })
      await vi.waitFor(() => expect(logs.some((l) => l.startsWith('Live op wifi'))).toBe(true))
      expect(logs.find((l) => l.startsWith('Live op wifi'))).toMatch(/\. Deze pc blijft wakker\.$/)
      expect(logs).toContain(`Certificaat voor je telefoon: http://${LAN_IP}:${port}/certificaat`)
      await call('POST', '/api/server/live', { port, headers: host, body: { on: false } })
      await vi.waitFor(() => expect(logs).toContain('Live uit: alleen deze pc kan erbij'))
    } finally {
      await live.close()
    }
  })

  it('says so when no certificate can be made, without naming an iPhone or a Mac', async () => {
    app = winApp({ tls: await failingTls('tls-failing-win') })
    await app.refreshTls()
    const line = logs.find((l) => l.startsWith('Certificaat maken mislukt'))!
    expect(line).toMatch(/Je telefoon kan er nu niet bij; op deze pc werkt alles gewoon\.$/)
  })
})

describe('live switch on real sockets', () => {
  let live: AppServer

  afterEach(async () => {
    await live?.close()
  })

  it('starts on loopback only, goes to every interface and back', async () => {
    const awake = { start: vi.fn(), stop: vi.fn() }
    live = makeApp({ port: 0, stayAwake: awake })
    await live.start()
    const port = live.listeners.port
    expect(port).toBeGreaterThan(0)
    expect(live.listeners.live).toBe(false)
    expect(live.listeners.addresses().sort()).toEqual([`127.0.0.1:${port}`, `[::1]:${port}`].sort())

    const host = { host: `localhost:${port}` }
    const on = await call('POST', '/api/server/live', { port, headers: host, body: { on: true } })
    expect(on.status).toBe(200)
    expect(on.json).toMatchObject({
      live: true,
      local: true,
      urls: [`https://${MAC}:${port}`, `https://${LAN_IP}:${port}`],
      certificateUrl: `http://${MAC}:${port}/certificaat`,
    })
    await vi.waitFor(() => expect(live.listeners.addresses().sort()).toEqual([`0.0.0.0:${port}`, `[::]:${port}`].sort()))
    expect(live.listeners.live).toBe(true)
    // The Mac stays awake while live, so the phone keeps reaching it.
    await vi.waitFor(() => expect(awake.start).toHaveBeenCalledTimes(1))
    expect(awake.stop).not.toHaveBeenCalled()
    expect((await call('GET', '/api/server', { port, headers: host })).json.live).toBe(true)
    expect((await call('GET', '/api/health', { port, address: '::1', headers: host })).status).toBe(200)

    const off = await call('POST', '/api/server/live', { port, headers: host, body: { on: false } })
    expect(off.json).toMatchObject({ live: false, urls: [] })
    await vi.waitFor(() => expect(live.listeners.addresses().sort()).toEqual([`127.0.0.1:${port}`, `[::1]:${port}`].sort()))
    await vi.waitFor(() => expect(awake.stop).toHaveBeenCalledTimes(1))
    expect((await call('GET', '/api/server', { port, headers: host })).json.live).toBe(false)
    expect(logs.some((l) => l.startsWith('Live op wifi'))).toBe(true)
    expect(logs).toContain('Live uit: alleen deze Mac kan erbij')
  })

  it('stays on loopback when the port is taken on the network', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen({ port: 0, host: '::', ipv6Only: true }, r))
    const port = (blocker.address() as AddressInfo).port
    try {
      const awake = { start: vi.fn(), stop: vi.fn() }
      live = makeApp({ port, hosts: { loopback: ['127.0.0.1'], live: ['::'] }, stayAwake: awake })
      await live.start()
      const host = { host: `localhost:${port}` }
      expect((await call('POST', '/api/server/live', { port, headers: host, body: { on: true } })).status).toBe(200)
      await vi.waitFor(() => expect(logs.some((l) => l.startsWith('Live zetten mislukt'))).toBe(true))
      expect(logs.find((l) => l.startsWith('Live zetten mislukt'))).toContain(`Poort ${port} is op het netwerk al in gebruik`)
      expect(live.listeners.live).toBe(false)
      expect(awake.start).not.toHaveBeenCalled()
      expect(live.listeners.addresses()).toEqual([`127.0.0.1:${port}`])
      expect((await call('GET', '/api/server', { port, headers: host })).json.live).toBe(false)
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })

  it('answers plain http and https on the same port', async () => {
    live = makeApp({ port: 0 })
    await live.start()
    const port = live.listeners.port
    const host = { host: `localhost:${port}` }
    // This Mac, as the Mac app uses it: plain http on loopback, exactly as before.
    const plain = await call('GET', '/api/health', { port, headers: host })
    expect(plain.status).toBe(200)
    expect(plain.json).toEqual({ ok: true, mode: 'app' })

    const ca = sharedTls.current!.caPem
    const secure = await callHttps(port, '/api/health', { ca, headers: host })
    expect(secure.status).toBe(200)
    expect(secure.json).toEqual({ ok: true, mode: 'app' })
    expect(secure.subjectAltName).toContain(`DNS:${MAC}`)
    expect(secure.subjectAltName).toContain('DNS:localhost')

    const index = await callHttps(port, '/', { ca, headers: host })
    expect(index.status).toBe(200)
    expect(index.headers['x-ash-log-app']).toBe('1')

    // Without the CA the certificate is not trusted: it really is TLS with Ash Log's own CA.
    await expect(callHttps(port, '/api/health', { headers: host })).rejects.toThrow(/certificate/i)
    // Keep-alive over both protocols.
    expect((await call('GET', '/api/server', { port, headers: host })).json.mode).toBe('app')
    expect((await callHttps(port, '/api/server', { ca, headers: host })).json.mode).toBe('app')
  })

  it('makes a new server certificate when live goes on with another address', async () => {
    let lanList = [LAN_IP]
    live = makeApp({ port: 0, lanAddresses: () => lanList, stayAwake: { start: vi.fn(), stop: vi.fn() } })
    await live.start()
    const port = live.listeners.port
    const host = { host: `localhost:${port}` }
    const ca = sharedTls.current!.caPem
    expect((await callHttps(port, '/api/health', { ca, headers: host })).subjectAltName).toContain(`IP Address:${LAN_IP}`)

    lanList = ['10.0.0.7']
    expect((await call('POST', '/api/server/live', { port, headers: host, body: { on: true } })).status).toBe(200)
    await vi.waitFor(() => expect(live.listeners.live).toBe(true))
    const after = await callHttps(port, '/api/health', { ca, headers: host })
    expect(after.subjectAltName).toContain('IP Address:10.0.0.7')
    expect(after.subjectAltName).not.toContain(LAN_IP)
    // Same CA: phones keep trusting it.
    expect(sharedTls.current!.caPem).toBe(ca)
    expect(sharedTls.current!.names.ips).toEqual(['127.0.0.1', '10.0.0.7'])
    await call('POST', '/api/server/live', { port, headers: host, body: { on: false } })
    await vi.waitFor(() => expect(live.listeners.live).toBe(false))
  })

  it('keeps working on this Mac when no certificate can be made', async () => {
    const broken = await failingTls('tls-broken')
    live = makeApp({ port: 0, tls: broken })
    await live.start()
    const port = live.listeners.port
    const host = { host: `localhost:${port}` }
    expect(logs.some((l) => l.startsWith('Certificaat maken mislukt'))).toBe(true)
    expect((await call('GET', '/api/health', { port, headers: host })).status).toBe(200)
    await expect(callHttps(port, '/api/health', { ca: sharedTls.current!.caPem, headers: host })).rejects.toThrow()
    expect((await call('GET', '/certificaat', { port, headers: host })).status).toBe(503)
  })

  it('refuses to start when the port is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen({ port: 0, host: '127.0.0.1' }, r))
    const port = (blocker.address() as AddressInfo).port
    try {
      live = makeApp({ port })
      await expect(live.start()).rejects.toThrow(`Poort ${port} is al in gebruik`)
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })

  it('closes: no more connections afterwards, and lets the Mac sleep again', async () => {
    const awake = { start: vi.fn(), stop: vi.fn() }
    live = makeApp({ port: 0, stayAwake: awake })
    await live.start()
    const port = live.listeners.port
    await live.close()
    expect(awake.stop).toHaveBeenCalled()
    expect(live.listeners.addresses()).toEqual([])
    await expect(call('GET', '/api/health', { port, headers: { host: `localhost:${port}` } })).rejects.toThrow(/ECONNREFUSED/)
  })
})
