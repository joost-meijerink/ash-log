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

export function createContext(wiki: WikiClient, log: (message: string) => void, full: boolean): SyncContext {
  const revisions = new Map<string, number>()

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
      const cached = full ? undefined : await readCache(title)
      if (cached && cached.revid === revid) result.set(title, cached)
      else toFetch.push(title)
    }

    if (toFetch.length) {
      log(`  ${toFetch.length} van ${unique.length} pagina's ophalen (rest ongewijzigd)`)
      const fetched = await wiki.pages(toFetch)
      for (const [title, page] of fetched.pages) {
        result.set(title, page)
        await writeJsonAtomic(cachePath(title), page)
      }
      missing.push(...fetched.missing)
    } else if (unique.length) {
      log(`  ${unique.length} pagina's ongewijzigd, uit cache`)
    }

    for (const page of result.values()) revisions.set(page.title, page.revid)
    return { pages: result, missing }
  }

  return { wiki, log, full, pages, revisions }
}

function cachePath(title: string): string {
  return join(RAW_CACHE_DIR, `${slug(title).slice(0, 60)}-${hash(title)}.json`)
}

async function readCache(title: string): Promise<RawPage | undefined> {
  try {
    const page = JSON.parse(await readFile(cachePath(title), 'utf8')) as RawPage
    return typeof page.revid === 'number' && typeof page.content === 'string' ? page : undefined
  } catch {
    return undefined
  }
}

export function warnCollector(sink: SyncWarning[], source: SyncWarning['source']): Warn {
  return (message, page) => sink.push({ source, ...(page ? { page } : {}), message })
}
