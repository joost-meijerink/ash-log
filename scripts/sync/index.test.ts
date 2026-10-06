// runSync orchestration with the domain parsers, the assets and the data paths
// mocked. Never touches /data or the wiki.

import { readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mapPointId } from '../../src/lib/ids'
import type { DiffReport, MapData, Quest, Reward, SyncDomain, Vault } from '../../src/lib/types'
import type { WikiSnapshot } from './diff'
import { expandDomains, runSync } from './index'
import * as paths from './paths'

vi.mock('./paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'ashenfall-sync-'))
  const DATA_DIR = join(root, 'data')
  const WIKI_DIR = join(DATA_DIR, 'wiki')
  const PUBLIC_IMG_DIR = join(root, 'public', 'wiki-img')
  return {
    ROOT: root,
    DATA_DIR,
    WIKI_DIR,
    RAW_CACHE_DIR: join(WIKI_DIR, '.raw'),
    PROGRESS_FILE: join(DATA_DIR, 'progress.json'),
    OVERRIDES_FILE: join(DATA_DIR, 'overrides.json'),
    WIKI_FILES: {
      map: join(WIKI_DIR, 'map.json'),
      quests: join(WIKI_DIR, 'quests.json'),
      vaults: join(WIKI_DIR, 'vaults.json'),
      rewards: join(WIKI_DIR, 'rewards.json'),
      meta: join(WIKI_DIR, 'meta.json'),
      report: join(WIKI_DIR, 'report.json'),
    },
    PUBLIC_IMG_DIR,
    ICONS_DIR: join(PUBLIC_IMG_DIR, 'icons'),
    TILES_DIR: join(PUBLIC_IMG_DIR, 'tiles'),
    FIXTURES_DIR: join(root, 'fixtures'),
  }
})

/** What the fake wiki currently says. */
const wiki = vi.hoisted(() => ({ pinX: 100, rewardQuest: 'Ratcatcher' }))
const fsHook = vi.hoisted(() => ({ failWrite: null as null | ((path: string) => boolean) }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const writeFile = (async (path: Parameters<typeof orig.writeFile>[0], ...rest: unknown[]) => {
    if (fsHook.failWrite?.(String(path))) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    return (orig.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest)
  }) as typeof orig.writeFile
  return { ...orig, writeFile, default: { ...orig, writeFile } }
})

vi.mock('./domains/map', () => ({
  fetchMapSources: async () => ({}),
  parseMap: (): { map: MapData; icons: string[] } => ({
    map: {
      categories: [{ id: 'ratcatcher', label: 'Ratcatcher', group: 'quest', sources: [], count: 1 }],
      points: [{ id: mapPointId('ratcatcher', wiki.pinX, 200), categoryId: 'ratcatcher', x: wiki.pinX, y: 200 }],
    },
    icons: [],
  }),
}))

vi.mock('./domains/quests', () => ({
  fetchQuestSources: async () => ({}),
  parseQuests: (_src: unknown, map: MapData): Quest[] => [
    {
      id: 'Ratcatcher',
      name: 'Ratcatcher',
      kind: 'primary',
      location: 'Fellhollow',
      startPointId: map.points.find((p) => p.categoryId === 'ratcatcher')?.id,
      steps: [],
      stepsSource: 'walkthrough',
      items: [],
      rewards: [],
      requires: [],
      wikiUrl: '',
    },
  ],
}))

vi.mock('./domains/vaults', () => ({
  fetchVaultSources: async () => ({}),
  parseVaults: (): Vault[] => [{ id: 'Crasorak Kara', name: 'Crasorak Kara', order: 1, power: 1, area: 'Temple Woods', recipes: [] }],
}))

vi.mock('./domains/rewards', () => ({
  fetchRewardSources: async () => ({}),
  parseRewards: (): Reward[] => [{ id: 'quest:rat-hat', kind: 'quest', name: 'Rat Hat', questId: wiki.rewardQuest }],
}))

vi.mock('./assets', () => ({
  syncAssets: async () => ({ iconsDownloaded: 0, iconsExisting: 0, iconsMissing: [], tilesDownloaded: 0, tilesExisting: 0, tilesNotFound: 0, failed: 0 }),
}))

const readData = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T
const quiet = { log: () => {} }

beforeEach(async () => {
  process.env.WIKI_USER_AGENT = 'AshenfallLogboek-test/0.1 (test@ash-log.test)'
  wiki.pinX = 100
  wiki.rewardQuest = 'Ratcatcher'
  fsHook.failWrite = null
  await rm(paths.DATA_DIR, { recursive: true, force: true })
  await mkdir(paths.DATA_DIR, { recursive: true })
})

afterAll(async () => {
  await rm(paths.ROOT, { recursive: true, force: true })
})

