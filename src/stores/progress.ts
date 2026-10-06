// Progress (checkmarks), persisted to /data/progress.json via PUT /api/progress (debounced).
//
// Another tab or a hand edit can change progress.json while this tab is open. The api sends the
// ETag of the copy this tab last saw as If-Match; on a 409 the store merges its own changes onto
// the copy on disk (three-way, against `base`) and saves once more.
//
// On a phone that cannot reach the Mac (connection store) every change is refused: the app is
// read-only then. A save that failed because the Mac went away stays pending; when the Mac
// answers again, reconnect() merges it onto the copy on disk and sends it.

import { defineStore } from 'pinia'
import { computed, nextTick, ref, toRaw, watch } from 'vue'
import { api, type ProgressConflictError } from '@/lib/api'
import { emptyProgress, normalizeProgress } from '@/lib/normalize'
import { withoutOrphans } from '@/lib/orphans'
import { isEmptyQuestProgress, isEmptyVaultProgress, mergeProgress } from '@/lib/progress'
import type { Orphans, Progress, QuestProgress } from '@/lib/types'
import { useConnectionStore } from './connection'

const SAVE_DELAY_MS = 400

/** Shown when progress changed on disk twice while this tab was saving, so its own changes were dropped. */
export const PROGRESS_RELOADED_MESSAGE = 'Voortgang is elders gewijzigd en opnieuw geladen. Check je laatste vinkjes'

/** By name, not instanceof: tests mock '@/lib/api' without the class. */
const isConflict = (err: unknown): err is ProgressConflictError =>
  err instanceof Error && err.name === 'ProgressConflictError' && 'progress' in err

/** Plain deep copy; also works on reactive proxies. */
const clone = (p: Progress): Progress => JSON.parse(JSON.stringify(p))

