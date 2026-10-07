// Vite dev-middleware. Reads /data/wiki, reads and writes /data/progress.json and
// /data/overrides.json, runs the sync script and serves the images the sync downloads.
// The app server (server/app.ts) serves the built app with the same handlers.
//
// Every file location comes from server/paths.ts: the project layout for npm run dev and
// npm run app, or the installed app's layout (createDataApi({ paths })), where the wiki data
// and images are read from the user's copy or the bundled seed (server/wiki-source.ts).
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
//   GET  /wiki-img/*       icons and map tiles from /public/wiki-img (installed app: the user's copy, then the seed)
//   GET  /api/server       ServerStatus with mode 'dev' (live mode only exists in the app server)
//   GET  /manifest.webmanifest  web app manifest (start_url '/')
//
// Every non-GET /api request must be JSON (415 otherwise) and come from this app
// (403 for other sites), so a foreign page cannot start a sync or write data.

import { spawn, type ChildProcess } from 'node:child_process'
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
import { APP_VERSION_ENV } from '../scripts/sync/wiki.ts'
import { nodeTsCommand, type NodeCommand } from '../scripts/sync/node-command.ts'
import { ROOT } from '../scripts/sync/paths.ts'
import { checkWriteRequest, HttpError, isRecord, readBody, resolveInside, send, sendEmpty, sendError, serveFile } from './http.ts'
import { handleManifest } from './manifest.ts'
import { pathsToEnv, projectPaths, type AshLogPaths } from './paths.ts'
import { imageRoots, reconcileSeed, wikiFilesIn, wikiReadDir } from './wiki-source.ts'

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

async function readOverridesFile(file: string): Promise<OverridesFile> {
  const bytes = await readBytes(file)
  const etag = etagOf(bytes)
  if (bytes === null) return { overrides: emptyOverrides(), etag }
  try {
    return { overrides: normalizeOverrides(parseJson(decodeText(bytes), file)), etag }
  } catch (err) {
    return { overrides: emptyOverrides(), etag, error: (err as Error).message }
  }
}

async function loadAppDataWithEtag(paths: AshLogPaths): Promise<{ data: AppData; overridesEtag: string }> {
  // One folder for all wiki files: the user's copy or the seed, never a mix (wiki-source.ts).
  const wiki = wikiFilesIn(await wikiReadDir(paths))
  const [map, quests, vaults, rewards, meta, report, file] = await Promise.all([
    readJson<MapData | null>(wiki.map, null),
    readJson<Quest[] | null>(wiki.quests, null),
    readJson<Vault[] | null>(wiki.vaults, null),
    readJson<Reward[] | null>(wiki.rewards, null),
    readJson<SyncMeta | null>(wiki.meta, null),
    readJson<DiffReport | null>(wiki.report, null),
    readOverridesFile(paths.overridesFile),
  ])
  // A typo in the hand-edited overrides.json must not take the app down: serve empty
  // overrides and flag it. PUT /api/overrides refuses to write until the file is fixed.
  const data = mergeAppData({ map, quests, vaults, rewards, meta, report, overrides: file.overrides })
  return { data: file.error ? { ...data, overridesError: file.error } : data, overridesEtag: file.etag }
}

