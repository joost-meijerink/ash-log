<script setup lang="ts">
import type { ScrollAreaScrollbarProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { ScrollAreaScrollbar, ScrollAreaThumb } from 'reka-ui'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

const props = withDefaults(defineProps<ScrollAreaScrollbarProps & { class?: HTMLAttributes['class']; tone?: Tone }>(), {
  orientation: 'vertical',
  tone: undefined,
})

const delegatedProps = reactiveOmit(props, 'class', 'tone')
const tone = useTone(() => props.tone)
</script>

<template>
  <ScrollAreaScrollbar
    data-slot="scroll-area-scrollbar"
    v-bind="delegatedProps"
    :class="
      cn(
        'flex touch-none p-0.5 transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5',
        orientation === 'horizontal' && 'h-2.5 flex-col',
        props.class,
      )
    "
  >
    <ScrollAreaThumb
      data-slot="scroll-area-thumb"
      :class="
        cn(
          'relative flex-1 rounded-full transition-colors',
          tone === 'dark' ? 'bg-line-dark hover:bg-muted-light/60' : 'bg-gold-ink/25 hover:bg-gold-ink/45',
        )
      "
    />
  </ScrollAreaScrollbar>
</template>
