<script setup lang="ts">
import { computed } from 'vue'
import { Info } from 'lucide-vue-next'
import SectionHeading from '@/components/common/SectionHeading.vue'
import { dependentsOf } from '@/lib/quests-detail'
import type { AppQuest } from '@/lib/types'
import { useQuestEntries } from '@/composables/useQuestEntries'
import { useQuestLink } from '@/composables/useQuestRoute'
import QuestChip from './QuestChip.vue'

/** Quests to finish first ('Do first') and quests that need this one ('Needed for'). */
const props = defineProps<{ quest: AppQuest }>()

const { entries, entryById } = useQuestEntries()
const linkFor = useQuestLink()

const requires = computed(() =>
  props.quest.requires.map((id) => {
    const entry = entryById.value.get(id)
    return { id, name: entry?.quest.name ?? id, entry }
  }),
)
const unfinished = computed(() => requires.value.filter((r) => r.entry && r.entry.state !== 'done'))
const dependents = computed(() =>
  dependentsOf(props.quest.id, entries.value.map((e) => e.quest)).map((q) => ({ quest: q, entry: entryById.value.get(q.id)! })),
)

const orderOf = (q: AppQuest | undefined) => (q?.kind === 'primary' ? q.order : undefined)
</script>

<template>
  <div class="flex flex-col gap-7">
    <section aria-labelledby="quest-requires-heading">
      <SectionHeading id="quest-requires-heading" title="Do first" />
      <ul v-if="requires.length" class="mt-2.5 flex flex-wrap gap-2" role="list">
        <li v-for="r in requires" :key="r.id" class="max-w-full">
          <QuestChip
            :name="r.name"
            :state="r.entry?.state"
            :order="orderOf(r.entry?.quest)"
            :to="r.entry ? linkFor(r.id) : undefined"
          />
        </li>
      </ul>
      <p v-else class="mt-2 text-text-parchment/70">Nothing, you can start right away.</p>

      <p v-if="unfinished.length" class="mt-3 flex gap-2 text-sm leading-snug text-text-parchment/75">
        <Info class="mt-px size-4 shrink-0 text-gold-ink" aria-hidden="true" />
        <span>
          Not done yet:
          <template v-for="(r, i) in unfinished" :key="r.id">{{ i ? ', ' : '' }}<span lang="en">{{ r.name }}</span></template>.
          You might not be able to start this quest yet.
        </span>
      </p>
    </section>

    <section v-if="dependents.length" aria-labelledby="quest-unlocks-heading">
      <SectionHeading id="quest-unlocks-heading" title="Needed for" :count="dependents.length" />
      <ul class="mt-2.5 flex flex-wrap gap-2" role="list">
        <li v-for="d in dependents" :key="d.quest.id" class="max-w-full">
          <QuestChip :name="d.quest.name" :state="d.entry.state" :order="orderOf(d.quest)" :to="linkFor(d.quest.id)" />
        </li>
      </ul>
    </section>
  </div>
</template>
