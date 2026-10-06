<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { GLYPH_PATHS, markerTone, type MarkerGlyph } from '@/lib/map-icons'

/**
 * The stroke glyph a group gets on the map, for use in the sidebar and cards (so a row looks
 * like its marker). Coloured like the marker: ember, gold or muted.
 */
const props = withDefaults(
  defineProps<{
    glyph: MarkerGlyph
    /** Square size in px. Default 20. */
    size?: number
    /** Colour on parchment instead of leather. */
    onParchment?: boolean
    class?: HTMLAttributes['class']
  }>(),
  { size: 20, onParchment: false },
)

const toneClass = computed(() => {
  const tone = markerTone(props.glyph)
  if (props.onParchment) return tone === 'ember' ? 'text-ember' : tone === 'gold' ? 'text-gold-ink' : 'text-text-parchment/60'
  return tone === 'ember' ? 'text-[#e08a6c]' : tone === 'gold' ? 'text-gold' : 'text-muted-light'
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    :class="cn('shrink-0', toneClass, props.class)"
    v-html="GLYPH_PATHS[glyph]"
  />
</template>
