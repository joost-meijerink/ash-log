<script setup lang="ts">
import LocationText from '@/components/common/LocationText.vue'
import type { QuestNeed } from '@/lib/types'

/**
 * The {{Needed}} blocks of a walkthrough: what you need and what is recommended. Labels in
 * Dutch, the wiki text in English italics. Nothing to tick off, it is a reminder.
 */
withDefaults(
  defineProps<{
    needs: QuestNeed[]
    /** Show the section name above a block (for blocks that sit above all steps). */
    showSection?: boolean
  }>(),
  { showSection: false },
)
</script>

<template>
  <div data-slot="quest-needs" class="flex flex-col gap-1.5">
    <div
      v-for="(need, i) in needs"
      :key="i"
      class="flex max-w-[70ch] flex-col gap-1 rounded-md border border-gold-ink/15 bg-parchment-deep/35 px-2.5 py-2 text-[0.95rem] leading-snug"
    >
      <p v-if="showSection && need.section" lang="en" class="font-serif text-text-parchment/75 italic">{{ need.section }}</p>
      <p v-if="need.needed">
        <span class="font-semibold text-gold-ink">Nodig:</span> <LocationText lang="en">{{ need.needed }}</LocationText>
      </p>
      <p v-if="need.recommended">
        <span class="font-semibold text-gold-ink">Aanbevolen:</span> <LocationText lang="en">{{ need.recommended }}</LocationText>
      </p>
    </div>
  </div>
</template>
