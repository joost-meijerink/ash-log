<script setup lang="ts">
import { computed, ref, watch, type HTMLAttributes } from 'vue'
import { Button, type ButtonVariants } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Tone } from '@/composables/useTone'
import { useViewActive } from '@/composables/useViewRoute'

defineOptions({ inheritAttrs: false })

/**
 * Icon-only button with a tooltip; `label` is both the tooltip and the accessible name.
 * Put a lucide icon in the default slot. Listeners and attributes (@click, :disabled, ...)
 * go to the button. Needs the TooltipProvider that App.vue sets up.
 */
const props = withDefaults(
  defineProps<{
    label: string
    /** Button variant. Default 'ghost'. */
    variant?: ButtonVariants['variant']
    /** 'icon' (44px, default) or 'icon-sm' (36px look, 44px hit area). */
    size?: 'icon' | 'icon-sm'
    /** Tooltip side. Default 'top'. */
    side?: 'top' | 'right' | 'bottom' | 'left'
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { variant: 'ghost', size: 'icon', side: 'top', tone: undefined },
)

// The tooltip is drawn in the body, outside the view the button lives in. A view stays alive
// while another one is on screen, and a button that leaves the page with the pointer on it gets
// no pointerleave: its tooltip would hang over the other view (back or forward in the browser).
// So it closes with its view, and cannot open while the view is away (a delay that still ran).
// Its content is taken out at once as well (v-if below): a closing tooltip fades out first, and
// would do that in a corner of the other view, its button being gone.
const viewActive = useViewActive()
const shown = ref(false)
const open = computed({
  get: () => shown.value,
  set: (value) => {
    shown.value = value && viewActive.value
  },
})
watch(viewActive, (active) => {
  if (!active) shown.value = false
})
</script>

<template>
  <Tooltip v-model:open="open">
    <TooltipTrigger as-child>
      <Button v-bind="$attrs" :variant="variant" :size="size" :tone="tone" :class="props.class" :aria-label="label">
        <slot />
      </Button>
    </TooltipTrigger>
    <TooltipContent v-if="viewActive" :side="side">{{ label }}</TooltipContent>
  </Tooltip>
</template>
