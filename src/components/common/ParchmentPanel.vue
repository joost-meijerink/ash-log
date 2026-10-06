<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { provideTone } from '@/composables/useTone'

/**
 * Parchment content panel on the dark leather background. Everything inside gets tone
 * 'parchment' (buttons, checkboxes, CheckRow, ProgressBar, badges pick parchment colours).
 */
const props = withDefaults(
  defineProps<{
    /** Element to render. Default 'section'. */
    as?: string
    /** 'light' (default, parchment) or 'deep' (parchment-deep: open or unfinished cards). */
    shade?: 'light' | 'deep'
    /** Inner padding. Default true (p-4, sm:p-6). Set false to handle it yourself. */
    padded?: boolean
    /** Thin tooled frame just inside the edge. Default true. */
    framed?: boolean
    class?: HTMLAttributes['class']
  }>(),
  { as: 'section', shade: 'light', padded: true, framed: true },
)

provideTone('parchment')
</script>

<template>
  <component
    :is="as"
    data-slot="parchment-panel"
    :data-shade="shade"
    :class="
      cn(
        'relative rounded-md font-sans text-text-parchment',
        'shadow-[0_1px_0_rgba(255,255,255,0.35)_inset,0_0_0_1px_rgba(21,18,14,0.6),0_14px_30px_-18px_rgba(0,0,0,0.9)]',
        shade === 'light' ? 'bg-parchment' : 'bg-parchment-deep',
        framed &&
          `before:pointer-events-none before:absolute before:inset-[5px] before:rounded-[3px] before:border before:border-gold-ink/15 before:content-['']`,
        padded && 'p-4 sm:p-6',
        props.class,
      )
    "
  >
    <slot />
  </component>
</template>
