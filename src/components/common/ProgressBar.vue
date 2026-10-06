<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * Thin progress bar: gold on dark, gold-ink on parchment. With `label` and/or `detail`
 * it shows a line of text above the bar.
 */
const props = withDefaults(
  defineProps<{
    /** Fraction 0..1. Clamped; NaN counts as 0. */
    value: number
    /** Text left above the bar, e.g. 'Steps'. Also used as accessible name. */
    label?: string
    /** Text right above the bar, e.g. '3 / 8'. When omitted and `showPercent` is set, the percentage. */
    detail?: string
    /** Show the percentage as detail when `detail` is not given. Default false. */
    showPercent?: boolean
    /** 'sm' (4px, default) or 'md' (8px). */
    size?: 'sm' | 'md'
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { label: undefined, detail: undefined, showPercent: false, size: 'sm', tone: undefined },
)

const tone = useTone(() => props.tone)
const fraction = computed(() => (Number.isFinite(props.value) ? Math.min(1, Math.max(0, props.value)) : 0))
const percent = computed(() => Math.round(fraction.value * 100))
const detailText = computed(() => props.detail ?? (props.showPercent ? `${percent.value}%` : undefined))
</script>

<template>
  <div data-slot="progress-bar" :data-tone="tone" :class="cn('flex w-full flex-col gap-1.5', props.class)">
    <div
      v-if="label || detailText"
      :class="cn('flex items-baseline justify-between gap-3 text-sm', tone === 'dark' ? 'text-muted-light' : 'text-text-parchment/70')"
    >
      <span v-if="label" class="truncate">{{ label }}</span>
      <span v-if="detailText" :class="cn('ml-auto tabular-nums', tone === 'dark' ? 'text-text-light' : 'text-text-parchment')">
        {{ detailText }}
      </span>
    </div>
    <div
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent"
      :aria-label="label ?? 'Progress'"
      :class="
        cn(
          'relative w-full overflow-hidden rounded-full',
          size === 'sm' ? 'h-1' : 'h-2',
          tone === 'dark' ? 'bg-line-dark/70' : 'bg-gold-ink/15',
        )
      "
    >
      <div
        :class="
          cn(
            'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
            tone === 'dark' ? 'bg-gold' : 'bg-gold-ink',
          )
        "
        :style="{ width: `${fraction * 100}%` }"
      />
    </div>
  </div>
</template>
