// Leaflet building blocks for the map: the game CRS and the marker icons.
// Leaflet itself is imported here and in useMapLeaflet only.

import L from 'leaflet'
import 'leaflet.markercluster'
import { MULT, OFFSET_X, OFFSET_Y, WORLD_BOUNDS } from '@/lib/projection'
import {
  clusterSize,
  formatClusterCount,
  iconKey,
  markerClassName,
  markerHtml,
  markerSize,
  questStartHtml,
  singleKind,
  stackHtml,
  type MarkerIconSpec,
  type StackChild,
} from '@/lib/map-icons'

/**
 * CRS from MediaWiki:Gadget-maps.js: LatLng is [y, x] in game units, y is not flipped.
 * At zoom z: px = 2^z * MULT * (x + OFFSET_X), py = 2^z * MULT * (y + OFFSET_Y).
 */
export function createGameCrs(): L.CRS {
  return L.extend({}, L.CRS.Simple, {
    projection: L.Projection.LonLat,
    transformation: new L.Transformation(MULT, MULT * OFFSET_X, MULT, MULT * OFFSET_Y),
  }) as L.CRS
}

export function worldBounds(): L.LatLngBounds {
  return L.latLngBounds(WORLD_BOUNDS)
}

/**
 * divIcon whose wiki image falls back to the glyph disc when the file is missing
 * (not every icon the wiki names could be downloaded).
 */
class WikiDivIcon extends L.DivIcon {
  override createIcon(oldIcon?: HTMLElement): HTMLElement {
    const el = super.createIcon(oldIcon)
    const img = el.querySelector('img')
    // The marker element can be the icon itself or sit inside it (a stack, the selection ring).
    const marker = el.matches('.ash-marker') ? el : (el.querySelector('.ash-marker') ?? el)
    if (img) img.addEventListener('error', () => marker.classList.add('is-broken'), { once: true })
    return el
  }
}

/** Box of a stack icon: the 28px sprite with room around it. */
const STACK_SIZE = 32

/** One Leaflet icon per spec, shared by every marker with that spec. */
export function createIconCache() {
  const cache = new Map<string, L.DivIcon>()
  return {
    get(spec: MarkerIconSpec): L.DivIcon {
      const key = iconKey(spec)
      let icon = cache.get(key)
      if (!icon) {
        const size = markerSize(spec)
        icon = new WikiDivIcon({
          html: markerHtml(spec),
          className: markerClassName(spec),
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        })
        cache.set(key, icon)
      }
      return icon
    },
    clear() {
      cache.clear()
    },
  }
}

/** Selected point: the marker itself inside a gold ring, drawn above clusters. */
export function selectedIcon(spec: MarkerIconSpec): L.DivIcon {
  return new WikiDivIcon({
    html: `<span class="ash-selected__ring"></span><span class="${markerClassName(spec)}">${markerHtml(spec)}</span>`,
    className: 'ash-selected',
    iconSize: [48, 48],
    iconAnchor: [24, 24],
  })
}

/** Gold quest start pin. The tip of the pin sits on the spot. */
export function questStartIcon(count: number, highlighted: boolean, manual: boolean): L.DivIcon {
  const w = highlighted ? 36 : 28
  const h = highlighted ? 46 : 36
  return L.divIcon({
    html: `${highlighted ? '<span class="ash-quest-pin__ring"></span>' : ''}${questStartHtml(count)}`,
    className: ['ash-quest-pin', highlighted ? 'is-highlighted' : '', manual ? 'is-manual' : ''].filter(Boolean).join(' '),
    iconSize: [w, h],
    iconAnchor: [w / 2, h - 1],
  })
}

/**
 * A stack (all markers of one kind): the kind's own sprite with a count. Anything else: the leather
 * seal with a gold count. `childOf` tells what a marker is; without it every cluster is a seal.
 * markercluster calls this once per cluster and again only when its markers change, or when
 * refreshClusters says so (a found state that changed).
 */
export function clusterIcon(cluster: L.MarkerCluster, childOf?: (marker: L.Marker) => StackChild | undefined): L.DivIcon {
  const count = cluster.getChildCount()
  const stack = childOf ? singleKind(cluster.getAllChildMarkers(), childOf) : null
  if (stack) {
    return new WikiDivIcon({
      html: stackHtml(stack.spec, count, stack.label),
      className: 'ash-stack',
      iconSize: [STACK_SIZE, STACK_SIZE],
    })
  }
  const size = clusterSize(count)
  return L.divIcon({
    html:
      `<span class="ash-cluster__count" aria-hidden="true">${formatClusterCount(count)}</span>` +
      `<span class="ash-sr">${count} points, zoom in</span>`,
    className: `ash-cluster ash-cluster--${size}`,
    iconSize: [size, size],
  })
}

/* ---------------- cluster group ---------------- */

/*
 * leaflet.markercluster 1.5.3 assumes the map's minimum zoom never changes once the group is on the
 * map, and that it is a whole number. Ours follows the window (0, 0.5, 1 or 1.5), which broke two
 * things. Re-check both on every upgrade of the library:
 *
 * 1. The top cluster level sits at floor(minZoom) - 1, but the walk that draws markers starts at
 *    minZoom - 1 (not rounded). At minZoom 0.5 it never reached the top level, so a marker with no
 *    neighbour at any cluster zoom was never drawn: a lone lore item, most NPCs, some vaults.
 *    Fixed by starting both walks (draw and remove) at the top level itself.
 * 2. The cluster grids are built for zoom floor(minZoom) and up when the group is added or cleared,
 *    while adding and removing markers walks down to the current floor(minZoom). A floor that went
 *    down in between read grids that do not exist. Fixed by rebuilding the index when it changes.
 */

