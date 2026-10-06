<script setup lang="ts">
import '@/components/map/map.css'
import { computed, nextTick, ref, watch } from 'vue'
import { useEventListener, useMediaQuery } from '@vueuse/core'
import { SlidersHorizontal } from 'lucide-vue-next'
import MapPinBanner from '@/components/map/MapPinBanner.vue'
import MapPointCard from '@/components/map/MapPointCard.vue'
import MapQuestCard from '@/components/map/MapQuestCard.vue'
import MapReadout from '@/components/map/MapReadout.vue'
import MapSidebar from '@/components/map/MapSidebar.vue'
import MapZoomControl from '@/components/map/MapZoomControl.vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { countCategories, isInWorld, searchTerms, visiblePoints as filterPoints } from '@/lib/map-filter'
import type { QuestStartGroup } from '@/lib/map-links'
import type { FlyRequest } from '@/composables/useMapState'
import { useKeptScroll } from '@/composables/useKeptScroll'
import { provideMapContext } from '@/composables/useMapContext'
import { useMapGroupOverride } from '@/composables/useMapGroupOverride'
import { useMapLeaflet } from '@/composables/useMapLeaflet'
import { useMapModel } from '@/composables/useMapModel'
import { useMapState } from '@/composables/useMapState'
import { provideViewRoute } from '@/composables/useViewRoute'
import { useDataStore } from '@/stores/data'

// First: the view stays alive while another one is on screen, and everything below reads the
// map's own route through this (filters, selection, the Leaflet map and its scrollers live on).
const view = provideViewRoute('map')
const data = useDataStore()
const model = useMapModel()
const state = useMapState(model)

/* ---------------- filters -> points ---------------- */

const terms = computed(() => searchTerms(state.filters.search))
const powerSet = computed(() => new Set(state.filters.powers))
const regionSet = computed(() => new Set(state.filters.regions))
const EMPTY = new Set<string>()

const counts = computed(() =>
  countCategories(
    data.categories,
    model.drawable.value,
    { powers: powerSet.value, strictPower: state.filters.strictPower, regions: regionSet.value, found: model.found.value },
    model.powerOf,
  ),
)

const visible = computed(() =>
  filterPoints(
    state.filters.categories,
    data.categoryById,
    model.drawable.value,
    {
      powers: powerSet.value,
      strictPower: state.filters.strictPower,
      regions: regionSet.value,
      hideFound: state.filters.hideFound,
      // Only read progress when it matters, so ticking a point does not recompute every marker.
      found: state.filters.hideFound ? model.found.value : EMPTY,
    },
    model.powerOf,
  ),
)
const visibleCount = computed(() => visible.value.length)

const groupOverride = useMapGroupOverride()

provideMapContext({ model, state, counts, visibleCount, terms, groupOverride })

/* ---------------- selection ---------------- */

const selectedPoint = computed(() => (state.focus.value ? (data.pointById.get(state.focus.value) ?? null) : null))
const selectedQuest = computed(() => (state.quest.value ? (data.questById.get(state.quest.value) ?? null) : null))
const pinQuest = computed(() => (state.pin.value ? (data.questById.get(state.pin.value) ?? null) : null))
const highlightQuest = computed(() => state.quest.value ?? state.pin.value)
const cardOpen = computed(() => !!selectedPoint.value || !!selectedQuest.value)

/** All quest starts when switched on; otherwise only the one you are looking at. */
const questStarts = computed<QuestStartGroup[]>(() => {
  if (state.filters.questStarts) return model.startGroups.value
  const id = highlightQuest.value
  return id ? model.startGroups.value.filter((g) => g.quests.some((q) => q.id === id)) : []
})

/* ---------------- layout ---------------- */

