// Map category groups: fixed order, headings, and which groups can be ticked off.
// Pure, no DOM: this file is also type-checked by the Node config.

import type { MapCategory, MapGroup, Overrides } from './types'

/** Order of the filter groups in the sidebar. */
export const GROUP_ORDER: readonly MapGroup[] = [
  'resource',
  'chest',
  'unique',
  'lore',
  'quest',
  'vault',
  'npc',
  'monster',
  'location',
  'other',
]

/** Headings for the sidebar. */
export const GROUP_LABEL: Record<MapGroup, string> = {
  resource: 'Resources',
  chest: 'Chests',
  unique: 'Unique unlocks',
  lore: 'Lore',
  quest: 'Quests',
  vault: 'Vaults',
  npc: 'NPCs',
  monster: 'Monsters',
  location: 'Places',
  other: 'Other',
}

/**
 * Groups with one-time things you can tick off on the map. Chests and resources reset,
 * so they never get a found state (see docs/spikes.md).
 */
const TRACKABLE: ReadonlySet<MapGroup> = new Set<MapGroup>(['lore', 'unique'])

export function isTrackableGroup(group: MapGroup | undefined): boolean {
  return !!group && TRACKABLE.has(group)
}

/** Groups with more categories than this get their own mini filter. */
export const LARGE_GROUP_SIZE = 12

export interface CategoryGroup {
  group: MapGroup
  label: string
  categories: MapCategory[]
}

/** Case- and accent-insensitive label comparison, so 'Child’s Storybook' sorts with the C's. */
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

export function compareLabels(a: string, b: string): number {
  return collator.compare(a, b)
}

/**
 * Categories grouped in GROUP_ORDER, each group sorted by label. Empty groups are left out.
 * Unknown groups (a newer sync, a bad override) land in 'other' instead of disappearing.
 */
export function groupCategories(categories: readonly MapCategory[]): CategoryGroup[] {
  const buckets = new Map<MapGroup, MapCategory[]>()
  for (const category of categories) {
    const group = GROUP_ORDER.includes(category.group) ? category.group : 'other'
    const list = buckets.get(group)
    if (list) list.push(category)
    else buckets.set(group, [category])
  }
  const out: CategoryGroup[] = []
  for (const group of GROUP_ORDER) {
    const list = buckets.get(group)
    if (!list?.length) continue
    out.push({ group, label: GROUP_LABEL[group], categories: [...list].sort((a, b) => compareLabels(a.label, b.label)) })
  }
  return out
}

/**
 * Overrides with one category moved to `group` (overrides.categoryGroup), or back to the group
 * the sync picked when `group` is null. Everything else is kept as it is.
 */
export function withCategoryGroup<T extends Pick<Overrides, 'categoryGroup'>>(overrides: T, categoryId: string, group: MapGroup | null): T {
  const categoryGroup = { ...overrides.categoryGroup }
  if (group) categoryGroup[categoryId] = group
  else delete categoryGroup[categoryId]
  return { ...overrides, categoryGroup }
}
