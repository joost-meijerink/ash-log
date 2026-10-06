<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useVModel } from '@vueuse/core'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/** 44px text input. Dark field on leather, light field on parchment. */
const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  tone?: Tone
  class?: HTMLAttributes['class']
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
  <input
    v-model="modelValue"
    data-slot="input"
    :data-tone="tone"
    :class="
      cn(
        'h-11 w-full min-w-0 rounded-md border px-3 font-sans text-base transition-[border-color,box-shadow] outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2',
        'aria-invalid:border-ember aria-invalid:ring-ember/30',
        tone === 'dark'
          ? 'border-line-dark bg-ink/70 text-text-light placeholder:text-muted-light/80 selection:bg-gold selection:text-ink focus-visible:border-gold/70 focus-visible:ring-gold/30'
          : 'border-gold-ink/30 bg-[#f6eedb] text-text-parchment placeholder:text-text-parchment/45 selection:bg-gold-ink selection:text-parchment focus-visible:border-gold-ink focus-visible:ring-gold-ink/25',
        props.class,
      )
    "
  />
</template>
