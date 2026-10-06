// JSON file helpers shared by the sync script and the dev middleware.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** Raw file contents, or null when the file does not exist. Other read errors are thrown. */
export async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * The text of a file a person may have saved by hand: UTF-8 with or without a byte order mark,
 * or UTF-16 (LE or BE) with one. Windows editors write those: Notepad's 'UTF-8 with BOM',
 * PowerShell 5.1's Set-Content -Encoding UTF8 (a BOM) and its `>` redirect (UTF-16 LE).
 */
export function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const text = bytes.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * JSON.parse with an error message that names the file (a hand-edited file may hold a typo).
 * A leading byte order mark is skipped.
 */
export function parseJson<T>(text: string, path: string): T {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T
  } catch (err) {
    throw new Error(`${basename(path)} is not valid JSON: ${(err as Error).message}`)
  }
}

/** Parsed JSON, or `fallback` when the file does not exist. Invalid JSON throws an error naming the file. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const bytes = await readBytes(path)
  return bytes === null ? fallback : parseJson<T>(decodeText(bytes), path)
}

/** The exact text writeJsonAtomic puts on disk. */
export function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2) + '\n'
}

/** Errors a rename on Windows gives while another program briefly holds the target open. */
const RENAME_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
/**
 * Waits between rename attempts on Windows, about 1.5 s in all. A virus scanner, the search
 * indexer or a sync client (OneDrive, Dropbox) often opens a file that was just written; a
 * rename over it then fails for a moment. Elsewhere a rename over a file never fails like that,
 * so it is not retried.
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 25, 50, 100, 200, 400, 700]

export interface ReplaceFileOptions {
  platform?: NodeJS.Platform
  rename?: (from: string, to: string) => Promise<void>
  delaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

/** rename(from, to), retried on Windows while the target is busy (see RENAME_RETRY_DELAYS_MS). */
export async function replaceFile(from: string, to: string, opts: ReplaceFileOptions = {}): Promise<void> {
  const doRename = opts.rename ?? rename
  const delays = (opts.platform ?? process.platform) === 'win32' ? (opts.delaysMs ?? RENAME_RETRY_DELAYS_MS) : []
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to)
      return
    } catch (err) {
      if (attempt >= delays.length || !RENAME_BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err
      await sleep(delays[attempt]!)
    }
  }
}

/** A temp name no other write (same process or another one) can share. */
function tempPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`
}

async function stage(path: string, data: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = tempPath(path)
  try {
    await writeFile(tmp, jsonText(data), 'utf8')
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  return tmp
}

/**
 * Writes via a temp file + rename, so a crash never leaves half a file behind. Creates the
 * folder when needed (a fresh clone has no progress.json or overrides.json yet).
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = await stage(path, data)
  try {
    await replaceFile(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/** Start of the message of a PartialWriteError; the report text checks for it. */
export const PARTIAL_WRITE_PREFIX = 'Partially written'

/** Some files of a set were already replaced when a later rename failed. */
export class PartialWriteError extends Error {
  constructor(
    readonly written: string[],
    cause: Error,
  ) {
    super(`${PARTIAL_WRITE_PREFIX} (${written.join(', ')}), then failed: ${cause.message}`, { cause })
  }
}

/**
 * Writes a set of files in two phases: first every file to a temp name, then all
 * renames. A failure while staging (disk full, no permission) removes the temp
 * files and leaves every target untouched. Renames within one directory practically
 * never fail; if one does, the error lists the files already replaced.
 */
export async function writeJsonFilesAtomic(entries: ReadonlyArray<readonly [path: string, data: unknown]>): Promise<void> {
  const staged: [path: string, tmp: string][] = []
  try {
    for (const [path, data] of entries) staged.push([path, await stage(path, data)])
  } catch (err) {
    await Promise.all(staged.map(([, tmp]) => unlink(tmp).catch(() => {})))
    throw err
  }

  const written: string[] = []
  for (let i = 0; i < staged.length; i++) {
    const [path, tmp] = staged[i]!
    try {
      await replaceFile(tmp, path)
      written.push(basename(path))
    } catch (err) {
      await Promise.all(staged.slice(i).map(([, t]) => unlink(t).catch(() => {})))
      if (!written.length) throw err
      throw new PartialWriteError(written, err as Error)
    }
  }
}
