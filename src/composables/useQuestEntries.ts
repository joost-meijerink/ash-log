// All quests with their live progress state, in list order.

import { computed, type ComputedRef } from 'vue'
import { orderEntries, questEntry, type QuestEntry } from '@/lib/quests-list'
import type { AppQuest } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'

export function useQuestEntries(): {
  entries: ComputedRef<QuestEntry<AppQuest>[]>
  entryById: ComputedRef<Map<string, QuestEntry<AppQuest>>>
} {
  const data = useDataStore()
  const progress = useProgressStore()

  const entries = computed(() => orderEntries(data.quests.map((q) => questEntry(q, progress.state.quests[q.id]))))
  const entryById = computed(() => new Map(entries.value.map((e) => [e.quest.id, e])))

  return { entries, entryById }
}
