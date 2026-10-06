// Shares the map model, URL state and counters between MapView and its sidebar components,
// so the sidebar does not need a dozen props.

import { inject, provide, type ComputedRef, type InjectionKey } from 'vue'
import type { CategoryCount } from '@/lib/map-filter'
import type { MapGroupOverride } from './useMapGroupOverride'
import type { MapModel } from './useMapModel'
import type { MapState } from './useMapState'

export interface MapContext {
  model: MapModel
  state: MapState
  /** Per category id: points after the power and region filters, and found ones among them. */
  counts: ComputedRef<Map<string, CategoryCount>>
  /** Number of markers on the map right now (quest start pins not included). */
  visibleCount: ComputedRef<number>
  /** Search terms of the current query, normalized. Empty when not searching. */
  terms: ComputedRef<string[]>
  /** Moving a category to another group by hand (overrides.categoryGroup). */
  groupOverride: MapGroupOverride
}

const KEY: InjectionKey<MapContext> = Symbol('ashenfall-map')

export function provideMapContext(ctx: MapContext): MapContext {
  provide(KEY, ctx)
  return ctx
}

export function useMapContext(): MapContext {
  const ctx = inject(KEY, null)
  if (!ctx) throw new Error('useMapContext() needs provideMapContext() in MapView')
  return ctx
}
