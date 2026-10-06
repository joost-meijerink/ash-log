<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { Primitive } from 'reka-ui'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'
import type { BadgeVariants } from '.'
import { badgeVariants } from '.'

const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      /** default (gold) | solid | outline | ember */
      variant?: BadgeVariants['variant']
      tone?: Tone
      class?: HTMLAttributes['class']
    }
  >(),
  { as: 'span', tone: undefined },
)

const delegatedProps = reactiveOmit(props, 'class', 'tone', 'variant')
const tone = useTone(() => props.tone)
</script>

<template>
  <Primitive
    data-slot="badge"
    :data-tone="tone"
    :class="cn(badgeVariants({ variant, tone }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
