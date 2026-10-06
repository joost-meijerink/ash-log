<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { Primitive } from 'reka-ui'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'
import type { ButtonVariants } from '.'
import { buttonVariants } from '.'

interface Props extends PrimitiveProps {
  /** default | outline | secondary | ghost | destructive | link | parchment */
  variant?: ButtonVariants['variant']
  /** default (44px) | sm | xs | lg | icon (44px) | icon-sm. Small sizes keep a 44px hit area. */
  size?: ButtonVariants['size']
  /** Surface the button sits on. Defaults to the nearest provider (ParchmentPanel) or 'dark'. */
  tone?: Tone
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  as: 'button',
  tone: undefined,
})

const tone = useTone(() => props.tone)
</script>

<template>
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :data-tone="tone"
    :as="as"
    :as-child="asChild"
    :class="cn(buttonVariants({ variant, size, tone }), props.class)"
  >
    <slot />
  </Primitive>
</template>
