// Shared class strings for the collections components (all on parchment).

/** Small inline link inside a row or card, with a hit area grown towards 44px. */
export const inlineLink = [
  'relative inline-flex items-baseline gap-1 rounded-sm text-gold-ink underline decoration-gold-ink/35 decoration-1 underline-offset-[3px]',
  'transition-colors outline-none hover:decoration-gold-ink focus-visible:ring-2 focus-visible:ring-gold-ink/50',
  "before:absolute before:-inset-x-1 before:-inset-y-[11px] before:content-['']",
  '[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:translate-y-[2px] [&>svg]:self-start',
].join(' ')

/** Small-caps label in Cinzel on parchment. */
export const capsLabel = 'font-display text-[0.72rem] font-semibold tracking-[0.14em] text-gold-ink uppercase'
