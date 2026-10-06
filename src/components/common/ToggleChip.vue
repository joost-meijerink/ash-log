<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * On/off chip for filters (aria-pressed). 36px high with a 44px hit area.
 * Use with v-model:pressed.
 */
const props = withDefaults(
  defineProps<{
    /** Pressed state (v-model:pressed). */
    pressed: boolean
    /** Small number after the label, e.g. a point count. */
    count?: number | string | null
    disabled?: boolean
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { count: undefined, disabled: false, tone: undefined },
)

const emit = defineEmits<{
  'update:pressed': [value: boolean]
}>()

const tone = useTone(() => props.tone)
</script>

<template>
  <button
    type="button"
    data-slot="toggle-chip"
    :aria-pressed="pressed"
    :disabled="disabled"
    :class="
      cn(
        'relative inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 font-sans text-sm font-medium transition-colors outline-none',
        `before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']`,
        'focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        tone === 'dark'
          ? pressed
            ? 'border-gold/70 bg-gold/15 text-gold focus-visible:ring-gold focus-visible:ring-offset-ink'
            : 'border-line-dark text-text-light hover:border-muted-light/60 hover:bg-leather focus-visible:ring-gold focus-visible:ring-offset-ink'
          : pressed
            ? 'border-gold-ink bg-gold-ink text-parchment focus-visible:ring-gold-ink focus-visible:ring-offset-parchment'
            : 'border-gold-ink/30 text-text-parchment hover:border-gold-ink/60 hover:bg-parchment-deep focus-visible:ring-gold-ink focus-visible:ring-offset-parchment',
        props.class,
      )
    "
    @click="emit('update:pressed', !pressed)"
  >
    <slot name="icon" />
    <span class="truncate"><slot /></span>
    <span
      v-if="count !== undefined && count !== null"
      :class="cn('tabular-nums', pressed ? 'opacity-80' : tone === 'dark' ? 'text-muted-light' : 'text-text-parchment/60')"
    >
      {{ count }}
    </span>
  </button>
</template>
