import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

export { default as Badge } from './Badge.vue'

/**
 * Small Cinzel label in capitals. Tone-aware like Button: inside a ParchmentPanel it uses the
 * parchment colours automatically.
 */
export const badgeVariants = cva(
  [
    'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-[3px] border',
    'px-1.5 py-0.5 font-display text-[0.68rem] font-semibold leading-none tracking-[0.08em] uppercase',
    '[&>svg]:pointer-events-none [&>svg]:size-3',
  ],
  {
    variants: {
      variant: {
        /** Gold accent, for progress and highlights. */
        default: '',
        /** Filled, for a finished state. */
        solid: '',
        /** Quiet hairline. */
        outline: '',
        /** Ember: vaults, warnings, locations. */
        ember: '',
      },
      tone: {
        dark: '',
        parchment: '',
      },
    },
    compoundVariants: [
      { variant: 'default', tone: 'dark', class: 'border-gold/35 bg-gold/10 text-gold' },
      { variant: 'default', tone: 'parchment', class: 'border-gold-ink/35 bg-gold-ink/10 text-gold-ink' },
      { variant: 'solid', tone: 'dark', class: 'border-gold bg-gold text-ink' },
      { variant: 'solid', tone: 'parchment', class: 'border-gold-ink bg-gold-ink text-parchment' },
      { variant: 'outline', tone: 'dark', class: 'border-line-dark text-muted-light' },
      { variant: 'outline', tone: 'parchment', class: 'border-text-parchment/25 text-text-parchment/70' },
      { variant: 'ember', tone: 'dark', class: 'border-ember/60 bg-ember/15 text-[#e08a6c]' },
      { variant: 'ember', tone: 'parchment', class: 'border-ember/50 bg-ember/10 text-ember' },
    ],
    defaultVariants: {
      variant: 'default',
      tone: 'dark',
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
