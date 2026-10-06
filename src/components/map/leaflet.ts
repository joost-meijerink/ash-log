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
  type MarkerIconSpec,
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
    if (img) img.addEventListener('error', () => el.classList.add('is-broken'), { once: true })
    return el
  }
}

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

/** Leather disc with a gold count. */
export function clusterIcon(cluster: L.MarkerCluster): L.DivIcon {
  const count = cluster.getChildCount()
  const size = clusterSize(count)
  return L.divIcon({
    html:
      `<span class="ash-cluster__count" aria-hidden="true">${formatClusterCount(count)}</span>` +
      `<span class="ash-sr">${count} points, zoom in</span>`,
    className: `ash-cluster ash-cluster--${size}`,
    iconSize: [size, size],
  })
}

export { L }
