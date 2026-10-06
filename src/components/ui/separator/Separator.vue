<script setup lang="ts">
import type { SeparatorProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { Separator } from 'reka-ui'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

const props = withDefaults(defineProps<SeparatorProps & { class?: HTMLAttributes['class']; tone?: Tone }>(), {
  orientation: 'horizontal',
  decorative: true,
  tone: undefined,
})

const delegatedProps = reactiveOmit(props, 'class', 'tone')
const tone = useTone(() => props.tone)
</script>

<template>
  <Separator
    data-slot="separator"
    v-bind="delegatedProps"
    :class="
      cn(
        'shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        tone === 'dark' ? 'bg-line-dark' : 'bg-gold-ink/20',
        props.class,
      )
    "
  />
</template>
