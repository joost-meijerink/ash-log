// Vite dev-middleware. Reads /data/wiki, reads and writes /data/progress.json and
// /data/overrides.json, runs the sync script and serves the images the sync downloads.
// The app server (server/app.ts) serves the built app with the same handlers.
//
// progress.json and overrides.json are per user and not in git: a fresh clone has neither.
// Reading never creates them (empty progress and overrides, ETag "0"); the first save does.
//
//   GET  /api/data         wiki data + overrides merged (AppData), header X-Overrides-ETag
//   GET  /api/progress     progress.json, header ETag
//   PUT  /api/progress     overwrite progress.json (debounced by the app); If-Match -> 409 when stale
//   PUT  /api/overrides    overwrite overrides.json; 409 while the file on disk is invalid or If-Match is stale
//   POST /api/sync         start a sync ({ only?: SyncDomain[], full?: boolean }), 202 or 409
//   GET  /api/sync/status  running flag, log lines, report of the last run
//   GET  /wiki-img/*       icons and map tiles from /public/wiki-img
//   GET  /api/server       ServerStatus with mode 'dev' (live mode only exists in the app server)
//   GET  /manifest.webmanifest  web app manifest (start_url '/')
//
// Every non-GET /api request must be JSON (415 otherwise) and come from this app
// (403 for other sites), so a foreign page cannot start a sync or write data.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { emptyOverrides, normalizeOverrides, normalizeProgress } from '../src/lib/normalize.ts'
import { serverPlatform } from '../src/lib/platform.ts'
import type {
  AppData,
  AppQuest,
  DiffReport,
  MapData,
  Overrides,
  Progress,
  Quest,
  Reward,
  ServerStatus,
  SyncDomain,
  SyncMeta,
  SyncStatus,
  Vault,
} from '../src/lib/types.ts'
import { decodeText, jsonText, parseJson, readBytes, readJson, writeJsonAtomic } from '../scripts/sync/files.ts'
import { nodeTsCommand, type NodeCommand } from '../scripts/sync/node-command.ts'
import { OVERRIDES_FILE, PROGRESS_FILE, PUBLIC_IMG_DIR, ROOT, WIKI_FILES } from '../scripts/sync/paths.ts'
import { checkWriteRequest, HttpError, isRecord, readBody, resolveInside, send, sendEmpty, sendError, serveFile } from './http.ts'
import { handleManifest } from './manifest.ts'

const DOMAINS: SyncDomain[] = ['map', 'quests', 'vaults', 'rewards']
const MAX_LOG_LINES = 300

/* ------------------------------------------------------------------ */
/* Revisions and write locks                                           */
/* ------------------------------------------------------------------ */

/** Revision of a file: sha1 of its bytes, '0' when it does not exist. Sent quoted as ETag. */
export function etagOf(bytes: Buffer | string | null): string {
  return bytes === null ? '0' : createHash('sha1').update(bytes).digest('hex')
}

/** True when there is no If-Match header or it names the current revision. */
function ifMatchOk(header: string | string[] | undefined, etag: string): boolean {
  const value = (Array.isArray(header) ? header.join(',') : (header ?? '')).trim()
  if (!value) return true
  return value
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === `"${etag}"` || t === etag)
}

const locks = new Map<string, Promise<unknown>>()

/** Runs fn after every earlier fn with the same key, so writes land in the order they arrived. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => {})
  locks.set(key, tail)
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return next
}

/* ------------------------------------------------------------------ */
/* App data                                                            */
/* ------------------------------------------------------------------ */

interface OverridesFile {
  overrides: Overrides
  etag: string
  /** Set when overrides.json exists but cannot be parsed. */
  error?: string
}

async function readOverridesFile(): Promise<OverridesFile> {
  const bytes = await readBytes(OVERRIDES_FILE)
  const etag = etagOf(bytes)
  if (bytes === null) return { overrides: emptyOverrides(), etag }
  try {
    return { overrides: normalizeOverrides(parseJson(decodeText(bytes), OVERRIDES_FILE)), etag }
  } catch (err) {
    return { overrides: emptyOverrides(), etag, error: (err as Error).message }
  }
}

