<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { cn } from '@/lib/utils'
import { QUEST_STATE_LABEL, type QuestState } from '@/lib/progress'
import QuestStatusMark from './QuestStatusMark.vue'

/** A quest as a small pill with its status, linking to it. Plain text when the quest is unknown. */
defineProps<{
  name: string
  state?: QuestState
  /** Main story order, shown in the ring. */
  order?: number
  to?: RouteLocationRaw
}>()
</script>

<template>
  <component
    :is="to ? RouterLink : 'span'"
    :to="to"
    data-slot="quest-chip"
    :class="
      cn(
        'relative inline-flex h-9 max-w-full items-center gap-2 rounded-full border border-gold-ink/30 bg-parchment/70 pr-3.5 pl-2 text-[0.93rem] leading-none text-text-parchment',
        to &&
          `transition-colors outline-none before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:border-gold-ink/60 hover:bg-parchment-deep focus-visible:ring-2 focus-visible:ring-gold-ink focus-visible:ring-offset-1 focus-visible:ring-offset-parchment`,
        !to && 'border-dashed',
      )
    "
  >
    <QuestStatusMark v-if="state" :state="state" :order="order" size="sm" tone="parchment" />
    <span lang="en" class="truncate">{{ name }}</span>
    <span v-if="state" class="sr-only">, {{ QUEST_STATE_LABEL[state] }}</span>
    <span v-else class="sr-only">, not in the log</span>
  </component>
</template>
