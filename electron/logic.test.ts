import { describe, expect, it } from 'vitest'
import { closeAction, compareVersions, dueForCheck, linkAction, parseRelease, RELEASES_PAGE, updateToShow } from './logic.ts'

describe('linkAction', () => {
  it.each([
    ['http://localhost:5199/quests?q=1#x', 'app'],
    ['http://127.0.0.1:5199/', 'app'],
    ['http://[::1]:5199/map', 'app'],
    ['http://LOCALHOST:5199/', 'app'],
    ['http://localhost:5200/', 'block'],
    ['https://localhost:5199/', 'block'],
    ['https://dragonwilds.runescape.wiki/w/Quests', 'external'],
    ['https://creativecommons.org/licenses/by-nc-sa/3.0/', 'external'],
    ['http://mijn-mac.local:5199/pair?code=1', 'external'],
    ['file:///Users/me/.ssh/id_ed25519', 'block'],
    ['javascript:alert(1)', 'block'],
    ['steam://run/1374490', 'block'],
    ['mailto:someone@example.com', 'block'],
    ['not a url', 'block'],
  ] as const)('%s -> %s', (url, action) => {
    expect(linkAction(url, 5199)).toBe(action)
  })
})

describe('closeAction', () => {
  it('hides the window on macOS and keeps the server running', () => {
    expect(closeAction({ platform: 'darwin', live: false, quitting: false })).toBe('hide')
    expect(closeAction({ platform: 'darwin', live: true, quitting: false })).toBe('hide')
  })

  it('quits on Windows, but asks first while Live on Wi-Fi is on', () => {
    expect(closeAction({ platform: 'win32', live: false, quitting: false })).toBe('quit')
    expect(closeAction({ platform: 'win32', live: true, quitting: false })).toBe('ask')
    expect(closeAction({ platform: 'linux', live: true, quitting: false })).toBe('ask')
  })

  it('always quits once quitting', () => {
    expect(closeAction({ platform: 'darwin', live: true, quitting: true })).toBe('quit')
    expect(closeAction({ platform: 'win32', live: true, quitting: true })).toBe('quit')
  })
})

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['v1.2.0', '1.1.9', 1],
    ['1.2', '1.2.0', 0],
    ['1.10.0', '1.9.0', 1],
    ['0.9.9', '1.0.0', -1],
    ['1.1.0-beta.1', '1.1.0', 0],
  ] as const)('%s vs %s', (a, b, result) => {
    expect(compareVersions(a, b)).toBe(result)
  })
})

describe('update check', () => {
  const day = 24 * 60 * 60 * 1000

  it('parses the latest release, ignoring drafts and prereleases', () => {
    expect(parseRelease({ tag_name: 'v1.2.0', html_url: 'https://github.com/joost-meijerink/ash-log/releases/tag/v1.2.0' })).toEqual({
      version: '1.2.0',
      url: 'https://github.com/joost-meijerink/ash-log/releases/tag/v1.2.0',
    })
    expect(parseRelease({ tag_name: 'v1.2.0', html_url: 'https://evil.example/x' })?.url).toBe(RELEASES_PAGE)
    expect(parseRelease({ tag_name: 'v2.0.0', prerelease: true })).toBeNull()
    expect(parseRelease({ tag_name: 'v2.0.0', draft: true })).toBeNull()
    expect(parseRelease({ message: 'Not Found' })).toBeNull()
    expect(parseRelease(null)).toBeNull()
  })

  it('checks at most once a day', () => {
    expect(dueForCheck({}, 1000)).toBe(true)
    expect(dueForCheck({ lastCheck: 1000 }, 1000 + day - 1)).toBe(false)
    expect(dueForCheck({ lastCheck: 1000 }, 1000 + day)).toBe(true)
    expect(dueForCheck({ lastCheck: 5000 }, 1000)).toBe(true)
  })

  it('shows only a newer version that was not skipped', () => {
    const release = { version: '1.1.0', url: RELEASES_PAGE }
    expect(updateToShow(release, '1.0.0', {})).toBe(release)
    expect(updateToShow(release, '1.1.0', {})).toBeNull()
    expect(updateToShow(release, '1.2.0', {})).toBeNull()
    expect(updateToShow(release, '1.0.0', { skipped: '1.1.0' })).toBeNull()
    expect(updateToShow({ ...release, version: '1.2.0' }, '1.0.0', { skipped: '1.1.0' })).not.toBeNull()
    expect(updateToShow(null, '1.0.0', {})).toBeNull()
  })
})
