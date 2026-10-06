// npm run sync [-- --only=map|quests|vaults|rewards[,..]] [--full] [--no-tiles]
//
// 1. Fetch and parse everything in memory (images go straight to /public/wiki-img).
// 2. Compare with the current /data/wiki/*.json.
// 3. Write the new files plus meta.json and report.json into /data/wiki, all or nothing.
// 4. Print the diff report. Orphaned progress is reported, never deleted.
//
// A fatal error aborts before any data file is written; only report.json records the failure.
// Progress and overrides are only read (orphan check), never written; they may be missing
// (a fresh clone has neither: they are per user and not in git).

import { join } from 'node:path'
import { emptyOverrides, emptyProgress, normalizeOverrides, normalizeProgress } from '../../src/lib/normalize'
import type { DiffReport, MapData, Quest, Reward, SyncDomain, SyncMeta, SyncWarning, Vault } from '../../src/lib/types'
import { syncAssets } from './assets'
import { createContext, warnCollector } from './context'
import { buildReport, findDanglingRefs, formatReport, plural, type WikiSnapshot } from './diff'
import { fetchMapSources, parseMap } from './domains/map'
import { fetchQuestSources, parseQuests } from './domains/quests'
import { fetchRewardSources, parseRewards } from './domains/rewards'
import { fetchVaultSources, parseVaults } from './domains/vaults'
import { loadEnvFile } from './env'
import { PartialWriteError, readJson, writeJsonAtomic, writeJsonFilesAtomic } from './files'
import { isEntryPoint } from './node-command'
import { OVERRIDES_FILE, PROGRESS_FILE, ROOT, WIKI_FILES } from './paths'
import { WikiClient } from './wiki'

const ALL_DOMAINS: SyncDomain[] = ['map', 'quests', 'vaults', 'rewards']
const DOMAIN_NAME: Record<SyncDomain, string> = { map: 'map', quests: 'quests', vaults: 'vaults', rewards: 'rewards' }

export interface SyncOptions {
  only?: SyncDomain[]
  full?: boolean
  tiles?: boolean
  log?: (message: string) => void
}

export async function runSync(options: SyncOptions = {}): Promise<DiffReport> {
  const log = options.log ?? ((m: string) => console.log(m))
  const started = Date.now()
  const syncedAt = new Date(started).toISOString()
  const warnings: SyncWarning[] = []

  // The wiki files are generated, so an unreadable one is rebuilt instead of blocking the sync.
  const rebuild = new Set<SyncDomain>()
  async function readPrev<T>(path: string, domain?: SyncDomain): Promise<T | null> {
    try {
      return await readJson<T | null>(path, null)
    } catch (err) {
      warnings.push({ source: 'sync', message: `${(err as Error).message}. The file will be rebuilt.` })
      if (domain) rebuild.add(domain)
      return null
    }
  }
  const prev: WikiSnapshot = {
    map: await readPrev<MapData>(WIKI_FILES.map, 'map'),
    quests: await readPrev<Quest[]>(WIKI_FILES.quests, 'quests'),
    vaults: await readPrev<Vault[]>(WIKI_FILES.vaults, 'vaults'),
    rewards: await readPrev<Reward[]>(WIKI_FILES.rewards, 'rewards'),
  }
  const prevMeta = await readPrev<SyncMeta>(WIKI_FILES.meta)

  const requested = options.only?.length ? options.only : ALL_DOMAINS
  const domains = expandDomains(requested, prev, rebuild)
  const order = ALL_DOMAINS.filter((d) => domains.has(d))
  const extra = order.filter((d) => !requested.includes(d))
  if (extra.length) log(`Also updating, since they depend on it: ${extra.map((d) => DOMAIN_NAME[d]).join(', ')}`)

  try {
    const userAgent = process.env.WIKI_USER_AGENT ?? ''
    const wiki = new WikiClient({ userAgent, log: (m) => log(`  ${m}`) })
    const ctx = createContext(wiki, log, !!options.full)

    let map = prev.map
    let icons: string[] = []
    if (domains.has('map')) {
      log('Map: fetching Module:Map pages')
      const result = parseMap(await fetchMapSources(ctx), warnCollector(warnings, 'map'))
      map = result.map
      icons = result.icons
      log(`Map: ${map.categories.length} categories, ${map.points.length} points`)
    }

    let quests = prev.quests
    if (domains.has('quests')) {
      log('Quests: fetching pages')
      quests = parseQuests(await fetchQuestSources(ctx), map!, warnCollector(warnings, 'quests'))
      log(`Quests: ${quests.length} quests`)
    }

    let vaults = prev.vaults
    if (domains.has('vaults')) {
      log('Vaults: fetching page')
      vaults = parseVaults(await fetchVaultSources(ctx), map!, warnCollector(warnings, 'vaults'))
      log(`Vaults: ${vaults.length} vaults`)
    }

    let rewards = prev.rewards
    if (domains.has('rewards')) {
      log('Rewards: fetching Consumable Recipes')
      rewards = parseRewards(await fetchRewardSources(ctx), { quests: quests ?? [], vaults: vaults ?? [], map }, warnCollector(warnings, 'rewards'))
      log(`Rewards: ${rewards.length} unique unlocks`)
    }

    if (domains.has('map')) {
      log('Images: checking icons and map tiles')
      const assets = await syncAssets(ctx, { icons, tiles: options.tiles !== false }, warnCollector(warnings, 'assets'))
      log(`Images: downloaded ${plural(assets.iconsDownloaded, 'new icon', 'new icons')} and ${plural(assets.tilesDownloaded, 'new tile', 'new tiles')}`)
    }

    const next: WikiSnapshot = { map, quests, vaults, rewards }
    warnings.push(...findDanglingRefs(next))

    // Progress and overrides are only read here (orphan check), never written by sync.
    // A hand-edited file with a typo skips the orphan check instead of failing the sync.
    let progress = emptyProgress()
    let overrides = emptyOverrides()
    try {
      progress = normalizeProgress(await readJson(PROGRESS_FILE, {}))
      overrides = normalizeOverrides(await readJson(OVERRIDES_FILE, {}))
    } catch (err) {
      progress = emptyProgress()
      overrides = emptyOverrides()
      warnings.push({ source: 'sync', message: `Orphaned progress not checked: ${(err as Error).message}` })
    }
    const report = buildReport({ syncedAt, domains: order, prev, next, progress, overrides, warnings })

    // Revisions: keep entries of domains that were not refreshed.
    const revisions: Record<string, number> = { ...(prevMeta?.revisions ?? {}) }
    for (const [title, revid] of ctx.revisions) revisions[title] = revid

    const meta: SyncMeta = {
      syncedAt,
      durationMs: Date.now() - started,
      domains: order,
      counts: {
        categories: map?.categories.length ?? 0,
        points: map?.points.length ?? 0,
        quests: quests?.length ?? 0,
        vaults: vaults?.length ?? 0,
        rewards: rewards?.length ?? 0,
      },
      revisions,
    }

    // Everything parsed: now write the data files. Sync writes only into /data/wiki and
    // /public/wiki-img (images, see assets.ts). All files are staged first and renamed
    // together, so a full disk cannot leave a new map.json next to an old quests.json.
    const files: [string, unknown][] = []
    if (domains.has('map') && map) files.push([WIKI_FILES.map, map])
    if (domains.has('quests') && quests) files.push([WIKI_FILES.quests, quests])
    if (domains.has('vaults') && vaults) files.push([WIKI_FILES.vaults, vaults])
    if (domains.has('rewards') && rewards) files.push([WIKI_FILES.rewards, rewards])
    files.push([WIKI_FILES.meta, meta], [WIKI_FILES.report, report])
    await writeJsonFilesAtomic(files)
    log(`Done in ${Math.round(meta.durationMs / 1000)} s, ${wiki.requestCount} requests to the wiki`)
    return report
  } catch (err) {
    const report: DiffReport = {
      syncedAt,
      ok: false,
      error: (err as Error).message,
      domains: order,
      orphans: { quests: [], steps: [], items: [], points: [], vaults: [], rewards: [] },
      warnings,
    }
    // Keep the original error if even the failure report cannot be written.
    await writeJsonAtomic(WIKI_FILES.report, report).catch((e) => log(`report.json not written: ${(e as Error).message}`))
    throw err
  }
}

