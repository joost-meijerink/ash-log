<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useVModel } from '@vueuse/core'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/** Multi-line input, same look as Input. Grows with its content. */
const props = defineProps<{
  class?: HTMLAttributes['class']
  defaultValue?: string | number
  modelValue?: string | number
  tone?: Tone
}>()

const emits = defineEmits<{
  (e: 'update:modelValue', payload: string | number): void
}>()

const modelValue = useVModel(props, 'modelValue', emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
const tone = useTone(() => props.tone)
</script>

<template>
  <textarea
    v-model="modelValue"
    data-slot="textarea"
    :data-tone="tone"
    :class="
      cn(
        'field-sizing-content flex min-h-20 w-full rounded-md border px-3 py-2.5 font-sans text-base transition-[border-color,box-shadow] outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2',
        'aria-invalid:border-ember aria-invalid:ring-ember/30',
        tone === 'dark'
          ? 'border-line-dark bg-ink/70 text-text-light placeholder:text-muted-light/80 focus-visible:border-gold/70 focus-visible:ring-gold/30'
          : 'border-gold-ink/30 bg-[#f6eedb] text-text-parchment placeholder:text-text-parchment/45 focus-visible:border-gold-ink focus-visible:ring-gold-ink/25',
        props.class,
      )
    "
  />
</template>
