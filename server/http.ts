// HTTP helpers shared by the Vite dev middleware (middleware.ts) and the app server (app.ts).

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY = 5 * 1024 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: Record<string, unknown>,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function send(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(JSON.stringify(body))
}

export function sendEmpty(res: ServerResponse, code: number, headers: Record<string, string> = {}) {
  res.statusCode = code
  res.setHeader('Cache-Control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end()
}

/** Sends an HttpError as { error } JSON, anything else as a 500. */
export function sendError(res: ServerResponse, err: unknown) {
  if (err instanceof HttpError) send(res, err.status, { ...err.body, error: err.message }, err.headers)
  else send(res, 500, { error: (err as Error).message })
}

/** Parsed JSON body, or undefined when the body is empty. */
export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

/**
 * Only this app may change data or start a sync. A JSON content type forces a CORS
 * preflight (which neither server answers for foreign origins), and browsers mark requests
 * from other sites with Sec-Fetch-Site or an Origin that does not match the host.
 */
export function checkWriteRequest(req: IncomingMessage) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Forbidden: request from another site')
  const origin = req.headers.origin
  if (origin && req.headers.host) {
    let host: string | undefined
    try {
      host = new URL(origin).host
    } catch {
      host = undefined
    }
    if (host !== req.headers.host.toLowerCase()) throw new HttpError(403, 'Forbidden: request from another site')
  }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
    throw new HttpError(415, 'Expected application/json')
  }
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

export type Resolved = { ok: true; file: string } | { ok: false; status: 400 | 403 }

/** The parts of node:path resolveInside needs: path.posix or path.win32 (tests simulate the other system). */
export interface PathRules {
  resolve(...paths: string[]): string
  readonly sep: string
}

/** Device names Windows reserves in every folder, with or without an extension (nul.png is the null device). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i

/**
 * A path segment Windows would read as something else than the file it names: a stream
 * (x.png:hidden) or drive (C:), a character it does not allow, a name it trims (a trailing
 * dot or space) or a device (CON, NUL).
 */
function windowsUnsafeSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false
  return /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_DEVICE.test(segment)
}

/**
 * Maps the URL path below `prefix` to a file inside `root`. Refuses encoded traversal
 * (403), malformed escapes, NUL bytes and backslashes (400). The pathname must start with
 * `prefix`. On Windows (`path` is path.win32 there) also refuses names Windows would not
 * take literally (400), such as x.png:stream, CON or a trailing dot. `path` is only
 * injected by tests.
 */
export function resolveInside(root: string, pathname: string, prefix = '/', path: PathRules = nodePath): Resolved {
  let rel: string
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length - 1))
  } catch {
    return { ok: false, status: 400 }
  }
  if (rel.includes('\0')) return { ok: false, status: 400 }
  // A folder separator on Windows: never part of a name in a URL, refused alike everywhere.
  if (rel.includes('\\')) return { ok: false, status: 400 }
  if (path.sep === '\\' && rel.split('/').some(windowsUnsafeSegment)) return { ok: false, status: 400 }
  const base = path.resolve(root)
  const file = path.resolve(base, '.' + rel)
  if (!file.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return { ok: false, status: 403 }
  return { ok: true, file }
}

/**
 * Streams a file with its content type, Last-Modified and If-Modified-Since support.
 * Returns false (and sends nothing) when the file does not exist.
 */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  opts: { cacheControl: string; headers?: Record<string, string>; types?: Record<string, string> },
): Promise<boolean> {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return false

  const lastModified = new Date(Math.floor(info.mtimeMs / 1000) * 1000)
  const since = Date.parse(String(req.headers['if-modified-since'] ?? ''))
  res.setHeader('Cache-Control', opts.cacheControl)
  res.setHeader('Last-Modified', lastModified.toUTCString())
  for (const [name, value] of Object.entries(opts.headers ?? {})) res.setHeader(name, value)
  if (Number.isFinite(since) && lastModified.getTime() <= since) {
    res.statusCode = 304
    res.end()
    return true
  }

  res.statusCode = 200
  res.setHeader('Content-Type', (opts.types ?? CONTENT_TYPES)[extname(file).toLowerCase()] ?? 'application/octet-stream')
  res.setHeader('Content-Length', String(info.size))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  // A cancelled request (Leaflet drops tiles while zooming) rejects the pipeline; nothing to do then.
  await pipeline(createReadStream(file), res).catch(() => {})
  return true
}
