<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * Section heading: Cinzel in spaced capitals, an optional count, a hairline rule that fills
 * the rest of the line, and an optional `right` slot for actions.
 */
const props = withDefaults(
  defineProps<{
    /** Heading text. The default slot replaces it when given. */
    title?: string
    /** Shown after the title, e.g. 12 or '3 / 8'. Hidden when undefined or null. */
    count?: number | string | null
    /** Heading level. Default 'h2'. */
    as?: 'h1' | 'h2' | 'h3' | 'h4'
    /** Draw the hairline rule after the title. Default true. */
    rule?: boolean
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { title: undefined, count: undefined, as: 'h2', rule: true, tone: undefined },
)

const tone = useTone(() => props.tone)
</script>

<template>
  <div data-slot="section-heading" :class="cn('flex min-h-8 items-center gap-3', props.class)">
    <component
      :is="as"
      :class="
        cn(
          'flex min-w-0 items-baseline gap-2 font-display text-[0.8rem] font-semibold tracking-[0.14em] uppercase',
          tone === 'dark' ? 'text-muted-light' : 'text-gold-ink',
        )
      "
    >
      <span class="truncate"><slot>{{ title }}</slot></span>
      <span
        v-if="count !== undefined && count !== null"
        :class="cn('font-sans text-sm font-medium tracking-normal tabular-nums normal-case', tone === 'dark' ? 'text-gold' : 'text-text-parchment/60')"
      >
        {{ count }}
      </span>
    </component>
    <span
      v-if="rule"
      aria-hidden="true"
      :class="cn('h-px min-w-4 flex-1', tone === 'dark' ? 'bg-line-dark' : 'bg-gold-ink/20')"
    />
    <div v-if="$slots.right" class="flex shrink-0 items-center gap-1">
      <slot name="right" />
    </div>
  </div>
</template>