/** The app data of the project layout (see createDataApi for any other). */
export async function loadAppData(): Promise<AppData> {
  return defaultDataApi().loadAppData()
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

async function readProgress(file: string): Promise<{ progress: Progress; etag: string }> {
  const bytes = await readBytes(file)
  const raw = bytes === null ? {} : parseJson<unknown>(decodeText(bytes), file)
  return { progress: normalizeProgress(raw), etag: etagOf(bytes) }
}

async function putProgress(req: IncomingMessage, body: unknown, file: string) {
  if (!isRecord(body) || body.version !== 1) throw new HttpError(400, 'Invalid progress: expected an object with version 1')
  const progress = normalizeProgress(body)
  return withLock(file, async () => {
    // Also refuses to overwrite a progress.json that is not valid JSON (the parse error names the file).
    const current = await readProgress(file)
    if (!ifMatchOk(req.headers['if-match'], current.etag)) {
      throw new HttpError(409, 'Progress was changed elsewhere', { progress: current.progress }, { ETag: `"${current.etag}"` })
    }
    await writeJsonAtomic(file, progress)
    return { progress, etag: etagOf(jsonText(progress)) }
  })
}

async function putOverrides(req: IncomingMessage, body: unknown, file: string) {
  if (!isRecord(body)) throw new HttpError(400, 'Invalid overrides: expected an object')
  const overrides = normalizeOverrides(body)
  return withLock(file, async () => {
    const current = await readOverridesFile(file)
    // Never replace a hand-edited file that has a typo: the user would lose every override in it.
    if (current.error) throw new HttpError(409, 'overrides.json is invalid, fix the file first', { detail: current.error })
    if (!ifMatchOk(req.headers['if-match'], current.etag)) {
      throw new HttpError(409, 'Overrides were changed elsewhere', { overrides: current.overrides }, { ETag: `"${current.etag}"` })
    }
    await writeJsonAtomic(file, overrides)
    return { overrides, etag: etagOf(jsonText(overrides)) }
  })
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

/** One sync at a time per data API: its status for the app, and the process while it runs. */
interface SyncState {
  status: SyncStatus
  /** The running sync process, so the app server can stop it when it shuts down. */
  child: ChildProcess | null
}

function pushLog(status: SyncStatus, line: string) {
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

/** The arguments of the sync script: --only=map,quests and --full. */
export function syncArgs(only: readonly SyncDomain[], full: boolean): string[] {
  const args: string[] = []
  if (only.length) args.push(`--only=${only.join(',')}`)
  if (full) args.push('--full')
  return args
}

/**
 * The sync as one Node process: this Node with tsx's loader, no shell and no .bin shim (on
 * Windows that shim is tsx.cmd, which spawn cannot run). See scripts/sync/node-command.ts.
 */
export function syncCommand(only: readonly SyncDomain[], full: boolean, opts: { execPath?: string; loaderUrl?: string; root?: string } = {}): NodeCommand {
  return nodeTsCommand(join(opts.root ?? ROOT, 'scripts', 'sync', 'index.ts'), syncArgs(only, full), opts)
}

/**
 * How a data API starts the sync with these arguments (syncArgs): a command spawn() runs
 * without a shell, plus environment on top of the one the server gives it (process.env with
 * the paths, see pathsToEnv) and an optional working folder.
 */
export interface SyncSpawn extends NodeCommand {
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/** What startSync runs: the command with its full environment and working folder. */
type SyncLaunch = (args: string[]) => Required<SyncSpawn>

/**
 * Starts the sync unless one runs. `reportFile` is where the sync writes report.json (the
 * user's copy of the wiki data), so a run that wrote none is reported as failed.
 */
function startSync(state: SyncState, launch: SyncLaunch, reportFile: string, only: SyncDomain[], full: boolean): boolean {
  const { status } = state
  if (status.running) return false
  status.running = true
  status.startedAt = new Date().toISOString()
  status.log = []
  delete status.report

  let buffer = ''
  const finish = async (code: number | null, error?: Error) => {
    if (buffer) pushLog(status, buffer)
    buffer = ''
    const report = await readJson<DiffReport | null>(reportFile, null).catch(() => null)
    const fresh = report && status.startedAt && report.syncedAt >= status.startedAt.slice(0, 19)
    status.report = fresh && report ? report : failedReport(only, error?.message ?? `Sync stopped with code ${code}`)
    status.running = false
  }

  try {
    const { command, args, env, cwd } = launch(syncArgs(only, full))
    // windowsHide: no console window pops up when the server runs without one (the launcher).
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    state.child = child
    // One decoder per stream: a character such as an é may arrive split over two chunks.
    const reader = () => {
      const decoder = new StringDecoder('utf8')
      return (chunk: Buffer) => {
        buffer += decoder.write(chunk)
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        lines.forEach((line) => pushLog(status, line))
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
      if (state.child === child) state.child = null
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

interface ApiContext {
  paths: AshLogPaths
  sync: SyncState
  launch: SyncLaunch
  /** Moves a stale user copy of the wiki data aside, once (reconcileSeed). */
  ready: () => Promise<void>
}

async function routeApi(api: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return false
  const route = `${req.method} ${url.pathname}`
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') checkWriteRequest(req)
    switch (route) {
      case 'GET /api/data': {
        await api.ready()
        const { data, overridesEtag } = await loadAppDataWithEtag(api.paths)
        send(res, 200, data, { 'X-Overrides-ETag': `"${overridesEtag}"` })
        return true
      }
      case 'GET /api/progress': {
        const { progress, etag } = await readProgress(api.paths.progressFile)
        send(res, 200, progress, { ETag: `"${etag}"` })
        return true
      }
      case 'PUT /api/progress': {
        const { progress, etag } = await putProgress(req, await readBody(req), api.paths.progressFile)
        send(res, 200, progress, { ETag: `"${etag}"` })
        return true
      }
      case 'PUT /api/overrides': {
        const { overrides, etag } = await putOverrides(req, await readBody(req), api.paths.overridesFile)
        send(res, 200, overrides, { ETag: `"${etag}"` })
        return true
      }
      case 'POST /api/sync': {
        const raw = await readBody(req)
        const body: { only?: unknown; full?: unknown } = isRecord(raw) ? raw : {}
        const only = Array.isArray(body.only) ? body.only.filter((d): d is SyncDomain => DOMAINS.includes(d)) : []
        await api.ready()
        if (!startSync(api.sync, api.launch, wikiFilesIn(api.paths.wikiDir).report, only, body.full === true)) {
          send(res, 409, { error: 'A sync is already running' })
          return true
        }
        send(res, 202, api.sync.status)
        return true
      }
      case 'GET /api/sync/status':
        send(res, 200, api.sync.status)
        return true
    }
    send(res, 404, { error: `Unknown endpoint: ${route}` })
    return true
  } catch (err) {
    sendError(res, err)
    return true
  }
}

export interface DataApiOptions {
  /** Every file location. Default: the project layout (projectPaths). */
  paths?: AshLogPaths
  /**
   * How to start the sync with these arguments (syncArgs). Default: this Node with tsx's
   * loader on scripts/sync/index.ts (syncCommand), in paths.resourcesDir. Its env is added to
   * process.env with the paths (pathsToEnv), so the sync reads and writes the same folders.
   */
  syncCommand?: (args: string[]) => SyncSpawn
  /**
   * The installed app's version. Set: the sync gets ASH_LOG_APP_VERSION, so without a
   * WIKI_USER_AGENT it uses the app's default User-Agent (scripts/sync/wiki.ts wikiUserAgent).
   */
  appVersion?: string
  /** Where a stale user copy that was moved aside is reported (reconcileSeed). */
  log?: (line: string) => void
}

/** The data API of one set of paths: /api/* (data, progress, overrides, sync) and /wiki-img/*. */
export interface DataApi {
  readonly paths: AshLogPaths
  /** Handles /api/* (except /api/server and /api/health); false for any other path. */
  handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  /** Handles /wiki-img/*: the user's copy first, then the seed; false for any other path. */
  handleWikiImage(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  loadAppData(): Promise<AppData>
  /** Moves a stale user copy of the wiki data aside (once; also done before the first read). */
  prepare(): Promise<void>
  /** True while a sync runs (the app server mentions it when it shuts down). */
  syncRunning(): boolean
  /**
   * Asks a running sync to stop (SIGTERM; on Windows that ends the process at once), for a
   * server that shuts down. Its files are written atomically, so the old data stays in place.
   */
  stopSync(): void
  /**
   * Resolves once no progress or overrides write is queued and no sync runs, or after
   * `timeoutMs`. Returns false on a timeout. The app server waits for this before it exits.
   */
  whenIdle(timeoutMs: number): Promise<boolean>
}

export function createDataApi(opts: DataApiOptions = {}): DataApi {
  const paths = opts.paths ?? projectPaths()
  const sync: SyncState = { status: { running: false, log: [] }, child: null }
  let prepared: Promise<void> | null = null
  const ready = () => (prepared ??= reconcileSeed(paths, opts.log).then(() => {}))
  const launch: SyncLaunch = (args) => {
    const custom: SyncSpawn = opts.syncCommand ? opts.syncCommand(args) : nodeTsCommand(join(paths.resourcesDir, 'scripts', 'sync', 'index.ts'), args)
    const env = pathsToEnv(paths)
    if (opts.appVersion) env[APP_VERSION_ENV] = opts.appVersion
    return { command: custom.command, args: custom.args, env: { ...env, ...custom.env }, cwd: custom.cwd ?? paths.resourcesDir }
  }
  const api: ApiContext = { paths, sync, launch, ready }
  return {
    paths,
    handleApi: (req, res) => routeApi(api, req, res),
    handleWikiImage: (req, res) => serveWikiImage(imageRoots(paths), req, res),
    loadAppData: async () => {
      await ready()
      return (await loadAppDataWithEtag(paths)).data
    },
    prepare: ready,
    syncRunning: () => sync.status.running,
    stopSync: () => void sync.child?.kill('SIGTERM'),
    async whenIdle(timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (locks.size > 0 || sync.status.running) {
        if (Date.now() >= deadline) return false
        await new Promise((r) => setTimeout(r, 50))
      }
      return true
    },
  }
}

let defaultApi: DataApi | null = null
/** The data API of the project layout: npm run dev and the module-level functions below. */
export function defaultDataApi(): DataApi {
  return (defaultApi ??= createDataApi())
}

/** /api/* of the project layout (npm run dev). */
export const handleApi = (req: IncomingMessage, res: ServerResponse) => defaultDataApi().handleApi(req, res)
/** See DataApi.whenIdle (project layout). */
export const whenIdle = (timeoutMs: number) => defaultDataApi().whenIdle(timeoutMs)
/** See DataApi.syncRunning (project layout). */
export const syncRunning = (): boolean => defaultDataApi().syncRunning()
/** See DataApi.stopSync (project layout). */
export const stopSync = (): void => defaultDataApi().stopSync()

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
 * `roots` in order (the user's copy, then the seed); each is checked against traversal.
 */
async function serveWikiImage(roots: readonly string[], req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (!pathname.startsWith(WIKI_IMG_PREFIX)) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendEmpty(res, 405, { Allow: 'GET, HEAD' })
    return true
  }
  for (const root of roots) {
    const resolved = resolveInside(root, pathname, WIKI_IMG_PREFIX)
    if (!resolved.ok) {
      sendEmpty(res, resolved.status)
      return true
    }
    if (await serveFile(req, res, resolved.file, { cacheControl: 'no-cache', types: IMAGE_TYPES })) return true
  }
  sendEmpty(res, 404)
  return true
}

/** /wiki-img/* of the project layout (npm run dev). */
export const handleWikiImage = (req: IncomingMessage, res: ServerResponse) => defaultDataApi().handleWikiImage(req, res)

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
