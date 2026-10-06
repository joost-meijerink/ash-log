/**
 * Figma-friendly copies of the app icon, for editing by hand.
 *
 *   npx tsx scripts/desktop/make-figma.ts    writes scripts/desktop/figma/ash-log-ios.svg and ash-log-macos.svg
 *
 * The render sources (icon.svg, icon-macos.svg) use things Figma imports badly: the sprite as a
 * separate file, SVG filters (leather grain, drop shadows) and masks that draw the borders as exact
 * inward offsets of the icon shape. These copies inline the sprite, drop the filters and draw every
 * border as a plain stroked path: Apple's continuous-corner rectangle inset by d with radius R - d,
 * which stays within 1.5 px of the exact offset at 1024 px. Element ids become Figma layer names.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DESKTOP_DIR, readSource } from './make-icons.ts'
import { continuousRect, IOS_MASK_RADIUS, num } from './shapes.ts'

export { continuousRect }

export const FIGMA_DIR = join(DESKTOP_DIR, 'figma')

export type FigmaVariant = 'ios' | 'macos'

/** The shape each render source draws its borders against. */
export const SHAPES = {
  // The mask iOS puts on a home-screen icon (the full-bleed icon.svg is masked by iOS itself).
  ios: { source: 'icon', id: 'mask', x: 0, y: 0, size: 1024, radius: IOS_MASK_RADIUS },
  // The body of the macOS icon on Apple's icon grid (824 px, radius 185.4).
  macos: { source: 'icon-macos', id: 'body', x: 100, y: 100, size: 824, radius: 185.4 },
} as const

export interface Band {
  name: string
  /** Distance of the middle of the line from the edge of the shape. */
  inset: number
  width: number
  color: string
  opacity?: number
}

/** The borders of a render source, read from its band masks (stroke widths 2d + w and 2d - w). */
export function readBands(svg: string): Band[] {
  const bands: Band[] = []
  const maskRe = /<mask id="band-([\w-]+)"[^>]*>\s*<use [^>]*stroke-width="([\d.]+)"\/>\s*<use [^>]*stroke-width="([\d.]+)"\/>\s*<\/mask>/g
  for (const [, name, outer, inner] of svg.matchAll(maskRe)) {
    const rect = new RegExp(`<rect [^>]*fill="(#[0-9a-fA-F]+)"(?: opacity="([\\d.]+)")? mask="url\\(#band-${name}\\)"/>`).exec(svg)
    if (!rect) throw new Error(`No rect uses band-${name}`)
    const a = Number(outer)
    const b = Number(inner)
    bands.push({ name: name!, inset: (a + b) / 4, width: (a - b) / 2, color: rect[1]!, ...(rect[2] ? { opacity: Number(rect[2]) } : {}) })
  }
  return bands
}

const BAND_LAYER: Record<string, string> = { outer: 'Rand_buiten', inner: 'Rand_binnen', gold: 'Rand_goud' }

/** A Figma-friendly SVG of one icon variant. */
export function figmaSvg(variant: FigmaVariant): string {
  const shape = SHAPES[variant]
  let svg = readSource(shape.source)
  const shapePath = new RegExp(`<path id="${shape.id}" d="([^"]+)"/>`).exec(svg)?.[1]
  if (!shapePath) throw new Error(`${shape.source}.svg has no path #${shape.id}`)
  const bands = readBands(svg)

  // Borders: plain stroked paths instead of the masked rects.
  const borders = bands
    .map((band) => {
      const s = shape.size - 2 * band.inset
      const d = continuousRect(shape.x + band.inset, shape.y + band.inset, s, s, shape.radius - band.inset)
      const opacity = band.opacity === undefined ? '' : ` opacity="${band.opacity}"`
      return `    <path id="${BAND_LAYER[band.name] ?? `Rand_${band.name}`}" d="${d}" fill="none" stroke="${band.color}" stroke-width="${num(band.width)}"${opacity}/>`
    })
    .join('\n')
  svg = svg.replace(/<g clip-path="url\(#(?:inside|clip)\)">\s*(?:<rect [^>]*mask="url\(#band-[\w-]+\)"\/>\s*)+<\/g>/, `<g id="Randen">\n${borders}\n  </g>`)

  // No masks, filters or unused paint servers.
  svg = svg
    .replace(/\s*<mask id="band-[\s\S]*?<\/mask>/g, '')
    .replace(/\s*<filter [\s\S]*?<\/filter>/g, '')
    .replace(/\s*<linearGradient id="gilt"[\s\S]*?<\/linearGradient>/, '')
    .replace(/\s*<rect [^>]*filter="url\(#grain\)"[^>]*\/>/g, '')
    .replace(/ filter="url\(#[\w-]+\)"/g, '')
    .replace(/\s*<clipPath id="inside">[\s\S]*?<\/clipPath>/, '')

  // Inline <use> of the shape (Figma resolves plain paths more reliably than references).
  svg = svg.replace(new RegExp(`<use href="#${shape.id}"([^>]*)/>`, 'g'), `<path d="${shapePath}"$1/>`)
  svg = svg.replace(new RegExp(`\\s*<path id="${shape.id}" d="[^"]+"/>`), '')

  // Layer names.
  svg = svg
    .replace(/<rect width="1024" height="1024" fill="url\(#leather\)"\/>/, '<rect id="Leer" width="1024" height="1024" fill="url(#leather)"/>')
    .replace(/<g fill="none" stroke="#0d0b08"/, '<g id="Kompasroos" fill="none" stroke="#0d0b08"')
    .replace(/<g fill="#c9a24a" opacity="0.95">/, '<g id="Ruitjes" fill="#c9a24a" opacity="0.95">')
    .replace(/<image href=/, '<image id="Ash_Logs" xlink:href=')
    .replace(/<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/, '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"')
  if (variant === 'macos') {
    svg = svg
      .replace(/<path d="([^"]+)" fill="#15120e"\/>/, '<path id="Vorm" d="$1" fill="#15120e"/>')
      .replace(/<g clip-path="url\(#clip\)">/, '<g id="Body" clip-path="url(#clip)">')
      .replace(/<path d="([^"]+)" fill="none" stroke="url\(#rim\)"/, '<path id="Randlicht" d="$1" fill="none" stroke="url(#rim)"')
  } else {
    // Guide only: iOS applies this mask itself. Hide the layer before exporting.
    svg = svg.replace(
      '</svg>',
      `  <path id="iOS-masker_hulplijn_verbergen_bij_export" d="${shapePath}" fill="none" stroke="#ff4fd8" stroke-width="2" stroke-dasharray="12 8" opacity="0.8"/>\n</svg>`,
    )
  }

  const note =
    variant === 'ios'
      ? '<!-- Ash Log icon for iPhone and the web, Figma copy. Generated by make-figma.ts from icon.svg; iOS rounds the corners itself. -->'
      : '<!-- Ash Log icon for the macOS Dock, Figma copy. Generated by make-figma.ts from icon-macos.svg. -->'
  return svg
    .replace(/\s*<!--[\s\S]*?-->/g, '')
    .replace(/(<svg [^>]*>)/, `$1\n  ${note}`)
    .replace(/\n\s*\n/g, '\n')
}

export function writeFigmaSvgs(dir = FIGMA_DIR): string[] {
  mkdirSync(dir, { recursive: true })
  return (['ios', 'macos'] as const).map((variant) => {
    const file = join(dir, `ash-log-${variant}.svg`)
    writeFileSync(file, figmaSvg(variant))
    return file
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const file of writeFigmaSvgs()) console.log(`geschreven: ${file}`)
}
