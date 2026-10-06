// Compares the previous /data/wiki files with the new sync result and finds
// progress that no longer points at anything. Pure: no I/O.

import { findOrphans } from '../../src/lib/orphans'
import { PARTIAL_WRITE_PREFIX } from './files'
import type {
  DiffReport,
  ListDiff,
  MapData,
  Orphans,
  Overrides,
  Progress,
  Quest,
  QuestStep,
  Reward,
  SyncDomain,
  SyncWarning,
  Vault,
} from '../../src/lib/types'

export interface WikiSnapshot {
  map: MapData | null
  quests: Quest[] | null
  vaults: Vault[] | null
  rewards: Reward[] | null
}

export interface ReportInput {
  syncedAt: string
  domains: SyncDomain[]
  prev: WikiSnapshot
  /** Complete new state (domains not refreshed carry the previous data). */
  next: WikiSnapshot
  progress: Progress
  /** Read-only: override item ids keep checked items from being reported as orphans. */
  overrides?: Overrides
  warnings: SyncWarning[]
}

type QuestStepDiff = NonNullable<DiffReport['quests']>['steps'][number]

export function buildReport(input: ReportInput): DiffReport {
  const { prev, next } = input
  const refreshed = new Set(input.domains)
  const report: DiffReport = {
    syncedAt: input.syncedAt,
    ok: true,
    domains: [...input.domains],
    orphans: sortOrphans(
      findOrphans(
        { map: next.map, quests: next.quests, vaults: next.vaults, rewards: next.rewards, overrides: input.overrides },
        input.progress,
      ),
    ),
    warnings: [...input.warnings],
  }

  if (refreshed.has('map')) report.map = diffMap(prev.map, next.map)
  if (refreshed.has('quests')) {
    report.quests = {
      quests: diffById(prev.quests, next.quests, (q) => q.id),
      steps: diffSteps(prev.quests, next.quests),
    }
  }
  if (refreshed.has('vaults')) report.vaults = { vaults: diffById(prev.vaults, next.vaults, (v) => v.id) }
  if (refreshed.has('rewards')) report.rewards = { rewards: diffById(prev.rewards, next.rewards, (r) => r.id) }
  return report
}

/**
 * References between domains that point at nothing: a quest start or vault pin that is
 * not on the map, a reward linked to a quest, vault or map point that does not exist.
 * mergeAppData and the app silently drop such links, so the report names them.
 * A domain that was never synced (null) is not checked.
 */
export function findDanglingRefs(next: WikiSnapshot): SyncWarning[] {
  const out: SyncWarning[] = []
  const hint = 'Draai een volledige sync.'
  const pointIds = next.map ? new Set(next.map.points.map((p) => p.id)) : null
  const questIds = next.quests ? new Set(next.quests.map((q) => q.id)) : null
  const vaultIds = next.vaults ? new Set(next.vaults.map((v) => v.id)) : null

  if (pointIds) {
    for (const q of next.quests ?? []) {
      if (q.startPointId && !pointIds.has(q.startPointId)) {
        out.push({ source: 'sync', page: q.id, message: `startpunt ${q.startPointId} staat niet (meer) op de kaart. ${hint}` })
      }
    }
    for (const v of next.vaults ?? []) {
      if (v.pointId && !pointIds.has(v.pointId)) {
        out.push({ source: 'sync', page: v.id, message: `kaartpunt ${v.pointId} staat niet (meer) op de kaart. ${hint}` })
      }
    }
  }
  for (const r of next.rewards ?? []) {
    if (questIds && r.questId && !questIds.has(r.questId)) {
      out.push({ source: 'sync', message: `Beloning ${r.id} verwijst naar quest ${r.questId}, die bestaat niet (meer). ${hint}` })
    }
    if (vaultIds && r.vaultId && !vaultIds.has(r.vaultId)) {
      out.push({ source: 'sync', message: `Beloning ${r.id} verwijst naar vault ${r.vaultId}, die bestaat niet (meer). ${hint}` })
    }
    if (pointIds) {
      for (const pointId of r.pointIds ?? []) {
        if (!pointIds.has(pointId)) {
          out.push({ source: 'sync', message: `Beloning ${r.id} verwijst naar kaartpunt ${pointId}, dat staat niet (meer) op de kaart. ${hint}` })
        }
      }
    }
  }
  return out
}

/**
 * added/removed by id, changed = present on both sides with a different deep value.
 * `null` (never synced) counts as empty, so a first sync reports everything as added.
 */
export function diffById<T>(
  prev: readonly T[] | null | undefined,
  next: readonly T[] | null | undefined,
  idOf: (item: T) => string,
): ListDiff {
  const before = indexBy(prev ?? [], idOf)
  const after = indexBy(next ?? [], idOf)
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [id, item] of after) {
    if (!before.has(id)) added.push(id)
    else if (canonical(before.get(id)) !== canonical(item)) changed.push(id)
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id)
  return { added: sortIds(added), removed: sortIds(removed), changed: sortIds(changed) }
}

