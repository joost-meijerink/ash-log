<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { ExternalLink } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { wikiUrl } from '@/lib/ids'
import { useTone, type Tone } from '@/composables/useTone'

/**
 * External link to the Dragonwilds wiki, opens in a new tab with a small external icon.
 * Give either `page` (a wiki page title) or `href` (a full URL, e.g. Quest.wikiUrl).
 * The link text is the default slot, falling back to the page title or 'Op de wiki'.
 */
const props = withDefaults(
  defineProps<{
    /** Wiki page title, e.g. 'Ratcatcher' or 'Dragonkin Vault'. */
    page?: string
    /** Full URL. Wins over `page`. */
    href?: string
    /** Show the external-link icon. Default true. */
    icon?: boolean
    tone?: Tone
    class?: HTMLAttributes['class']
  }>(),
  { page: undefined, href: undefined, icon: true, tone: undefined },
)

const tone = useTone(() => props.tone)

/** The invisible ::before grows the one-line link to a 44px hit area, like inlineLink in collections/styles.ts. */
const BASE = [
  'relative inline-flex items-baseline gap-1 rounded-sm underline decoration-1 underline-offset-[3px] transition-colors outline-none focus-visible:ring-2',
  "before:absolute before:-inset-x-1 before:-inset-y-[11px] before:content-['']",
].join(' ')
const url = computed(() => props.href ?? (props.page ? wikiUrl(props.page) : 'https://dragonwilds.runescape.wiki'))
</script>

<template>
  <a
    :href="url"
    target="_blank"
    rel="noopener noreferrer"
    data-slot="wiki-link"
    :class="
      cn(
        BASE,
        tone === 'dark'
          ? 'text-gold decoration-gold/40 hover:decoration-gold focus-visible:ring-gold/60'
          : 'text-gold-ink decoration-gold-ink/35 hover:decoration-gold-ink focus-visible:ring-gold-ink/50',
        props.class,
      )
    "
  >
    <!-- A page title is English wiki text; the fallback and a slot are the caller's (usually Dutch). -->
    <span v-if="!$slots.default && page" lang="en">{{ page }}</span>
    <slot v-else>Op de wiki</slot>
    <ExternalLink v-if="icon" aria-hidden="true" class="size-3.5 shrink-0 translate-y-[1px] self-center" />
    <span class="sr-only">(opent in een nieuw tabblad)</span>
  </a>
</template>