/**
 * Which domains a sync refreshes. Upstream: a domain needs the files it is parsed
 * against (quests, vaults and rewards need the map, rewards need quests and vaults),
 * so missing ones are added. Downstream: whatever links into a refreshed domain is
 * refreshed too (quest start and vault pins point at map ids, rewards at quests,
 * vaults and map points), so no id keeps pointing into the old data. With the
 * revision cache the extra domains mostly cost revision checks.
 */
export function expandDomains(requested: readonly SyncDomain[], prev: WikiSnapshot, rebuild: ReadonlySet<SyncDomain> = new Set()): Set<SyncDomain> {
  const domains = new Set<SyncDomain>([...requested, ...rebuild])
  for (let size = -1; size !== domains.size; ) {
    size = domains.size
    if ((domains.has('quests') || domains.has('vaults') || domains.has('rewards')) && !prev.map) domains.add('map')
    if (domains.has('rewards') && !prev.quests) domains.add('quests')
    if (domains.has('rewards') && !prev.vaults) domains.add('vaults')
    if (domains.has('map')) {
      domains.add('quests')
      domains.add('vaults')
    }
    if (domains.has('quests') || domains.has('vaults')) domains.add('rewards')
  }
  return domains
}

function parseArgs(argv: string[]): SyncOptions {
  const opts: SyncOptions = {}
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      const names = arg.slice('--only='.length).split(/[|,]/).filter(Boolean)
      const bad = names.filter((n) => !ALL_DOMAINS.includes(n as SyncDomain))
      if (bad.length) throw new Error(`Unknown --only value: ${bad.join(', ')} (choose from ${ALL_DOMAINS.join(', ')})`)
      opts.only = names as SyncDomain[]
    } else if (arg === '--full') opts.full = true
    else if (arg === '--no-tiles') opts.tiles = false
    else throw new Error(`Unknown option: ${arg}`)
  }
  return opts
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  loadEnvFile(join(ROOT, '.env'))
  try {
    const report = await runSync(parseArgs(process.argv.slice(2)))
    console.log('\n' + formatReport(report))
  } catch (err) {
    const written = err instanceof PartialWriteError ? '' : ', nothing was written'
    console.error(`\nSync failed${written}: ${(err as Error).message}`)
    process.exitCode = 1
  }
}
