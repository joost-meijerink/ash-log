// Marker icon choice and markup. Leaflet turns the markup into divIcons (src/components/map/leaflet.ts).
// Pure, no DOM: this file is also type-checked by the Node config.

import { iconFileName } from './ids'
import { isTrackableGroup } from './map-groups'
import type { MapCategory, MapGroup, MapPoint } from './types'

export type MarkerTone = 'ember' | 'gold' | 'muted'
export type MarkerGlyph = MapGroup | 'quest-start'

export interface MarkerIconSpec {
  /** Wiki icon file (point icon wins over category icon). Undefined: draw the glyph disc. */
  file?: string
  /** Glyph for the disc, also the fallback when the image fails to load. */
  glyph: MarkerGlyph
  tone: MarkerTone
  /** Found lore or unique point: drawn dimmed. */
  found: boolean
}

/** Ember for vaults, chests and places; gold for quest starts; muted for everything else. */
export function markerTone(glyph: MarkerGlyph): MarkerTone {
  if (glyph === 'vault' || glyph === 'chest' || glyph === 'location') return 'ember'
  if (glyph === 'quest-start') return 'gold'
  return 'muted'
}

export function markerIconSpec(point: MapPoint, category: MapCategory | undefined, found: boolean): MarkerIconSpec {
  const glyph: MarkerGlyph = category?.group ?? 'other'
  const file = point.icon || category?.icon || undefined
  return {
    ...(file ? { file } : {}),
    glyph,
    tone: markerTone(glyph),
    found: found && isTrackableGroup(category?.group),
  }
}

/** Cache key: markers with the same spec share one Leaflet icon. */
export function iconKey(spec: MarkerIconSpec): string {
  return [spec.file ?? '', spec.glyph, spec.tone, spec.found ? 'found' : ''].join('|')
}

export function iconUrl(file: string): string {
  return `/wiki-img/icons/${encodeURIComponent(iconFileName(file))}`
}

/** Inner SVG markup per glyph, 24x24 viewBox, drawn with stroke only. */
export const GLYPH_PATHS: Record<MarkerGlyph, string> = {
  // leaf
  resource: '<path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14Z"/><path d="M5 19 13.5 10.5"/>',
  // chest
  chest:
    '<path d="M4 10h16v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z"/><path d="M4 10V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2"/><path d="M4 13.5h16M12 12.5v3"/>',
  // star
  unique: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z"/>',
  // open book
  lore: '<path d="M12 7c-2-1.6-4.6-2-8-2v13c3.4 0 6 .4 8 2 2-1.6 4.6-2 8-2V5c-3.4 0-6 .4-8 2Z"/><path d="M12 7v13"/>',
  // pennant
  quest: '<path d="M6 21V4"/><path d="M6 4.5h11.5l-2.8 4 2.8 4H6"/>',
  // vault door
  vault: '<path d="M5.5 20V11a6.5 6.5 0 0 1 13 0v9"/><path d="M3.5 20h17"/><path d="M9.5 20v-5.5a2.5 2.5 0 0 1 5 0V20"/>',
  // person
  npc: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-4 3.6-6.5 7-6.5s6.2 2.5 7 6.5"/>',
  // crossed swords
  monster: '<path d="m5 4 10.5 10.5M19 4 8.5 14.5"/><path d="m6 15 3 3M4.5 19.5l2.5-2.5M18 15l-3 3M19.5 19.5 17 17"/>',
  // tower
  location: '<path d="M7.5 20V9.5L6 8V4h2.5v2h2V4h3v2h2V4H18v4l-1.5 1.5V20"/><path d="M5 20h14"/><path d="M10.5 20v-3.5a1.5 1.5 0 0 1 3 0V20"/>',
  // ringed dot
  other: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.5"/>',
  // exclamation banner
  'quest-start': '<path d="M12 5v8.5"/><path d="M12 17.5v.5"/>',
}

export function glyphSvg(glyph: MarkerGlyph, className = 'ash-glyph'): string {
  return (
    `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH_PATHS[glyph]}</svg>`
  )
}

/** Class names for the marker element. */
export function markerClassName(spec: MarkerIconSpec): string {
  return ['ash-marker', `ash-marker--${spec.tone}`, spec.file ? 'has-img' : 'is-disc', spec.found ? 'is-found' : '']
    .filter(Boolean)
    .join(' ')
}

/** Inner markup: the wiki image with the glyph disc underneath as a fallback when it fails to load. */
export function markerHtml(spec: MarkerIconSpec): string {
  const disc = `<span class="ash-marker__disc">${glyphSvg(spec.glyph)}</span>`
  if (!spec.file) return disc
  return `<img class="ash-marker__img" src="${iconUrl(spec.file)}" alt="" draggable="false" decoding="async" />${disc}`
}

/** Pixel size of the marker element. */
export function markerSize(spec: MarkerIconSpec): number {
  return spec.file ? 28 : 24
}

/** Gold quest start pin; `count` > 1 adds a small number for shared starts. */
export function questStartHtml(count: number): string {
  const badge = count > 1 ? `<span class="ash-quest-pin__count">${count}</span>` : ''
  return (
    '<svg class="ash-quest-pin__shape" viewBox="0 0 28 36" aria-hidden="true">' +
    '<path d="M14 34.5S2.5 22.8 2.5 13.5a11.5 11.5 0 0 1 23 0C25.5 22.8 14 34.5 14 34.5Z"/></svg>' +
    `${glyphSvg('quest-start', 'ash-quest-pin__glyph')}${badge}`
  )
}

/** Cluster count: 7, 84, 950, 1.2k, 12k (English decimal point). */
export function formatClusterCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(Math.floor(count / 100) / 10).toString()}k`
  return `${Math.floor(count / 1000)}k`
}

/** Cluster disc size in px, growing with the count. */
export function clusterSize(count: number): number {
  if (count < 10) return 34
  if (count < 100) return 40
  if (count < 1000) return 46
  return 52
}