describe('expandDomains', () => {
  const full: WikiSnapshot = { map: { categories: [], points: [] }, quests: [], vaults: [], rewards: [] }
  const sorted = (s: Set<SyncDomain>) => [...s].sort()

  it('refreshes everything that links into a refreshed domain', () => {
    expect(sorted(expandDomains(['map'], full))).toEqual(['map', 'quests', 'rewards', 'vaults'])
    expect(sorted(expandDomains(['quests'], full))).toEqual(['quests', 'rewards'])
    expect(sorted(expandDomains(['vaults'], full))).toEqual(['rewards', 'vaults'])
    expect(sorted(expandDomains(['rewards'], full))).toEqual(['rewards'])
  })

  it('adds missing prerequisites', () => {
    expect(sorted(expandDomains(['rewards'], { ...full, quests: null }))).toEqual(['quests', 'rewards'])
    expect(sorted(expandDomains(['rewards'], { ...full, map: null }))).toEqual(['map', 'quests', 'rewards', 'vaults'])
  })

  it('adds domains whose file must be rebuilt', () => {
    expect(sorted(expandDomains(['rewards'], full, new Set<SyncDomain>(['vaults'])))).toEqual(['rewards', 'vaults'])
  })
})

describe('runSync', () => {
  it('keeps quest start pins valid after a map-only sync', async () => {
    await runSync(quiet)
    wiki.pinX = 140
    const lines: string[] = []
    const report = await runSync({ log: (m) => lines.push(m), only: ['map'] })
    expect(lines[0]).toBe('Ook bijgewerkt, omdat ze samenhangen: quests, vaults, beloningen')

    expect(report.domains).toEqual(['map', 'quests', 'vaults', 'rewards'])
    const map = await readData<MapData>(paths.WIKI_FILES.map)
    const quests = await readData<Quest[]>(paths.WIKI_FILES.quests)
    expect(map.points.map((p) => p.id)).toEqual(['ratcatcher:140:200'])
    expect(quests[0]!.startPointId).toBe('ratcatcher:140:200')
    expect(report.warnings).toEqual([])
  })

  it('warns about links that point at nothing', async () => {
    wiki.rewardQuest = 'Gone Quest'
    const report = await runSync(quiet)
    expect(report.warnings.map((w) => w.message)).toContainEqual(expect.stringContaining('verwijst naar quest Gone Quest'))
  })

  it('runs on a fresh clone without progress.json, overrides.json or a data folder, and creates neither', async () => {
    await rm(paths.DATA_DIR, { recursive: true, force: true })
    const report = await runSync(quiet)
    expect(report.ok).toBe(true)
    expect(report.warnings).toEqual([])
    expect((await readData<MapData>(paths.WIKI_FILES.map)).points).toHaveLength(1)
    expect((await readdir(paths.DATA_DIR)).sort()).toEqual(['wiki'])
  })

  it('finishes with a warning when progress.json or overrides.json is broken', async () => {
    await writeFile(paths.PROGRESS_FILE, JSON.stringify({ version: 1, points: { 'gone:1:1': { foundAt: 'x' } } }))
    await writeFile(paths.OVERRIDES_FILE, '{ "questStart": { "A": { "x": 1, "y": 2 }, } }')
    const report = await runSync(quiet)

    expect(report.ok).toBe(true)
    expect(report.warnings).toContainEqual({
      source: 'sync',
      message: expect.stringMatching(/^Verweesde voortgang niet gecontroleerd: overrides\.json is geen geldige JSON/),
    })
    expect(report.orphans.points).toEqual([])
    expect((await readData<MapData>(paths.WIKI_FILES.map)).points).toHaveLength(1)
  })

  it('rebuilds a wiki file it cannot read', async () => {
    await runSync(quiet)
    await writeFile(paths.WIKI_FILES.quests, '{ broken')
    const report = await runSync({ ...quiet, only: ['vaults'] })

    expect(report.domains).toEqual(['quests', 'vaults', 'rewards'])
    expect(report.warnings[0]!.message).toMatch(/^quests\.json is geen geldige JSON: .*Het bestand wordt opnieuw opgebouwd\.$/)
    expect((await readData<Quest[]>(paths.WIKI_FILES.quests))[0]!.id).toBe('Ratcatcher')
  })

  it('writes nothing but the failure report when the disk fills up halfway', async () => {
    await runSync(quiet)
    const mapBefore = await readFile(paths.WIKI_FILES.map, 'utf8')
    const metaBefore = await readFile(paths.WIKI_FILES.meta, 'utf8')
    wiki.pinX = 140
    fsHook.failWrite = (path) => path.includes('quests.json.') && path.endsWith('.tmp')

    await expect(runSync(quiet)).rejects.toThrow(/ENOSPC/)

    expect(await readFile(paths.WIKI_FILES.map, 'utf8')).toBe(mapBefore)
    expect(await readFile(paths.WIKI_FILES.meta, 'utf8')).toBe(metaBefore)
    const report = await readData<DiffReport>(paths.WIKI_FILES.report)
    expect(report).toMatchObject({ ok: false, error: expect.stringMatching(/ENOSPC/) })
    expect((await readdir(paths.WIKI_DIR)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
