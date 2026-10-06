// Small formatting helpers for the live dialog and the 'can't be reached' screen.

/** Remaining time as 'm:ss' ('9:05'), never below '0:00'. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** A six digit code in two groups of three ('123 456'), easier to read and type. */
export function formatCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/** Data URI for an SVG string, for an <img> (no scripts run in there, unlike inline markup). */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** The page was opened on the Mac itself (not over wifi from a phone). */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname)
}

/**
 * What to tell the user when the server behind the logbook does not answer.
 * `mode` is the last known server mode (unknown when that never loaded).
 */
export function unreachableHint(opts: { mode?: 'dev' | 'app'; hostname: string }): string {
  if (opts.mode === 'dev') {
    return 'The app reads and writes through a small server that runs along with npm run dev. Is it still running?'
  }
  if (isLoopbackHost(opts.hostname)) {
    return "Ash Log's server isn't answering. Open Ash Log again from its icon and try once more."
  }
  return "Ash Log on your computer isn't answering. Is it on, is the app open and is Live on Wi-Fi on?"
}
