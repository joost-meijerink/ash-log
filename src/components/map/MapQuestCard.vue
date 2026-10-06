<script setup lang="ts">
import { computed } from 'vue'
import { MapPinPlus, MapPinned, ScrollText, X } from 'lucide-vue-next'
import IconButton from '@/components/common/IconButton.vue'
import LocationText from '@/components/common/LocationText.vue'
import ParchmentPanel from '@/components/common/ParchmentPanel.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { positionKey } from '@/lib/map-links'
import { questState } from '@/lib/progress'
import { questKindLabel } from '@/lib/quests-detail'
import type { AppQuest } from '@/lib/types'
import { useMapContext } from '@/composables/useMapContext'
import { useConnectionStore } from '@/stores/connection'
import { useProgressStore } from '@/stores/progress'

/**
 * Card for a quest start. Several quests can start on the same spot; the selected one comes
 * first, the others follow on the same card.
 */
const props = defineProps<{ quest: AppQuest }>()
const emit = defineEmits<{ close: [] }>()

const progress = useProgressStore()
const connection = useConnectionStore()
const { model, state } = useMapContext()

const quests = computed<AppQuest[]>(() => {
  const start = props.quest.start
  if (!start) return [props.quest]
  const group = model.startGroups.value.find((g) => g.key === positionKey(start.x, start.y))
  const others = group ? group.quests.filter((q) => q.id !== props.quest.id) : []
  return [props.quest, ...others]
})

const sourceText = computed(() => {
  const start = props.quest.start
  if (!start) return 'No start point yet'
  return start.source === 'override' ? 'Your own pin' : 'From the wiki'
})

function questPath(id: string) {
  return `/quests/${encodeURIComponent(id)}`
}
</script>

<template>
  <ParchmentPanel as="article" :padded="false" class="flex flex-col" aria-labelledby="map-card-title">
    <header class="flex items-start gap-3 px-4 pt-4 sm:px-5">
      <span class="mt-0.5 grid size-10 shrink-0 place-content-center rounded-full border border-gold-ink/30 bg-gold-ink text-parchment">
        <MapPinned aria-hidden="true" class="size-5" :stroke-width="1.75" />
      </span>
      <div class="min-w-0 flex-1 pt-0.5">
        <p class="font-display text-[0.7rem] font-semibold tracking-[0.14em] text-gold-ink uppercase">
          Quest start · {{ sourceText }}
        </p>
        <h2 id="map-card-title" lang="en" class="mt-0.5 font-display text-lg leading-snug font-semibold text-balance break-words">
          {{ quest.name }}
        </h2>
      </div>
      <IconButton label="Close" size="icon-sm" class="-mt-1 -mr-2 shrink-0" @click="emit('close')">
        <X />
      </IconButton>
    </header>

    <ul class="flex flex-col px-4 pb-4 sm:px-5" role="list">
      <li
        v-for="(q, i) in quests"
        :key="q.id"
        :class="cn('flex flex-col gap-2.5', i === 0 ? 'pt-3' : 'mt-3 border-t border-gold-ink/15 pt-3')"
      >
        <h3 v-if="i > 0" lang="en" class="font-display text-base leading-snug font-semibold">{{ q.name }}</h3>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm text-text-parchment/70">{{ questKindLabel(q) }}</span>
          <StatusBadge :state="questState(q, progress.state.quests[q.id])" />
        </div>
        <LocationText v-if="q.location" as="p" pin lang="en" class="leading-relaxed">{{ q.location }}</LocationText>
        <p v-if="!q.start" class="text-sm text-text-parchment/75">
          The wiki doesn't give a spot on the map. Set a pin yourself so you can find the start again.
        </p>
        <div class="flex flex-wrap gap-2">
          <Button as-child :variant="i === 0 ? 'default' : 'outline'" size="sm">
            <RouterLink :to="questPath(q.id)">
              <ScrollText aria-hidden="true" />
              Open quest
            </RouterLink>
          </Button>
          <Button variant="outline" size="sm" :disabled="connection.readOnly" @click="state.startPin(q.id)">
            <MapPinPlus aria-hidden="true" />
            {{ q.start ? 'Move pin' : 'Set pin' }}
          </Button>
        </div>
      </li>
    </ul>
  </ParchmentPanel>
</template>
