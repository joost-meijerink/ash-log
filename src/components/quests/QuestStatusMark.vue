<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import type { QuestState } from '@/lib/progress'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * Compact quest status, decorative (the caller adds the state as text for screen readers).
 * With an order number it is a waypoint ring for the main story: filled when done, gold ring
 * when in progress, quiet when open. Without one it is a small diamond like a map marker.
 */
const props = withDefaults(
  defineProps<{
    state: QuestState
    /** Main story order. Shows a numbered ring instead of a diamond. */
    order?: number
    size?: 'sm' | 'md'
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { order: undefined, size: 'md', tone: undefined },
)

const tone = useTone(() => props.tone)
const dark = computed(() => tone.value === 'dark')

const ringClass = computed(() => {
  const s = props.state
  if (dark.value) {
    if (s === 'done') return 'border-gold bg-gold text-ink'
    if (s === 'active') return 'border-gold bg-leather text-gold shadow-[0_0_0_3px_rgba(201,162,74,0.14)]'
    return 'border-line-dark bg-leather text-muted-light'
  }
  if (s === 'done') return 'border-gold-ink bg-gold-ink text-parchment'
  if (s === 'active') return 'border-gold-ink bg-parchment text-gold-ink'
  return 'border-text-parchment/30 bg-parchment text-text-parchment/60'
})

const diamondClass = computed(() => {
  const s = props.state
  if (dark.value) {
    if (s === 'done') return 'border-gold bg-gold'
    if (s === 'active') return 'border-gold bg-[linear-gradient(135deg,transparent_50%,#c9a24a_50%)]'
    return 'border-muted-light/60 bg-transparent'
  }
  if (s === 'done') return 'border-gold-ink bg-gold-ink'
  if (s === 'active') return 'border-gold-ink bg-[linear-gradient(135deg,transparent_50%,#7a561a_50%)]'
  return 'border-text-parchment/40 bg-transparent'
})
</script>

<template>
  <span
    aria-hidden="true"
    data-slot="quest-status-mark"
    :data-state="state"
    :class="cn('relative grid shrink-0 place-content-center', size === 'md' ? 'size-7' : 'size-5', props.class)"
  >
    <span
      v-if="order !== undefined"
      :class="
        cn(
          'grid place-content-center rounded-full border font-display leading-none font-semibold tabular-nums transition-colors',
          size === 'md' ? 'size-7 text-[0.72rem]' : 'size-5 text-[0.6rem]',
          ringClass,
        )
      "
    >
      {{ order }}
    </span>
    <span
      v-else
      :class="
        cn(
          'rotate-45 rounded-[2px] border-[1.5px] transition-colors',
          size === 'md' ? 'size-3' : 'size-2.5',
          diamondClass,
        )
      "
    />
  </span>
</template>
