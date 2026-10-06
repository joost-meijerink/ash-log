// File locations shared by the sync script and the dev middleware.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DATA_DIR = join(ROOT, 'data')
/** Written only by the sync script. */
export const WIKI_DIR = join(DATA_DIR, 'wiki')
/** Raw page cache keyed by revision id, so a resync only fetches changed pages. Not in git. */
export const RAW_CACHE_DIR = join(WIKI_DIR, '.raw')
export const PROGRESS_FILE = join(DATA_DIR, 'progress.json')
export const OVERRIDES_FILE = join(DATA_DIR, 'overrides.json')

export const WIKI_FILES = {
  map: join(WIKI_DIR, 'map.json'),
  quests: join(WIKI_DIR, 'quests.json'),
  vaults: join(WIKI_DIR, 'vaults.json'),
  rewards: join(WIKI_DIR, 'rewards.json'),
  meta: join(WIKI_DIR, 'meta.json'),
  report: join(WIKI_DIR, 'report.json'),
} as const

/** Images the sync downloads, served as /wiki-img/... by the data middleware (server/middleware.ts). Not in git. */
export const PUBLIC_IMG_DIR = join(ROOT, 'public', 'wiki-img')
export const ICONS_DIR = join(PUBLIC_IMG_DIR, 'icons')
export const TILES_DIR = join(PUBLIC_IMG_DIR, 'tiles')

export const FIXTURES_DIR = join(ROOT, 'scripts', 'sync', '__fixtures__')
