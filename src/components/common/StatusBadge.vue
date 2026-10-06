<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Check } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { QUEST_STATE_LABEL, type QuestState } from '@/lib/progress'
import type { Tone } from '@/composables/useTone'

/** Quest status label: 'Open' (quiet), 'Bezig' (gold), 'Voltooid' (filled, with a check). */
const props = defineProps<{
  state: QuestState
  tone?: Tone
  class?: HTMLAttributes['class']
}>()

const VARIANT = { open: 'outline', active: 'default', done: 'solid' } as const
</script>

<template>
  <Badge :variant="VARIANT[state]" :tone="tone" :class="props.class" :data-state="state">
    <Check v-if="state === 'done'" aria-hidden="true" :stroke-width="3" />
    {{ QUEST_STATE_LABEL[state] }}
  </Badge>
</template>
