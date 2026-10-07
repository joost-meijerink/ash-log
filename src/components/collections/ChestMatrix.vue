<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PackageOpen } from 'lucide-vue-next'
import { EmptyState, ParchmentPanel, ToggleChip } from '@/components/common'
import { useKeptScroll } from '@/composables/useKeptScroll'
import { buildChestMatrix, chestCategories, mapFilterLocation } from '@/lib/collections-chests'
import { pointPower, powerEstimates } from '@/lib/map-power'
import { cn } from '@/lib/utils'
import type { MapPoint } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { capsLabel } from './styles'

/**
 * Where the chests are: counts per top-level region and power level, every count a link to
 * the map with those filters. Chests reset, so nothing is ticked off here.
 */
const data = useDataStore()

const categories = computed(() => chestCategories(data.categories, data.overrides))
const selected = ref<Set<string>>(new Set())

// Everything on by default; keep the choice when data reloads, add new chest categories.
let known = new Set<string>()
watch(
  categories,
  (list) => {
    const next = new Set([...selected.value].filter((id) => list.some((c) => c.id === id)))
    for (const c of list) if (!known.has(c.id)) next.add(c.id)
    known = new Set(list.map((c) => c.id))
    selected.value = next
  },
  { immediate: true },
)

function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}

const points = computed<MapPoint[]>(() => categories.value.flatMap((c) => data.pointsByCategory.get(c.id) ?? []))
const pointCount = (id: string) => data.pointsByCategory.get(id)?.length ?? 0
/** The map's levels: the wiki's, else the region estimate (map-power.ts), so a cell opens what it counts. */
const estimates = computed(() => powerEstimates(data.points, (id) => data.categoryById.get(id)?.group, data.vaults))
const powerOf = (p: MapPoint) => pointPower(p, data.categoryById.get(p.categoryId)?.group, p.power, estimates.value)
const matrix = computed(() => buildChestMatrix(points.value, selected.value, powerOf))
const hasEstimated = computed(() => matrix.value.totals.estimated.some((n) => n > 0))

// On a narrow screen the table scrolls sideways. The view is taken out of the page while another
// one is on screen, which would put it back at the first column.
const tableScroller = ref<HTMLElement | null>(null)
useKeptScroll(tableScroller)
/** Selected ids in label order, for the ?c= of every link. */
const selectedIds = computed(() => categories.value.filter((c) => selected.value.has(c.id)).map((c) => c.id))

/** Largest single cell, for the tint. */
const max = computed(() => Math.max(1, ...matrix.value.rows.flatMap((r) => [...r.cells, r.unknown])))
function tint(count: number): Record<string, string> | undefined {
  if (!count) return undefined
  const alpha = 0.05 + 0.3 * Math.sqrt(count / max.value)
  return { backgroundColor: `rgba(122, 86, 26, ${alpha.toFixed(3)})` }
}

/**
 * Map link for a cell. A power level cell uses the strict power filter (ps=1), so the map
 * leaves out chests without a level and shows exactly the count in the cell.
 */
const link = (region: string | null, power?: number) =>
  mapFilterLocation({
    categories: selectedIds.value,
    regions: region ? [region] : [],
    powers: power === undefined ? [] : [power],
    strictPower: power !== undefined,
  })

function linkLabel(count: number, region: string | null, power?: number, estimated = 0): string {
  const what = count === 1 ? '1 chest' : `${count} chests`
  const where = region ? `in ${region}` : 'in all regions'
  const level = power === undefined ? '' : `, power level ${power}`
  return `${what} ${where}${level}${estimated ? ` (${estimateText(count, estimated)})` : ''}: show on the map`
}

/** 'estimated' when the whole cell is, else '24 estimated'. */
const estimateText = (count: number, estimated: number) => (estimated === count ? 'estimated' : `${estimated} estimated`)
function estimateTitle(count: number, estimated: number): string | undefined {
  if (!estimated) return undefined
  if (estimated === count) return 'Estimated level: the wiki lists none for these chests'
  return `${estimated} of these ${count} ${estimated === 1 ? 'has' : 'have'} an estimated level: the wiki lists none`
}