export function hasChanges(d: ListDiff): boolean {
  return d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0
}

function diffMap(prev: MapData | null, next: MapData | null): NonNullable<DiffReport['map']> {
  const categories = diffById(prev?.categories, next?.categories, (c) => c.id)
  const before = groupBy(prev?.points ?? [], (p) => p.categoryId)
  const after = groupBy(next?.points ?? [], (p) => p.categoryId)
  const points: Record<string, ListDiff> = {}
  for (const categoryId of sortIds([...new Set([...before.keys(), ...after.keys()])])) {
    const d = diffById(before.get(categoryId), after.get(categoryId), (p) => p.id)
    if (hasChanges(d)) points[categoryId] = d
  }
  return { categories, points }
}

/**
 * Step changes of quests that exist on both sides. New and removed quests already
 * show up in the quest ListDiff; listing all their steps would only add noise.
 * Steps keep their walkthrough order.
 */
function diffSteps(prev: Quest[] | null, next: Quest[] | null): QuestStepDiff[] {
  const before = new Map((prev ?? []).map((q) => [q.id, q]))
  const out: QuestStepDiff[] = []
  for (const quest of [...(next ?? [])].sort((a, b) => compareIds(a.id, b.id))) {
    const old = before.get(quest.id)
    if (!old) continue
    const added = stepsNotIn(quest.steps, old.steps)
    const removed = stepsNotIn(old.steps, quest.steps)
    if (added.length || removed.length) out.push({ questId: quest.id, added, removed })
  }
  return out
}

function stepsNotIn(steps: QuestStep[], other: QuestStep[]): { id: string; text: string }[] {
  const otherIds = new Set(other.map((s) => s.id))
  const seen = new Set<string>()
  const out: { id: string; text: string }[] = []
  for (const s of steps) {
    if (otherIds.has(s.id) || seen.has(s.id)) continue
    seen.add(s.id)
    out.push({ id: s.id, text: s.text })
  }
  return out
}

function sortOrphans(o: Orphans): Orphans {
  const clean = (ids: string[]) => sortIds([...new Set(ids)])
  return {
    quests: clean(o.quests),
    steps: clean(o.steps),
    items: clean(o.items),
    points: clean(o.points),
    vaults: clean(o.vaults),
    rewards: clean(o.rewards),
  }
}

/** JSON with sorted object keys; undefined fields vanish, so `{ a: undefined }` equals `{}`. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return v
    const obj = v as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) sorted[key] = obj[key]
    return sorted
  })
}

function indexBy<T>(items: readonly T[], idOf: (item: T) => string): Map<string, T> {
  const out = new Map<string, T>()
  for (const item of items) out.set(idOf(item), item)
  return out
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const list = out.get(key)
    if (list) list.push(item)
    else out.set(key, [item])
  }
  return out
}

/** Code-unit order: the same on every machine, unlike localeCompare. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortIds(ids: string[]): string[] {
  return ids.sort(compareIds)
}

/* ------------------------------------------------------------------ */
/* Terminal summary                                                    */
/* ------------------------------------------------------------------ */

const DOMAIN_LABEL: Record<SyncDomain, string> = {
  map: 'Kaart',
  quests: 'Quests',
  vaults: 'Vaults',
  rewards: 'Beloningen',
}

const SOURCE_LABEL: Record<SyncWarning['source'], string> = {
  ...DOMAIN_LABEL,
  assets: 'Afbeeldingen',
  sync: 'Sync',
}

const SOURCE_ORDER: SyncWarning['source'][] = ['sync', 'map', 'quests', 'vaults', 'rewards', 'assets']

const ORPHAN_LABEL: Record<keyof Orphans, [one: string, many: string]> = {
  quests: ['quest', 'quests'],
  steps: ['stap', 'stappen'],
  items: ['item', 'items'],
  points: ['kaartpunt', 'kaartpunten'],
  vaults: ['vault', 'vaults'],
  rewards: ['beloning', 'beloningen'],
}

const MAX_WARNINGS = 40
const MAX_CATEGORY_LINES = 15
const MAX_STEP_QUESTS = 10
const MAX_STEP_LINES = 3

