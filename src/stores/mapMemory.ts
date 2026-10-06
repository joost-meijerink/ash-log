// The last map filters of this session, in memory only (nothing is written to disk).
// A link to /map without filter params ('Show on map' from a quest) keeps them, so a link
// with a target does not throw away your setup. See useMapState.
//
// The map view itself stays alive between visits (<KeepAlive> in App.vue) and keeps its whole
// state, so while it lives these are simply its current filters. They are kept outside the view
// for the one case where the view is created anew within a session: the shell dropped its views
// (no data for a moment) or, while developing, a hot reload of the view.

import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { cloneFilters, type MapFilters } from '@/lib/map-url'

export const useMapMemoryStore = defineStore('mapMemory', () => {
  const lastFilters = shallowRef<MapFilters | null>(null)

  function remember(filters: MapFilters) {
    lastFilters.value = cloneFilters(filters)
  }

  function forget() {
    lastFilters.value = null
  }

  return { lastFilters, remember, forget }
})
