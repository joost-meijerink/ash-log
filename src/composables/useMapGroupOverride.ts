// Moves a map category to another group by hand (overrides.categoryGroup), or back to the group
// the sync picked. Handy for the categories the sync leaves under 'Other'. The change is a hand
// correction in overrides.json, so a resync never undoes it.

import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { GROUP_LABEL, withCategoryGroup } from '@/lib/map-groups'
import type { MapGroup } from '@/lib/types'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'

const NOTICE_MS = 6000

export type GroupOverrideMessage =
  | { kind: 'moved'; label: string; group: string; manual: boolean }
  | { kind: 'error'; label: string; text: string }

export function useMapGroupOverride() {
  const data = useDataStore()
  const connection = useConnectionStore()

  /** Category id being saved right now; every picker waits meanwhile. */
  const saving = ref<string | null>(null)
  /** Outcome of the last change, for the status line in the sidebar. */
  const message = shallowRef<GroupOverrideMessage | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  /** The Mac cannot be reached (offline on a phone): changes wait until it answers again. */
  const offline = computed(() => connection.readOnly)
  /** overrides.json could not be read (it stays read-only until it is fixed by hand), or the Mac cannot be reached. */
  const readOnly = computed(() => !!data.data?.overridesError || offline.value)

  /** The group set by hand for a category, if any. */
  function manualGroup(categoryId: string): MapGroup | undefined {
    return data.overrides.categoryGroup[categoryId]
  }

  function show(next: GroupOverrideMessage) {
    message.value = next
    if (timer) clearTimeout(timer)
    timer = next.kind === 'moved' ? setTimeout(() => (message.value = null), NOTICE_MS) : undefined
  }

  /** Moves a category to `group`, or back to the automatic group with null. */
  async function setGroup(categoryId: string, group: MapGroup | null) {
    if (readOnly.value || saving.value) return
    const label = data.categoryById.get(categoryId)?.label ?? categoryId
    saving.value = categoryId
    try {
      await data.saveOverrides((ov) => withCategoryGroup(ov, categoryId, group))
      const now = data.categoryById.get(categoryId)?.group
      show({ kind: 'moved', label, group: now ? GROUP_LABEL[now] : '', manual: group !== null })
    } catch (err) {
      show({ kind: 'error', label, text: (err as Error).message })
    } finally {
      saving.value = null
    }
  }

  function dismiss() {
    if (timer) clearTimeout(timer)
    timer = undefined
    message.value = null
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  return { saving, message, readOnly, offline, manualGroup, setGroup, dismiss }
}

export type MapGroupOverride = ReturnType<typeof useMapGroupOverride>