/** Human-readable Dutch summary for the terminal. */
export function formatReport(report: DiffReport): string {
  const lines: string[] = []
  const when = formatTime(report.syncedAt)

  if (!report.ok) {
    lines.push(`Sync mislukt (${when}): ${report.error ?? 'onbekende fout'}`)
    // The sync writes all files in two phases, so a failure normally leaves everything as it was.
    if (report.error?.startsWith(PARTIAL_WRITE_PREFIX)) {
      lines.push('Je voortgang is onveranderd, maar de wiki-data is half bijgewerkt. Draai de sync opnieuw.')
    } else {
      lines.push('Er is niets weggeschreven, je data en voortgang zijn onveranderd.')
    }
  } else {
    const names = report.domains.map((d) => DOMAIN_LABEL[d].toLowerCase()).join(', ')
    lines.push(`Sync gelukt (${when})${names ? `, bijgewerkt: ${names}` : ''}`)
    lines.push('')

    if (report.map) {
      const pointDiffs = Object.entries(report.map.points)
      lines.push('Kaart')
      lines.push(`  Categorieën: ${countLine(report.map.categories)}`)
      lines.push(`  Punten: ${countLine(sumDiffs(pointDiffs.map(([, d]) => d)))}`)
      const ranked = pointDiffs.sort(([a, da], [b, db]) => total(db) - total(da) || compareIds(a, b))
      for (const [categoryId, d] of ranked.slice(0, MAX_CATEGORY_LINES)) {
        lines.push(`    ${categoryId}: ${countLine(d, true)}`)
      }
      if (ranked.length > MAX_CATEGORY_LINES) lines.push(`    en ${ranked.length - MAX_CATEGORY_LINES} categorieën meer`)
    }

    if (report.quests) {
      lines.push(`Quests: ${countLine(report.quests.quests)}`)
      const steps = report.quests.steps
      if (steps.length) {
        lines.push(`  Stappen gewijzigd in ${plural(steps.length, 'quest', 'quests')} (vinkjes op weggevallen stappen raken verweesd):`)
        for (const s of steps.slice(0, MAX_STEP_QUESTS)) {
          lines.push(`    ${s.questId}: ${s.added.length} nieuw, ${s.removed.length} weg`)
          lines.push(...stepLines('-', s.removed), ...stepLines('+', s.added))
        }
        if (steps.length > MAX_STEP_QUESTS) lines.push(`    en ${steps.length - MAX_STEP_QUESTS} quests meer`)
      }
    }

    if (report.vaults) lines.push(`Vaults: ${countLine(report.vaults.vaults)}`)
    if (report.rewards) lines.push(`Beloningen: ${countLine(report.rewards.rewards)}`)

    lines.push('')
    lines.push(...orphanLines(report.orphans))
  }

  lines.push(...warningLines(report.warnings))
  return lines.join('\n')
}

function countLine(d: ListDiff, skipZero = false): string {
  if (!hasChanges(d)) return 'geen wijzigingen'
  const parts: [number, string][] = [
    [d.added.length, 'nieuw'],
    [d.removed.length, 'weg'],
    [d.changed.length, 'gewijzigd'],
  ]
  return parts
    .filter(([n]) => !skipZero || n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(', ')
}

function sumDiffs(diffs: ListDiff[]): ListDiff {
  return {
    added: diffs.flatMap((d) => d.added),
    removed: diffs.flatMap((d) => d.removed),
    changed: diffs.flatMap((d) => d.changed),
  }
}

function total(d: ListDiff): number {
  return d.added.length + d.removed.length + d.changed.length
}

function stepLines(sign: '+' | '-', steps: { text: string }[]): string[] {
  const out = steps.slice(0, MAX_STEP_LINES).map((s) => `      ${sign} ${truncate(s.text, 100)}`)
  if (steps.length > MAX_STEP_LINES) out.push(`      ${sign} en ${steps.length - MAX_STEP_LINES} meer`)
  return out
}

function orphanLines(o: Orphans): string[] {
  const parts = (Object.keys(ORPHAN_LABEL) as (keyof Orphans)[])
    .filter((key) => o[key].length > 0)
    .map((key) => plural(o[key].length, ...ORPHAN_LABEL[key]))
  if (!parts.length) return ['Geen verweesde voortgang.']
  const count = (Object.keys(ORPHAN_LABEL) as (keyof Orphans)[]).reduce((n, key) => n + o[key].length, 0)
  return [
    `Verweesde voortgang: ${count} (${parts.join(', ')})`,
    '  Sync verwijdert niets. Ruim het op in de app, daar staat een knop voor.',
  ]
}

function warningLines(warnings: SyncWarning[]): string[] {
  if (!warnings.length) return []
  const out = ['', `Waarschuwingen: ${warnings.length}`]
  const sources = [...SOURCE_ORDER, ...new Set(warnings.map((w) => w.source).filter((s) => !SOURCE_ORDER.includes(s)))]
  let budget = MAX_WARNINGS
  for (const source of sources) {
    const group = warnings.filter((w) => w.source === source)
    if (!group.length || budget <= 0) continue
    out.push(`  ${SOURCE_LABEL[source] ?? source} (${group.length})`)
    for (const w of group.slice(0, budget)) {
      out.push(`    ${truncate(w.page ? `${w.page}: ${w.message}` : w.message, 200)}`)
    }
    budget -= Math.min(group.length, budget)
  }
  const hidden = warnings.length - (MAX_WARNINGS - budget)
  if (hidden > 0) out.push(`  en ${hidden} meer (zie data/wiki/report.json)`)
  return out
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
