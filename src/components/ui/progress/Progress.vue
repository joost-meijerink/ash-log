<script setup lang="ts">
import type { ProgressRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { ProgressIndicator, ProgressRoot } from 'reka-ui'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/** Low-level progress track (modelValue 0..max, default max 100). Prefer common/ProgressBar (0..1). */
const props = withDefaults(defineProps<ProgressRootProps & { class?: HTMLAttributes['class']; tone?: Tone }>(), {
  modelValue: 0,
  tone: undefined,
})

const delegatedProps = reactiveOmit(props, 'class', 'tone')
const tone = useTone(() => props.tone)
const percent = () => {
  const max = props.max ?? 100
  const value = props.modelValue ?? 0
  return max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
}
</script>

<template>
  <ProgressRoot
    data-slot="progress"
    :data-tone="tone"
    v-bind="delegatedProps"
    :class="
      cn(
        'relative h-2 w-full overflow-hidden rounded-full',
        tone === 'dark'
          ? 'bg-ink shadow-[inset_0_0_0_1px_#3a2f22]'
          : 'bg-parchment-deep shadow-[inset_0_0_0_1px_rgba(122,86,26,0.2)]',
        props.class,
      )
    "
  >
    <ProgressIndicator
      data-slot="progress-indicator"
      :class="cn('h-full w-full flex-1 rounded-full transition-transform duration-500 ease-out motion-reduce:transition-none', tone === 'dark' ? 'bg-gold' : 'bg-gold-ink')"
      :style="`transform: translateX(-${100 - percent()}%);`"
    />
  </ProgressRoot>
</template>
