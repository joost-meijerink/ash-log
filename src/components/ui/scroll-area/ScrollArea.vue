<script setup lang="ts">
import type { ScrollAreaRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { cn } from '@/lib/utils'
import type { Tone } from '@/composables/useTone'
import ScrollBar from './ScrollBar.vue'

const props = defineProps<
  ScrollAreaRootProps & {
    class?: HTMLAttributes['class']
    /** Class for the scrolling viewport, e.g. to add padding. */
    viewportClass?: HTMLAttributes['class']
    tone?: Tone
  }
>()

const delegatedProps = reactiveOmit(props, 'class', 'viewportClass', 'tone')
</script>

<template>
  <ScrollAreaRoot data-slot="scroll-area" v-bind="delegatedProps" :class="cn('relative overflow-hidden', props.class)">
    <ScrollAreaViewport
      data-slot="scroll-area-viewport"
      :class="
        cn(
          'size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-gold/50 focus-visible:ring-inset',
          props.viewportClass,
        )
      "
    >
      <slot />
    </ScrollAreaViewport>
    <ScrollBar :tone="tone" />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
