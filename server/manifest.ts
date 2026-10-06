// Web app manifest, served dynamically as /manifest.webmanifest.
//
// On iOS a home-screen web app may get its own cookie jar, separate from Safari. So a
// paired phone gets start_url '/?device=<token>': the home-screen app then logs itself in
// on launch (the app server sets the cookie and redirects to '/'). Everyone else gets '/'.

import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { APP_ICONS_DIR } from './config.ts'

export const MANIFEST_PATH = '/manifest.webmanifest'
/** Header colour: browser bars and the Mac titlebar take it on. */
const THEME = '#211c16'
/** Page colour (ink), used behind the splash screen. */
const BACKGROUND = '#15120e'

export interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose?: 'any' | 'maskable'
}

export interface WebManifest {
  id: string
  name: string
  short_name: string
  lang: string
  start_url: string
  scope: string
  display: 'standalone'
  background_color: string
  theme_color: string
  icons: ManifestIcon[]
}

/** Icon names used when public/icons cannot be read. */
export const DEFAULT_ICONS: ManifestIcon[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
]

export function buildManifest(startUrl: string, icons: ManifestIcon[] = DEFAULT_ICONS): WebManifest {
  return {
    // A fixed id keeps the app's identity when start_url carries a device token.
    id: '/',
    name: 'Ash Log',
    short_name: 'Ash Log',
    lang: 'nl',
    start_url: startUrl,
    scope: '/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: THEME,
    icons,
  }
}

/** start_url for a device: its token as ?device=, or '/' without one. */
export function startUrlFor(token: string | undefined): string {
  return token ? `/?device=${encodeURIComponent(token)}` : '/'
}

/** Width and height from a PNG header, or null when the bytes are not a PNG. */
export function pngSize(header: Buffer): { width: number; height: number } | null {
  const signature = '89504e470d0a1a0a'
  if (header.length < 24 || header.subarray(0, 8).toString('hex') !== signature) return null
  if (header.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

async function readHeader(file: string): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buf = Buffer.alloc(24)
    const { bytesRead } = await handle.read(buf, 0, 24, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * The square PNG icons in public/icons of at least 144px, sizes read from the files
 * themselves. A name with 'maskable' marks a maskable icon; the Apple touch icon and
 * favicons are left out. Falls back to DEFAULT_ICONS when nothing usable is found.
 */
export async function readManifestIcons(dir = APP_ICONS_DIR): Promise<ManifestIcon[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const found: { icon: ManifestIcon; size: number }[] = []
  for (const name of names.sort()) {
    if (!/\.png$/i.test(name) || /apple|favicon/i.test(name)) continue
    const size = pngSize(await readHeader(join(dir, name)).catch(() => Buffer.alloc(0)))
    if (!size || size.width !== size.height || size.width < 144) continue
    const icon: ManifestIcon = {
      src: `/icons/${encodeURIComponent(name)}`,
      sizes: `${size.width}x${size.height}`,
      type: 'image/png',
      purpose: /maskable/i.test(name) ? 'maskable' : 'any',
    }
    found.push({ icon, size: size.width })
  }
  if (!found.length) return DEFAULT_ICONS
  const maskable = (icon: ManifestIcon) => (icon.purpose === 'maskable' ? 1 : 0)
  found.sort((a, b) => a.size - b.size || maskable(a.icon) - maskable(b.icon))
  return found.map((f) => f.icon)
}

/** GET /manifest.webmanifest with the given start_url. Returns false for other paths. */
export async function handleManifest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { startUrl: string; iconsDir?: string },
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname !== MANIFEST_PATH) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.end()
    return true
  }
  const body = JSON.stringify(buildManifest(opts.startUrl, await readManifestIcons(opts.iconsDir)), null, 2)
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
  // Differs per device (start_url), so never cached.
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vary', 'Cookie')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}
