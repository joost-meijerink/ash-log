<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { X } from 'lucide-vue-next'
import { reactiveOmit } from '@vueuse/core'
import { DialogClose, DialogContent, DialogPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'
import { provideTone } from '@/composables/useTone'
import DialogOverlay from './DialogOverlay.vue'

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<
    DialogContentProps & {
      class?: HTMLAttributes['class']
      showCloseButton?: boolean
      /** 'center' (default): a centered modal. 'sheet': a full-height panel sliding in from the right. */
      layout?: 'center' | 'sheet'
    }
  >(),
  {
    showCloseButton: true,
    layout: 'center',
  },
)
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'layout', 'showCloseButton')
const forwarded = useForwardPropsEmits(delegatedProps, emits)

// Dialogs render on dark leather, even when opened from inside a parchment panel.
provideTone('dark')
</script>

<template>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent
      data-slot="dialog-content"
      :data-layout="layout"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="
        cn(
          'fixed z-50 border-line-dark bg-leather font-sans text-text-light shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none',
          layout === 'center'
            ? 'top-1/2 left-1/2 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border p-6 duration-200 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-w-lg'
            : 'inset-y-0 right-0 flex h-dvh w-full flex-col border-l duration-300 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-xl',
          props.class,
        )
      "
    >
      <slot />

      <DialogClose
        v-if="showCloseButton"
        data-slot="dialog-close"
        class="absolute top-2 right-2 grid size-11 cursor-pointer place-content-center rounded-md text-muted-light transition-colors outline-none hover:bg-line-dark/60 hover:text-gold focus-visible:ring-2 focus-visible:ring-gold [&_svg]:size-5"
      >
        <X />
        <span class="sr-only">Sluiten</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
