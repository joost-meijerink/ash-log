<script setup lang="ts">
import { computed, ref } from 'vue'
import { FolderInput } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { GROUP_LABEL, GROUP_ORDER } from '@/lib/map-groups'
import type { MapCategory, MapGroup } from '@/lib/types'
import { useMapContext } from '@/composables/useMapContext'

/**
 * Small picker next to a category row: moves the category to another group by hand, or back to
 * the group the sync picked. A native select over a folder icon, so it works with touch,
 * keyboard and screen readers without a popover. Gold when the group was set by hand.
 */
const props = defineProps<{ category: MapCategory }>()

const { groupOverride } = useMapContext()

const select = ref<HTMLSelectElement | null>(null)
const manual = computed(() => groupOverride.manualGroup(props.category.id))
const value = computed(() => manual.value ?? '')
const disabled = computed(() => groupOverride.readOnly.value || groupOverride.saving.value !== null)

const current = computed(() => GROUP_LABEL[props.category.group] ?? GROUP_LABEL.other)
const autoOption = computed(() => (manual.value ? 'Automatisch (zoals de sync)' : `Automatisch: ${current.value}`))
const label = computed(() => {
  const how = manual.value ? 'met de hand' : 'automatisch'
  return `Groep van ${props.category.label}: ${current.value} (${how}). Kies een andere groep.`
})
const hint = computed(() => {
  if (groupOverride.offline.value) return 'Offline: groep wijzigen kan weer zodra je computer bereikbaar is'
  return groupOverride.readOnly.value ? 'overrides.json is niet te lezen, groep wijzigen kan nu niet' : 'Andere groep kiezen'
})

async function onChange(event: Event) {
  const next = (event.target as HTMLSelectElement).value
  await groupOverride.setGroup(props.category.id, next ? (next as MapGroup) : null)
  // Stay controlled: after a failed save the select shows the group that is really stored.
  if (select.value) select.value.value = value.value
}
</script>

<template>
  <span
    data-slot="map-group-picker"
    :title="hint"
    :class="
      cn(
        'relative grid h-11 w-11 shrink-0 place-content-center rounded-md transition-colors',
        'focus-within:ring-2 focus-within:ring-gold/70',
        manual ? 'text-gold' : 'text-muted-light/55',
        disabled ? 'opacity-50' : 'hover:bg-line-dark/45 hover:text-gold',
      )
    "
  >
    <FolderInput aria-hidden="true" class="size-4" :stroke-width="1.75" />
    <select
      ref="select"
      :value="value"
      :disabled="disabled"
      :aria-label="label"
      class="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
      @change="onChange"
    >
      <option value="">{{ autoOption }}</option>
      <option v-for="g in GROUP_ORDER" :key="g" :value="g">{{ GROUP_LABEL[g] }}</option>
    </select>
  </span>
</template>
