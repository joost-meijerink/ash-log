// handleApi and handleWikiImage behind a real HTTP server, with every data path
// redirected to a temp dir and spawn mocked. Never touches /data or the wiki.

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as paths from '../scripts/sync/paths.ts'
import { handleApi, handleWikiImage, stopSync, syncRunning, whenIdle } from './middleware.ts'

vi.mock('../scripts/sync/paths.ts', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'ashenfall-api-'))
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

const spawnMock = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock.fn(...args) }))

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
  json: any
}

let server: Server
let port: number

function call(method: string, path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const headers: Record<string, string> = {
    ...(body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {}),
    ...opts.headers,
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const sha1 = (text: string | Buffer) => createHash('sha1').update(text).digest('hex')
const progressBody = (steps: string[] = []) => ({ version: 1, quests: { Ratcatcher: { steps, items: [] } }, points: {}, vaults: {}, rewards: {} })

beforeAll(async () => {
  server = createServer((req, res) => {
    const handle = async () => (await handleWikiImage(req, res)) || (await handleApi(req, res))
    handle().then(
      (handled) => {
        if (!handled) {
          // Stands in for Vite's SPA fallback.
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html')
          res.end('<!doctype html>')
        }
      },
      (err: Error) => {
        res.statusCode = 599
        res.end(err.message)
      },
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(paths.ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(paths.DATA_DIR, { recursive: true, force: true })
  await rm(paths.PUBLIC_IMG_DIR, { recursive: true, force: true })
  await mkdir(paths.DATA_DIR, { recursive: true })
  spawnMock.fn.mockReset()
})

describe('a fresh clone: no progress.json or overrides.json (per user, not in git)', () => {
  const exists = (path: string) => stat(path).then(() => true, () => false)

  it('shows the first-run screen without wiki data and creates nothing by reading', async () => {
    await rm(paths.DATA_DIR, { recursive: true, force: true })
    const data = await call('GET', '/api/data')
    expect(data.status).toBe(200)
    expect(data.json.ready).toBe(false)
    expect(data.json.overrides).toEqual({ questStart: {}, questItems: {}, categoryGroup: {} })
    expect(data.json.overridesError).toBeUndefined()
    expect(data.headers['x-overrides-etag']).toBe('"0"')
    const progress = await call('GET', '/api/progress')
    expect(progress.status).toBe(200)
    expect(progress.headers.etag).toBe('"0"')
    expect(await exists(paths.DATA_DIR)).toBe(false)
  })

  it('serves the committed wiki data with empty progress and overrides', async () => {
    await mkdir(paths.WIKI_DIR, { recursive: true })
    await writeFile(paths.WIKI_FILES.map, JSON.stringify({ categories: [], points: [] }))
    await writeFile(paths.WIKI_FILES.meta, JSON.stringify({ syncedAt: '2026-09-28T12:00:00.000Z', durationMs: 1, domains: [], counts: {}, revisions: {} }))
    const data = await call('GET', '/api/data')
    expect(data.json.ready).toBe(true)
    expect(data.json.overrides).toEqual({ questStart: {}, questItems: {}, categoryGroup: {} })
    expect((await call('GET', '/api/progress')).json).toEqual({ version: 1, quests: {}, points: {}, vaults: {}, rewards: {} })
    expect(await exists(paths.PROGRESS_FILE)).toBe(false)
    expect(await exists(paths.OVERRIDES_FILE)).toBe(false)
  })

  it('reads progress.json and overrides.json saved by a Windows editor (BOM, CRLF)', async () => {
    await mkdir(paths.DATA_DIR, { recursive: true })
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    await writeFile(paths.PROGRESS_FILE, Buffer.concat([bom, Buffer.from('{\r\n  "version": 1,\r\n  "quests": { "Ratcatcher": { "steps": ["Ratcatcher:s:aaaa"] } }\r\n}\r\n')]))
    await writeFile(paths.OVERRIDES_FILE, Buffer.concat([bom, Buffer.from('{\r\n  "questStart": { "Ratcatcher": { "x": 1, "y": 2 } }\r\n}\r\n')]))
    const progress = await call('GET', '/api/progress')
    expect(progress.status).toBe(200)
    expect(progress.json.quests.Ratcatcher.steps).toEqual(['Ratcatcher:s:aaaa'])
    const data = await call('GET', '/api/data')
    expect(data.json.overridesError).toBeUndefined()
    expect(data.json.overrides.questStart).toEqual({ Ratcatcher: { x: 1, y: 2 } })
  })

  it('creates the files (and the data folder) on the first save', async () => {
    await rm(paths.DATA_DIR, { recursive: true, force: true })
    const progress = await call('PUT', '/api/progress', { body: progressBody(['Ratcatcher:s:aaaa']), headers: { 'if-match': '"0"' } })
    expect(progress.status).toBe(200)
    expect(JSON.parse(await readFile(paths.PROGRESS_FILE, 'utf8')).quests.Ratcatcher.steps).toEqual(['Ratcatcher:s:aaaa'])
    const overrides = await call('PUT', '/api/overrides', {
      body: { questStart: { Ratcatcher: { x: 1, y: 2 } }, questItems: {}, categoryGroup: {} },
      headers: { 'if-match': '"0"' },
    })
    expect(overrides.status).toBe(200)
    expect(JSON.parse(await readFile(paths.OVERRIDES_FILE, 'utf8')).questStart).toEqual({ Ratcatcher: { x: 1, y: 2 } })
  })
})

describe('progress: ETag and If-Match', () => {
  it('sends ETag "0" while progress.json does not exist', async () => {
    const res = await call('GET', '/api/progress')
    expect(res.status).toBe(200)
    expect(res.headers.etag).toBe('"0"')
    expect(res.json).toEqual({ version: 1, quests: {}, points: {}, vaults: {}, rewards: {} })
  })

  it('answers a PUT with the sha1 of the bytes on disk, and GET agrees', async () => {
    const put = await call('PUT', '/api/progress', { body: progressBody(['Ratcatcher:s:aaaa']), headers: { 'if-match': '"0"' } })
    expect(put.status).toBe(200)
    const onDisk = await readFile(paths.PROGRESS_FILE)
    expect(put.headers.etag).toBe(`"${sha1(onDisk)}"`)
    const get = await call('GET', '/api/progress')
    expect(get.headers.etag).toBe(put.headers.etag)
    expect(get.json.quests.Ratcatcher.steps).toEqual(['Ratcatcher:s:aaaa'])
  })

  it('refuses a stale If-Match with 409, the current progress and the current ETag', async () => {
    const first = await call('PUT', '/api/progress', { body: progressBody(['Ratcatcher:s:aaaa']), headers: { 'if-match': '"0"' } })
    // A second tab that still holds the revision from before the first save.
    const stale = await call('PUT', '/api/progress', {
      body: { ...progressBody(), rewards: { 'plan:torch': { at: 'x' } } },
      headers: { 'if-match': '"0"' },
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error).toBe('Progress was changed elsewhere')
    expect(stale.json.progress.quests.Ratcatcher.steps).toEqual(['Ratcatcher:s:aaaa'])
    expect(stale.headers.etag).toBe(first.headers.etag)
    const get = await call('GET', '/api/progress')
    expect(get.json.quests.Ratcatcher.steps).toEqual(['Ratcatcher:s:aaaa'])
    expect(get.json.rewards).toEqual({})
  })

  it('accepts a matching If-Match and a PUT without one', async () => {
    const first = await call('PUT', '/api/progress', { body: progressBody(['a']) })
    const second = await call('PUT', '/api/progress', { body: progressBody(['b']), headers: { 'if-match': String(first.headers.etag) } })
    expect(second.status).toBe(200)
    const third = await call('PUT', '/api/progress', { body: progressBody(['c']) })
    expect(third.status).toBe(200)
    expect((await call('GET', '/api/progress')).json.quests.Ratcatcher.steps).toEqual(['c'])
  })

  it('refuses bodies that are not progress with 400 and keeps the file', async () => {
    await call('PUT', '/api/progress', { body: progressBody(['a']) })
    for (const raw of ['', '{}', '[]', '{"version":2}', '"x"']) {
      const res = await call('PUT', '/api/progress', { raw })
      expect(res.status, raw).toBe(400)
    }
    expect((await call('GET', '/api/progress')).json.quests.Ratcatcher.steps).toEqual(['a'])
  })

  it('never corrupts progress.json with concurrent saves', async () => {
    const long = progressBody(Array.from({ length: 80 }, (_, i) => `Ratcatcher:s:${i}`))
    const short = progressBody(['x'])
    for (let round = 0; round < 20; round++) {
      const [a, b] = await Promise.all([call('PUT', '/api/progress', { body: long }), call('PUT', '/api/progress', { body: short })])
      expect([a.status, b.status]).toEqual([200, 200])
      const get = await call('GET', '/api/progress')
      expect(get.status).toBe(200)
      expect([1, 80]).toContain(get.json.quests.Ratcatcher.steps.length)
    }
  })

  it('names progress.json when it is invalid and never overwrites it', async () => {
    await writeFile(paths.PROGRESS_FILE, '{ "version": 1, }')
    const get = await call('GET', '/api/progress')
    expect(get.status).toBe(500)
    expect(get.json.error).toMatch(/^progress\.json is not valid JSON/)
    const put = await call('PUT', '/api/progress', { body: progressBody(['a']) })
    expect(put.status).toBe(500)
    expect(await readFile(paths.PROGRESS_FILE, 'utf8')).toBe('{ "version": 1, }')
  })
})

describe('overrides', () => {
  const pin = { questStart: { Ratcatcher: { x: 1, y: 2 } }, questItems: {}, categoryGroup: {} }

  it('serves the app with empty overrides and a flag when overrides.json is invalid', async () => {
    await writeFile(paths.OVERRIDES_FILE, '{ "questStart": { "Ratcatcher": { "x": 1, "y": 2 }, } }')
    const res = await call('GET', '/api/data')
    expect(res.status).toBe(200)
    expect(res.json.overrides).toEqual({ questStart: {}, questItems: {}, categoryGroup: {} })
    expect(res.json.overridesError).toMatch(/^overrides\.json is not valid JSON/)
  })

  it('refuses to write while overrides.json is invalid, so the hand edits survive', async () => {
    const broken = '{ "questStart": { "Ratcatcher": { "x": 1, "y": 2 }, } }'
    await writeFile(paths.OVERRIDES_FILE, broken)
    const res = await call('PUT', '/api/overrides', { body: pin })
    expect(res.status).toBe(409)
    expect(res.json.error).toBe('overrides.json is invalid, fix the file first')
    expect(await readFile(paths.OVERRIDES_FILE, 'utf8')).toBe(broken)
  })

  it('writes valid overrides, sends their ETag and honours If-Match', async () => {
    const put = await call('PUT', '/api/overrides', { body: pin })
    expect(put.status).toBe(200)
    expect(put.headers.etag).toBe(`"${sha1(await readFile(paths.OVERRIDES_FILE))}"`)
    const data = await call('GET', '/api/data')
    expect(data.headers['x-overrides-etag']).toBe(put.headers.etag)
    expect(data.json.overridesError).toBeUndefined()
    expect(data.json.overrides.questStart).toEqual({ Ratcatcher: { x: 1, y: 2 } })

    const stale = await call('PUT', '/api/overrides', { body: { ...pin, questStart: {} }, headers: { 'if-match': '"0"' } })
    expect(stale.status).toBe(409)
    expect(stale.json.overrides.questStart).toEqual({ Ratcatcher: { x: 1, y: 2 } })
    expect(stale.headers.etag).toBe(put.headers.etag)
  })

  it('refuses an empty body', async () => {
    await call('PUT', '/api/overrides', { body: pin })
    expect((await call('PUT', '/api/overrides', { raw: '' })).status).toBe(400)
    expect((await call('GET', '/api/data')).json.overrides.questStart).toEqual({ Ratcatcher: { x: 1, y: 2 } })
  })
})

describe('write requests from elsewhere', () => {
  it('refuses a non-JSON content type with 415 (a simple cross-origin POST)', async () => {
    const res = await call('POST', '/api/sync', { raw: '{"full":true}', headers: { 'content-type': 'text/plain;charset=UTF-8' } })
    expect(res.status).toBe(415)
    expect(spawnMock.fn).not.toHaveBeenCalled()
  })

  it('refuses Sec-Fetch-Site cross-site with 403', async () => {
    const res = await call('POST', '/api/sync', { body: {}, headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(403)
    expect(spawnMock.fn).not.toHaveBeenCalled()
  })

  it('refuses a foreign Origin with 403', async () => {
    const res = await call('PUT', '/api/progress', { body: progressBody(), headers: { origin: 'http://localhost:3000' } })
    expect(res.status).toBe(403)
    const nullOrigin = await call('PUT', '/api/progress', { body: progressBody(), headers: { origin: 'null' } })
    expect(nullOrigin.status).toBe(403)
  })

  it('accepts the app itself: JSON, same origin', async () => {
    const res = await call('PUT', '/api/progress', {
      body: progressBody(),
      headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(200)
  })

  it('leaves GET requests alone', async () => {
    expect((await call('GET', '/api/sync/status')).status).toBe(200)
  })
})

describe('sync start', () => {
  /** tsx's loader as a file URL, never a .bin shim (tsx.cmd on Windows) or a shell. */
  const TSX_LOADER = expect.stringMatching(/^file:\/\/\/.*\/node_modules\/tsx\/dist\/loader\.mjs$/)

  function fakeChild() {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
    return child
  }

  async function settled() {
    for (let i = 0; i < 100; i++) {
      const status = await call('GET', '/api/sync/status')
      if (!status.json.running) return status.json
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('sync kept running')
  }

  it('resets the running flag when spawn throws', async () => {
    spawnMock.fn.mockImplementation(() => {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
    })
    const res = await call('POST', '/api/sync', { body: {} })
    expect(res.status).toBe(500)
    expect(res.json.error).toBe("Couldn't start the sync: spawn EINVAL")
    const status = (await call('GET', '/api/sync/status')).json
    expect(status.running).toBe(false)
    expect(status.report).toMatchObject({ ok: false, error: "Couldn't start the sync: spawn EINVAL" })

    const child = fakeChild()
    spawnMock.fn.mockImplementation(() => child)
    expect((await call('POST', '/api/sync', { body: {} })).status).toBe(202)
    child.emit('close', 0)
    await settled()
  })

  it('keeps the real cause when a failed spawn emits error and then close', async () => {
    const child = fakeChild()
    spawnMock.fn.mockImplementation(() => child)
    expect((await call('POST', '/api/sync', { body: { only: ['map'] } })).status).toBe(202)
    expect(spawnMock.fn.mock.calls[0]![1]).toEqual(['--import', TSX_LOADER, join(paths.ROOT, 'scripts', 'sync', 'index.ts'), '--only=map'])
    child.emit('error', Object.assign(new Error('spawn /x/tsx ENOENT'), { code: 'ENOENT' }))
    // Not finished on 'error' alone.
    expect((await call('GET', '/api/sync/status')).json.running).toBe(true)
    child.emit('close', -2)
    const status = await settled()
    expect(status.report).toMatchObject({ ok: false, error: 'spawn /x/tsx ENOENT', domains: ['map'] })
  })

  it('can be stopped when the app server shuts down, and whenIdle waits for it', async () => {
    const child = Object.assign(fakeChild(), { kill: vi.fn() })
    spawnMock.fn.mockImplementation(() => child)
    expect((await call('POST', '/api/sync', { body: {} })).status).toBe(202)
    expect(syncRunning()).toBe(true)
    expect(await whenIdle(30)).toBe(false)
    stopSync()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null)
    expect(await whenIdle(1000)).toBe(true)
    expect(syncRunning()).toBe(false)
    // Nothing to stop any more.
    stopSync()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('runs the sync with this Node, in the project folder, without a shell or a console window', async () => {
    const child = fakeChild()
    spawnMock.fn.mockImplementation(() => child)
    expect((await call('POST', '/api/sync', { body: { full: true } })).status).toBe(202)
    const [command, args, options] = spawnMock.fn.mock.calls[0]! as [string, string[], Record<string, unknown>]
    expect(command).toBe(process.execPath)
    expect(args.at(-1)).toBe('--full')
    expect(options).toMatchObject({ cwd: paths.ROOT, windowsHide: true })
    expect(options.shell).toBeUndefined()
    child.emit('close', 0)
    await settled()
  })

  it('reads log lines with Windows line endings too', async () => {
    const child = fakeChild()
    spawnMock.fn.mockImplementation(() => child)
    expect((await call('POST', '/api/sync', { body: {} })).status).toBe(202)
    child.stdout.emit('data', Buffer.from('Map: fetching\r\nQuests: 12 quests\r\nhalf'))
    child.stderr.emit('data', Buffer.from(' line\r\n'))
    // A two-byte character split over two chunks.
    const word = Buffer.from('Map: 75 categories, café\r\n')
    const cut = word.indexOf(0xc3) + 1
    child.stdout.emit('data', word.subarray(0, cut))
    child.stdout.emit('data', word.subarray(cut))
    expect((await call('GET', '/api/sync/status')).json.log).toEqual(['Map: fetching', 'Quests: 12 quests', 'half line', 'Map: 75 categories, café'])
    child.emit('close', 0)
    await settled()
  })

  it('accepts an empty body as a full sync', async () => {
    const child = fakeChild()
    spawnMock.fn.mockImplementation(() => child)
    expect((await call('POST', '/api/sync', { raw: '' })).status).toBe(202)
    expect(spawnMock.fn.mock.calls[0]![1]).toEqual(['--import', TSX_LOADER, join(paths.ROOT, 'scripts', 'sync', 'index.ts')])
    child.emit('close', 1)
    const status = await settled()
    expect(status.report).toMatchObject({ ok: false, error: 'Sync stopped with code 1' })
  })
})

describe('/wiki-img', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it('serves a file that appeared after the server started', async () => {
    await mkdir(paths.ICONS_DIR, { recursive: true })
    await writeFile(join(paths.ICONS_DIR, 'Bittercap_Mushroom_(Map_Icon).png'), png)
    await mkdir(join(paths.TILES_DIR, '0'), { recursive: true })
    await writeFile(join(paths.TILES_DIR, '0', '0_0.png'), png)

    const icon = await call('GET', `/wiki-img/icons/${encodeURIComponent('Bittercap_Mushroom_(Map_Icon).png')}`)
    expect(icon.status).toBe(200)
    expect(icon.headers['content-type']).toBe('image/png')
    expect(icon.headers['content-length']).toBe(String(png.length))
    expect(icon.headers['cache-control']).toBe('no-cache')
    const tile = await call('GET', '/wiki-img/tiles/0/0_0.png')
    expect(tile.status).toBe(200)
    expect(tile.headers['content-type']).toBe('image/png')
  })

  it('answers a missing image with a bare 404, never the SPA page', async () => {
    const res = await call('GET', '/wiki-img/icons/Nope.png')
    expect(res.status).toBe(404)
    expect(res.text).toBe('')
  })

  it('refuses to leave the image folder', async () => {
    await mkdir(paths.PUBLIC_IMG_DIR, { recursive: true })
    await writeFile(join(paths.DATA_DIR, 'progress.json'), '{}')
    for (const path of ['/wiki-img/..%2F..%2Fdata%2Fprogress.json', '/wiki-img/icons/..%2F..%2F..%2Fdata%2Fprogress.json', '/wiki-img/%2e%2e%2f%2e%2e%2fdata/progress.json']) {
      const res = await call('GET', path)
      expect(res.status, path).toBe(403)
      expect(res.text).toBe('')
    }
    expect((await call('GET', '/wiki-img/icons/%E0%A4%A.png')).status).toBe(400)
    expect((await call('GET', '/wiki-img/icons/a%00.png')).status).toBe(400)
  })

  it('supports HEAD and If-Modified-Since', async () => {
    await mkdir(paths.ICONS_DIR, { recursive: true })
    await writeFile(join(paths.ICONS_DIR, 'Gold_Ore.png'), png)
    const head = await call('HEAD', '/wiki-img/icons/Gold_Ore.png')
    expect(head.status).toBe(200)
    expect(head.text).toBe('')
    const again = await call('GET', '/wiki-img/icons/Gold_Ore.png', { headers: { 'if-modified-since': String(head.headers['last-modified']) } })
    expect(again.status).toBe(304)
  })

  it('leaves other paths to the next handler', async () => {
    const res = await call('GET', '/quests')
    expect(res.text).toBe('<!doctype html>')
  })
})