async function loadAppDataWithEtag(): Promise<{ data: AppData; overridesEtag: string }> {
  const [map, quests, vaults, rewards, meta, report, file] = await Promise.all([
    readJson<MapData | null>(WIKI_FILES.map, null),
    readJson<Quest[] | null>(WIKI_FILES.quests, null),
    readJson<Vault[] | null>(WIKI_FILES.vaults, null),
    readJson<Reward[] | null>(WIKI_FILES.rewards, null),
    readJson<SyncMeta | null>(WIKI_FILES.meta, null),
    readJson<DiffReport | null>(WIKI_FILES.report, null),
    readOverridesFile(),
  ])
  // A typo in the hand-edited overrides.json must not take the app down: serve empty
  // overrides and flag it. PUT /api/overrides refuses to write until the file is fixed.
  const data = mergeAppData({ map, quests, vaults, rewards, meta, report, overrides: file.overrides })
  return { data: file.error ? { ...data, overridesError: file.error } : data, overridesEtag: file.etag }
}

export async function loadAppData(): Promise<AppData> {
  return (await loadAppDataWithEtag()).data
}

/** Pure merge of the wiki layer with the overrides layer. */
export function mergeAppData(input: {
  map: MapData | null
  quests: Quest[] | null
  vaults: Vault[] | null
  rewards: Reward[] | null
  meta: SyncMeta | null
  report: DiffReport | null
  overrides: Overrides
}): AppData {
  const { overrides } = input
  const map: MapData = input.map ?? { categories: [], points: [] }
  const categories = map.categories.map((c) =>
    overrides.categoryGroup[c.id] ? { ...c, group: overrides.categoryGroup[c.id] } : c,
  )
  const pointById = new Map(map.points.map((p) => [p.id, p]))

  const quests: AppQuest[] = (input.quests ?? []).map((q) => {
    const manual = overrides.questStart[q.id]
    const point = q.startPointId ? pointById.get(q.startPointId) : undefined
    const start = manual
      ? { x: manual.x, y: manual.y, source: 'override' as const }
      : point
        ? { x: point.x, y: point.y, pointId: point.id, source: 'wiki' as const }
        : undefined
    const itemsOverride = overrides.questItems[q.id]
    return {
      ...q,
      ...(start ? { start } : {}),
      items: itemsOverride ?? q.items,
      itemsOverridden: !!itemsOverride,
    }
  })

  return {
    ready: !!input.map && !!input.meta,
    ...(input.meta ? { meta: input.meta } : {}),
    map: { categories, points: map.points },
    quests,
    vaults: input.vaults ?? [],
    rewards: input.rewards ?? [],
    overrides,
    ...(input.report ? { lastReport: input.report } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Progress and overrides writes                                       */
/* ------------------------------------------------------------------ */

async function readProgress(): Promise<{ progress: Progress; etag: string }> {
  const bytes = await readBytes(PROGRESS_FILE)
  const raw = bytes === null ? {} : parseJson<unknown>(decodeText(bytes), PROGRESS_FILE)
  return { progress: normalizeProgress(raw), etag: etagOf(bytes) }
}

async function putProgress(req: IncomingMessage, body: unknown) {
  if (!isRecord(body) || body.version !== 1) throw new HttpError(400, 'Invalid progress: expected an object with version 1')
  const progress = normalizeProgress(body)
  return withLock(PROGRESS_FILE, async () => {
    // Also refuses to overwrite a progress.json that is not valid JSON (the parse error names the file).
    const current = await readProgress()
    if (!ifMatchOk(req.headers['if-match'], current.etag)) {
      throw new HttpError(409, 'Progress was changed elsewhere', { progress: current.progress }, { ETag: `"${current.etag}"` })
    }
    await writeJsonAtomic(PROGRESS_FILE, progress)
    return { progress, etag: etagOf(jsonText(progress)) }
  })
}

async function putOverrides(req: IncomingMessage, body: unknown) {
  if (!isRecord(body)) throw new HttpError(400, 'Invalid overrides: expected an object')
  const overrides = normalizeOverrides(body)
  return withLock(OVERRIDES_FILE, async () => {
    const current = await readOverridesFile()
    // Never replace a hand-edited file that has a typo: the user would lose every override in it.
    if (current.error) throw new HttpError(409, 'overrides.json is invalid, fix the file first', { detail: current.error })
    if (!ifMatchOk(req.headers['if-match'], current.etag)) {
      throw new HttpError(409, 'Overrides were changed elsewhere', { overrides: current.overrides }, { ETag: `"${current.etag}"` })
    }
    await writeJsonAtomic(OVERRIDES_FILE, overrides)
    return { overrides, etag: etagOf(jsonText(overrides)) }
  })
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

const status: SyncStatus = { running: false, log: [] }
/** The running sync process, so the app server can stop it when it shuts down. */
let syncChild: ReturnType<typeof spawn> | null = null

function pushLog(line: string) {
  if (!line.trim()) return
  status.log.push(line)
  if (status.log.length > MAX_LOG_LINES) status.log.splice(0, status.log.length - MAX_LOG_LINES)
}

function failedReport(only: SyncDomain[], error: string): DiffReport {
  return {
    syncedAt: new Date().toISOString(),
    ok: false,
    error,
    domains: only.length ? only : DOMAINS,
    orphans: { quests: [], steps: [], items: [], points: [], vaults: [], rewards: [] },
    warnings: [],
  }
}

/**
 * The sync as one Node process: this Node with tsx's loader, no shell and no .bin shim (on
 * Windows that shim is tsx.cmd, which spawn cannot run). See scripts/sync/node-command.ts.
 */
export function syncCommand(only: readonly SyncDomain[], full: boolean, opts: { execPath?: string; loaderUrl?: string; root?: string } = {}): NodeCommand {
  const args: string[] = []
  if (only.length) args.push(`--only=${only.join(',')}`)
  if (full) args.push('--full')
  return nodeTsCommand(join(opts.root ?? ROOT, 'scripts', 'sync', 'index.ts'), args, opts)
}

function startSync(only: SyncDomain[], full: boolean): boolean {
  if (status.running) return false
  status.running = true
  status.startedAt = new Date().toISOString()
  status.log = []
  delete status.report

  let buffer = ''
  const finish = async (code: number | null, error?: Error) => {
    if (buffer) pushLog(buffer)
    buffer = ''
    const report = await readJson<DiffReport | null>(WIKI_FILES.report, null).catch(() => null)
    const fresh = report && status.startedAt && report.syncedAt >= status.startedAt.slice(0, 19)
    status.report = fresh && report ? report : failedReport(only, error?.message ?? `Sync stopped with code ${code}`)
    status.running = false
  }

  try {
    const { command, args } = syncCommand(only, full)
    // windowsHide: no console window pops up when the server runs without one (the launcher).
    const child = spawn(command, args, { cwd: ROOT, env: process.env, windowsHide: true })
    syncChild = child
    // One decoder per stream: a character such as an é may arrive split over two chunks.
    const reader = () => {
      const decoder = new StringDecoder('utf8')
      return (chunk: Buffer) => {
        buffer += decoder.write(chunk)
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        lines.forEach(pushLog)
      }
    }
    child.stdout?.on('data', reader())
    child.stderr?.on('data', reader())
    // A failed spawn emits 'error' and then 'close'; finish once, on 'close', with the real cause.
    // An 'error' can also come from a failed kill while the child still runs, so never finish on it.
    let spawnError: Error | undefined
    child.on('error', (err) => {
      spawnError = err
    })
    child.on('close', (code) => {
      if (syncChild === child) syncChild = null
      void finish(code, spawnError)
    })
  } catch (err) {
    const message = `Couldn't start the sync: ${(err as Error).message}`
    status.report = failedReport(only, message)
    status.running = false
    throw new HttpError(500, message)
  }
  return true
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return false
  const route = `${req.method} ${url.pathname}`
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') checkWriteRequest(req)
    switch (route) {
      case 'GET /api/data': {
        const { data, overridesEtag } = await loadAppDataWithEtag()
        send(res, 200, data, { 'X-Overrides-ETag': `"${overridesEtag}"` })
        return true
      }
      case 'GET /api/progress': {
        const { progress, etag } = await readProgress()
        send(res, 200, progress, { ETag: `"${etag}"` })
        return true
      }
      case 'PUT /api/progress': {
        const { progress, etag } = await putProgress(req, await readBody(req))
        send(res, 200, progress, { ETag: `"${etag}"` })
        return true
      }
      case 'PUT /api/overrides': {
        const { overrides, etag } = await putOverrides(req, await readBody(req))
        send(res, 200, overrides, { ETag: `"${etag}"` })
        return true
      }
      case 'POST /api/sync': {
        const raw = await readBody(req)
        const body: { only?: unknown; full?: unknown } = isRecord(raw) ? raw : {}
        const only = Array.isArray(body.only) ? body.only.filter((d): d is SyncDomain => DOMAINS.includes(d)) : []
        if (!startSync(only, body.full === true)) {
          send(res, 409, { error: 'A sync is already running' })
          return true
        }
        send(res, 202, status)
        return true
      }
      case 'GET /api/sync/status':
        send(res, 200, status)
        return true
    }
    send(res, 404, { error: `Unknown endpoint: ${route}` })
    return true
  } catch (err) {
    sendError(res, err)
    return true
  }
}

/**
 * Resolves once no progress or overrides write is queued and no sync runs, or after
 * `timeoutMs`. Returns false on a timeout. The app server waits for this before it exits.
 */
export async function whenIdle(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (locks.size > 0 || status.running) {
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

/** True while a sync runs (the app server mentions it when it shuts down). */
export const syncRunning = (): boolean => status.running

/**
 * Asks a running sync to stop (SIGTERM; on Windows that ends the process at once), for a
 * server that shuts down: better than leaving it behind without anyone reading its output.
 * Its files are written atomically, so stopping it halfway leaves the old data in place.
 */
export function stopSync(): void {
  syncChild?.kill('SIGTERM')
}

/* ------------------------------------------------------------------ */
/* Server status under the dev server                                 */
/* ------------------------------------------------------------------ */

/**
 * GET /api/server under `npm run dev`: no live mode there, so the app hides those controls.
 * The management endpoints only exist in the app server (server/app.ts) and answer 409 here.
 */
export async function handleDevServerApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname === '/api/health' && req.method === 'GET') {
    send(res, 200, { ok: true, mode: 'dev' })
    return true
  }
  if (pathname !== '/api/server' && !pathname.startsWith('/api/server/')) return false
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') checkWriteRequest(req)
    if (pathname === '/api/server' && (req.method === 'GET' || req.method === 'HEAD')) {
      const serverStatus: ServerStatus = { mode: 'dev', platform: serverPlatform(process.platform), local: true, live: false, port: req.socket.localPort ?? 0, urls: [] }
      send(res, 200, serverStatus)
      return true
    }
    if (req.method === 'POST') {
      send(res, 409, { error: 'Only works in the app: start Ash Log from its app icon' })
      return true
    }
    send(res, 404, { error: `Unknown endpoint: ${req.method} ${pathname}` })
    return true
  } catch (err) {
    sendError(res, err)
    return true
  }
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

const WIKI_IMG_PREFIX = '/wiki-img/'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

/**
 * GET /wiki-img/* straight from disk. Vite only serves public files it saw at startup,
 * so icons and tiles that a sync downloads while the dev server runs would otherwise
 * get the SPA page until a restart. A missing file is a plain 404, never index.html.
 * The app server uses the same handler, so it never needs a copy of the images in dist.
 */
export async function handleWikiImage(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (!pathname.startsWith(WIKI_IMG_PREFIX)) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendEmpty(res, 405, { Allow: 'GET, HEAD' })
    return true
  }
  const resolved = resolveInside(PUBLIC_IMG_DIR, pathname, WIKI_IMG_PREFIX)
  if (!resolved.ok) {
    sendEmpty(res, resolved.status)
    return true
  }
  if (!(await serveFile(req, res, resolved.file, { cacheControl: 'no-cache', types: IMAGE_TYPES }))) sendEmpty(res, 404)
  return true
}

export function dataMiddleware(): Plugin {
  return {
    name: 'ashenfall-data-middleware',
    configureServer(server) {
      // Added directly (not returned), so this runs before Vite's own public-file and SPA handlers.
      server.middlewares.use((req, res, next) => {
        const handle = async () =>
          (await handleWikiImage(req, res)) ||
          (await handleManifest(req, res, { startUrl: '/' })) ||
          (await handleDevServerApi(req, res)) ||
          (await handleApi(req, res))
        handle().then((handled) => {
          if (!handled) next()
        }, next)
      })
    },
  }
}
