import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ICONS, buildManifest, pngSize, readManifestIcons, startUrlFor } from './manifest.ts'
import { pngHeader } from './test-utils.ts'

describe('buildManifest', () => {
  it('describes the standalone app in the ink colour', () => {
    const m = buildManifest('/')
    expect(m).toMatchObject({
      id: '/',
      name: 'Ash Log',
      short_name: 'Ash Log',
      display: 'standalone',
      start_url: '/',
      scope: '/',
      background_color: '#15120e',
      theme_color: '#211c16',
    })
    expect(m.icons).toEqual(DEFAULT_ICONS)
  })

  it('puts a device token in start_url, url-encoded', () => {
    expect(startUrlFor(undefined)).toBe('/')
    expect(startUrlFor('abc_-DEF')).toBe('/?device=abc_-DEF')
    expect(startUrlFor('a+b/c=')).toBe('/?device=a%2Bb%2Fc%3D')
  })
})

describe('icons', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ashenfall-icons-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the size from a PNG header', () => {
    expect(pngSize(pngHeader(192, 192))).toEqual({ width: 192, height: 192 })
    expect(pngSize(Buffer.from('not a png at all, really not'))).toBeNull()
    expect(pngSize(Buffer.alloc(3))).toBeNull()
  })

  it('lists the square icons with their real sizes, maskable by name, apple and favicons left out', async () => {
    await writeFile(join(dir, 'icon-512.png'), pngHeader(512, 512))
    await writeFile(join(dir, 'icon-192.png'), pngHeader(192, 192))
    await writeFile(join(dir, 'icon-maskable-512.png'), pngHeader(512, 512))
    await writeFile(join(dir, 'apple-touch-icon.png'), pngHeader(180, 180))
    await writeFile(join(dir, 'favicon-32.png'), pngHeader(32, 32))
    await writeFile(join(dir, 'banner.png'), pngHeader(512, 256))
    await writeFile(join(dir, 'broken.png'), 'nope')
    await writeFile(join(dir, 'icon.svg'), '<svg/>')
    expect(await readManifestIcons(dir)).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ])
  })

  it('falls back to the default names when the folder is missing or empty', async () => {
    expect(await readManifestIcons(join(dir, 'missing'))).toEqual(DEFAULT_ICONS)
    expect(await readManifestIcons(dir)).toEqual(DEFAULT_ICONS)
  })
})
