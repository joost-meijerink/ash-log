// Every file location of Ash Log in one place, for the app server, the dev middleware and the sync.
//
// Two layouts:
//   project  everything inside the cloned project (npm run dev, npm run app, npm run sync, the
//            Swift app and the Windows launcher): data/, data/wiki, public/wiki-img, dist/, .local/, .env
//   desktop  the installed app: read-only app files in a resources folder (dist/, public/ and the
//            bundled wiki data and images as a seed, in the same layout as the project) and
//            everything writable in a per-user folder (see desktopPaths).
//
// The desktop layout is picked with options (resolvePaths) or, for a child process such as the
// sync, with ASH_LOG_USER_DATA and ASH_LOG_RESOURCES (pathsFromEnv, pathsToEnv).

import { join, resolve } from 'node:path'
import { DATA_DIR, OVERRIDES_FILE, PROGRESS_FILE, PUBLIC_IMG_DIR, RAW_CACHE_DIR, ROOT, WIKI_DIR } from '../scripts/sync/paths.ts'

/** The per-user folder: switches to the desktop layout. */
export const USER_DATA_ENV = 'ASH_LOG_USER_DATA'
/** The read-only app folder of the desktop layout (default: the project). */
export const RESOURCES_ENV = 'ASH_LOG_RESOURCES'

export interface AshLogPaths {
  layout: 'project' | 'desktop'
  /** The per-user folder of the desktop layout (Electron's userData). Null in the project layout. */
  userDataDir: string | null
  /** Read-only: the folder holding dist/, public/ and data/wiki (the project itself in the project layout). */
  resourcesDir: string
  /** Read-only: the built app (vite build). */
  distDir: string
  /** Read-only: sw.js and other public files. */
  publicDir: string
  /** Read-only: the app icons, served as /icons/*. */
  appIconsDir: string
  /** Read-only: the wiki data that ships with the app (meta.json and the rest). Null in the project layout. */
  seedWikiDir: string | null
  /** Read-only: the icons and map tiles that ship with the app. Null in the project layout. */
  seedImgDir: string | null
  /** Read-only: the revision cache that ships with the app (may be missing). Null in the project layout. */
  seedRawCacheDir: string | null
  /** Writable from here on. Holds progress.json, overrides.json and the wiki folder. */
  dataDir: string
  progressFile: string
  overridesFile: string
  /** Where a sync writes the wiki data. Reads fall back to seedWikiDir, see wiki-source.ts. */
  wikiDir: string
  /** Raw page cache of the sync, keyed by revision id. */
  rawCacheDir: string
  /** Where a sync writes icons (icons/) and map tiles (tiles/). Reads fall back to seedImgDir. */
  imgDir: string
  /** Machine-local server state: paired devices, certificates, log, pid. */
  localDir: string
  serverStateFile: string
  tlsDir: string
  logFile: string
  pidFile: string
  /** Optional settings (WIKI_USER_AGENT, APP_PORT, LIVE_ADDRESS). */
  envFile: string
}

/**
 * Where the machine-local server state lives in the project layout: .local, or ASH_LOG_LOCAL_DIR
 * (for tests and CI only, so a test server never touches the real paired devices or certificate).
 */
export function localDir(env: NodeJS.ProcessEnv = process.env, root = ROOT): string {
  const override = env.ASH_LOG_LOCAL_DIR?.trim()
  return override ? resolve(root, override) : join(root, '.local')
}

function withLocal(dir: string) {
  return {
    localDir: dir,
    serverStateFile: join(dir, 'server.json'),
    tlsDir: join(dir, 'tls'),
    logFile: join(dir, 'server.log'),
    pidFile: join(dir, 'server.pid'),
  }
}

