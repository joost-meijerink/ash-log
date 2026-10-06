// Helpers to turn stored API responses into parser input. Tests never hit the live wiki.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RawPage } from '../wiki'

const DIR = import.meta.dirname

export function fixtureJson<T = any>(relPath: string): T {
  return JSON.parse(readFileSync(join(DIR, relPath), 'utf8')) as T
}

export function fixtureText(relPath: string): string {
  return readFileSync(join(DIR, relPath), 'utf8')
}

/** RawPage[] from one or more `prop=revisions` responses. Missing pages are skipped. */
export function fixturePages(...relPaths: string[]): RawPage[] {
  const out: RawPage[] = []
  for (const rel of relPaths) {
    const data = fixtureJson(rel)
    for (const p of data.query?.pages ?? []) {
      if (p.missing || !p.revisions?.length) continue
      const rev = p.revisions[0]
      out.push({ title: p.title, revid: rev.revid, content: rev.slots.main.content })
    }
  }
  return out
}

/** The single page in a `prop=revisions` response file. */
export function fixturePage(relPath: string): RawPage {
  const [page] = fixturePages(relPath)
  if (!page) throw new Error(`No page in fixture ${relPath}`)
  return page
}

/** title -> non-hidden categories, from `prop=categories` responses. */
export function fixtureCategories(...relPaths: string[]): { categories: Record<string, string[]>; missing: string[] } {
  const categories: Record<string, string[]> = {}
  const missing: string[] = []
  for (const rel of relPaths) {
    const data = fixtureJson(rel)
    for (const p of data.query?.pages ?? []) {
      if (p.missing) missing.push(p.title)
      else categories[p.title] = (p.categories ?? []).map((c: { title: string }) => c.title)
    }
  }
  return { categories, missing }
}

export const MAP_CONTENT_FILES = Array.from({ length: 9 }, (_, i) => `map/content-${i + 1}.json`)
export const MAP_CATEGORY_FILES = Array.from({ length: 9 }, (_, i) => `map/categories-${i + 1}.json`)
