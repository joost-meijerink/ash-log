// Live collections data for the Collections view: the pure helpers in src/lib/collections-*
// wired to the data and progress stores.

import { computed } from 'vue'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import {
  collectionSummary,
  indexRewardsByName,
  sortVaults,
  vaultAnchor,
  vaultRecipeGroups,
  type VaultRecipeGroup,
} from '@/lib/collections-vaults'
import { rewardHaystack, rewardRegion, trackedRewards } from '@/lib/collections-rewards'
import type { Vault } from '@/lib/types'

export interface VaultCardData {
  vault: Vault
  /** Element id, e.g. 'vault-takla-kara'. */
  anchor: string
  groups: VaultRecipeGroup[]
}

export function useCollections() {
  const data = useDataStore()
  const progress = useProgressStore()

  /** Reward ids ticked off (may include orphans; lookups by known id only). */
  const owned = computed<ReadonlySet<string>>(() => new Set(Object.keys(progress.state.rewards)))

  /** Rewards the page tracks: no plans (see REWARD_KINDS). */
  const rewards = computed(() => trackedRewards(data.rewards))

  const rewardIndex = computed(() => indexRewardsByName(rewards.value))

  const vaultCards = computed<VaultCardData[]>(() =>
    sortVaults(data.vaults).map((vault) => ({
      vault,
      anchor: vaultAnchor(vault.id),
      groups: vaultRecipeGroups(vault, rewardIndex.value, rewards.value),
    })),
  )

  /** Region per reward id (see rewardRegion), built once per data load. Rewards without one are left out. */
  const regions = computed<ReadonlyMap<string, string>>(() => {
    const lookup = {
      quest: (id: string) => data.questById.get(id)?.region,
      vault: (id: string) => data.vaultById.get(id)?.region,
      point: (id: string) => data.pointById.get(id)?.region,
    }
    const out = new Map<string, string>()
    for (const r of rewards.value) {
      const region = rewardRegion(r, lookup)
      if (region) out.set(r.id, region)
    }
    return out
  })

  /** Search text per reward id, built once per data load. Includes the quest and vault names and the region. */
  const haystacks = computed(() => {
    const out = new Map<string, string>()
    for (const r of rewards.value) {
      const quest = r.questId ? data.questById.get(r.questId)?.name : undefined
      const vault = r.vaultId ? data.vaultById.get(r.vaultId)?.name : undefined
      out.set(r.id, rewardHaystack(r, [quest, vault, regions.value.get(r.id)]))
    }
    return out
  })

  const summary = computed(() => collectionSummary(data.vaults, rewards.value, progress.state))

  return { owned, rewards, vaultCards, haystacks, regions, summary }
}
