<script setup lang="ts">
import { ref, type HTMLAttributes } from 'vue'
import { Search, X } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * 44px search field with a magnifier and a clear button. Escape clears it.
 * Use with v-model (string).
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    /** Placeholder and accessible name. Default 'Zoeken'. */
    placeholder?: string
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { placeholder: 'Zoeken', tone: undefined },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const tone = useTone(() => props.tone)
const input = ref<HTMLInputElement | null>(null)

function clear() {
  emit('update:modelValue', '')
  input.value?.focus()
}

/** Focuses the field (e.g. from a keyboard shortcut in a view). */
defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div data-slot="search-input" :class="cn('relative w-full', props.class)">
    <Search
      aria-hidden="true"
      :class="
        cn(
          'pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2',
          tone === 'dark' ? 'text-muted-light' : 'text-text-parchment/50',
        )
      "
    />
    <input
      ref="input"
      type="search"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="placeholder"
      autocomplete="off"
      spellcheck="false"
      :class="
        cn(
          'h-11 w-full min-w-0 appearance-none rounded-md border pr-11 pl-9 font-sans text-base transition-[border-color,box-shadow] outline-none focus-visible:ring-2',
          '[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden',
          tone === 'dark'
            ? 'border-line-dark bg-ink/70 text-text-light placeholder:text-muted-light/80 focus-visible:border-gold/70 focus-visible:ring-gold/30'
            : 'border-gold-ink/30 bg-[#f6eedb] text-text-parchment placeholder:text-text-parchment/45 focus-visible:border-gold-ink focus-visible:ring-gold-ink/25',
        )
      "
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.esc="modelValue ? (clear(), $event.stopPropagation()) : undefined"
    />
    <button
      v-if="modelValue"
      type="button"
      aria-label="Zoekterm wissen"
      :class="
        cn(
          'absolute top-0 right-0 grid size-11 cursor-pointer place-content-center rounded-md transition-colors outline-none focus-visible:ring-2',
          tone === 'dark'
            ? 'text-muted-light hover:text-gold focus-visible:ring-gold/60'
            : 'text-text-parchment/60 hover:text-gold-ink focus-visible:ring-gold-ink/50',
        )
      "
      @click="clear"
    >
      <X class="size-4" aria-hidden="true" />
    </button>
  </div>
</template>
