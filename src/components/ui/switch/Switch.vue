<script setup lang="ts">
import type { SwitchRootEmits, SwitchRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SwitchRoot, SwitchThumb, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * 44x24 switch, gold track when on. Its hit area is grown to 44px high, but prefer wrapping it
 * in a Label so the whole row toggles.
 */
const props = defineProps<SwitchRootProps & { class?: HTMLAttributes['class']; tone?: Tone }>()
const emits = defineEmits<SwitchRootEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'tone')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
const tone = useTone(() => props.tone)
</script>

<template>
  <SwitchRoot
    v-slot="slotProps"
    data-slot="switch"
    :data-tone="tone"
    v-bind="forwarded"
    :class="
      cn(
        'peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors outline-none',
        `before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']`,
        'focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'dark'
          ? 'border-line-dark bg-ink focus-visible:ring-gold focus-visible:ring-offset-ink data-[state=checked]:border-gold data-[state=checked]:bg-gold'
          : 'border-gold-ink/40 bg-parchment-deep focus-visible:ring-gold-ink focus-visible:ring-offset-parchment data-[state=checked]:border-gold-ink data-[state=checked]:bg-gold-ink',
        props.class,
      )
    "
  >
    <SwitchThumb
      data-slot="switch-thumb"
      :class="
        cn(
          'pointer-events-none block size-[18px] rounded-full shadow-sm transition-transform',
          'data-[state=checked]:translate-x-[21px] data-[state=unchecked]:translate-x-[2px]',
          tone === 'dark'
            ? 'bg-muted-light data-[state=checked]:bg-ink'
            : 'bg-gold-ink/70 data-[state=checked]:bg-parchment',
        )
      "
    >
      <slot name="thumb" v-bind="slotProps" />
    </SwitchThumb>
  </SwitchRoot>
</template>
