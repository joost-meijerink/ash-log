// Wiki data merged with overrides, as served by GET /api/data.
//
// On a phone that cannot reach the Mac, the service worker may answer with the last copy it
// kept. That copy is only taken while nothing is on screen yet (a cold start); the connection
// store then runs the app read-only until the Mac answers again, and this store reloads.

import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { api } from '@/lib/api'
import type { AppData, AppQuest, MapCategory, MapPoint, Overrides, Reward, Vault } from '@/lib/types'
import { useConnectionStore } from './connection'

/** Why a change is refused while the Mac cannot be reached. */
export const READ_ONLY_MESSAGE = "Your computer can't be reached. Changes can wait until it's back"

/**
 * What can change without a sync (overrides, a hand-fixed overrides.json) plus the sync itself.
 * Wiki data only changes through a sync, which always writes a new meta and report.
 */
function fingerprint(d: AppData): string {
  return JSON.stringify([d.ready, d.meta?.syncedAt, d.lastReport?.syncedAt, d.overrides, d.overridesError ?? null])
}

export const useDataStore = defineStore('data', () => {
  const connection = useConnectionStore()
  const data = shallowRef<AppData | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Overrides saves in progress. */
  let savingOverrides = 0
  /** Bumped by every load and refresh, so a slow refresh never overwrites newer data. */
  let generation = 0

  async function load() {
    generation++
    loading.value = true
    error.value = null
    try {
      // An offline copy only when there is nothing to show yet; never over newer data.
      data.value = await api.data({ acceptOffline: !data.value })
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  /**
   * Quiet reload when the tab gets focus again, so overrides edited by hand or in another tab
   * show up before the next edit. Only swaps in the new data when something changed, so the
   * views (and the map layers) do not rebuild for nothing.
   */
  async function refresh() {
    if (loading.value || savingOverrides > 0 || !data.value) return
    const gen = ++generation
    try {
      const next = await api.data()
      if (gen !== generation) return
      if (!data.value || fingerprint(next) !== fingerprint(data.value)) data.value = next
      error.value = null
    } catch (err) {
      if (gen === generation) error.value = (err as Error).message
    }
  }

  /**
   * Changes overrides.json. Reloads first so the update starts from what is on disk
   * (another tab or a hand edit may have changed it), then writes and reloads again,
   * because the merge with the wiki data happens server side.
   */
  async function saveOverrides(update: (current: Overrides) => Overrides) {
    if (connection.readOnly) throw new Error(READ_ONLY_MESSAGE)
    savingOverrides++
    try {
      await load()
      if (error.value) throw new Error(error.value)
      if (data.value?.overridesError) throw new Error(data.value.overridesError)
      await api.saveOverrides(update(overrides.value))
      await load()
    } finally {
      savingOverrides--
    }
  }

  // Back online after the Mac could not be reached: quietly fetch what may have changed.
  connection.onReconnect(() => (data.value ? refresh() : load()))

  const ready = computed(() => !!data.value?.ready)
  const meta = computed(() => data.value?.meta)
  const lastReport = computed(() => data.value?.lastReport)
  const overrides = computed<Overrides>(() => data.value?.overrides ?? { questStart: {}, questItems: {}, categoryGroup: {} })
  const categories = computed<MapCategory[]>(() => data.value?.map.categories ?? [])
  const points = computed<MapPoint[]>(() => data.value?.map.points ?? [])
  const quests = computed<AppQuest[]>(() => data.value?.quests ?? [])
  const vaults = computed<Vault[]>(() => [...(data.value?.vaults ?? [])].sort((a, b) => a.order - b.order))
  const rewards = computed<Reward[]>(() => data.value?.rewards ?? [])

  const categoryById = computed(() => new Map(categories.value.map((c) => [c.id, c])))
  const pointById = computed(() => new Map(points.value.map((p) => [p.id, p])))
  const questById = computed(() => new Map(quests.value.map((q) => [q.id, q])))
  const vaultById = computed(() => new Map(vaults.value.map((v) => [v.id, v])))
  const rewardById = computed(() => new Map(rewards.value.map((r) => [r.id, r])))
  const pointsByCategory = computed(() => {
    const out = new Map<string, MapPoint[]>()
    for (const p of points.value) {
      const list = out.get(p.categoryId)
      if (list) list.push(p)
      else out.set(p.categoryId, [p])
    }
    return out
  })

  return {
    data,
    loading,
    error,
    load,
    refresh,
    saveOverrides,
    ready,
    meta,
    lastReport,
    overrides,
    categories,
    points,
    quests,
    vaults,
    rewards,
    categoryById,
    pointById,
    questById,
    vaultById,
    rewardById,
    pointsByCategory,
  }
})
