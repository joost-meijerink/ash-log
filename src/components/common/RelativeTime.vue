<script setup lang="ts">
import { computed } from 'vue'
import { useRelativeTime } from '@/composables/useRelativeTime'

/**
 * <time> element with a live relative time ('5 minutes ago', or '5 min' with `short`)
 * and the absolute date as tooltip. Renders `fallback` when the value is missing.
 */
const props = withDefaults(
  defineProps<{
    /** ISO string, Date or epoch ms. */
    value?: string | number | Date | null
    /** Text when there is no value. Default ''. */
    fallback?: string
    /** Compact form ('5 min', '14:02', 'yesterday'). Default false. */
    short?: boolean
  }>(),
  { value: undefined, fallback: '', short: false },
)

const { relative, short: compact, absolute } = useRelativeTime(() => props.value)
const text = computed(() => (props.short ? compact.value : relative.value))
const iso = computed(() => {
  if (props.value === undefined || props.value === null) return undefined
  const d = new Date(props.value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
})
</script>

<template>
  <time v-if="text" :datetime="iso" :title="absolute">{{ text }}</time>
  <span v-else>{{ fallback }}</span>
</template>
