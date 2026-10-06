import type { Config } from 'tailwindcss'

// Design tokens from the style draft (see CLAUDE.md). Loaded by src/style.css via @config.
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        ink: '#15120e',
        leather: '#211c16',
        'line-dark': '#3a2f22',
        parchment: '#efe4cc',
        'parchment-deep': '#e2d4b3',
        'text-parchment': '#2a2118',
        'text-light': '#efe2c4',
        'muted-light': '#a8977a',
        gold: '#c9a24a',
        'gold-ink': '#7a561a',
        ember: '#a4452a',
      },
      fontFamily: {
        display: ['Cinzel', 'serif'],
        sans: ['"Alegreya Sans"', 'system-ui', 'sans-serif'],
        serif: ['Alegreya', 'Georgia', 'serif'],
      },
      minHeight: { tap: '44px' },
      minWidth: { tap: '44px' },
    },
  },
} satisfies Config
