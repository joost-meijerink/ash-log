// Texts of the 'can't be reached' state. public/sw.js shows the same title and text on its own
// page (when not even the app is cached); a test keeps the two in step.

export const OFFLINE_TITLE = "Ash Log can't be reached"
export const OFFLINE_TEXT =
  'Your computer is off or asleep, or Live on Wi-Fi is off. Make sure your phone is on the same Wi-Fi.'
export const RETRY_LABEL = 'Try again'
export const BROWSE_LABEL = 'View last known data'

/** The auto-retry line under the retry button. */
export function retryHint(opts: { checking: boolean; secondsLeft: number | null }): string {
  if (opts.checking) return 'Checking whether your computer is back...'
  if (opts.secondsLeft === null) return 'Ash Log will try again on its own.'
  if (opts.secondsLeft <= 1) return 'Ash Log will try again in a moment.'
  return `Ash Log will try again in ${opts.secondsLeft} s.`
}
