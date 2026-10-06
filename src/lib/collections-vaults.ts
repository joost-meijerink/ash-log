// Dragonkin vaults on the collections page: standard order, recipe-to-reward matching,
// recipes grouped by armour set, and the summary counts. Pure functions only.

import { slug } from './ids'
import { compareNames, type Tally } from './collections-shared'
import type { Progress, Reward, Vault } from './types'

/** Element id of a vault card: 'vault-crasorak-kara'. Deep links use '#vault-<slug>'. */
export function vaultAnchor(vaultId: string): string {
  return `vault-${slug(vaultId)}`
}

/** Standard progression order, then name (the two Umbral Sands vaults share order 11). */
export function sortVaults(vaults: readonly Vault[]): Vault[] {
  return [...vaults].sort((a, b) => a.order - b.order || compareNames(a.name, b.name))
}

/** Case- and punctuation-insensitive key for matching names: "Paladin's helm" = "Paladin's Helm". */
export function nameKey(name: string): string {
  return slug(name)
}

export type RewardIndex = Map<string, Reward[]>

/** Rewards by nameKey, keeping the input order within one name. */
export function indexRewardsByName(rewards: readonly Reward[]): RewardIndex {
  const index: RewardIndex = new Map()
  for (const r of rewards) {
    const key = nameKey(r.name)
    const list = index.get(key)
    if (list) list.push(r)
    else index.set(key, [r])
  }
  return index
}

/**
 * The reward a vault recipe unlocks. Prefers the effigy of this vault, then any reward of
 * this vault, then any reward with the same name (e.g. the quest reward 'Anti-Dragon Shield').
 */
export function matchRecipeReward(recipeName: string, vaultId: string, index: RewardIndex): Reward | undefined {
  const candidates = index.get(nameKey(recipeName))
  if (!candidates?.length) return undefined
  return (
    candidates.find((r) => r.kind === 'effigy' && r.vaultId === vaultId) ??
    candidates.find((r) => r.vaultId === vaultId) ??
    candidates[0]
  )
}

export interface VaultRecipeRow {
  /** Stable key for lists. */
  key: string
  /** Wiki text as listed for this vault. */
  name: string
  set?: string
  note?: string
  /** Matched unique unlock; undefined means plain text (nothing to tick off). */
  reward?: Reward
  /**
   * 'recipe': from the recipes table on the Dragonkin Vault page.
   * 'effigy': only listed as an effigy of this vault on Consumable Recipes.
   */
  origin: 'recipe' | 'effigy'
}

export interface VaultRecipeGroup {
  key: string
  /** Armour set label, e.g. 'Paladin armour set'. Undefined for loose recipes. */
  set?: string
  /** Effigies of this vault that the vault's own recipe table does not list. */
  extra: boolean
  rows: VaultRecipeRow[]
}

/**
 * Recipes of a vault, grouped by set in the order they first appear (loose recipes form one
 * group at the position of the first loose recipe). Effigies of this vault that no recipe
 * matched are added afterwards: to their set group when it exists, else to an 'extra' group.
 */
export function vaultRecipeGroups(vault: Vault, index: RewardIndex, rewards: readonly Reward[]): VaultRecipeGroup[] {
  const groups: VaultRecipeGroup[] = []
  const bySet = new Map<string, VaultRecipeGroup>()
  let loose: VaultRecipeGroup | undefined
  const matched = new Set<string>()

  const setGroup = (set: string, extra: boolean): VaultRecipeGroup => {
    let g = bySet.get(set)
    if (!g) {
      g = { key: `set:${slug(set)}`, set, extra, rows: [] }
      bySet.set(set, g)
      groups.push(g)
    }
    return g
  }

  vault.recipes.forEach((recipe, i) => {
    const reward = matchRecipeReward(recipe.name, vault.id, index)
    if (reward) matched.add(reward.id)
    const row: VaultRecipeRow = {
      key: `recipe:${i}:${nameKey(recipe.name)}`,
      name: recipe.name,
      set: recipe.set,
      note: recipe.note,
      reward,
      origin: 'recipe',
    }
    if (recipe.set) {
      setGroup(recipe.set, false).rows.push(row)
    } else {
      if (!loose) {
        loose = { key: 'loose', extra: false, rows: [] }
        groups.push(loose)
      }
      loose.rows.push(row)
    }
  })

  const extras = rewards
    .filter((r) => r.kind === 'effigy' && r.vaultId === vault.id && !matched.has(r.id))
    .sort((a, b) => compareNames(a.name, b.name))
  let extraGroup: VaultRecipeGroup | undefined
  for (const reward of extras) {
    const row: VaultRecipeRow = { key: `effigy:${reward.id}`, name: reward.name, set: reward.set, reward, origin: 'effigy' }
    if (reward.set) {
      setGroup(reward.set, !bySet.has(reward.set)).rows.push(row)
    } else {
      if (!extraGroup) extraGroup = { key: 'extra', extra: true, rows: [] }
      extraGroup.rows.push(row)
    }
  }
  if (extraGroup) groups.push(extraGroup)
  return groups
}

/** Unique rewards behind the rows of a vault card, in display order. */
export function vaultRewards(groups: readonly VaultRecipeGroup[]): Reward[] {
  const seen = new Map<string, Reward>()
  for (const g of groups) for (const row of g.rows) if (row.reward && !seen.has(row.reward.id)) seen.set(row.reward.id, row.reward)
  return [...seen.values()]
}

/** Rewards of a vault card that are not ticked off yet. */
export function uncheckedVaultRewards(groups: readonly VaultRecipeGroup[], owned: ReadonlySet<string>): Reward[] {
  return vaultRewards(groups).filter((r) => !owned.has(r.id))
}

/** How many of a vault card's rewards are ticked off. */
export function vaultRewardTally(groups: readonly VaultRecipeGroup[], owned: ReadonlySet<string>): Tally {
  const list = vaultRewards(groups)
  return { done: list.filter((r) => owned.has(r.id)).length, total: list.length }
}

export interface CollectionSummary {
  /** Unique unlocks ticked off. */
  rewards: Tally
  vaults: Tally
}

/** Top-of-page counts. Progress for ids the wiki no longer has (orphans) is not counted. */
export function collectionSummary(
  vaults: readonly Vault[],
  rewards: readonly Reward[],
  progress: Pick<Progress, 'vaults' | 'rewards'>,
): CollectionSummary {
  let vaultsDone = 0
  for (const v of vaults) if (progress.vaults[v.id]?.done) vaultsDone++
  return {
    rewards: { done: rewards.filter((r) => !!progress.rewards[r.id]).length, total: rewards.length },
    vaults: { done: vaultsDone, total: vaults.length },
  }
}
