<script setup lang="ts">
import { computed } from 'vue'

/** Game coordinates under the cursor (or of the map center when the cursor is elsewhere). */
const props = defineProps<{
  cursor: { x: number; y: number } | null
  center: { x: number; y: number } | null
}>()

const pos = computed(() => props.cursor ?? props.center)
</script>

<template>
  <div
    v-if="pos"
    class="pointer-events-none flex items-baseline gap-3 rounded-md border border-line-dark bg-leather/90 px-2.5 py-1.5 text-sm text-text-light tabular-nums shadow-[0_10px_24px_-12px_rgba(0,0,0,0.9)]"
    :title="cursor ? 'Positie van de cursor' : 'Midden van de kaart'"
  >
    <span class="font-display text-[0.65rem] font-semibold tracking-[0.14em] text-muted-light uppercase">
      {{ cursor ? 'Cursor' : 'Midden' }}
    </span>
    <span><span class="text-gold">x</span> {{ Math.round(pos.x) }}</span>
    <span><span class="text-gold">y</span> {{ Math.round(pos.y) }}</span>
  </div>
</template>
