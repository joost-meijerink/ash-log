// Texts of the 'niet bereikbaar' state. public/sw.js shows the same title and text on its own
// page (when not even the app is cached); a test keeps the two in step.

export const OFFLINE_TITLE = 'Ash Log is niet bereikbaar'
export const OFFLINE_TEXT =
  'Je computer staat uit of slaapt, of Live op wifi staat uit. Zorg dat je telefoon op hetzelfde wifi zit.'
export const RETRY_LABEL = 'Opnieuw proberen'
export const BROWSE_LABEL = 'Laatst bekende gegevens bekijken'

/** The auto-retry line under the retry button. */
export function retryHint(opts: { checking: boolean; secondsLeft: number | null }): string {
  if (opts.checking) return 'Even kijken of je computer er weer is...'
  if (opts.secondsLeft === null) return 'Ash Log probeert het vanzelf opnieuw.'
  if (opts.secondsLeft <= 1) return 'Ash Log probeert het zo opnieuw.'
  return `Ash Log probeert het over ${opts.secondsLeft} s vanzelf opnieuw.`
}