type ChildMarker = L.Marker & { _latlng: L.LatLng; _backupLatlng?: L.LatLng; clusterHide?(): void }

/** Private parts of a MarkerCluster (leaflet.markercluster 1.5.3). */
interface ClusterNode {
  _zoom: number
  _group: ClusterGroupInternals
  _markers: ChildMarker[]
  _addToMap(startPos?: L.LatLng | null): void
  _recursively(
    bounds: L.LatLngBounds,
    start: number,
    stop: number,
    every: ((c: ClusterNode) => void) | null,
    bottom?: (c: ClusterNode) => void,
  ): void
}

type ClusterClass = { extend(props: object): ClusterClass; prototype: Record<string, unknown> }

/** Private parts of a MarkerClusterGroup (leaflet.markercluster 1.5.3). */
type ClusterGroupInternals = Pick<L.MarkerClusterGroup, 'getLayers' | 'clearLayers' | 'addLayers'> & {
  _map: L.Map | null
  _featureGroup: L.FeatureGroup
  _topClusterLevel?: ClusterNode
  _markerCluster: ClusterClass
}

const TOP_LEVEL_FIX = {
  /** The library's own body, except that it starts at the top level instead of minZoom - 1. */
  _recursivelyAddChildrenToMap(this: ClusterNode, startPos: L.LatLng | null, zoomLevel: number, bounds: L.LatLngBounds) {
    this._recursively(
      bounds,
      this._group._topClusterLevel?._zoom ?? this._zoom,
      zoomLevel,
      (c) => {
        if (zoomLevel === c._zoom) return
        // Child markers go in at startPos, so they can be animated out.
        for (let i = c._markers.length - 1; i >= 0; i--) {
          const nm = c._markers[i]!
          if (!bounds.contains(nm._latlng)) continue
          if (startPos) {
            nm._backupLatlng = nm.getLatLng()
            nm.setLatLng(startPos)
            nm.clusterHide?.()
          }
          c._group._featureGroup.addLayer(nm)
        }
      },
      (c) => c._addToMap(startPos),
    )
  },

  /** Also takes markers that hang directly under the top level off the map. */
  _recursivelyRemoveChildrenFromMap(
    this: ClusterNode,
    previousBounds: L.LatLngBounds,
    mapMinZoom: number,
    zoomLevel: number,
    exceptBounds?: L.LatLngBounds,
  ) {
    const top = this._group._topClusterLevel?._zoom ?? this._zoom
    const base = (L.MarkerCluster.prototype as unknown as Record<string, (...args: unknown[]) => void>)
      ._recursivelyRemoveChildrenFromMap!
    base.call(this, previousBounds, Math.min(mapMinZoom, top + 1), zoomLevel, exceptBounds)
  },
}

const groupBase = L.MarkerClusterGroup.prototype as unknown as {
  initialize(this: ClusterGroupInternals, options?: L.MarkerClusterGroupOptions): void
  onAdd(this: ClusterGroupInternals, map: L.Map): void
  onRemove(this: ClusterGroupInternals, map: L.Map): void
}

const FixedClusterGroup = L.MarkerClusterGroup.extend({
  initialize(this: ClusterGroupInternals, options?: L.MarkerClusterGroupOptions) {
    groupBase.initialize.call(this, options)
    // The library picks the animated or plain class here; both get the fix.
    this._markerCluster = this._markerCluster.extend(TOP_LEVEL_FIX)
  },
  onAdd(this: ClusterGroupInternals & { _followMinZoom(): void }, map: L.Map) {
    groupBase.onAdd.call(this, map)
    map.on('zoomlevelschange', this._followMinZoom, this)
    this._followMinZoom()
  },
  onRemove(this: ClusterGroupInternals & { _followMinZoom(): void }, map: L.Map) {
    map.off('zoomlevelschange', this._followMinZoom, this)
    groupBase.onRemove.call(this, map)
  },
  /** Rebuilds the cluster index when the whole part of the minimum zoom changed. */
  _followMinZoom(this: ClusterGroupInternals & { _followMinZoom(): void }) {
    const map = this._map
    const top = this._topClusterLevel
    if (!map || !top || Math.floor(map.getMinZoom()) === top._zoom + 1) return
    // Below the new minimum, setMinZoom zooms in right after this event. The new index must not
    // be built under the zoom that is drawn (its top level would land on the map), so wait.
    if (map.getZoom() < map.getMinZoom()) {
      map.once('zoomend', this._followMinZoom, this)
      return
    }
    const layers = this.getLayers()
    this.clearLayers()
    this.addLayers(layers)
  },
}) as unknown as new (options?: L.MarkerClusterGroupOptions) => L.MarkerClusterGroup

/** A marker cluster group that copes with a minimum zoom that changes and is not a whole number. */
export function createClusterGroup(options: L.MarkerClusterGroupOptions): L.MarkerClusterGroup {
  return new FixedClusterGroup(options)
}

export { L }