const isWide = useMediaQuery('(min-width: 1024px)')
const isSm = useMediaQuery('(min-width: 640px)')
const sidebarOpen = ref(isWide.value)
watch(isWide, (wide) => {
  sidebarOpen.value = wide
})
// A link from another view shows something on the map: the drawer that was left open on a
// narrow screen must not cover it. Coming back through the tab leaves it as it was.
watch(view.arrival, (arrival) => {
  if (arrival?.kind === 'fresh' && !isWide.value) sidebarOpen.value = false
})

const sidebarRef = ref<InstanceType<typeof MapSidebar> | null>(null)
const toggleRef = ref<InstanceType<typeof Button> | null>(null)
const mapEl = ref<HTMLElement | null>(null)
const cardEl = ref<HTMLElement | null>(null)

function openSidebar() {
  sidebarOpen.value = true
  if (!isWide.value) void nextTick(() => sidebarRef.value?.focusSearch())
}

function closeSidebar() {
  sidebarOpen.value = false
  void nextTick(() => (toggleRef.value?.$el as HTMLElement | undefined)?.focus?.())
}

/* ---------------- Leaflet ---------------- */

const leaflet = useMapLeaflet({
  container: mapEl,
  visiblePoints: visible,
  categoryById: computed(() => data.categoryById),
  found: model.found,
  dataVersion: model.dataVersion,
  questStarts,
  highlightQuest,
  selectedPoint,
  pinMode: computed(() => !!pinQuest.value),
  landExtent: model.landExtent,
  onPointClick: (id) => state.selectPoint(id),
  onQuestStartClick: (group) => {
    const current = state.quest.value
    const keep = current && group.quests.some((q) => q.id === current)
    state.selectQuest(keep ? current : group.quests[0]!.id)
  },
  onMapClick: (pos, inWorld) => {
    if (pinQuest.value) void placePin(pos, inWorld)
    else state.clearSelection()
  },
})

/** Pixel shift so a spot is not hidden under the card: left of a floating card, above a sheet. */
function cardOffset(): [number, number] {
  if (isSm.value) return [196, 0]
  const h = mapEl.value?.clientHeight ?? 600
  return [0, Math.round(h * 0.25)]
}

function fly(req: FlyRequest) {
  if (req.kind === 'land') {
    leaflet.fitLand(true)
  } else if (req.kind === 'point') {
    const p = data.pointById.get(req.id)
    if (p && isInWorld(p)) leaflet.flyTo(p.x, p.y, { offset: cardOffset() })
  } else {
    const start = data.questById.get(req.id)?.start
    if (start) leaflet.flyTo(start.x, start.y, req.kind === 'quest' ? { offset: cardOffset() } : {})
  }
}

// A request that comes with a link from another view waits until the map is back in the page
// with its real size (onScreen): the map has no size before, and the card offset needs one.
let handledSeq = 0
watch([() => state.flyRequest.value, leaflet.map, leaflet.onScreen], ([req, m, onScreen]) => {
  if (!req || !m || !onScreen || req.seq === handledSeq) return
  handledSeq = req.seq
  fly(req)
})

function onSearchSelect(pointId: string) {
  if (!isWide.value) sidebarOpen.value = false
  state.selectPoint(pointId, { fly: true })
}

/* ---------------- card focus ---------------- */

const cardKey = computed(() => state.focus.value ?? (state.quest.value ? `quest:${state.quest.value}` : ''))
watch(cardKey, (key, prev) => {
  if (key && key !== prev) {
    void nextTick(() => {
      if (view.active.value) cardEl.value?.focus({ preventScroll: true })
    })
  }
})

// The card keeps its scroll position while another view is on screen. Another card starts at the
// top, also when it replaced the old one through a link from another view.
const cardScroll = useKeptScroll(cardEl)
watch(cardKey, () => cardScroll.reset(), { flush: 'post' })

function closeCard() {
  state.clearSelection()
  void nextTick(() => {
    if (view.active.value) mapEl.value?.focus({ preventScroll: true })
  })
}

/* ---------------- pin mode ---------------- */

const pinSaving = ref(false)
const pinError = ref<string | null>(null)
watch(
  () => state.pin.value,
  () => {
    pinError.value = null
  },
)

