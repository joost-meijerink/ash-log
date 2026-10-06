<script setup lang="ts">
// Source attribution, required by the wiki's CC BY-NC-SA 3.0 licence. Shown at the bottom of
// the sync report (where the wiki data comes in) and in the Mac app's About panel; the app
// itself has no footer bar.
const WIKI = 'https://dragonwilds.runescape.wiki'
const LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/3.0/'

// 44px tall link targets, growing the row instead of reaching into neighbours.
const linkClass =
  'inline-flex min-h-11 items-center rounded-sm text-text-light underline decoration-gold/40 underline-offset-2 outline-none hover:text-gold hover:decoration-gold focus-visible:ring-2 focus-visible:ring-gold/60'
</script>

<template>
  <div class="min-w-0 text-[0.78rem] leading-snug text-muted-light">
    <p>
      Bron:
      <a :href="WIKI" target="_blank" rel="noopener noreferrer" lang="en" :class="linkClass">RuneScape: Dragonwilds Wiki</a>,
      <a :href="LICENSE" target="_blank" rel="noopener noreferrer license" lang="en" :class="linkClass">CC BY-NC-SA 3.0</a>.
      <span class="whitespace-nowrap">Onofficiële fantool, niet verbonden aan Jagex.</span>
    </p>
  </div>
</template>