/** Today's layout inside the project. */
export function projectPaths(env: NodeJS.ProcessEnv = process.env): AshLogPaths {
  const publicDir = join(ROOT, 'public')
  return {
    layout: 'project',
    userDataDir: null,
    resourcesDir: ROOT,
    distDir: join(ROOT, 'dist'),
    publicDir,
    appIconsDir: join(publicDir, 'icons'),
    seedWikiDir: null,
    seedImgDir: null,
    seedRawCacheDir: null,
    dataDir: DATA_DIR,
    progressFile: PROGRESS_FILE,
    overridesFile: OVERRIDES_FILE,
    wikiDir: WIKI_DIR,
    rawCacheDir: RAW_CACHE_DIR,
    imgDir: PUBLIC_IMG_DIR,
    ...withLocal(localDir(env)),
    envFile: join(ROOT, '.env'),
  }
}

export interface DesktopPathOptions {
  /** The per-user folder (Electron's userData). A relative path resolves against the working directory. */
  userData: string
  /** The read-only app folder in the project layout (dist/, public/, data/wiki). Default: the project. */
  resources?: string
}

/**
 * The installed app. In `userData`:
 *   .env                  optional settings
 *   data/progress.json    checkmarks
 *   data/overrides.json   own corrections
 *   data/wiki/            wiki data after the first sync (until then the seed is read)
 *   data/wiki-old-*       a copy moved aside because the app brought newer data (wiki-source.ts)
 *   data/wiki-cache/      the sync's revision cache (outside wiki/, so it survives that move)
 *   wiki-img/             icons and map tiles a sync downloads (reads fall back to the seed)
 *   server/               server.json (paired devices), tls/, server.log, server.pid
 * In `resources`: dist/, public/ (icons/, sw.js, wiki-img/ as the image seed) and data/wiki
 * (the data seed, with .raw as an optional revision cache seed).
 */
export function desktopPaths(opts: DesktopPathOptions): AshLogPaths {
  const userData = resolve(opts.userData)
  const resources = resolve(opts.resources ?? ROOT)
  const publicDir = join(resources, 'public')
  const dataDir = join(userData, 'data')
  const seedWikiDir = join(resources, 'data', 'wiki')
  return {
    layout: 'desktop',
    userDataDir: userData,
    resourcesDir: resources,
    distDir: join(resources, 'dist'),
    publicDir,
    appIconsDir: join(publicDir, 'icons'),
    seedWikiDir,
    seedImgDir: join(publicDir, 'wiki-img'),
    seedRawCacheDir: join(seedWikiDir, '.raw'),
    dataDir,
    progressFile: join(dataDir, 'progress.json'),
    overridesFile: join(dataDir, 'overrides.json'),
    wikiDir: join(dataDir, 'wiki'),
    rawCacheDir: join(dataDir, 'wiki-cache'),
    imgDir: join(userData, 'wiki-img'),
    ...withLocal(join(userData, 'server')),
    envFile: join(userData, '.env'),
  }
}

export interface PathOptions {
  /** Set: the desktop layout with this per-user folder. Unset: the project layout. */
  userData?: string
  resources?: string
  /** For ASH_LOG_LOCAL_DIR in the project layout. */
  env?: NodeJS.ProcessEnv
}

export function resolvePaths(opts: PathOptions = {}): AshLogPaths {
  const userData = opts.userData?.trim()
  return userData ? desktopPaths({ userData, resources: opts.resources?.trim() || undefined }) : projectPaths(opts.env)
}

/** The paths this process was started with: ASH_LOG_USER_DATA and ASH_LOG_RESOURCES, else the project. */
export function pathsFromEnv(env: NodeJS.ProcessEnv = process.env): AshLogPaths {
  return resolvePaths({ userData: env[USER_DATA_ENV], resources: env[RESOURCES_ENV], env })
}

/**
 * The environment for a child process (the sync) that must use the same paths: `base` with
 * ASH_LOG_USER_DATA and ASH_LOG_RESOURCES set for the desktop layout and removed for the project.
 */
export function pathsToEnv(paths: AshLogPaths, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env[USER_DATA_ENV]
  delete env[RESOURCES_ENV]
  if (paths.userDataDir) {
    env[USER_DATA_ENV] = paths.userDataDir
    env[RESOURCES_ENV] = paths.resourcesDir
  }
  return env
}
