// Unique unlocks on the collections page: kinds, groups, counts, search and the URL state.
// Pure functions only, no Vue.

import {
  compareNames,
  compareRegions,
  emptyTally,
  isRegion,
  matchesQuery,
  searchKey,
  type Tally,
} from './collections-shared'
import type { Reward, RewardKind, RewardVia } from './types'

/**
 * Kinds shown and counted on the collections page, in display order: gear first,
 * then recipe books and fishing trophies. Plans (building decorations) are not tracked,
 * although the sync still reads them from the wiki.
 */
export const REWARD_KINDS: readonly RewardKind[] = [
  'pattern',
  'vestige',
  'quest',
  'effigy',
  'recipe-book',
  'fishing-trophy',
]

/** True for rewards of a kind the collections page tracks. */
export function isTrackedReward(reward: Pick<Reward, 'kind'>): boolean {
  return (REWARD_KINDS as readonly string[]).includes(reward.kind)
}

/** Only the rewards the collections page tracks (see REWARD_KINDS). */
export function trackedRewards(rewards: readonly Reward[]): Reward[] {
  return rewards.filter(isTrackedReward)
}

export const REWARD_KIND_LABEL: Record<RewardKind, string> = {
  plan: 'Plans',
  pattern: 'Patterns',
  vestige: 'Vestiges',
  quest: 'Questbeloningen',
  effigy: 'Effigies',
  'recipe-book': 'Receptenboeken',
  'fishing-trophy': 'Vistrofeeën',
}

export type KindFilter = RewardKind | 'all'

export const KIND_FILTERS: readonly KindFilter[] = ['all', ...REWARD_KINDS]

export function kindLabel(kind: KindFilter): string {
  return kind === 'all' ? 'Alles' : REWARD_KIND_LABEL[kind]
}

export function isRewardKind(value: unknown): value is RewardKind {
  return typeof value === 'string' && (REWARD_KINDS as readonly string[]).includes(value)
}

/** Done/total per kind, plus 'all'. Search and 'hide owned' do not change these. */
export function kindTallies(rewards: readonly Reward[], owned: ReadonlySet<string>): Record<KindFilter, Tally> {
  const out = Object.fromEntries(KIND_FILTERS.map((k) => [k, emptyTally()])) as Record<KindFilter, Tally>
  for (const r of rewards) {
    const has = owned.has(r.id)
    for (const key of ['all', r.kind] as const) {
      const t = out[key] ?? (out[key] = emptyTally())
      t.total++
      if (has) t.done++
    }
  }
  return out
}

/**
 * Group order inside a kind: named groups alphabetically ('Garou', 'Lighting'), then regions
 * in play order ('Brynmoor' before 'Fellhollow'), then rewards without a group.
 */
export function compareGroups(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  const ra = isRegion(a)
  const rb = isRegion(b)
  if (ra && rb) return compareRegions(a, b)
  if (ra) return 1
  if (rb) return -1
  return compareNames(a, b)
}

/* ------------------------------------------------------------------ */
/* How you get it: via labels and the wiki source                       */
/* ------------------------------------------------------------------ */

/** Display order of Reward.via. */
export const REWARD_VIA: readonly RewardVia[] = ['drops', 'shops']

/** Dutch labels for the source hints the sync reads from wiki templates. */
export const REWARD_VIA_LABEL: Record<RewardVia, string> = {
  drops: 'Drop van monsters',
  shops: 'Te koop in winkels',
}

/** Known via values in display order, without duplicates. */
export function rewardVia(r: Pick<Reward, 'via'>): RewardVia[] {
  const set = new Set<string>(r.via ?? [])
  return REWARD_VIA.filter((v) => set.has(v))
}

/** 'Drop van monsters, te koop in winkels'. Empty for no via. */
export function viaText(via: readonly RewardVia[]): string {
  return REWARD_VIA.filter((v) => via.includes(v))
    .map((v, i) => (i ? REWARD_VIA_LABEL[v].charAt(0).toLowerCase() + REWARD_VIA_LABEL[v].slice(1) : REWARD_VIA_LABEL[v]))
    .join(', ')
}

/** How you get a reward, as a row shows it: via labels (Dutch) and the wiki source (English). */
export interface RewardNote {
  via: RewardVia[]
  source?: string
}

export const isEmptyNote = (n: RewardNote): boolean => !n.via.length && !n.source

const noteKey = (n: RewardNote): string => `${n.via.join(',')}\n${n.source ?? ''}`

const withoutVia = (n: RewardNote, drop: readonly RewardVia[]): RewardNote => {
  const via = n.via.filter((v) => !drop.includes(v))
  return n.source ? { via, source: n.source } : { via }
}

