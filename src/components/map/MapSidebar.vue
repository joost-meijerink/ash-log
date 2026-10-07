<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { EyeOff, MapPinned, PanelLeftClose, X } from 'lucide-vue-next'
import EmptyState from '@/components/common/EmptyState.vue'
import IconButton from '@/components/common/IconButton.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import SectionHeading from '@/components/common/SectionHeading.vue'
import ToggleChip from '@/components/common/ToggleChip.vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { categoryMatches, searchIndex } from '@/lib/map-filter'
import { hasActiveFilters } from '@/lib/map-url'
import { useKeptScroll, type ScrollPosition } from '@/composables/useKeptScroll'
import { useMapContext } from '@/composables/useMapContext'
import { useViewRoute } from '@/composables/useViewRoute'
import MapFilterGroup from './MapFilterGroup.vue'
import MapSearchResults from './MapSearchResults.vue'

/** Filters on leather: search, view switches, power level, region and the category groups. */
const props = defineProps<{
  /** Narrow screens: the sidebar is a drawer, the header button closes it. */
  drawer: boolean
  /** False while the column is hidden (wide screens, 'Hide filters'). */
  shown: boolean
}>()

const emit = defineEmits<{
  close: []
  select: [pointId: string]
}>()

const { model, state, visibleCount, terms, groupOverride } = useMapContext()
const view = useViewRoute()

const SEARCH_LIMIT = 20

const searchInput = ref<InstanceType<typeof SearchInput> | null>(null)
defineExpose({ focusSearch: () => searchInput.value?.focus() })

// The list keeps its scroll position while another view is on screen. A hidden column has no
// scroll position to read, so where it stood when it was hidden is put back when it shows again.
const scroller = ref<HTMLElement | null>(null)
const scroll = useKeptScroll(scroller)
let hiddenAt: ScrollPosition | null = null
watch(
  () => props.shown,
  (shown) => {
    if (!shown) hiddenAt = { ...scroll.position() }
  },
)
watch(
  () => props.shown,
  (shown) => {
    if (!shown || !hiddenAt) return
    const position = hiddenAt
    hiddenAt = null
    // A tick later: the parent shows the column (v-show) at the end of this update, and until
    // then the list has no box to scroll.
    void nextTick(() => scroll.set(position))
  },
  { flush: 'post' },
)

const searching = computed(() => terms.value.length > 0)
const results = computed(() => searchIndex(model.searchEntries.value, state.filters.search, SEARCH_LIMIT))
const groups = computed(() =>
  searching.value
    ? model.groups.value.filter((g) => g.categories.some((c) => categoryMatches(c, terms.value)))
    : model.groups.value,
)

const active = computed(() => hasActiveFilters(state.filters))

/** A moved category leaves its group, and focus with it: catch focus on the message instead. */
const groupStatus = ref<HTMLElement | null>(null)
watch(
  () => groupOverride.message.value,
  (message) => {
    // Not while another view is on screen: the focus is theirs.
    if (!view.active.value) return
    const lost = !document.activeElement || document.activeElement === document.body
    if (message && lost) groupStatus.value?.focus()
  },
  { flush: 'post' },
)

