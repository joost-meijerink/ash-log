import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../scripts/sync/paths.ts'
import { desktopPaths, pathsFromEnv, pathsToEnv, projectPaths, resolvePaths, RESOURCES_ENV, USER_DATA_ENV } from './paths.ts'

describe('projectPaths', () => {
  it('keeps everything inside the project, as npm run app always did', () => {
    const p = projectPaths({})
    expect(p.layout).toBe('project')
    expect(p.userDataDir).toBeNull()
    expect(p.seedWikiDir).toBeNull()
    expect(p.distDir).toBe(join(ROOT, 'dist'))
    expect(p.progressFile).toBe(join(ROOT, 'data', 'progress.json'))
    expect(p.wikiDir).toBe(join(ROOT, 'data', 'wiki'))
    expect(p.imgDir).toBe(join(ROOT, 'public', 'wiki-img'))
    expect(p.localDir).toBe(join(ROOT, '.local'))
    expect(p.tlsDir).toBe(join(ROOT, '.local', 'tls'))
    expect(p.envFile).toBe(join(ROOT, '.env'))
  })

  it('moves only the local state for tests and CI (ASH_LOG_LOCAL_DIR)', () => {
    const p = projectPaths({ ASH_LOG_LOCAL_DIR: 'tmp-state' })
    expect(p.localDir).toBe(resolve(ROOT, 'tmp-state'))
    expect(p.serverStateFile).toBe(join(resolve(ROOT, 'tmp-state'), 'server.json'))
    expect(p.progressFile).toBe(join(ROOT, 'data', 'progress.json'))
  })
})

describe('desktopPaths', () => {
  const user = resolve('/tmp/ash user')
  const res = resolve('/Applications/Ash Log.app/Contents/Resources/app-files')
  const p = desktopPaths({ userData: user, resources: res })

  it('writes only to the per-user folder', () => {
    for (const file of [p.dataDir, p.progressFile, p.overridesFile, p.wikiDir, p.rawCacheDir, p.imgDir, p.localDir, p.tlsDir, p.logFile, p.pidFile, p.serverStateFile, p.envFile]) {
      expect(file.startsWith(user)).toBe(true)
    }
  })

  it('reads the app and the seed from the resources folder, in the project layout', () => {
    expect(p.distDir).toBe(join(res, 'dist'))
    expect(p.appIconsDir).toBe(join(res, 'public', 'icons'))
    expect(p.seedWikiDir).toBe(join(res, 'data', 'wiki'))
    expect(p.seedImgDir).toBe(join(res, 'public', 'wiki-img'))
    expect(p.seedRawCacheDir).toBe(join(res, 'data', 'wiki', '.raw'))
  })

  it('keeps the revision cache outside the wiki folder, so moving a stale copy aside keeps it', () => {
    expect(p.rawCacheDir.startsWith(p.wikiDir + sep)).toBe(false)
  })
})

describe('resolvePaths, pathsFromEnv and pathsToEnv', () => {
  it('picks the desktop layout only when a per-user folder is given', () => {
    expect(resolvePaths({ env: {} }).layout).toBe('project')
    expect(resolvePaths({ userData: '   ', env: {} }).layout).toBe('project')
    expect(resolvePaths({ userData: '/tmp/u' }).layout).toBe('desktop')
  })

  it('round-trips through the environment of a child process', () => {
    const desktop = desktopPaths({ userData: '/tmp/u', resources: '/tmp/r' })
    const env = pathsToEnv(desktop, { PATH: '/bin' })
    expect(env).toMatchObject({ PATH: '/bin', [USER_DATA_ENV]: resolve('/tmp/u'), [RESOURCES_ENV]: resolve('/tmp/r') })
    expect(pathsFromEnv(env)).toEqual(desktop)
  })

  it('clears inherited desktop variables for the project layout', () => {
    const env = pathsToEnv(projectPaths({}), { [USER_DATA_ENV]: '/old', [RESOURCES_ENV]: '/old' })
    expect(env[USER_DATA_ENV]).toBeUndefined()
    expect(env[RESOURCES_ENV]).toBeUndefined()
  })
})
