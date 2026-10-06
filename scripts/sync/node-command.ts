// Running a TypeScript entry point (the sync, the app server) from Node itself.
//
// No node_modules/.bin shim and no shell: on Windows the shim is tsx.cmd, which spawn() cannot
// run without a shell, and a shell brings quoting trouble with spaces in paths. Instead this
// Node (process.execPath) loads tsx's loader with --import and runs the script in the same
// process. One process also means one pid: stopping it (TerminateProcess on Windows) stops the
// script itself, never only a wrapper that leaves the real work running.

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface NodeCommand {
  command: string
  args: string[]
}

/**
 * file:// URL of tsx's loader (the package's main export, as in `node --import tsx`). A URL,
 * because --import does not take a Windows path such as C:\x\loader.mjs.
 */
export function tsxLoaderUrl(resolve: (id: string) => string = createRequire(import.meta.url).resolve, toUrl = (path: string) => pathToFileURL(path).href): string {
  return toUrl(resolve('tsx'))
}

/** `node --import <tsx loader> <script> ...args`, ready for spawn(command, args) without a shell. */
export function nodeTsCommand(script: string, args: readonly string[] = [], opts: { execPath?: string; loaderUrl?: string } = {}): NodeCommand {
  return {
    command: opts.execPath ?? process.execPath,
    args: ['--import', opts.loaderUrl ?? tsxLoaderUrl(), script, ...args],
  }
}

export interface EntryPointOptions {
  platform?: NodeJS.Platform
  /** Resolves symlinks, junctions and (on Windows) the real case of the path. Returns the input when it fails. */
  realpath?: (path: string) => string
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * True when the module at `moduleUrl` (import.meta.url) is the script Node was started with
 * (`argv1`, process.argv[1]). Compares real paths, so a symlinked or junctioned project folder,
 * a subst drive or a drive letter typed in lower case (c:\ vs C:\) still counts. Windows paths
 * compare without case.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined, opts: EntryPointOptions = {}): boolean {
  if (!argv1) return false
  const platform = opts.platform ?? process.platform
  const windows = platform === 'win32'
  const realpath = opts.realpath ?? realpathOrSelf
  let modulePath: string
  try {
    modulePath = fileURLToPath(moduleUrl, { windows })
  } catch {
    return false
  }
  const path = windows ? win32 : posix
  const a = realpath(path.resolve(argv1))
  const b = realpath(path.resolve(modulePath))
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b
}
