// Map projection, taken from MediaWiki:Gadget-maps.js (see docs/spikes.md).
// Verified with the Windmill point: it lands on the windmill in tile 4/1_16.
//
// Game coordinates: x grows east, y grows south. Leaflet LatLng is [y, x], and the
// CRS does not flip y. At zoom z a game coordinate maps to pixels as:
//   px = 2^z * MULT * (x + OFFSET_X)
//   py = 2^z * MULT * (y + OFFSET_Y)
// Pure numbers only here; MapView builds the Leaflet CRS from these constants.

/** World size in game units (square). */
export const WORLD_SIZE = 420000
/** Pixel size of the full map at the highest native zoom. */
export const MAP_PIXELS = 6144
/** Tiles per side of the original map the offsets were based on. */
export const ORIGINAL_TILES = 16
export const MULT = MAP_PIXELS / WORLD_SIZE / ORIGINAL_TILES
export const OFFSET_X = 11075
export const OFFSET_Y = 100800 + 16885

export const TILE_SIZE = 256
export const MIN_NATIVE_ZOOM = 0
export const MAX_NATIVE_ZOOM = 4

/** Leaflet bounds as [[lat, lng], [lat, lng]] (top-left, bottom-right). */
export const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-OFFSET_Y, -OFFSET_X],
  [WORLD_SIZE - OFFSET_Y, WORLD_SIZE - OFFSET_X],
]

/** Local tile URL template (tiles are downloaded once by the sync). */
export const TILE_URL = '/wiki-img/tiles/{z}/{x}_{y}.png'
/** Upstream tile URL template, used only by the sync to download. */
export const UPSTREAM_TILE_URL = 'https://maps.runescape.wiki/dw/tiles/{z}/{x}_{y}.png'

export function toLatLng(x: number, y: number): [number, number] {
  return [y, x]
}

export function fromLatLng(lat: number, lng: number): { x: number; y: number } {
  return { x: lng, y: lat }
}

/** Pixel position of a game coordinate at a zoom level. */
export function toPixel(x: number, y: number, zoom: number): { px: number; py: number } {
  const scale = 2 ** zoom * MULT
  return { px: scale * (x + OFFSET_X), py: scale * (y + OFFSET_Y) }
}

/** Number of tiles per side at a native zoom level. */
export function tilesPerSide(zoom: number): number {
  return Math.ceil((2 ** zoom * MULT * WORLD_SIZE) / TILE_SIZE)
}