async function placePin(pos: { x: number; y: number }, inWorld: boolean) {
  const id = state.pin.value
  if (!id || pinSaving.value) return
  if (!inWorld) {
    pinError.value = 'Die plek ligt buiten de kaart. Klik binnen de kaart.'
    return
  }
  pinSaving.value = true
  pinError.value = null
  try {
    await data.saveOverrides((ov) => ({
      ...ov,
      questStart: { ...ov.questStart, [id]: { x: Math.round(pos.x), y: Math.round(pos.y) } },
    }))
    state.finishPin(id)
  } catch (err) {
    pinError.value = `Opslaan lukt niet: ${(err as Error).message}`
  } finally {
    pinSaving.value = false
  }
}

async function removePin() {
  const id = state.pin.value
  if (!id || pinSaving.value) return
  pinSaving.value = true
  pinError.value = null
  try {
    await data.saveOverrides((ov) => {
      const questStart = { ...ov.questStart }
      delete questStart[id]
      return { ...ov, questStart }
    })
    state.finishPin(id)
  } catch (err) {
    pinError.value = `Verwijderen lukt niet: ${(err as Error).message}`
  } finally {
    pinSaving.value = false
  }
}

/* ---------------- keyboard ---------------- */

useEventListener(document, 'keydown', (e: KeyboardEvent) => {
  // Another view is on screen: its Escape is not ours.
  if (!view.active.value) return
  if (e.key !== 'Escape' || e.defaultPrevented) return
  // A dialog (sync report) handles its own Escape.
  if (document.querySelector('[role="dialog"][data-state="open"]')) return
  if (!isWide.value && sidebarOpen.value) return closeSidebar()
  if (cardOpen.value) return closeCard()
  if (state.pin.value && !pinSaving.value) state.cancelPin()
})

/* ---------------- empty map hint ---------------- */

const emptyHint = computed<'nothing' | 'filtered' | null>(() => {
  if (state.pin.value || cardOpen.value || questStarts.value.length > 0 || visibleCount.value > 0) return null
  return state.filters.categories.length === 0 ? 'nothing' : 'filtered'
})
</script>