/**
 * The note of one reward. A source that only repeats the vault link ('Dragonkin effigy in
 * Takla Kara') is left out. `vaultName` defaults to the vault id, which is the vault's name.
 */
export function rewardNote(r: Reward, vaultName: string | undefined = r.vaultId): RewardNote {
  const via = rewardVia(r)
  const source = r.source?.trim() || undefined
  if (!source) return { via }
  const repeatsVault = !!(r.vaultId && vaultName && source.toLowerCase().includes(vaultName.toLowerCase()))
  return repeatsVault ? { via } : { via, source }
}

/** What the rewards of one group have in common, shown once under the group heading. */
export interface GroupNote {
  /** Via that every reward in the group has. Left off the rows. */
  via: RewardVia[]
  /**
   * The rest of a note (after `via`) that `count` rewards share: all of them, or most of them
   * when every other reward has a note of its own. Left off the rows that carry it.
   */
  shared?: RewardNote & { count: number }
  /** Rewards in the group. */
  total: number
}

/**
 * The shared part of the notes in a group, so a long source is not repeated on every row.
 * A note is shared when at least two rewards carry it and either every reward does, or more
 * than half do and every other reward shows a note of its own (so a row without a note can
 * only be one that shares it). Undefined when nothing is shared.
 */
export function groupNote(rewards: readonly Reward[]): GroupNote | undefined {
  if (rewards.length < 2) return undefined
  const notes = rewards.map((r) => rewardNote(r))
  const via = REWARD_VIA.filter((v) => notes.every((n) => n.via.includes(v)))
  const rest = notes.map((n) => withoutVia(n, via))

  const counts = new Map<string, { note: RewardNote; count: number }>()
  for (const n of rest) {
    if (isEmptyNote(n)) continue
    const key = noteKey(n)
    const entry = counts.get(key)
    if (entry) entry.count++
    else counts.set(key, { note: n, count: 1 })
  }
  let shared: GroupNote['shared']
  let top: { note: RewardNote; count: number } | undefined
  for (const entry of counts.values()) if (!top || entry.count > top.count) top = entry
  if (top && top.count >= 2) {
    const all = top.count === rewards.length
    const most = top.count * 2 > rewards.length && rest.every((n) => !isEmptyNote(n))
    if (all || most) shared = { ...top.note, count: top.count }
  }

  if (!via.length && !shared) return undefined
  return shared ? { via, shared, total: rewards.length } : { via, total: rewards.length }
}

/** What a row still shows once its group note is shown above it. */
export function rowNote(r: Reward, group?: GroupNote, vaultName?: string): RewardNote {
  const note = rewardNote(r, vaultName)
  if (!group) return note
  const rest = withoutVia(note, group.via)
  if (group.shared && !isEmptyNote(rest) && noteKey(rest) === noteKey(group.shared)) return { via: [] }
  return rest
}

/**
 * Everything a search can hit: name, recipe, source, via labels, group, plus set,
 * requirement, quest and vault. Pass extra text (e.g. the quest's display name) when it differs.
 */
export function rewardHaystack(r: Reward, extra: readonly (string | undefined)[] = []): string {
  return searchKey(
    [
      r.name,
      r.recipe,
      r.source,
      ...rewardVia(r).map((v) => REWARD_VIA_LABEL[v]),
      r.group,
      r.set,
      r.requirement,
      r.questId,
      r.vaultId,
      ...extra,
    ]
      .filter(Boolean)
      .join(' \n '),
  )
}

export interface RewardFilter {
  kind: KindFilter
  query: string
  hideOwned: boolean
}

export interface RewardGroupView {
  key: string
  /** Sub-heading from the wiki ('Lighting', 'Brynmoor'). Undefined when the kind has no groups. */
  label?: string
  /** Counts over the whole group, ignoring search and 'hide owned'. */
  tally: Tally
  /** What the whole group shares (see groupNote), shown once instead of on every row. */
  note?: GroupNote
  /** Rewards to show, sorted by name. */
  rewards: Reward[]
}

export interface RewardKindBlock {
  kind: RewardKind
  label: string
  /** Counts over the whole kind, ignoring search and 'hide owned'. */
  tally: Tally
  groups: RewardGroupView[]
  /** Number of rewards shown in this block. */
  visible: number
}

export interface RewardListView {
  blocks: RewardKindBlock[]
  /** Rewards shown over all blocks. */
  visible: number
  /** Rewards in the selected kind(s) before search and 'hide owned'. */
  total: number
}

/**
 * Kind blocks with their groups for the unlock list. Blocks and groups with nothing to show
 * are left out; their counts always cover the full kind or group.
 * `haystacks` (reward id -> searchKey text) avoids rebuilding search text on every keystroke.
 */
