<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { Check, Minus } from 'lucide-vue-next'
import { reactiveOmit } from '@vueuse/core'
import { CheckboxIndicator, CheckboxRoot, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * 20px checkbox. Gold when checked (gold-ink on parchment), with a visible focus ring.
 * The box itself is smaller than 44px: put it in a row or label that is the 44px target
 * (CheckRow does that for you).
 */
const props = defineProps<CheckboxRootProps & { class?: HTMLAttributes['class']; tone?: Tone }>()
const emits = defineEmits<CheckboxRootEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'tone')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
const tone = useTone(() => props.tone)
</script>

<template>
  <CheckboxRoot
    v-slot="slotProps"
    data-slot="checkbox"
    :data-tone="tone"
    v-bind="forwarded"
    :class="
      cn(
        'peer grid size-5 shrink-0 cursor-pointer place-content-center rounded-[4px] border-[1.5px] transition-[background-color,border-color,box-shadow] outline-none',
        'focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'dark'
          ? 'border-muted-light/70 bg-ink/60 text-ink hover:border-gold focus-visible:ring-gold focus-visible:ring-offset-ink data-[state=checked]:border-gold data-[state=checked]:bg-gold data-[state=indeterminate]:border-gold data-[state=indeterminate]:bg-gold'
          : 'border-gold-ink/60 bg-parchment text-parchment hover:border-gold-ink focus-visible:ring-gold-ink focus-visible:ring-offset-parchment data-[state=checked]:border-gold-ink data-[state=checked]:bg-gold-ink data-[state=indeterminate]:border-gold-ink data-[state=indeterminate]:bg-gold-ink',
        props.class,
      )
    "
  >
    <CheckboxIndicator data-slot="checkbox-indicator" class="grid place-content-center text-current">
      <slot v-bind="slotProps">
        <Minus v-if="slotProps.state === 'indeterminate'" class="size-3.5" :stroke-width="3" />
        <Check v-else class="size-3.5" :stroke-width="3" />
      </slot>
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
