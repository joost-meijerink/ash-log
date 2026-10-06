<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useAnchorNavigator } from '@/composables/useCollectionAnchor'

/**
 * Link to an anchor on the Collections page ('#vault-takla-kara'). A plain click scrolls
 * inside <main> via the view's anchor navigator; modified clicks behave like a normal link.
 */
const props = defineProps<{
  /** Element id without '#'. */
  to: string
  class?: HTMLAttributes['class']
}>()

const nav = useAnchorNavigator()

function onClick(event: MouseEvent) {
  if (!nav || event.defaultPrevented || event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  nav.goTo(props.to)
}
</script>

<template>
  <a :href="`#${to}`" :class="props.class" @click="onClick"><slot /></a>
</template>
