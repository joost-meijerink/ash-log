// Which copy of the wiki data and images to read in the desktop layout (server/paths.ts).
//
// The installed app ships the wiki data and images as a seed, so the map works before the
// first sync. A sync writes to the user copy (paths.wikiDir, paths.imgDir). The rule:
//   - data: the newest complete copy by meta.json syncedAt wins, the user copy on a tie. The
//     files of one copy are always read together, never a mix of both.
//   - images: per file, the user copy first, then the seed (a name never changes content).
//   - an app update that brings newer data than the user's last sync: the stale user copy is
//     moved aside (reconcileSeed), never deleted, and the move is logged.
// In the project layout there is no seed and everything reads the project's own files.

import { rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readJson } from '../scripts/sync/files.ts'
import type { SyncMeta } from '../src/lib/types.ts'
import type { AshLogPaths } from './paths.ts'

export const WIKI_FILE_NAMES = {
  map: 'map.json',
  quests: 'quests.json',
  vaults: 'vaults.json',
  rewards: 'rewards.json',
  meta: 'meta.json',
  report: 'report.json',
} as const

export type WikiFiles = Record<keyof typeof WIKI_FILE_NAMES, string>

/** The wiki data files in a folder. */
export function wikiFilesIn(dir: string): WikiFiles {
  const files = {} as WikiFiles
  for (const [key, name] of Object.entries(WIKI_FILE_NAMES)) files[key as keyof WikiFiles] = join(dir, name)
  return files
}

/** syncedAt of the meta.json in a folder, in ms. Null when it is missing, unreadable or has no valid date. */
export async function syncedAtOf(dir: string): Promise<number | null> {
  try {
    const meta = await readJson<Partial<SyncMeta> | null>(join(dir, WIKI_FILE_NAMES.meta), null)
    const time = typeof meta?.syncedAt === 'string' ? Date.parse(meta.syncedAt) : NaN
    return Number.isFinite(time) ? time : null
  } catch {
    return null
  }
}

/**
 * The folder to read the wiki data from: the user copy when it has data at least as new as the
 * seed, otherwise the seed when that has data, otherwise the user copy (nothing synced yet).
 */
export async function wikiReadDir(paths: AshLogPaths): Promise<string> {
  if (!paths.seedWikiDir) return paths.wikiDir
  const [user, seed] = await Promise.all([syncedAtOf(paths.wikiDir), syncedAtOf(paths.seedWikiDir)])
  if (user !== null && (seed === null || user >= seed)) return paths.wikiDir
  return seed !== null ? paths.seedWikiDir : paths.wikiDir
}

/** Where to look for a wiki image, in order: the user copy, then the seed. */
export function imageRoots(paths: AshLogPaths): string[] {
  return paths.seedImgDir ? [paths.imgDir, paths.seedImgDir] : [paths.imgDir]
}

/** Where the sync looks for a cached raw page, in order (it only writes the first). */
export function rawCacheRoots(paths: AshLogPaths): string[] {
  return paths.seedRawCacheDir ? [paths.rawCacheDir, paths.seedRawCacheDir] : [paths.rawCacheDir]
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10)

/** A free name next to `dir` for the old copy: wiki-old-2026-10-06T14-31-00Z, then -2, -3 and so on. */
async function freeSibling(dir: string, time: number): Promise<string> {
  const stamp = new Date(time).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
  const base = join(dirname(dir), `${basename(dir)}-old-${stamp}`)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    if (!(await stat(candidate).catch(() => null))) return candidate
  }
}

/**
 * When the seed holds newer data than the user copy (an app update after the user's last
 * sync), moves the user copy aside so the seed is read and the next sync starts from it.
 * Returns the folder it moved to, or null when nothing moved. Logs what it did; never throws
 * (when the move fails the seed is still read, see wikiReadDir).
 */
export async function reconcileSeed(paths: AshLogPaths, log: (line: string) => void = () => {}): Promise<string | null> {
  if (!paths.seedWikiDir) return null
  const [user, seed] = await Promise.all([syncedAtOf(paths.wikiDir), syncedAtOf(paths.seedWikiDir)])
  if (user === null || seed === null || user >= seed) return null
  const what = `The app brings newer wiki data (${day(seed)}) than your last update (${day(user)})`
  try {
    const target = await freeSibling(paths.wikiDir, user)
    await rename(paths.wikiDir, target)
    log(`${what}, so it uses that now. Your old copy is kept in ${target}`)
    return target
  } catch (err) {
    log(`${what}, so it uses that now. Your old copy couldn't be moved aside: ${(err as Error).message}`)
    return null
  }
}
