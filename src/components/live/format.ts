// Small formatting helpers for the live dialog and the 'not reachable' screen.

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
    return 'De app leest en schrijft via een kleine server die met npm run dev meedraait. Draait die nog?'
  }
  if (isLoopbackHost(opts.hostname)) {
    return 'De server van het logboek reageert niet. Open Ash Log opnieuw via het icoon en probeer het nog eens.'
  }
  return 'Het logboek op je laptop reageert niet. Staat de laptop aan, is de app open en staat Live op wifi aan?'
}
