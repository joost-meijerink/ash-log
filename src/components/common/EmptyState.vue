<script setup lang="ts">
import type { Component, HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * Centered message for empty lists, first runs and errors. Tell the user what to do next:
 * put the action in the `action` slot.
 */
const props = withDefaults(
  defineProps<{
    title: string
    /** One or two short sentences. The default slot can hold richer content instead. */
    text?: string
    /** A lucide icon component, e.g. `:icon="MapIcon"`. Or use the `icon` slot. */
    icon?: Component
    /** Tighter spacing for use inside panels. Default false. */
    compact?: boolean
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { text: undefined, icon: undefined, compact: false, tone: undefined },
)

const tone = useTone(() => props.tone)
</script>

<template>
  <div
    data-slot="empty-state"
    :class="
      cn(
        'mx-auto flex max-w-md flex-col items-center text-center',
        compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12 sm:py-16',
        props.class,
      )
    "
  >
    <div
      v-if="icon || $slots.icon"
      :class="
        cn(
          'mb-1 grid size-12 place-content-center rounded-full border [&_svg]:size-6',
          tone === 'dark' ? 'border-line-dark text-gold' : 'border-gold-ink/25 text-gold-ink',
        )
      "
      aria-hidden="true"
    >
      <slot name="icon">
        <component :is="icon" :stroke-width="1.5" />
      </slot>
    </div>
    <p
      :class="
        cn(
          'font-display text-base font-semibold tracking-[0.08em] uppercase',
          tone === 'dark' ? 'text-text-light' : 'text-text-parchment',
        )
      "
    >
      {{ title }}
    </p>
    <p v-if="text" :class="cn('text-[0.975rem] leading-relaxed text-balance', tone === 'dark' ? 'text-muted-light' : 'text-text-parchment/70')">
      {{ text }}
    </p>
    <div v-if="$slots.default" :class="cn('text-[0.975rem] leading-relaxed', tone === 'dark' ? 'text-muted-light' : 'text-text-parchment/70')">
      <slot />
    </div>
    <div v-if="$slots.action" class="mt-2 flex flex-wrap items-center justify-center gap-2">
      <slot name="action" />
    </div>
  </div>
</template>
