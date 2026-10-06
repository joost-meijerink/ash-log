<script setup lang="ts">
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'
import WikiIcon from '@/components/common/WikiIcon.vue'
import { cn } from '@/lib/utils'
import { isTrackableGroup } from '@/lib/map-groups'
import type { CategoryCount } from '@/lib/map-filter'
import type { MapCategory } from '@/lib/types'
import MapGlyph from './MapGlyph.vue'

/**
 * One category in a filter group: a 44px row around a native checkbox, the wiki icon (or the
 * marker glyph), the label and a counter. Lore and unique show 'found / total'.
 */
const props = defineProps<{
  category: MapCategory
  on: boolean
  count: CategoryCount | undefined
  /** Points of this category outside the map (vault interiors, instanced areas). */
  skipped: number
}>()

const emit = defineEmits<{ toggle: [on: boolean] }>()

const trackable = computed(() => isTrackableGroup(props.category.group))
const total = computed(() => props.count?.total ?? 0)
const found = computed(() => props.count?.found ?? 0)
const complete = computed(() => trackable.value && total.value > 0 && found.value === total.value)

const countText = computed(() => (trackable.value ? `${found.value} / ${total.value}` : total.value.toLocaleString('en-GB')))
const countLabel = computed(() =>
  trackable.value ? `${found.value} of ${total.value} found` : `${total.value} ${total.value === 1 ? 'point' : 'points'}`,
)
</script>

<template>
  <label
    data-slot="map-category-row"
    :class="
      cn(
        'group/row flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[0.95rem] leading-tight transition-colors',
        'hover:bg-line-dark/45',
        total === 0 && !on && 'opacity-55',
      )
    "
  >
    <span class="relative grid size-[18px] shrink-0 place-content-center">
      <input
        type="checkbox"
        :checked="on"
        :class="
          cn(
            'peer absolute inset-0 m-0 size-[18px] cursor-pointer appearance-none rounded-[4px] border-[1.5px] outline-none',
            'border-muted-light/60 bg-ink/60 transition-colors group-hover/row:border-gold',
            'checked:border-gold checked:bg-gold',
            'focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-leather',
          )
        "
        @change="emit('toggle', ($event.target as HTMLInputElement).checked)"
      />
      <Check aria-hidden="true" :stroke-width="3.25" class="pointer-events-none relative size-3 text-ink opacity-0 peer-checked:opacity-100" />
    </span>

    <WikiIcon :file="category.icon" :size="20">
      <template #fallback>
        <MapGlyph :glyph="category.group" :size="18" />
      </template>
    </WikiIcon>

    <span class="flex min-w-0 flex-1 flex-col">
      <span lang="en" :class="cn('truncate', on ? 'text-text-light' : 'text-text-light/85')" :title="category.label">{{ category.label }}</span>
      <span
        v-if="skipped > 0"
        class="truncate text-xs text-muted-light/80"
        title="These points are in vaults or other instanced areas, off the overworld map."
      >
        {{ skipped }} in instanced areas
      </span>
    </span>

    <span :class="cn('flex shrink-0 items-center gap-1 text-sm tabular-nums', complete ? 'text-gold' : 'text-muted-light')">
      <Check v-if="complete" aria-hidden="true" class="size-3.5" :stroke-width="2.5" />
      <span aria-hidden="true">{{ countText }}</span>
      <span class="sr-only">, {{ countLabel }}</span>
    </span>
  </label>
</template>
