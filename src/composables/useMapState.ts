// Map filters, selection and pin mode, kept in the URL (see src/lib/map-url.ts for the params).
// Every change goes through an action here, which writes the URL with a replace.
// Navigation from elsewhere (a link to /kaart?focus=...) is parsed back in; our own writes are
// recognised by their query key and ignored, so typing never races the URL.
// A URL without filter params gets the last filters of this session (src/stores/mapMemory.ts).
//
// The map view stays alive while another view is on screen (src/composables/useViewRoute.ts), so
// this state lives on. Coming back where the map was left (the header tab, back/forward) keeps the
// state as it is and only brings the URL in line; any other way in (a link with a target) is
// applied like navigation, and its target is shown again even when it already was the selection.
// While the map is away nothing is written to the URL: it belongs to another view then.

import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import {
  canonicalNumbers,
  canonicalStrings,
  emptyFilters,
  hasFilterParams,
  queryKey,
  parseMapQuery,
  serializeFilters,
  serializeMapQuery,
  type MapFilters,
  type RawQuery,
} from '@/lib/map-url'
import { useDataStore } from '@/stores/data'
import { useMapMemoryStore } from '@/stores/mapMemory'
import type { MapModel } from './useMapModel'
import { useViewRoute } from './useViewRoute'

const SEARCH_DEBOUNCE_MS = 300

/** A request to move the map; `seq` makes repeated requests for the same target distinct. */
export interface FlyRequest {
  /**
   * 'pin': show the current start of the quest being pinned, no card to dodge.
   * 'land': the whole land, for a link that names filters and no spot (`id` is empty).
   */
  kind: 'point' | 'quest' | 'pin' | 'land'
  id: string
  seq: number
}