export const useProgressStore = defineStore('progress', () => {
  const connection = useConnectionStore()
  const state = ref<Progress>(emptyProgress())
  const loaded = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  /** The error is a notice (progress was reloaded after a conflict), not a failed save. */
  const conflict = ref(false)
  /** Checkmarks can change: progress is loaded and the Mac can be reached. */
  const canEdit = computed(() => loaded.value && !connection.readOnly)
  /** Changes wait until the Mac answers again. */
  const readOnly = () => connection.readOnly

  let timer: ReturnType<typeof setTimeout> | undefined
  /** State has changes the server has not confirmed yet. */
  let dirty = false
  /** Last progress the server confirmed (load, save or conflict): the base of the three-way merge. */
  let base: Progress = emptyProgress()
  /** The next watcher run comes from the store itself (load, merge), not from the user: do not save it. */
  let skipNextChange = false
  /** Requests run one at a time, so the api's ETag, `base` and `state` always belong together. */
  let queue: Promise<unknown> = Promise.resolve()
  let running = 0

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    running++
    const run = queue.then(fn).finally(() => running--)
    queue = run.catch(() => undefined)
    return run
  }

  function setError(message: string | null, isConflictNotice = false) {
    error.value = message
    conflict.value = !!message && isConflictNotice
  }

  /** Puts a copy from the server in place without saving it back. */
  function adopt(server: Progress) {
    base = clone(server)
    skipNextChange = true
    state.value = server
  }

  /** A fresh copy from the server arrived. Keeps unsaved local changes on top of it. */
  function receive(server: Progress) {
    if (loaded.value && (dirty || timer)) {
      // The pending save sends the merged state (the watcher reschedules it).
      const merged = mergeProgress(base, clone(state.value), server)
      base = clone(server)
      state.value = merged
    } else {
      adopt(server)
    }
  }

  function load(): Promise<void> {
    return serial(async () => {
      try {
        // An offline copy only when nothing is loaded yet; never over newer checkmarks.
        receive(normalizeProgress(await api.progress({ acceptOffline: !loaded.value })))
        loaded.value = true
        setError(null)
      } catch (err) {
        setError((err as Error).message)
      }
    })
  }

  /**
   * Picks up changes from another tab or a hand edit (called when the tab gets focus again).
   * Only while nothing is waiting to be saved; failures stay silent, the next save reports them.
   */
  async function refresh(): Promise<void> {
    if (!loaded.value || dirty || timer || running > 0) return
    await serial(async () => {
      try {
        receive(normalizeProgress(await api.progress()))
      } catch {
        /* middleware not reachable; keep what is on screen */
      }
    })
  }

  /**
   * The Mac answers again after it could not be reached: fetch its copy (unsaved checkmarks
   * stay on top, merged three-way) and send what was waiting. The ETag makes sure this never
   * overwrites a newer copy on disk.
   */
  async function reconnect(): Promise<void> {
    if (!loaded.value) return load()
    let fetched = false
    await serial(async () => {
      try {
        receive(normalizeProgress(await api.progress()))
        fetched = true
      } catch {
        /* still not reachable; the next reconnect tries again */
      }
    })
    if (!fetched) return
    // receive() changed the state; let the watcher see that before sending.
    await nextTick()
    if (dirty || timer) await flush()
    // Nothing was waiting: an error from while the Mac was away is over (a conflict notice stays).
    else if (!conflict.value) setError(null)
  }

  async function save(keepalive: boolean) {
    if (!dirty || !loaded.value) return
    dirty = false
    saving.value = true
    const init: RequestInit = keepalive ? { keepalive: true } : {}
    const sent = clone(state.value)
    try {
      await api.saveProgress(sent, init)
      base = sent
      setError(null)
    } catch (err) {
      if (isConflict(err)) await resolveConflict(err.progress, init)
      else {
        dirty = true
        setError(`Opslaan mislukt: ${(err as Error).message}`)
      }
    } finally {
      saving.value = false
    }
  }

  /** Someone else saved first: merge this tab's changes onto their copy and retry once. */
  async function resolveConflict(serverCopy: Progress, init: RequestInit) {
    const server = normalizeProgress(serverCopy)
    const merged = mergeProgress(base, clone(state.value), server)
    base = clone(server)
    // `merged` holds every local change so far; later changes schedule their own save.
    if (timer) clearTimeout(timer)
    timer = undefined
    dirty = false
    skipNextChange = true
    state.value = merged
    const sent = clone(merged)
    try {
      await api.saveProgress(sent, init)
      base = sent
      setError(null)
    } catch (err) {
      if (isConflict(err)) {
        // Changed again in the meantime: take the copy on disk as it is and say so.
        if (timer) clearTimeout(timer)
        timer = undefined
        dirty = false
        adopt(normalizeProgress(err.progress))
        setError(PROGRESS_RELOADED_MESSAGE, true)
      } else {
        dirty = true
        setError(`Opslaan mislukt: ${(err as Error).message}`)
      }
    }
  }

  function flush(keepalive = false): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = undefined
    // The page is going away: send now instead of waiting for the queue.
    if (keepalive) return save(true)
    return serial(() => save(false))
  }

  watch(
    state,
    () => {
      if (skipNextChange) {
        skipNextChange = false
        return
      }
      if (!loaded.value) return
      dirty = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), SAVE_DELAY_MS)
    },
    { deep: true },
  )

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void flush(true))
  }

  const now = () => new Date().toISOString()

  function quest(questId: string): QuestProgress {
    if (!state.value.quests[questId]) state.value.quests[questId] = { steps: [], items: [] }
    return state.value.quests[questId]
  }

  /** Drops a quest or vault entry that holds nothing any more, so it can never show up as an orphan. */
  function pruneQuest(questId: string) {
    const qp = state.value.quests[questId]
    if (qp && isEmptyQuestProgress(qp)) delete state.value.quests[questId]
  }

  function pruneVault(vaultId: string) {
    const vp = state.value.vaults[vaultId]
    if (vp && isEmptyVaultProgress(vp)) delete state.value.vaults[vaultId]
  }

  function toggleIn(list: string[], id: string, on?: boolean) {
    const has = list.includes(id)
    const want = on ?? !has
    if (want && !has) list.push(id)
    if (!want && has) list.splice(list.indexOf(id), 1)
  }

  connection.onReconnect(reconnect)

  return {
    state,
    loaded,
    saving,
    error,
    conflict,
    canEdit,
    load,
    refresh,
    reconnect,
    flush,
    /** Dismisses the error or notice in the header. */
    clearError: () => setError(null),

    isStepDone: (questId: string, stepId: string) => !!state.value.quests[questId]?.steps.includes(stepId),
    toggleStep(questId: string, stepId: string, on?: boolean) {
      if (readOnly()) return
      toggleIn(quest(questId).steps, stepId, on)
      pruneQuest(questId)
    },
    isItemDone: (questId: string, itemId: string) => !!state.value.quests[questId]?.items.includes(itemId),
    toggleItem(questId: string, itemId: string, on?: boolean) {
      if (readOnly()) return
      toggleIn(quest(questId).items, itemId, on)
      pruneQuest(questId)
    },
    setQuestDone(questId: string, done: boolean) {
      if (readOnly()) return
      const qp = quest(questId)
      if (done) qp.done = true
      else delete qp.done
      pruneQuest(questId)
    },
    /** Drops checked item ids that are no longer in the quest's item list (after editing the list). */
    keepItems(questId: string, keep: ReadonlySet<string>) {
      if (readOnly()) return
      const qp = state.value.quests[questId]
      if (!qp) return
      qp.items = qp.items.filter((id) => keep.has(id))
      pruneQuest(questId)
    },
    resetQuest(questId: string) {
      if (readOnly()) return
      delete state.value.quests[questId]
    },

    isPointFound: (pointId: string) => !!state.value.points[pointId],
    togglePoint(pointId: string, on?: boolean) {
      if (readOnly()) return
      const want = on ?? !state.value.points[pointId]
      if (want) state.value.points[pointId] = { foundAt: now() }
      else delete state.value.points[pointId]
    },

    isVaultDone: (vaultId: string) => !!state.value.vaults[vaultId]?.done,
    setVaultDone(vaultId: string, done: boolean) {
      if (readOnly()) return
      const vp = (state.value.vaults[vaultId] ??= {})
      if (done) vp.done = true
      else delete vp.done
      pruneVault(vaultId)
    },

    hasReward: (rewardId: string) => !!state.value.rewards[rewardId],
    toggleReward(rewardId: string, on?: boolean) {
      if (readOnly()) return
      const want = on ?? !state.value.rewards[rewardId]
      if (want) state.value.rewards[rewardId] = { at: now() }
      else delete state.value.rewards[rewardId]
    },

    removeOrphans(orphans: Orphans) {
      if (readOnly()) return
      state.value = withoutOrphans(toRaw(state.value), orphans)
    },
  }
})
