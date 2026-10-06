<script setup lang="ts">
import { computed } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import ProgressBar from '@/components/common/ProgressBar.vue'
import { cn } from '@/lib/utils'
import { QUEST_STATE_LABEL } from '@/lib/progress'
import type { QuestEntry } from '@/lib/quests-list'
import type { AppQuest } from '@/lib/types'
import QuestStatusMark from './QuestStatusMark.vue'

/** One quest in the list: status mark, name and step progress. The whole row is the link. */
const props = withDefaults(
  defineProps<{
    entry: QuestEntry<AppQuest>
    to: RouteLocationRaw
    selected?: boolean
    /** Show the main story order in a numbered ring. */
    numbered?: boolean
    /** Story path line above and below the mark: gold when the leg is walked. */
    pathAbove?: 'done' | 'todo'
    pathBelow?: 'done' | 'todo'
  }>(),
  { selected: false, numbered: false, pathAbove: undefined, pathBelow: undefined },
)

const emit = defineEmits<{ select: [questId: string] }>()

const quest = computed(() => props.entry.quest)

const progressText = computed(() => {
  const { state, stepsDone, stepsTotal } = props.entry
  if (state === 'done') return 'Done'
  if (!stepsTotal) return 'No steps'
  return `${stepsDone} / ${stepsTotal}`
})

const srText = computed(() => {
  const { state, stepsDone, stepsTotal } = props.entry
  const steps = stepsTotal ? `, ${stepsDone} of ${stepsTotal} ${stepsTotal === 1 ? 'step' : 'steps'}` : ''
  return `, ${QUEST_STATE_LABEL[state]}${state === 'done' ? '' : steps}`
})

const pathClass = (leg: 'done' | 'todo') => (leg === 'done' ? 'bg-gold/60' : 'bg-line-dark')
</script>

<template>
  <RouterLink
    :to="to"
    data-quest-row
    :data-quest-id="quest.id"
    :aria-current="selected ? 'page' : undefined"
    :class="
      cn(
        'group relative flex min-h-14 items-stretch gap-3 rounded-md pr-2 pl-2 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-inset',
        selected ? 'bg-line-dark/60 shadow-[inset_2px_0_0_#c9a24a]' : 'hover:bg-line-dark/30',
      )
    "
    @click="emit('select', quest.id)"
  >
    <span class="relative flex w-7 shrink-0 items-center justify-center" aria-hidden="true">
      <span v-if="pathAbove" :class="cn('absolute top-0 bottom-1/2 left-1/2 w-px -translate-x-1/2', pathClass(pathAbove))" />
      <span v-if="pathBelow" :class="cn('absolute top-1/2 bottom-0 left-1/2 w-px -translate-x-1/2', pathClass(pathBelow))" />
      <QuestStatusMark :state="entry.state" :order="numbered ? quest.order : undefined" tone="dark" />
    </span>

    <span class="flex min-w-0 flex-1 flex-col justify-center gap-1.5 py-2.5">
      <span
        :class="
          cn(
            'leading-snug font-medium transition-colors',
            selected ? 'text-text-light' : entry.state === 'done' ? 'text-text-light/60 group-hover:text-text-light/85' : 'text-text-light',
          )
        "
      >
        <span lang="en">{{ quest.name }}</span><span class="sr-only">{{ srText }}</span>
      </span>
      <span class="flex items-center gap-2.5 text-xs text-muted-light" aria-hidden="true">
        <ProgressBar v-if="entry.stepsTotal" :value="entry.fraction" tone="dark" class="flex-1" />
        <span :class="cn('shrink-0 tabular-nums', entry.state === 'done' && 'text-gold/80')">{{ progressText }}</span>
      </span>
    </span>
  </RouterLink>
</template>
