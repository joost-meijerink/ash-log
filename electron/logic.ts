// The decisions of the desktop app that need no Electron: which links stay in the window, what
// closing the window does, and the update check against GitHub Releases. electron/main.ts wires
// them to Electron; the tests run them as plain functions.

/** Hosts the app server answers on this computer (the window only ever shows these). */
const APP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export type LinkAction = 'app' | 'external' | 'block'

/**
 * Where a link goes: 'app' for the app server on this port (it stays in the window), 'external'
 * for any other http(s) address (the default browser), 'block' for everything else (file:,
 * javascript:, custom schemes, https on the app port).
 */
export function linkAction(url: string, port: number): LinkAction {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'block'
  }
  if (parsed.protocol === 'http:' && APP_HOSTS.has(parsed.hostname.toLowerCase()) && Number(parsed.port || 80) === port) return 'app'
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (APP_HOSTS.has(parsed.hostname.toLowerCase())) return 'block'
    return 'external'
  }
  return 'block'
}

export type CloseAction = 'hide' | 'ask' | 'quit'

/**
 * What closing the window does. macOS: hide it and keep the server running for phones (the Dock
 * icon brings it back, Quit stops it), like the Mac app before. Windows and Linux: quit, but ask
 * first while Live on Wi-Fi is on, because a phone may still be using it.
 */
export function closeAction(opts: { platform: NodeJS.Platform; live: boolean; quitting: boolean }): CloseAction {
  if (opts.quitting) return 'quit'
  if (opts.platform === 'darwin') return 'hide'
  return opts.live ? 'ask' : 'quit'
}

/** 1, 0 or -1 for two versions like 1.2.3 (a leading v and anything after a hyphen are ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

export const RELEASES_API = 'https://api.github.com/repos/joost-meijerink/ash-log/releases/latest'
export const RELEASES_PAGE = 'https://github.com/joost-meijerink/ash-log/releases/latest'
/** At most one check per day. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface Release {
  version: string
  url: string
}

/** The version and page of a GitHub release (the latest-release API answer), or null. */
export function parseRelease(json: unknown): Release | null {
  if (!json || typeof json !== 'object') return null
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
  if (r.draft || r.prerelease || typeof r.tag_name !== 'string') return null
  const url = typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : RELEASES_PAGE
  return { version: r.tag_name.replace(/^v/i, ''), url }
}

/** What the app remembers between update checks (update.json in the per-user folder). */
export interface UpdateState {
  lastCheck?: number
  /** A version the user chose to skip. */
  skipped?: string
}

/** True when it is time to ask GitHub again. */
export function dueForCheck(state: UpdateState, now: number): boolean {
  return !state.lastCheck || now - state.lastCheck >= CHECK_INTERVAL_MS || state.lastCheck > now
}

/** The release to tell the user about, or null: newer than this version and not skipped. */
export function updateToShow(release: Release | null, current: string, state: UpdateState): Release | null {
  if (!release) return null
  if (compareVersions(release.version, current) <= 0) return null
  if (state.skipped && compareVersions(release.version, state.skipped) === 0) return null
  return release
}