const powerHint = computed(() => {
  if (!state.filters.powers.length) return 'Pick your levels: points with another level disappear. Points without a level stay.'
  if (state.filters.strictPower) return 'Only points with a picked level stay.'
  return 'Points with another level disappear, points without a level stay.'
})
const countText = computed(() => {
  const n = visibleCount.value
  return `${n.toLocaleString('en-GB')} ${n === 1 ? 'point' : 'points'}`
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-leather text-text-light">
    <!-- Header and search stay put, the rest scrolls -->
    <div class="shrink-0 border-b border-line-dark px-3 pt-2.5 pb-3">
      <div class="flex min-h-11 items-center gap-2">
        <h1 class="font-display text-base font-semibold tracking-[0.12em] text-text-light uppercase">Map</h1>
        <p class="truncate text-sm text-muted-light tabular-nums" aria-live="polite">{{ countText }}</p>
        <div class="ml-auto flex items-center gap-0.5">
          <Button v-if="active" variant="ghost" size="sm" class="text-muted-light" @click="state.clearFilters()">
            Clear filters
          </Button>
          <IconButton
            :label="props.drawer ? 'Close filters' : 'Hide filters'"
            size="icon-sm"
            :side="props.drawer ? 'bottom' : 'right'"
            @click="emit('close')"
          >
            <X v-if="props.drawer" />
            <PanelLeftClose v-else />
          </IconButton>
        </div>
      </div>
      <SearchInput
        ref="searchInput"
        class="mt-1.5"
        :model-value="state.filters.search"
        placeholder="Search a spot or category"
        @update:model-value="state.setSearch"
      />
      <!-- Outcome of moving a category to another group -->
      <div aria-live="polite" data-slot="map-group-status">
        <div
          v-if="groupOverride.message.value"
          ref="groupStatus"
          tabindex="-1"
          :class="
            cn(
              'mt-2 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm leading-snug outline-none',
              groupOverride.message.value.kind === 'error' ? 'border-ember/70 text-[#e08a6c]' : 'border-gold/40 text-text-light',
            )
          "
        >
          <p class="min-w-0 flex-1 py-1">
            <template v-if="groupOverride.message.value.kind === 'error'">
              Couldn't save the group for <span lang="en">{{ groupOverride.message.value.label }}</span>:
              {{ groupOverride.message.value.text }}
            </template>
            <template v-else-if="groupOverride.message.value.manual">
              <span lang="en">{{ groupOverride.message.value.label }}</span> is now under
              {{ groupOverride.message.value.group }}.
            </template>
            <template v-else>
              <span lang="en">{{ groupOverride.message.value.label }}</span> follows the sync again:
              {{ groupOverride.message.value.group }}.
            </template>
          </p>
          <IconButton label="Dismiss message" size="icon-sm" class="-my-1 -mr-1.5 shrink-0" @click="groupOverride.dismiss()">
            <X />
          </IconButton>
        </div>
      </div>
    </div>

    <!-- overflow-anchor: search results replace the filters; the browser must not scroll along with that -->
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-color:#3a2f22_transparent]"
    >
      <template v-if="searching">
        <MapSearchResults :hits="results.hits" :total="results.total" @select="(id) => emit('select', id)" />
        <EmptyState
          v-if="results.total === 0 && groups.length === 0"
          compact
          title="Nothing found"
          :text="`No spot or category matches '${state.filters.search.trim()}'. Try another word.`"
        />
      </template>

      <template v-else>
        <!-- View switches -->
        <section aria-labelledby="map-view-heading" class="px-3 pt-3">
          <SectionHeading id="map-view-heading" as="h2" title="View" />
          <label class="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-line-dark/45">
            <MapPinned aria-hidden="true" class="size-[18px] shrink-0 text-gold" :stroke-width="1.75" />
            <span class="flex min-w-0 flex-1 flex-col leading-tight">
              <span>Quest starts</span>
              <span class="text-xs text-muted-light">{{ model.questsWithStart.value }} quests with a start point</span>
            </span>
            <Switch :model-value="state.filters.questStarts" @update:model-value="(v: boolean) => state.setQuestStarts(v)" />
          </label>
          <label class="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-line-dark/45">
            <EyeOff aria-hidden="true" class="size-[18px] shrink-0 text-muted-light" :stroke-width="1.75" />
            <span class="flex min-w-0 flex-1 flex-col leading-tight">
              <span>Hide what I've found</span>
              <span class="text-xs text-muted-light">Only lore and unique unlocks, chests respawn</span>
            </span>
            <Switch :model-value="state.filters.hideFound" @update:model-value="(v: boolean) => state.setHideFound(v)" />
          </label>
        </section>

        <!-- Power level -->
        <section v-if="model.powers.value.length" aria-labelledby="map-power-heading" class="px-3 pt-3">
          <SectionHeading id="map-power-heading" as="h2" title="Power level" />
          <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Power level">
            <ToggleChip
              v-for="level in model.powers.value"
              :key="level"
              :pressed="state.filters.powers.includes(level)"
              :aria-label="`Power level ${level}`"
              @update:pressed="state.togglePower(level)"
            >
              PL {{ level }}
            </ToggleChip>
          </div>
          <ToggleChip
            v-if="state.filters.powers.length"
            class="mt-2"
            :pressed="state.filters.strictPower"
            @update:pressed="(v: boolean) => state.setStrictPower(v)"
          >
            Only with a power level
            <template v-if="state.filters.strictPower" #icon><X aria-hidden="true" class="order-last" /></template>
          </ToggleChip>
          <p class="mt-2 px-0.5 text-sm leading-snug text-muted-light">
            {{ powerHint }}
            <template v-if="model.estimatedPowers.value">Some chests have no level on the wiki: they get one estimated from their region.</template>
          </p>
        </section>

        <!-- Region -->
        <section v-if="model.regions.value.length" aria-labelledby="map-region-heading" class="px-3 pt-3">
          <SectionHeading id="map-region-heading" as="h2" title="Region" />
          <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Region">
            <ToggleChip
              v-for="region in model.regions.value"
              :key="region"
              :pressed="state.filters.regions.includes(region)"
              @update:pressed="state.toggleRegion(region)"
            >
              <span lang="en">{{ region }}</span>
            </ToggleChip>
          </div>
          <p class="mt-2 px-0.5 text-sm leading-snug text-muted-light">
            With a region picked, you only see points in those regions, even when the region is estimated.
          </p>
        </section>
      </template>

      <!-- Category groups -->
      <section v-if="groups.length" aria-labelledby="map-groups-heading" class="px-3 pt-3 pb-4">
        <SectionHeading id="map-groups-heading" as="h2" title="Categories" />
        <div class="mt-1">
          <MapFilterGroup v-for="g in groups" :key="g.group" :group="g" />
        </div>
      </section>
    </div>
  </div>
</template>
