import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultUserAgent, userAgentProblem, wikiUserAgent } from '../scripts/sync/wiki.ts'
import { desktopPaths, projectPaths, type AshLogPaths } from './paths.ts'
import { imageRoots, rawCacheRoots, reconcileSeed, syncedAtOf, wikiReadDir } from './wiki-source.ts'

let root: string
let paths: AshLogPaths

function meta(dir: string, syncedAt: string | null) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(syncedAt ? { syncedAt } : {}))
  writeFileSync(join(dir, 'map.json'), JSON.stringify({ from: dir }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ash-seed-'))
  paths = desktopPaths({ userData: join(root, 'user'), resources: join(root, 'res') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('wikiReadDir', () => {
  it('reads the project folder in the project layout', async () => {
    const project = projectPaths({})
    expect(await wikiReadDir(project)).toBe(project.wikiDir)
  })

  it('reads the seed until the first sync', async () => {
    meta(paths.seedWikiDir!, '2026-10-01T10:00:00Z')
    expect(await wikiReadDir(paths)).toBe(paths.seedWikiDir)
  })

  it('reads the user copy once it is at least as new as the seed', async () => {
    meta(paths.seedWikiDir!, '2026-10-01T10:00:00Z')
    meta(paths.wikiDir, '2026-10-01T10:00:00Z')
    expect(await wikiReadDir(paths)).toBe(paths.wikiDir)
    meta(paths.wikiDir, '2026-10-05T10:00:00Z')
    expect(await wikiReadDir(paths)).toBe(paths.wikiDir)
  })

  it('reads the seed when the app brought newer data', async () => {
    meta(paths.seedWikiDir!, '2026-11-01T10:00:00Z')
    meta(paths.wikiDir, '2026-10-05T10:00:00Z')
    expect(await wikiReadDir(paths)).toBe(paths.seedWikiDir)
  })

  it('treats a meta.json without a valid date as no data', async () => {
    meta(paths.seedWikiDir!, null)
    expect(await syncedAtOf(paths.seedWikiDir!)).toBeNull()
    expect(await wikiReadDir(paths)).toBe(paths.wikiDir)
  })
})

describe('reconcileSeed', () => {
  it('moves a stale user copy aside, keeps it, and says so', async () => {
    meta(paths.seedWikiDir!, '2026-11-01T10:00:00Z')
    meta(paths.wikiDir, '2026-10-05T10:00:00Z')
    const lines: string[] = []
    const moved = await reconcileSeed(paths, (l) => lines.push(l))
    expect(moved).toMatch(/wiki-old-2026-10-05T10-00-00Z$/)
    expect(readdirSync(moved!)).toContain('map.json')
    expect(lines.join('\n')).toMatch(/newer wiki data .*kept in/)
    expect(await wikiReadDir(paths)).toBe(paths.seedWikiDir)
  })

  it('leaves a user copy that is as new or newer alone', async () => {
    meta(paths.seedWikiDir!, '2026-10-01T10:00:00Z')
    meta(paths.wikiDir, '2026-10-05T10:00:00Z')
    expect(await reconcileSeed(paths)).toBeNull()
    expect(readdirSync(paths.wikiDir)).toContain('map.json')
  })

  it('picks a free name when an older copy was moved aside before', async () => {
    meta(paths.seedWikiDir!, '2026-11-01T10:00:00Z')
    meta(paths.wikiDir, '2026-10-05T10:00:00Z')
    const first = await reconcileSeed(paths)
    meta(paths.wikiDir, '2026-10-05T10:00:00Z')
    const second = await reconcileSeed(paths)
    expect(second).not.toBe(first)
    expect(second).toMatch(/-2$/)
  })
})

describe('images and the revision cache', () => {
  it('look in the user copy first, then the seed', () => {
    expect(imageRoots(paths)).toEqual([paths.imgDir, paths.seedImgDir])
    expect(rawCacheRoots(paths)).toEqual([paths.rawCacheDir, paths.seedRawCacheDir])
    const project = projectPaths({})
    expect(imageRoots(project)).toEqual([project.imgDir])
  })
})

describe('the wiki User-Agent', () => {
  it('uses WIKI_USER_AGENT when it is set', () => {
    expect(wikiUserAgent({ WIKI_USER_AGENT: 'Me (me@mail.nl)', ASH_LOG_APP_VERSION: '1.0.0' })).toBe('Me (me@mail.nl)')
  })

  it('falls back to the project URL only for the installed app', () => {
    expect(wikiUserAgent({ ASH_LOG_APP_VERSION: '1.2.3' })).toBe('AshLog/1.2.3 (https://github.com/joost-meijerink/ash-log)')
    expect(userAgentProblem(defaultUserAgent('1.2.3'))).toBeNull()
    expect(wikiUserAgent({})).toBe('')
  })

  it('keeps odd characters out of the version', () => {
    expect(defaultUserAgent('1.0 (beta)\n')).toBe('AshLog/1.0beta (https://github.com/joost-meijerink/ash-log)')
  })
})
