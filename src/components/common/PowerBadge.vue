<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Badge } from '@/components/ui/badge'
import type { Tone } from '@/composables/useTone'

/** Power level as 'PL 4', with 'Power level 4' as tooltip and for screen readers. */
const props = defineProps<{
  power: number
  tone?: Tone
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <Badge variant="default" :tone="tone" :class="props.class" :title="`Power level ${power}`" data-slot="power-badge">
    <span aria-hidden="true">PL {{ power }}</span>
    <span class="sr-only">Power level {{ power }}</span>
  </Badge>
</template>
