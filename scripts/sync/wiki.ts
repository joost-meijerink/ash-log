// Polite MediaWiki client for dragonwilds.runescape.wiki.
// Rules (CLAUDE.md): own User-Agent with contact details, one request at a time,
// titles batched per 50, maxlag=5, honour Retry-After. Only api.php and action=raw.

import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { replaceFile } from './files'

export const WIKI_ORIGIN = 'https://dragonwilds.runescape.wiki'
export const API_URL = `${WIKI_ORIGIN}/api.php`
export const BATCH_SIZE = 50

export interface RawPage {
  title: string
  revid: number
  content: string
}

export interface WikiClientOptions {
  userAgent: string
  /** Pause between two requests, in ms. */
  delayMs?: number
  maxRetries?: number
  log?: (message: string) => void
  fetchImpl?: typeof fetch
}

type Params = Record<string, string | number | undefined>

export class WikiError extends Error {}

/** Example domains (RFC 2606) such as the placeholder in .env.example: nobody reads mail there. */
const EXAMPLE_DOMAIN = /(^|\.)example(\.(com|net|org))?\.?$/i
const EMAIL_DOMAINS = /[^\s<>()@;,]+@([a-z0-9.-]+)/gi
const URL_HOSTS = /https?:\/\/([^\s/:;,()<>?#]+)/gi

/**
 * Why a User-Agent is not good enough for the wiki: 'missing' without an e-mail address or URL,
 * 'example' when every contact in it is at an example domain (the .env.example placeholder).
 * Null when the wiki can reach whoever runs the sync.
 */
export function userAgentProblem(userAgent: string): 'missing' | 'example' | null {
  const domains = [...userAgent.matchAll(EMAIL_DOMAINS), ...userAgent.matchAll(URL_HOSTS)].map((m) => m[1]!)
  if (!domains.length) return 'missing'
  return domains.every((domain) => EXAMPLE_DOMAIN.test(domain)) ? 'example' : null
}

export class WikiClient {
  private readonly userAgent: string
  private readonly delayMs: number
  private readonly maxRetries: number
  private readonly log: (message: string) => void
  private readonly fetchImpl: typeof fetch
  /** Serialises every request, even if callers forget to await. */
  private queue: Promise<unknown> = Promise.resolve()
  private lastRequestAt = 0
  requestCount = 0

  constructor(options: WikiClientOptions) {
    const problem = userAgentProblem(options.userAgent ?? '')
    if (problem === 'missing') {
      throw new WikiError('WIKI_USER_AGENT mist contactgegevens (e-mail of URL). Zet hem in .env, zie .env.example.')
    }
    if (problem === 'example') {
      throw new WikiError('WIKI_USER_AGENT bevat nog het voorbeeldadres uit .env.example. Zet er je eigen e-mailadres of URL in .env in.')
    }
    this.userAgent = options.userAgent
    this.delayMs = options.delayMs ?? 300
    this.maxRetries = options.maxRetries ?? 5
    this.log = options.log ?? (() => {})
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** GET api.php with format=json, formatversion=2 and maxlag=5. */
  async api<T = any>(params: Params): Promise<T> {
    const url = new URL(API_URL)
    // Defaults last, so no caller can drop maxlag or change the format (CLAUDE.md rule 3).
    const all: Params = { ...params, format: 'json', formatversion: 2, maxlag: 5 }
    for (const [key, value] of Object.entries(all)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const body = await this.request(url.toString(), 'json')
    const data = JSON.parse(body.toString('utf8'))
    if (data.error) {
      throw new WikiError(`Wiki-API-fout ${data.error.code}: ${data.error.info}`)
    }
    return data as T
  }

  /** index.php?action=raw for a page (e.g. MediaWiki:Gadget-maps.js). */
  async raw(title: string): Promise<string> {
    const url = `${WIKI_ORIGIN}/index.php?title=${encodeURIComponent(title)}&action=raw`
    return (await this.request(url, 'text')).toString('utf8')
  }

  /** Runs a list/generator query and follows `continue` until done. */
  async queryAll<T = any>(params: Params, pick: (data: any) => T[]): Promise<T[]> {
    const out: T[] = []
    let cont: Record<string, string> | undefined = {}
    while (cont) {
      const data: any = await this.api({ action: 'query', ...params, ...cont })
      out.push(...pick(data))
      cont = data.continue
    }
    return out
  }

  /**
   * Wikitext (or JSON) of many pages, 50 titles per request. Follows redirects.
   * Missing pages are left out of the result; `missing` lists the requested titles.
   * Result is keyed by the title as requested (after normalisation and redirects the
   * canonical title is in RawPage.title).
   */
  async pages(titles: string[]): Promise<{ pages: Map<string, RawPage>; missing: string[] }> {
    const pages = new Map<string, RawPage>()
    const missing: string[] = []
    const unique = [...new Set(titles)]
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE)
      const data: any = await this.api({
        action: 'query',
        prop: 'revisions',
        rvprop: 'content|ids',
        rvslots: 'main',
        redirects: 1,
        titles: batch.join('|'),
      })
      const q = data.query ?? {}
      const alias = aliasMap(q)
      const byTitle = new Map<string, RawPage>()
      for (const p of q.pages ?? []) {
        if (p.missing || p.invalid || !p.revisions?.length) continue
        const rev = p.revisions[0]
        byTitle.set(p.title, { title: p.title, revid: rev.revid, content: rev.slots?.main?.content ?? '' })
      }
      for (const t of batch) {
        const page = byTitle.get(resolveAlias(alias, t))
        if (page) pages.set(t, page)
        else missing.push(t)
      }
    }
    return { pages, missing }
  }

  /**
   * Latest revision id per requested title (after normalisation and redirects),
   * 50 per request. Missing pages are left out. Used for the fast resync check.
   */
  async revisions(titles: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    const unique = [...new Set(titles)]
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE)
      const data: any = await this.api({ action: 'query', prop: 'info', redirects: 1, titles: batch.join('|') })
      const q = data.query ?? {}
      const alias = aliasMap(q)
      const revByTitle = new Map<string, number>()
      for (const p of q.pages ?? []) {
        if (!p.missing && !p.invalid && p.lastrevid) revByTitle.set(p.title, p.lastrevid)
      }
      for (const t of batch) {
        const rev = revByTitle.get(resolveAlias(alias, t))
        if (rev) out.set(t, rev)
      }
    }
    return out
  }

  /**
   * Direct URLs for File: pages (prop=imageinfo), 50 per request. Keys are file names without 'File:'.
   * With `width` the URL is a thumbnail at most that wide (iiurlwidth); MediaWiki answers with the
   * original for images that are already narrower. The original URL is used when there is no thumbnail,
   * and always for an SVG: it scales by itself, and its thumbnail is a PNG that would be stored and
   * served as '.svg' (and then never show).
   */
  async imageUrls(fileNames: string[], opts: { width?: number } = {}): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const titles = [...new Set(fileNames)].map((f) => `File:${f}`)
    for (let i = 0; i < titles.length; i += BATCH_SIZE) {
      const batch = titles.slice(i, i + BATCH_SIZE)
      const data: any = await this.api({
        action: 'query',
        prop: 'imageinfo',
        iiprop: 'url',
        iiurlwidth: opts.width,
        redirects: 1,
        titles: batch.join('|'),
      })
      const q = data.query ?? {}
      const alias = aliasMap(q)
      const infoByTitle = new Map<string, { url?: unknown; thumburl?: unknown }>()
      for (const p of q.pages ?? []) {
        const info = p.imageinfo?.[0]
        if (info) infoByTitle.set(p.title, info)
      }
      for (const t of batch) {
        const info = infoByTitle.get(resolveAlias(alias, t))
        const thumb = opts.width && typeof info?.thumburl === 'string' && !isSvg(t) ? info.thumburl : undefined
        const url = thumb || (typeof info?.url === 'string' ? info.url : undefined)
        if (url) out.set(t.slice('File:'.length), url)
      }
    }
    return out
  }

  /** Downloads a binary file (image, tile). Returns false on 404. */
  async download(url: string, dest: string): Promise<boolean> {
    try {
      const body = await this.request(url, 'binary')
      await mkdir(dirname(dest), { recursive: true })
      // Temp file + rename: an interrupted write never looks like a finished download.
      const tmp = `${dest}.${process.pid}.part`
      await writeFile(tmp, body)
      // Retried on Windows while the dev server or a virus scanner has the old file open.
      await replaceFile(tmp, dest).catch(async (err: unknown) => {
        await unlink(tmp).catch(() => {})
        throw err
      })
      return true
    } catch (err) {
      if (err instanceof NotFoundError) return false
      throw err
    }
  }

  private request(url: string, kind: 'json' | 'text' | 'binary'): Promise<Buffer> {
    const run = () => this.doRequest(url, kind)
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  private async doRequest(url: string, kind: 'json' | 'text' | 'binary'): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.delayMs - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastRequestAt = Date.now()
      this.requestCount++

      // A connection can fail before the headers or while the body streams in
      // (undici: 'terminated'); both are retried with the same backoff.
      let res: Response
      let buf: Buffer
      try {
        res = await this.fetchImpl(url, {
          headers: {
            'User-Agent': this.userAgent,
            'Api-User-Agent': this.userAgent,
            Accept: kind === 'json' ? 'application/json' : '*/*',
          },
        })
        if (res.status === 404) {
          await res.body?.cancel()
          throw new NotFoundError(url)
        }
        buf = Buffer.from(await res.arrayBuffer())
      } catch (err) {
        if (err instanceof NotFoundError) throw err
        const message = (err as Error).message
        if (attempt >= this.maxRetries) {
          throw new WikiError(`Wiki niet bereikbaar na ${attempts(attempt + 1)}: ${message}`, { cause: err })
        }
        const backoff = 2000 * (attempt + 1)
        this.log(`Netwerkfout, opnieuw over ${backoff} ms: ${message}`)
        await sleep(backoff)
        continue
      }
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'))

      // maxlag answers with HTTP 200 + error code "maxlag" (or 503) and a Retry-After header.
      // A 200 that is not JSON (an HTML error page from a proxy) is retried as well.
      let lagged = false
      let badJson = false
      if (kind === 'json' && res.ok) {
        try {
          const data = JSON.parse(buf.toString('utf8'))
          lagged = data?.error?.code === 'maxlag'
        } catch {
          badJson = true
        }
      }

      if (lagged || badJson || res.status === 429 || res.status === 503 || (res.status >= 500 && res.status < 600)) {
        if (attempt >= this.maxRetries) {
          if (badJson) throw new WikiError(`Geen geldige JSON van ${url} (na ${attempts(attempt + 1)})`)
          throw new WikiError(`Opgegeven na ${attempts(attempt + 1)}: ${lagged ? 'maxlag' : `HTTP ${res.status}`} ${url}`)
        }
        const backoff = retryAfter ?? 5000 * (attempt + 1)
        const reason = lagged ? 'maxlag' : badJson ? 'geen geldige JSON' : `HTTP ${res.status}`
        this.log(`${reason}, ${Math.round(backoff / 1000)} s wachten${retryAfter !== undefined ? ' (Retry-After)' : ''}`)
        await sleep(backoff)
        continue
      }
      if (!res.ok) throw new WikiError(`HTTP ${res.status} voor ${url}`)
      return buf
    }
  }
}

export class NotFoundError extends WikiError {
  constructor(url: string) {
    super(`404 (niet gevonden): ${url}`)
  }
}

/** Requested title -> canonical title, from a query's `normalized` and `redirects` lists. */
function aliasMap(query: any): Map<string, string> {
  const alias = new Map<string, string>()
  for (const n of query.normalized ?? []) alias.set(n.from, n.to)
  for (const r of query.redirects ?? []) alias.set(r.from, r.to)
  return alias
}

function resolveAlias(alias: Map<string, string>, title: string): string {
  let cur = title
  for (let hops = 0; hops < 5 && alias.has(cur); hops++) cur = alias.get(cur)!
  return cur
}

const isSvg = (fileName: string) => /\.svgz?$/i.test(fileName.trim())

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(1000, date - Date.now())
  return undefined
}

function attempts(n: number): string {
  return n === 1 ? '1 poging' : `${n} pogingen`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
