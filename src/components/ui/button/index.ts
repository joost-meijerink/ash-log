import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

export { default as Button } from './Button.vue'

/**
 * Buttons on dark leather (tone 'dark', default) or on parchment (tone 'parchment').
 * Inside a ParchmentPanel the tone is picked up automatically.
 * Every size has a hit area of at least 44px: the smaller sizes grow it with an invisible
 * pseudo-element, so they still look compact.
 */
export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md',
    'font-sans text-[0.95rem] font-medium leading-none transition-[color,background-color,border-color,box-shadow]',
    'outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        /** Solid gold (dark) or solid gold-ink (parchment). The main action. */
        default: '',
        /** Hairline border, transparent fill. Secondary actions. */
        outline: 'border',
        /** Filled but quiet. */
        secondary: 'border',
        /** No chrome until hover. Toolbars and icon buttons. */
        ghost: '',
        /** Ember: removing or resetting things. */
        destructive: 'bg-ember text-text-light hover:bg-[#b5532f]',
        link: 'h-auto! px-0! underline-offset-4 hover:underline',
        /** Solid gold-ink on parchment, whatever the tone. */
        parchment:
          'bg-gold-ink text-parchment shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-[#6a4914] focus-visible:ring-gold-ink focus-visible:ring-offset-parchment',
      },
      tone: {
        dark: 'focus-visible:ring-gold focus-visible:ring-offset-ink',
        parchment: 'focus-visible:ring-gold-ink focus-visible:ring-offset-parchment',
      },
      size: {
        default: 'h-11 px-4',
        sm: "h-9 gap-1.5 px-3 text-sm before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']",
        xs: "h-7 gap-1 rounded px-2 text-xs before:absolute before:-inset-y-2 before:inset-x-0 before:content-[''] [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-12 px-6 text-base',
        icon: 'size-11',
        'icon-sm': "size-9 before:absolute before:-inset-1 before:content-['']",
      },
    },
    compoundVariants: [
      {
        variant: 'default',
        tone: 'dark',
        class: 'bg-gold text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:bg-[#d8b35d]',
      },
      {
        variant: 'default',
        tone: 'parchment',
        class: 'bg-gold-ink text-parchment shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-[#6a4914]',
      },
      {
        variant: 'outline',
        tone: 'dark',
        class: 'border-line-dark bg-transparent text-text-light hover:border-gold/50 hover:bg-leather hover:text-gold',
      },
      {
        variant: 'outline',
        tone: 'parchment',
        class: 'border-gold-ink/35 bg-transparent text-text-parchment hover:border-gold-ink/70 hover:bg-parchment-deep',
      },
      {
        variant: 'secondary',
        tone: 'dark',
        class: 'border-line-dark bg-leather text-text-light hover:bg-line-dark/70',
      },
      {
        variant: 'secondary',
        tone: 'parchment',
        class: 'border-gold-ink/20 bg-parchment-deep text-text-parchment hover:bg-[#d9c9a4]',
      },
      { variant: 'ghost', tone: 'dark', class: 'text-text-light hover:bg-line-dark/60 hover:text-gold' },
      { variant: 'ghost', tone: 'parchment', class: 'text-text-parchment hover:bg-parchment-deep hover:text-gold-ink' },
      // The parchment variant always sits on parchment, so its focus ring must win over the tone.
      { variant: 'parchment', class: 'focus-visible:ring-gold-ink focus-visible:ring-offset-parchment' },
      // A link button is only as tall as its text; grow its hit area to about 44px.
      { variant: 'link', class: "before:absolute before:-inset-x-1 before:-inset-y-[15px] before:content-['']" },
      { variant: 'link', tone: 'dark', class: 'text-gold' },
      { variant: 'link', tone: 'parchment', class: 'text-gold-ink' },
    ],
    defaultVariants: {
      variant: 'default',
      tone: 'dark',
      size: 'default',
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
