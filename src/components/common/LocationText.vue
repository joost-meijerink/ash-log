<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { MapPin } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * Wiki locations and quotes in Alegreya italic (English wiki text, never translated).
 * With `pin` it gets a small ember map pin in front. Marked lang="en" by default (wiki text);
 * pass another `lang` for text in another language.
 */
const props = withDefaults(
  defineProps<{
    /** Element to render. Default 'span'; use 'p' or 'blockquote' for longer text. */
    as?: string
    /** Small map pin icon in front. Default false. */
    pin?: boolean
    tone?: Tone
    /** Language of the text. Default 'en' (wiki text). */
    lang?: string
    class?: HTMLAttributes['class']
  }>(),
  { as: 'span', pin: false, tone: undefined, lang: 'en' },
)

const tone = useTone(() => props.tone)
</script>

<template>
  <component
    :is="as"
    data-slot="location-text"
    :lang="lang"
    :class="
      cn(
        'font-serif italic',
        pin && 'inline-flex items-baseline gap-1.5',
        tone === 'dark' ? 'text-text-light/90' : 'text-text-parchment/85',
        props.class,
      )
    "
  >
    <MapPin v-if="pin" aria-hidden="true" class="size-3.5 shrink-0 translate-y-[2px] self-start text-ember" />
    <span v-if="pin"><slot /></span>
    <slot v-else />
  </component>
</template>