<template>
  <div class="relative flex min-h-0 overflow-hidden bg-ink">
    <!-- Filters: a column on wide screens, a drawer on narrow ones -->
    <aside
      v-show="isWide ? sidebarOpen : true"
      id="map-filters"
      aria-label="Kaartfilters"
      :inert="!isWide && !sidebarOpen"
      :class="
        cn(
          'z-30 flex min-h-0 flex-col border-r border-line-dark bg-leather',
          isWide
            ? 'relative w-[21rem] shrink-0'
            : [
                'absolute inset-y-0 left-0 w-[min(22rem,calc(100%-3rem))] shadow-[18px_0_40px_-20px_rgba(0,0,0,0.9)]',
                'transition-transform duration-200 ease-out motion-reduce:transition-none',
                sidebarOpen ? 'translate-x-0' : '-translate-x-full',
              ],
        )
      "
    >
      <MapSidebar
        ref="sidebarRef"
        :drawer="!isWide"
        :shown="isWide ? sidebarOpen : true"
        @close="closeSidebar"
        @select="onSearchSelect"
      />
    </aside>
    <div
      v-if="!isWide && sidebarOpen"
      aria-hidden="true"
      class="absolute inset-0 z-20 bg-ink/60"
      @click="closeSidebar"
    />

    <!-- Map -->
    <div class="relative min-w-0 flex-1">
      <div
        ref="mapEl"
        class="ash-map absolute inset-0 isolate z-0"
        role="region"
        aria-label="Kaart. Pijltjes verschuiven, plus en min zoomen."
      />
      <!-- Soft vignette for depth at the edges of the view -->
      <div aria-hidden="true" class="pointer-events-none absolute inset-0 z-[1] shadow-[inset_0_0_90px_rgba(0,0,0,0.35)]" />

      <!-- Top: filters button, pin banner, empty hint -->
      <div class="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2">
        <Button
          v-if="!sidebarOpen"
          ref="toggleRef"
          variant="secondary"
          class="pointer-events-auto shadow-[0_10px_24px_-12px_rgba(0,0,0,0.9)]"
          aria-controls="map-filters"
          :aria-expanded="false"
          @click="openSidebar"
        >
          <SlidersHorizontal aria-hidden="true" />
          Filters
          <span
            v-if="state.filters.categories.length"
            class="rounded-full bg-gold/15 px-1.5 py-0.5 text-xs text-gold tabular-nums"
          >
            {{ state.filters.categories.length }}
            <span class="sr-only">categorieën aan</span>
          </span>
        </Button>

        <!-- Own row on phones, next to the button from sm up -->
        <div class="flex min-w-0 flex-1 basis-full justify-center sm:basis-0">
          <MapPinBanner
            v-if="pinQuest"
            :quest="pinQuest"
            :has-manual-pin="pinQuest.start?.source === 'override'"
            :saving="pinSaving"
            :error="pinError"
            @cancel="state.cancelPin()"
            @remove="removePin"
          />
          <div
            v-else-if="emptyHint"
            role="status"
            class="pointer-events-auto flex max-w-md flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line-dark bg-leather/95 px-4 py-2.5 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.9)]"
          >
            <p class="min-w-0 flex-1 basis-52 leading-snug">
              <template v-if="emptyHint === 'nothing'">Nog niets op de kaart. Kies bij de filters wat je wilt zien.</template>
              <template v-else>Je filters verbergen alle punten van deze categorieën.</template>
            </p>
            <Button v-if="emptyHint === 'nothing'" variant="outline" size="sm" @click="state.resetFilters()">
              Toon vaults en queststarts
            </Button>
            <Button v-else variant="outline" size="sm" @click="state.clearRefinements()">Wis level en regio</Button>
          </div>
        </div>
      </div>

      <!-- Card: floating on the right (clear of the zoom buttons), a bottom sheet on phones -->
      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        :enter-from-class="isSm ? 'opacity-0 translate-x-2' : 'opacity-0 translate-y-4'"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        :leave-to-class="isSm ? 'opacity-0 translate-x-2' : 'opacity-0 translate-y-4'"
      >
        <div
          v-if="cardOpen"
          ref="cardEl"
          :key="cardKey"
          tabindex="-1"
          :class="
            cn(
              'absolute z-10 overflow-y-auto overscroll-contain outline-none',
              isSm
                ? 'top-3 right-3 max-h-[calc(100%-10.5rem)] w-[23rem] max-w-[calc(100%-1.5rem)]'
                : 'inset-x-0 bottom-0 max-h-[62%] rounded-t-md shadow-[0_-16px_40px_-18px_rgba(0,0,0,0.95)]',
            )
          "
        >
          <MapPointCard
            v-if="selectedPoint"
            :point="selectedPoint"
            :class="!isSm && 'rounded-b-none'"
            @close="closeCard"
          />
          <MapQuestCard
            v-else-if="selectedQuest"
            :quest="selectedQuest"
            :class="!isSm && 'rounded-b-none'"
            @close="closeCard"
          />
        </div>
      </Transition>

      <!-- Bottom: coordinates and zoom -->
      <template v-if="isSm || !cardOpen">
        <div class="pointer-events-none absolute bottom-3 left-3 z-10">
          <MapReadout :cursor="leaflet.cursor.value" :center="leaflet.center.value" />
        </div>
        <div class="absolute right-3 bottom-3 z-10">
          <MapZoomControl
            :zoom="leaflet.zoom.value"
            :min-zoom="leaflet.minZoom.value"
            :max-zoom="leaflet.maxZoom"
            @in="leaflet.zoomIn()"
            @out="leaflet.zoomOut()"
            @fit="leaflet.fitLand(true)"
          />
        </div>
      </template>
    </div>
  </div>
</template>