export function buildRewardList(
  rewards: readonly Reward[],
  owned: ReadonlySet<string>,
  filter: RewardFilter,
  haystacks?: ReadonlyMap<string, string>,
): RewardListView {
  const kinds = filter.kind === 'all' ? REWARD_KINDS : [filter.kind]
  const query = filter.query.trim()
  const byKind = new Map<RewardKind, Map<string, { label?: string; all: Reward[] }>>()
  for (const r of rewards) {
    if (!kinds.includes(r.kind)) continue
    let groups = byKind.get(r.kind)
    if (!groups) byKind.set(r.kind, (groups = new Map()))
    const key = r.group ?? ''
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { label: r.group, all: [] }))
    g.all.push(r)
  }

  const blocks: RewardKindBlock[] = []
  let visible = 0
  let total = 0
  for (const kind of kinds) {
    const groups = byKind.get(kind)
    if (!groups) continue
    const kindTally = emptyTally()
    const views: RewardGroupView[] = []
    const ordered = [...groups.values()].sort((a, b) => compareGroups(a.label, b.label))
    for (const g of ordered) {
      const tally: Tally = { done: g.all.filter((r) => owned.has(r.id)).length, total: g.all.length }
      kindTally.done += tally.done
      kindTally.total += tally.total
      const shown = g.all
        .filter((r) => !(filter.hideOwned && owned.has(r.id)))
        .filter((r) => !query || matchesQuery(haystacks?.get(r.id) ?? rewardHaystack(r), query))
        .sort((a, b) => compareNames(a.name, b.name))
      if (!shown.length) continue
      const note = groupNote(g.all)
      views.push({ key: `${kind}:${g.label ?? ''}`, label: g.label, tally, ...(note ? { note } : {}), rewards: shown })
    }
    total += kindTally.total
    const count = views.reduce((n, g) => n + g.rewards.length, 0)
    visible += count
    if (views.length) blocks.push({ kind, label: REWARD_KIND_LABEL[kind], tally: kindTally, groups: views, visible: count })
  }
  return { blocks, visible, total }
}

/* ------------------------------------------------------------------ */
/* URL state: /verzamelingen?soort=<kind>&verberg=1                     */
/* ------------------------------------------------------------------ */

type QueryValue = string | null | undefined | readonly (string | null)[]

function first(value: QueryValue): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v : undefined
}

export interface CollectionUrlState {
  kind: KindFilter
  hideOwned: boolean
}

/** Reads ?soort= and ?verberg= (unknown values fall back to 'Alles' and off). */
export function parseCollectionQuery(query: Record<string, QueryValue>): CollectionUrlState {
  const kind = first(query.soort)
  const hide = first(query.verberg)
  return {
    kind: isRewardKind(kind) ? kind : 'all',
    hideOwned: hide === '1' || hide === 'true' || hide === 'ja',
  }
}

/**
 * The state after a link from another screen: what the link names wins, what it leaves out stays
 * as it was. '/verzamelingen#vault-x' names nothing, '?soort=quest' only the kind, and a value
 * that is not a kind ('?soort=all') asks for 'Alles'.
 *
 * `toList`: the link points at the unlock list itself ('#unlocks', the unlocks of a map point).
 * What it points at has to be in the list, so 'Verberg wat ik al heb' goes off unless the link
 * asks for it; a kept switch could hide exactly those unlocks.
 */
export function mergeCollectionQuery(
  query: Record<string, QueryValue>,
  kept: CollectionUrlState,
  toList = false,
): CollectionUrlState {
  const named = parseCollectionQuery(query)
  return {
    kind: query.soort === undefined ? kept.kind : named.kind,
    hideOwned: query.verberg === undefined && !toList ? kept.hideOwned : named.hideOwned,
  }
}

/** True when a link (its query and hash) points at the unlock list: it names a kind, or the hash is '#unlocks...'. */
export function targetsUnlockList(query: Record<string, QueryValue>, hash: string | undefined | null): boolean {
  return query.soort !== undefined || /^#unlocks(-|$)/.test(hash ?? '')
}

export function sameCollectionState(a: CollectionUrlState, b: CollectionUrlState): boolean {
  return a.kind === b.kind && a.hideOwned === b.hideOwned
}

/** The query for a state, keeping unrelated keys. Defaults are left out of the URL. */
export function collectionQuery(
  state: CollectionUrlState,
  base: Record<string, QueryValue> = {},
): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = { ...base }
  delete out.soort
  delete out.verberg
  if (state.kind !== 'all') out.soort = state.kind
  if (state.hideOwned) out.verberg = '1'
  return out
}
