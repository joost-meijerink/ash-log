<script setup lang="ts">
import { Maximize, Minus, Plus } from 'lucide-vue-next'
import IconButton from '@/components/common/IconButton.vue'

/** Zoom buttons on a leather strip, bottom right of the map. */
defineProps<{
  zoom: number
  minZoom: number
  maxZoom: number
}>()

const emit = defineEmits<{ in: []; out: []; fit: [] }>()
</script>

<template>
  <div
    role="group"
    aria-label="Zoom"
    class="pointer-events-auto flex flex-col overflow-hidden rounded-md border border-line-dark bg-leather/95 shadow-[0_10px_24px_-12px_rgba(0,0,0,0.9)]"
  >
    <IconButton label="Zoom in" side="left" :disabled="zoom >= maxZoom" @click="emit('in')">
      <Plus />
    </IconButton>
    <span aria-hidden="true" class="mx-2 h-px bg-line-dark" />
    <IconButton label="Zoom out" side="left" :disabled="zoom <= minZoom" @click="emit('out')">
      <Minus />
    </IconButton>
    <span aria-hidden="true" class="mx-2 h-px bg-line-dark" />
    <IconButton label="Whole map" side="left" @click="emit('fit')">
      <Maximize />
    </IconButton>
  </div>
</template>
