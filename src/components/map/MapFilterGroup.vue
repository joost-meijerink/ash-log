<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { ChevronRight, X } from 'lucide-vue-next'
import ProgressBar from '@/components/common/ProgressBar.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import ToggleChip from '@/components/common/ToggleChip.vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { categoryMatches, searchTerms } from '@/lib/map-filter'
import { LARGE_GROUP_SIZE, isTrackableGroup, type CategoryGroup } from '@/lib/map-groups'
import { useMapContext } from '@/composables/useMapContext'
import MapCategoryRow from './MapCategoryRow.vue'
import MapGlyph from './MapGlyph.vue'
import MapGroupPicker from './MapGroupPicker.vue'

/**
 * One filter group (Resources, Lore...): collapsible, with an all-on/all-off action.
 * Large groups get their own filter field. While collapsed, the categories that are on show as
 * chips, so you can switch them off without opening the list.
 */
const props = defineProps<{ group: CategoryGroup }>()

const { model, state, counts, terms } = useMapContext()

const MAX_CHIPS = 6

const uid = useId()
const headingId = `${uid}-heading`
const panelId = `${uid}-panel`

const large = computed(() => props.group.categories.length > LARGE_GROUP_SIZE)
const enabled = computed(() => new Set(state.filters.categories))
const active = computed(() => props.group.categories.filter((c) => enabled.value.has(c.id)))

// Small groups with something on start open; large ones stay closed and show chips instead.
const expanded = ref(!large.value && active.value.length > 0)
const chipsExpanded = ref(false)
const local = ref('')

const searching = computed(() => terms.value.length > 0)
const localTerms = computed(() => searchTerms(local.value))
const rows = computed(() =>
  props.group.categories.filter((c) => categoryMatches(c, terms.value) && categoryMatches(c, localTerms.value)),
)
const filtered = computed(() => rows.value.length < props.group.categories.length)
const open = computed(() => (searching.value ? rows.value.length > 0 : expanded.value))
const allOn = computed(() => rows.value.length > 0 && rows.value.every((c) => enabled.value.has(c.id)))

/** Lore and unique: found / total over the whole group, within the power and region filters. */
const progress = computed(() => {
  if (!isTrackableGroup(props.group.group)) return null
  let found = 0
  let total = 0
  for (const c of props.group.categories) {
    const n = counts.value.get(c.id)
    found += n?.found ?? 0
    total += n?.total ?? 0
  }
  return total > 0 ? { found, total } : null
})

const chips = computed(() => (chipsExpanded.value ? active.value : active.value.slice(0, MAX_CHIPS)))
const moreChips = computed(() => active.value.length - chips.value.length)

const toggleAllLabel = computed(() => {
  const what = filtered.value ? 'selection' : 'all'
  return `${allOn.value ? 'Hide' : 'Show'} ${what}`
})
const toggleAllAria = computed(() => {
  const n = rows.value.length
  const scope = filtered.value ? `${n} ${n === 1 ? 'category' : 'categories'} in ${props.group.label}` : `everything in ${props.group.label}`
  return `Turn ${allOn.value ? 'off' : 'on'} ${scope}`
})

function toggleAll() {
  state.setCategories(
    rows.value.map((c) => c.id),
    !allOn.value,
  )
}

function toggleOpen() {
  if (searching.value) return
  expanded.value = !expanded.value
}
</script>

<template>
  <section :aria-labelledby="headingId" data-slot="map-filter-group" class="border-t border-line-dark/70 py-1 first:border-t-0">
    <div class="flex items-center gap-1">
      <h3 class="min-w-0 flex-1">
        <button
          :id="headingId"
          type="button"
          :aria-expanded="open"
          :aria-controls="panelId"
          :class="
            cn(
              'flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors outline-none',
              'hover:bg-line-dark/45 focus-visible:ring-2 focus-visible:ring-gold/70',
              searching && 'cursor-default hover:bg-transparent',
            )
          "
          @click="toggleOpen"
        >
          <ChevronRight
            aria-hidden="true"
            :class="cn('size-4 shrink-0 text-muted-light transition-transform motion-reduce:transition-none', open && 'rotate-90')"
          />
          <MapGlyph :glyph="group.group" :size="16" />
          <span class="truncate font-display text-[0.78rem] font-semibold tracking-[0.14em] text-text-light uppercase">
            {{ group.label }}
          </span>
          <span class="ml-auto shrink-0 pl-2 text-sm tabular-nums">
            <span class="sr-only">, </span>
            <span v-if="active.length" class="text-gold">{{ active.length }} on</span>
            <span v-else class="text-muted-light">{{ group.categories.length }}<span class="sr-only">{{ group.categories.length === 1 ? ' category' : ' categories' }}</span></span>
          </span>
        </button>
      </h3>
      <Button
        variant="ghost"
        size="xs"
        class="shrink-0 text-muted-light"
        :aria-label="toggleAllAria"
        :disabled="rows.length === 0"
        @click="toggleAll"
      >
        {{ toggleAllLabel }}
      </Button>
    </div>

    <ProgressBar
      v-if="progress"
      class="px-2 pb-2"
      :value="progress.found / progress.total"
      :label="`${group.label}: found`"
      :detail="`${progress.found} / ${progress.total}`"
    />

    <!-- Collapsed: what is on, as chips that switch off -->
    <div v-if="!open && active.length" class="flex flex-wrap gap-1.5 px-2 pt-0.5 pb-2">
      <ToggleChip
        v-for="c in chips"
        :key="c.id"
        :pressed="true"
        class="max-w-full px-2.5 text-[0.85rem]"
        :title="`Turn off ${c.label}`"
        @update:pressed="state.toggleCategory(c.id, false)"
      >
        <span lang="en">{{ c.label }}</span>
        <template #icon><X aria-hidden="true" class="order-last" /></template>
      </ToggleChip>
      <Button v-if="moreChips > 0" variant="link" size="xs" @click="chipsExpanded = true">and {{ moreChips }} more</Button>
    </div>

    <!-- Rows are only rendered while open: 400 categories stay cheap -->
    <div v-show="open" :id="panelId" class="pb-1">
      <template v-if="open">
        <div v-if="large && !searching" class="px-1 pt-0.5 pb-1.5">
          <SearchInput v-model="local" :placeholder="`Filter ${group.label.toLowerCase()}`" />
        </div>
        <ul class="flex flex-col" role="list">
          <li v-for="c in rows" :key="c.id" class="flex items-center">
            <MapCategoryRow
              class="min-w-0 flex-1"
              :category="c"
              :on="enabled.has(c.id)"
              :count="counts.get(c.id)"
              :skipped="model.skipped.value.get(c.id) ?? 0"
              @toggle="(on) => state.toggleCategory(c.id, on)"
            />
            <MapGroupPicker :category="c" />
          </li>
        </ul>
        <p v-if="rows.length === 0" class="px-2 py-2 text-sm text-muted-light">Nothing found for '{{ local }}'.</p>
      </template>
    </div>
  </section>
</template>
