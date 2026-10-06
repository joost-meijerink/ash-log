<script setup lang="ts">
import { computed } from 'vue'
import { ProgressBar } from '@/components/common'
import { tallyFraction, type Tally } from '@/lib/collections-shared'
import type { CollectionSummary } from '@/lib/collections-vaults'

/** Two counts on leather: unique unlocks and vaults done. */
const props = defineProps<{ summary: CollectionSummary }>()

interface Stat {
  key: string
  label: string
  tally: Tally
}

const stats = computed<Stat[]>(() => [
  { key: 'rewards', label: 'Unique unlocks', tally: props.summary.rewards },
  { key: 'vaults', label: 'Vaults done', tally: props.summary.vaults },
])
</script>

<template>
  <dl class="grid grid-cols-1 overflow-hidden rounded-md border border-line-dark bg-leather sm:grid-cols-[1.6fr_1fr]">
    <div
      v-for="(stat, i) in stats"
      :key="stat.key"
      :class="[
        'flex min-w-0 flex-col gap-2 px-4 py-3.5 sm:px-5 sm:py-4',
        i === 0 ? 'border-b border-line-dark sm:border-r sm:border-b-0' : '',
      ]"
    >
      <dt class="font-display text-[0.72rem] font-semibold tracking-[0.14em] text-muted-light uppercase">{{ stat.label }}</dt>
      <dd class="flex flex-col gap-2">
        <span class="flex items-baseline gap-1.5 tabular-nums">
          <span :class="['font-display font-semibold text-text-light', i === 0 ? 'text-[1.9rem] leading-none' : 'text-2xl leading-none']">
            {{ stat.tally.done }}
          </span>
          <span class="text-muted-light">/ {{ stat.tally.total }}</span>
          <span v-if="i === 0 && stat.tally.total" class="ml-auto text-sm text-gold">
            {{ Math.round(tallyFraction(stat.tally) * 100) }}%
          </span>
        </span>
        <!-- The numbers above carry the value for screen readers. -->
        <ProgressBar tone="dark" :value="tallyFraction(stat.tally)" :size="i === 0 ? 'md' : 'sm'" aria-hidden="true" />
      </dd>
    </div>
  </dl>
</template>