const cellLink = cn(
  'relative grid min-h-11 min-w-11 place-content-center rounded-[4px] px-2 font-medium text-text-parchment tabular-nums',
  'underline decoration-gold-ink/0 underline-offset-[3px] transition-[background-color,text-decoration-color] outline-none',
  'hover:decoration-gold-ink/70 hover:ring-1 hover:ring-gold-ink/40 focus-visible:ring-2 focus-visible:ring-gold-ink',
)
</script>

<template>
  <ParchmentPanel as="div">
    <p class="max-w-prose text-[0.975rem] leading-relaxed text-text-parchment/80">
      Chests refill, so there's nothing to tick off here. Pick a count and you'll see those chests on the map.
    </p>

    <div v-if="categories.length" class="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2.5">
      <span :class="cn(capsLabel, 'mr-1')" id="chest-kinds">Kinds</span>
      <div role="group" aria-labelledby="chest-kinds" class="flex flex-wrap gap-x-2 gap-y-2.5">
        <ToggleChip
          v-for="c in categories"
          :key="c.id"
          :pressed="selected.has(c.id)"
          :count="pointCount(c.id)"
          @update:pressed="(on) => toggle(c.id, on)"
        >
          <span lang="en">{{ c.label }}</span>
        </ToggleChip>
      </div>
    </div>

    <EmptyState
      v-if="!categories.length || !matrix.rows.length"
      compact
      :icon="PackageOpen"
      title="No chests found"
      text="The map data has no chests yet. Run a sync to fetch them."
      class="mt-2"
    />
    <EmptyState
      v-else-if="!selectedIds.length"
      compact
      :icon="PackageOpen"
      title="No kind picked"
      text="Turn on at least one kind of chest above."
      class="mt-2"
    />

    <div
      v-else
      ref="tableScroller"
      class="-mx-4 mt-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      role="region"
      aria-labelledby="chest-caption"
      tabindex="0"
    >
      <table class="w-full min-w-max border-separate border-spacing-0.5 text-[0.95rem]">
        <caption id="chest-caption" class="sr-only">Chests per region and power level</caption>
        <thead>
          <tr>
            <th scope="col" :class="cn(capsLabel, 'sticky left-0 z-[1] bg-parchment pr-3 pb-1 text-left')">Region</th>
            <th v-for="pw in matrix.powers" :key="pw" scope="col" :class="cn(capsLabel, 'min-w-11 px-1 pb-1 text-center')">
              <span aria-hidden="true">PL {{ pw }}</span>
              <span class="sr-only">Power level {{ pw }}</span>
            </th>
            <th
              v-if="matrix.hasUnknown"
              scope="col"
              :class="cn(capsLabel, 'px-1 pb-1 text-center')"
              title="No power level on the wiki and nothing to estimate one from. On the map you'll find them through a total."
            >
              Unknown
            </th>
            <th scope="col" :class="cn(capsLabel, 'border-l border-gold-ink/20 pb-1 pl-2 text-center')">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in matrix.rows" :key="row.region ?? '-'">
            <th
              scope="row"
              :lang="row.region ? 'en' : undefined"
              class="sticky left-0 z-[1] bg-parchment pr-3 text-left font-serif text-[0.98rem] font-normal whitespace-nowrap italic"
            >
              {{ row.region ?? 'No region' }}
            </th>
            <td v-for="(count, i) in row.cells" :key="i" class="p-0 text-center">
              <RouterLink
                v-if="count && row.region"
                :to="link(row.region, matrix.powers[i])"
                :class="cellLink"
                :style="tint(count)"
                :title="estimateTitle(count, row.estimated[i] ?? 0)"
                :aria-label="linkLabel(count, row.region, matrix.powers[i], row.estimated[i])"
              >
                {{ count }}
                <span v-if="row.estimated[i]" aria-hidden="true" class="absolute top-1 right-1 text-xs leading-none text-gold-ink">*</span>
              </RouterLink>
              <span v-else-if="count" class="grid min-h-11 place-content-center tabular-nums" :style="tint(count)">{{ count }}</span>
              <span v-else class="grid min-h-11 place-content-center text-text-parchment/30">
                <span aria-hidden="true">&middot;</span><span class="sr-only">0</span>
              </span>
            </td>
            <td v-if="matrix.hasUnknown" class="p-0 text-center">
              <span
                v-if="row.unknown"
                class="grid min-h-11 place-content-center rounded-[4px] text-text-parchment/80 tabular-nums"
                :style="tint(row.unknown)"
              >
                {{ row.unknown }}
              </span>
              <span v-else class="grid min-h-11 place-content-center text-text-parchment/30">
                <span aria-hidden="true">&middot;</span><span class="sr-only">0</span>
              </span>
            </td>
            <td class="border-l border-gold-ink/20 p-0 pl-1 text-center">
              <RouterLink
                v-if="row.total && row.region"
                :to="link(row.region)"
                :class="cn(cellLink, 'font-semibold')"
                :aria-label="linkLabel(row.total, row.region)"
              >
                {{ row.total }}
              </RouterLink>
              <span v-else class="grid min-h-11 place-content-center font-semibold tabular-nums">{{ row.total }}</span>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" :class="cn(capsLabel, 'sticky left-0 z-[1] border-t border-gold-ink/20 bg-parchment pt-1 pr-3 text-left')">
              All regions
            </th>
            <td v-for="(count, i) in matrix.totals.cells" :key="i" class="border-t border-gold-ink/20 p-0 pt-1 text-center">
              <RouterLink
                v-if="count"
                :to="link(null, matrix.powers[i])"
                :class="cn(cellLink, 'font-semibold')"
                :title="estimateTitle(count, matrix.totals.estimated[i] ?? 0)"
                :aria-label="linkLabel(count, null, matrix.powers[i], matrix.totals.estimated[i])"
              >
                {{ count }}
                <span v-if="matrix.totals.estimated[i]" aria-hidden="true" class="absolute top-1 right-1 text-xs leading-none text-gold-ink">*</span>
              </RouterLink>
              <span v-else class="grid min-h-11 place-content-center text-text-parchment/30">
                <span aria-hidden="true">&middot;</span><span class="sr-only">0</span>
              </span>
            </td>
            <td v-if="matrix.hasUnknown" class="border-t border-gold-ink/20 p-0 pt-1 text-center">
              <span class="grid min-h-11 place-content-center font-semibold text-text-parchment/80 tabular-nums">
                {{ matrix.totals.unknown }}
              </span>
            </td>
            <td class="border-t border-l border-gold-ink/20 p-0 pt-1 pl-1 text-center">
              <RouterLink
                v-if="matrix.totals.total"
                :to="link(null)"
                :class="cn(cellLink, 'font-bold')"
                :aria-label="linkLabel(matrix.totals.total, null)"
              >
                {{ matrix.totals.total }}
              </RouterLink>
              <span v-else class="grid min-h-11 place-content-center font-bold">0</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p v-if="selectedIds.length && hasEstimated" data-estimate-note class="mt-3 text-sm text-text-parchment/65">
      <span aria-hidden="true" class="text-gold-ink">*</span> Includes estimated levels: the wiki lists none for those chests, so
      the level comes from the vaults or other chests in that region.
    </p>
    <p v-if="selectedIds.length && matrix.hasUnknown && matrix.totals.unknown" class="mt-3 text-sm text-text-parchment/65">
      Unknown: no power level on the wiki and nothing to estimate one from. To see those chests on the map, pick a total
      (per region or all regions).
    </p>
  </ParchmentPanel>
</template>
