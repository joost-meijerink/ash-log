// Whether the server behind /api can be reached. The api client (api.ts) reports what every
// request found out; the connection store (stores/connection.ts) listens and decides when the
// app shows 'niet bereikbaar' or runs read-only. No DOM in here: src/lib is also type-checked
// without it (tsconfig.node.json).

/**
 * Header the service worker (public/sw.js) puts on a cached copy of GET /api/data or
 * GET /api/progress it hands out because the network failed. The value is the ISO time the
 * copy was cached.
 */
export const OFFLINE_HEADER = 'X-Ash-Log-Offline'

/** First health poll after the server stopped answering, then doubling up to the maximum. */
export const POLL_MS = 5000
export const POLL_MAX_MS = 30_000

export type ConnectionEvent =
  /** The server answered, with whatever status. */
  | { type: 'reached' }
  /** The request never got an answer (fetch rejected). Could be a blip: worth a check. */
  | { type: 'failed' }
  /**
   * The service worker answered from its cache because the network failed. `used` is true when
   * the caller took the copy (there was nothing on screen yet).
   */
  | { type: 'offline-copy'; at: string; used: boolean }

type Listener = (event: ConnectionEvent) => void

const listeners = new Set<Listener>()

/** Subscribes to connection events; returns the unsubscribe. */
export function onConnectionEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function reportConnection(event: ConnectionEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // A listener must never break a request.
    }
  }
}

/**
 * The service worker answered with an offline copy the caller did not ask for: it already has
 * newer data on screen, and an older copy must never replace it.
 */
export class OfflineCopyError extends Error {
  /** ISO time the copy was cached. */
  readonly at: string

  constructor(at: string) {
    super('Je computer is niet bereikbaar')
    this.name = 'OfflineCopyError'
    this.at = at
  }
}

/** Delay before health poll number `attempt` (0-based): 5 s, 10 s, 20 s, then every 30 s. */
export function pollDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.min(n, 10))
}

/** An ISO time from a header, or null when it is missing or not a date. */
export function parseTime(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** The earlier of two ISO times; null counts as unknown and loses. */
export function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) <= Date.parse(b) ? a : b
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * True when the page came over the network (a phone), false on the Mac itself. The Mac keeps
 * its own behaviour: the native app shows an alert when the server is gone.
 */
export function isRemoteHost(hostname: string | undefined): boolean {
  if (!hostname) return false
  const host = hostname.toLowerCase()
  return !LOOPBACK.has(host) && !host.endsWith('.localhost')
}
