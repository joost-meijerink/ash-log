<script setup lang="ts">
import { computed } from 'vue'
import { LocationText } from '@/components/common'
import { viaText, type RewardNote } from '@/lib/collections-rewards'

/**
 * How you get a reward, as running text: an optional prefix ('For 6 of the 7:'), the via
 * labels in the interface font and then the wiki's own source in italics.
 */
const props = defineProps<{
  note: RewardNote
  /** Interface text in front, e.g. 'For 6 of the 7:'. */
  prefix?: string
}>()

const via = computed(() => viaText(props.note.via))
</script>

<template>
  <span data-slot="reward-note">
    <template v-if="prefix"><span class="font-medium">{{ prefix }}</span>{{ ' ' }}</template>
    <span v-if="via" data-slot="reward-via">{{ via }}</span>
    <template v-if="via && note.source"><span aria-hidden="true"> · </span><span class="sr-only">, </span></template>
    <LocationText v-if="note.source" lang="en" class="text-[0.92rem] leading-snug">{{ note.source }}</LocationText>
  </span>
</template>