export function useMapState(model: MapModel) {
  const view = useViewRoute()
  /** The map's own route: it never shows the address of another view. */
  const route = view.route
  const data = useDataStore()
  const memory = useMapMemoryStore()

  const filters = reactive<MapFilters>(emptyFilters())
  const focus = ref<string | undefined>()
  const quest = ref<string | undefined>()
  const pin = ref<string | undefined>()
  const flyRequest = shallowRef<FlyRequest | null>(null)
  let seq = 0

  /**
   * Keys of our own URL writes that are still landing. The route watcher skips them, also when an
   * older write lands after a newer one. A key is dropped once its navigation has settled (a tick
   * later, after the watcher ran), so later navigation to the same URL is applied normally.
   */
  const ownKeys: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  /**
   * The map is on screen: the URL is ours to read. Writing goes through view.replace, which also
   * holds back while a navigation to another view is on its way (its component may still be
   * loading, and a write of ours would cancel it); coming back brings the URL in line.
   */
  const onMap = () => view.active.value

  function requestFly(kind: FlyRequest['kind'], id: string) {
    flyRequest.value = { kind, id, seq: ++seq }
  }

  /* ---------------- URL -> state ---------------- */

  /**
   * `arrived`: a link from another view brought you here. Its target is handled like on a map
   * that opens: the map goes there, also when it was the selection already.
   */
  function applyQuery(query: RawQuery, arrived = false) {
    if (timer) clearTimeout(timer)
    timer = undefined
    const prevFocus = focus.value
    const prevQuest = quest.value
    const prevPin = pin.value
    // No filter params: fall back on the last filters of this session. They go through the parser
    // too, so ids that a resync dropped are ignored.
    const remembered = memory.lastFilters
    const source =
      !hasFilterParams(query) && remembered ? { ...query, ...serializeFilters(remembered, model.defaults.value) } : query
    const s = parseMapQuery(source, model.known.value, model.defaults.value)
    filters.categories = s.categories
    filters.powers = s.powers
    filters.strictPower = s.strictPower
    filters.regions = s.regions
    filters.search = s.search
    filters.hideFound = s.hideFound
    filters.questStarts = s.questStarts
    focus.value = s.focus
    quest.value = s.quest
    pin.value = s.pin

    let dirty = false
    if (s.focus && (arrived || s.focus !== prevFocus)) {
      // Arriving with ?focus=: its category goes on and the map flies there.
      const point = data.pointById.get(s.focus)
      if (point && !filters.categories.includes(point.categoryId)) {
        filters.categories = canonicalStrings([...filters.categories, point.categoryId])
        dirty = true
      }
      requestFly('point', s.focus)
    }
    if (s.quest && (arrived || s.quest !== prevQuest)) requestFly('quest', s.quest)
    if (s.pin && (arrived || s.pin !== prevPin) && !s.focus && !s.quest) requestFly('pin', s.pin)
    // A link with filters and no spot (the chest counts in Verzamelingen): the map that was kept
    // may be zoomed in somewhere else, so show the whole land, as a map that opens does.
    if (arrived && !s.focus && !s.quest && !s.pin && hasFilterParams(query)) requestFly('land', '')
    // Unknown ids were dropped, or a category was added: bring the URL in line.
    if (dirty || queryKey(serializeMapQuery(s, model.defaults.value)) !== queryKey(query)) write()
  }

  /* ---------------- state -> URL ---------------- */

  const query = computed(() =>
    serializeMapQuery({ ...filters, focus: focus.value, quest: quest.value, pin: pin.value }, model.defaults.value),
  )

  /** Query with the current filters plus extra params, for links that stay on the map. */
  function mapQuery(extra: Record<string, string> = {}): Record<string, string> {
    return { ...serializeFilters(filters, model.defaults.value), ...extra }
  }

  function write() {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!onMap()) return
    const next = query.value
    const key = queryKey(next)
    if (key === queryKey(route.query)) return
    ownKeys.push(key)
    void view.replace({ query: next }).finally(() => {
      setTimeout(() => {
        const i = ownKeys.indexOf(key)
        if (i >= 0) ownKeys.splice(i, 1)
      }, 0)
    })
  }

  function writeSoon() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(write, SEARCH_DEBOUNCE_MS)
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  // Remember every change right away (also search text that is not in the URL yet).
  watch(filters, () => memory.remember(filters), { deep: true, flush: 'sync' })

  /**
   * A sync while the map was away can have removed the point or the quest that was selected. A
   * map that opens drops such ids from its address (the parser); a map that comes back does too.
   */
  function dropGone() {
    const known = model.known.value
    // A point that the sync merged into a twin: the card of the one that was kept.
    if (focus.value && !known.point(focus.value)) focus.value = known.pointAlias?.(focus.value)
    if (quest.value && !known.quest(quest.value)) quest.value = undefined
    if (pin.value && !known.quest(pin.value)) pin.value = undefined
  }

  /** The last switch to the map that was handled; the one this view was created for counts as handled. */
  let arrivalSeq = view.arrival.value?.seq

  function follow() {
    if (!onMap()) return
    const arrival = view.arrival.value
    const arrived = !!arrival && arrival.seq !== arrivalSeq
    arrivalSeq = arrival?.seq
    // Back where the map was left: the state is the truth. The URL can lag behind (search text
    // typed just before leaving, a pin that was saved while away), so bring it in line.
    if (arrived && arrival.kind === 'return') {
      dropGone()
      return write()
    }
    const next = route.query
    if (arrived) return applyQuery(next, true)
    // Our own write landing (possibly after a newer one), or already the current state: nothing to do.
    const key = queryKey(next)
    if (ownKeys.includes(key) || key === queryKey(query.value)) return
    applyQuery(next)
  }

  // Registered after `query` and `write` exist: the first run may write the URL.
  // One watcher for the address and the arrival: a link from another view changes both at once,
  // and its target must be handled once.
  watch([() => route.query, view.arrival], follow)
  follow()
  // The URL may already match the empty start state (/kaart?c=), then nothing was applied above.
  if (onMap()) memory.remember(filters)

  /* ---------------- actions ---------------- */

  function setCategories(ids: readonly string[], on: boolean) {
    const set = new Set(filters.categories)
    for (const id of ids) {
      if (on) set.add(id)
      else set.delete(id)
    }
    filters.categories = canonicalStrings(set)
    write()
  }

  function toggleCategory(id: string, on = !filters.categories.includes(id)) {
    setCategories([id], on)
  }

  function togglePower(level: number) {
    filters.powers = filters.powers.includes(level)
      ? filters.powers.filter((p) => p !== level)
      : canonicalNumbers([...filters.powers, level])
    // Strict mode means nothing without a level; it does not come back with the next level.
    if (filters.powers.length === 0) filters.strictPower = false
    write()
  }

  /** 'Alleen met power level': hide points without a level too. Only while a level is picked. */
  function setStrictPower(on: boolean) {
    filters.strictPower = on && filters.powers.length > 0
    write()
  }

  function toggleRegion(region: string) {
    filters.regions = filters.regions.includes(region)
      ? filters.regions.filter((r) => r !== region)
      : canonicalStrings([...filters.regions, region])
    write()
  }

  function setSearch(text: string) {
    filters.search = text
    writeSoon()
  }

  function setHideFound(on: boolean) {
    filters.hideFound = on
    write()
  }

  function setQuestStarts(on: boolean) {
    filters.questStarts = on
    write()
  }

  /** 'Wis filters': everything off, search cleared. The selection stays. */
  function clearFilters() {
    Object.assign(filters, emptyFilters())
    write()
  }

  /** Drops the power, region and found filters; categories stay. */
  function clearRefinements() {
    filters.powers = []
    filters.strictPower = false
    filters.regions = []
    filters.hideFound = false
    write()
  }

  /** Back to the defaults (vaults and quest starts). */
  function resetFilters() {
    const d = model.defaults.value
    Object.assign(filters, { ...d, categories: [...d.categories] })
    write()
  }

  /**
   * Opens the card of a point. `fly` moves the map (search results); a marker click does not.
   * The point's category goes on, so the point stays on the map after the card closes.
   */
  function selectPoint(id: string, opts: { fly?: boolean } = {}) {
    const point = data.pointById.get(id)
    if (!point) return
    if (!filters.categories.includes(point.categoryId)) {
      filters.categories = canonicalStrings([...filters.categories, point.categoryId])
    }
    focus.value = id
    quest.value = undefined
    if (opts.fly) requestFly('point', id)
    write()
  }

  function selectQuest(id: string, opts: { fly?: boolean } = {}) {
    if (!data.questById.has(id)) return
    quest.value = id
    focus.value = undefined
    if (opts.fly) requestFly('quest', id)
    write()
  }

  function clearSelection() {
    if (!focus.value && !quest.value) return
    focus.value = undefined
    quest.value = undefined
    write()
  }

  function startPin(id: string) {
    if (!data.questById.has(id)) return
    pin.value = id
    focus.value = undefined
    quest.value = undefined
    write()
  }

  function cancelPin() {
    if (!pin.value) return
    const id = pin.value
    pin.value = undefined
    quest.value = id
    write()
  }

  /** After placing or removing a pin: /kaart?quest=<id> with the current filters. */
  function finishPin(id: string) {
    pin.value = undefined
    focus.value = undefined
    quest.value = id
    write()
  }

  return {
    filters,
    focus,
    quest,
    pin,
    flyRequest,
    mapQuery,
    setCategories,
    toggleCategory,
    togglePower,
    setStrictPower,
    toggleRegion,
    setSearch,
    setHideFound,
    setQuestStarts,
    clearFilters,
    clearRefinements,
    resetFilters,
    selectPoint,
    selectQuest,
    clearSelection,
    startPin,
    cancelPin,
    finishPin,
  }
}

export type MapState = ReturnType<typeof useMapState>
