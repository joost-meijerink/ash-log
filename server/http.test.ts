// resolveInside with the path rules of both systems: path.win32 simulates Windows on any
// computer, so these run (and guard Windows) on macOS and Linux as well.

import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveInside } from './http.ts'

describe('resolveInside on Windows (path.win32)', () => {
  const root = 'C:\\Users\\Joost M\\Ash Log\\public\\wiki-img'
  const at = (pathname: string) => resolveInside(root, pathname, '/wiki-img/', win32)

  it('maps a normal path into the folder, spaces in the folder name included', () => {
    expect(at('/wiki-img/icons/Gold_Ore.png')).toEqual({ ok: true, file: `${root}\\icons\\Gold_Ore.png` })
    expect(at('/wiki-img/tiles/2/1_3.png')).toEqual({ ok: true, file: `${root}\\tiles\\2\\1_3.png` })
    expect(at('/wiki-img/icons/Raw%20Trout.png')).toEqual({ ok: true, file: `${root}\\icons\\Raw Trout.png` })
  })

  it('never leaves the folder through a backslash, plain or encoded', () => {
    for (const path of ['/wiki-img/..%5C..%5Cdata%5Cprogress.json', '/wiki-img/icons\\..\\..\\x', '/wiki-img/icons/%5c..%5c..%5c..%5cWindows%5cwin.ini']) {
      expect(at(path), path).toEqual({ ok: false, status: 400 })
    }
  })

  it('never leaves the folder through dots, in any case of the folder name', () => {
    for (const path of ['/wiki-img/..%2F..%2Fdata%2Fprogress.json', '/wiki-img/%2e%2e/%2e%2e/data/progress.json', '/wiki-img/../WIKI-IMG/icons/x.png']) {
      expect(at(path), path).toEqual({ ok: false, status: 403 })
    }
  })

  it('refuses drive letters, UNC paths and alternate data streams', () => {
    for (const path of ['/wiki-img/C:/Windows/win.ini', '/wiki-img/C%3A%5CWindows', '/wiki-img/icons/x.png:secret', '/wiki-img/icons/x.png%3A%3A%24DATA', '/wiki-img/%5C%5Cserver%5Cshare%5Cx']) {
      expect(at(path), path).toEqual({ ok: false, status: 400 })
    }
    // A protocol-relative looking path stays inside (two slashes are one folder level).
    expect(at('/wiki-img//server/share/x')).toEqual({ ok: true, file: `${root}\\server\\share\\x` })
  })

  it('refuses device names and names Windows trims', () => {
    for (const path of ['/wiki-img/icons/CON', '/wiki-img/icons/nul.png', '/wiki-img/icons/Com1.png', '/wiki-img/LPT9/x.png', '/wiki-img/icons/x.png.', '/wiki-img/icons/x.png%20', '/wiki-img/..%20/x', '/wiki-img/icons/a%3Cb.png']) {
      expect(at(path), path).toEqual({ ok: false, status: 400 })
    }
    // Only whole names are devices.
    expect(at('/wiki-img/icons/Console.png').ok).toBe(true)
    expect(at('/wiki-img/icons/con-1a2b.json').ok).toBe(true)
  })

  it('refuses NUL bytes and broken escapes', () => {
    expect(at('/wiki-img/icons/a%00.png')).toEqual({ ok: false, status: 400 })
    expect(at('/wiki-img/icons/%E0%A4%A.png')).toEqual({ ok: false, status: 400 })
  })
})

describe('resolveInside on macOS and Linux (path.posix)', () => {
  const root = '/Users/joost/Ash Log/public/wiki-img'
  const at = (pathname: string) => resolveInside(root, pathname, '/wiki-img/', posix)

  it('maps a normal path into the folder', () => {
    expect(at('/wiki-img/icons/Gold_Ore.png')).toEqual({ ok: true, file: `${root}/icons/Gold_Ore.png` })
  })

  it('refuses traversal, backslashes and NUL bytes', () => {
    expect(at('/wiki-img/..%2F..%2Fdata%2Fprogress.json')).toEqual({ ok: false, status: 403 })
    expect(at('/wiki-img/..%5C..%5Cdata')).toEqual({ ok: false, status: 400 })
    expect(at('/wiki-img/a%00')).toEqual({ ok: false, status: 400 })
  })

  it('leaves names that are only special on Windows alone', () => {
    expect(at('/wiki-img/icons/CON').ok).toBe(true)
    expect(at('/wiki-img/icons/x.png:2').ok).toBe(true)
  })

  it('works for the root of the app (prefix /)', () => {
    expect(resolveInside('/srv/dist', '/index.html', '/', posix)).toEqual({ ok: true, file: '/srv/dist/index.html' })
    expect(resolveInside('/srv/dist', '/', '/', posix)).toEqual({ ok: false, status: 403 })
    expect(resolveInside('C:\\srv\\dist', '/assets/app.js', '/', win32)).toEqual({ ok: true, file: 'C:\\srv\\dist\\assets\\app.js' })
  })
})
