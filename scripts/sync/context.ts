// What every sync domain gets: the polite wiki client, a revision-aware page cache,
// logging and warnings. Domains never write files; the orchestrator does.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hash, slug } from '../../src/lib/ids'
import type { SyncWarning } from '../../src/lib/types'
import { writeJsonAtomic } from './files'
import { RAW_CACHE_DIR } from './paths'
import type { RawPage, WikiClient } from './wiki'

/** Report a page the parser did not recognise. The page is skipped, never half-written. */
export type Warn = (message: string, page?: string) => void

export interface SyncContext {
  wiki: WikiClient
  log: (message: string) => void
  /** Ignore the raw cache and download every page again. */
  full: boolean
  /**
   * Page contents via the revision cache: asks the wiki for current revision ids
   * (cheap, 50 per request) and only downloads pages whose revision changed.
   * Every page returned is recorded in `revisions` for meta.json.
   */
  pages(titles: string[]): Promise<{ pages: Map<string, RawPage>; missing: string[] }>
  /** Title -> revision id of every page read during this sync. */
  revisions: Map<string, number>
}

/**
 * `cacheDirs`: where cached raw pages are looked up, in order. New pages are written to the
 * first (the installed app also reads the revision cache it ships with, see server/wiki-source.ts).
 */
export function createContext(wiki: WikiClient, log: (message: string) => void, full: boolean, cacheDirs: readonly string[] = [RAW_CACHE_DIR]): SyncContext {
  const revisions = new Map<string, number>()
  const writeDir = cacheDirs[0] ?? RAW_CACHE_DIR

  async function pages(titles: string[]) {
    const unique = [...new Set(titles)]
    const current = await wiki.revisions(unique)
    const result = new Map<string, RawPage>()
    const missing: string[] = []
    const toFetch: string[] = []

    for (const title of unique) {
      const revid = current.get(title)
      if (!revid) {
        missing.push(title)
        continue
      }
      const cached = full ? undefined : await readCache(cacheDirs, title, revid)
      if (cached) result.set(title, cached)
      else toFetch.push(title)
    }

    if (toFetch.length) {
      log(`  Fetching ${toFetch.length} of ${unique.length} pages (the rest is unchanged)`)
      const fetched = await wiki.pages(toFetch)
      for (const [title, page] of fetched.pages) {
        result.set(title, page)
        await writeJsonAtomic(cachePath(writeDir, title), page)
      }
      missing.push(...fetched.missing)
    } else if (unique.length) {
      log(`  ${unique.length} pages unchanged, read from cache`)
    }

    for (const page of result.values()) revisions.set(page.title, page.revid)
    return { pages: result, missing }
  }

  return { wiki, log, full, pages, revisions }
}

function cachePath(dir: string, title: string): string {
  return join(dir, `${slug(title).slice(0, 60)}-${hash(title)}.json`)
}

/** The cached page with this revision from the first folder that has it. */
async function readCache(dirs: readonly string[], title: string, revid: number): Promise<RawPage | undefined> {
  for (const dir of dirs) {
    try {
      const page = JSON.parse(await readFile(cachePath(dir, title), 'utf8')) as RawPage
      if (page.revid === revid && typeof page.content === 'string') return page
    } catch {
      // Not in this folder (or unreadable): try the next.
    }
  }
  return undefined
}

export function warnCollector(sink: SyncWarning[], source: SyncWarning['source']): Warn {
  return (message, page) => sink.push({ source, ...(page ? { page } : {}), message })
}
