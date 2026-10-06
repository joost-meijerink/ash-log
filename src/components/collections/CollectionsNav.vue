<script setup lang="ts">
import type { Component } from 'vue'
import AnchorLink from './AnchorLink.vue'

/** Sticky section links at the top of the Verzamelingen page. */
defineProps<{
  items: { id: string; label: string; short: string; icon: Component; count?: string }[]
}>()
</script>

<template>
  <nav
    aria-label="Secties"
    class="sticky top-0 z-10 border-y border-line-dark bg-ink/92 backdrop-blur-sm supports-[backdrop-filter]:bg-ink/80"
  >
    <ul class="mx-auto flex w-full max-w-6xl items-stretch gap-1 px-2 sm:gap-2 sm:px-4">
      <li v-for="item in items" :key="item.id" class="min-w-0">
        <AnchorLink
          :to="item.id"
          class="flex h-12 min-w-11 items-center gap-2 rounded-md px-2.5 font-display text-[0.74rem] font-semibold tracking-[0.13em] whitespace-nowrap text-muted-light uppercase transition-colors outline-none hover:text-text-light focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-inset sm:px-3"
        >
          <component :is="item.icon" class="size-4 shrink-0 text-gold" :stroke-width="1.75" aria-hidden="true" />
          <span class="sm:hidden">{{ item.short }}</span>
          <span class="hidden sm:inline">{{ item.label }}</span>
          <span v-if="item.count" class="hidden font-sans text-sm font-medium tracking-normal text-gold tabular-nums normal-case md:inline">
            {{ item.count }}
          </span>
        </AnchorLink>
      </li>
    </ul>
  </nav>
</template>
