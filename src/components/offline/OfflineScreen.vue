<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useIntervalFn, useNow, useOnline } from '@vueuse/core'
import { BookOpen, RefreshCw } from 'lucide-vue-next'
import ashLogs from '@/assets/ash-logs.png'
import RelativeTime from '@/components/common/RelativeTime.vue'
import { Button } from '@/components/ui/button'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'
import { BROWSE_LABEL, OFFLINE_TEXT, OFFLINE_TITLE, RETRY_LABEL, retryHint } from './texts'

/**
 * Full-screen 'niet bereikbaar' state on a phone that cannot reach the Mac. Retries on its own
 * (connection store); with data on hand (the service worker's copy, or what was on screen)
 * the last known data can be looked at, read-only.
 */
const connection = useConnectionStore()
const data = useDataStore()
const online = useOnline()

const hasData = computed(() => !!data.data)

// Countdown to the next automatic try, ticking only while this screen is up.
const now = useNow({ scheduler: (cb) => useIntervalFn(cb, 1000) })
const secondsLeft = computed(() => {
  const at = connection.nextCheckAt
  return at === null ? null : Math.max(0, Math.ceil((at - now.value.getTime()) / 1000))
})
const hint = computed(() => retryHint({ checking: connection.checking, secondsLeft: secondsLeft.value }))

// The screen replaces everything: move focus to it, so a screen reader announces it.
const title = ref<HTMLElement | null>(null)
onMounted(() => title.value?.focus({ preventScroll: true }))
</script>

<template>
  <div
    data-offline-screen
    class="overflow-y-auto bg-ink pt-[max(2.5rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(2.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] text-text-light"
  >
    <section aria-labelledby="offline-title" class="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center text-center">
      <img
        :src="ashLogs"
        alt=""
        width="88"
        height="88"
        class="size-22 opacity-80 grayscale-[40%] drop-shadow-[0_3px_3px_rgba(0,0,0,0.6)]"
      />
      <h1
        id="offline-title"
        ref="title"
        tabindex="-1"
        class="mt-5 font-display text-[1.35rem] leading-tight font-semibold tracking-[0.08em] text-balance uppercase outline-none"
      >
        {{ OFFLINE_TITLE }}
      </h1>
      <p class="mt-3 max-w-sm leading-relaxed text-pretty text-muted-light">{{ OFFLINE_TEXT }}</p>
      <p v-if="!online" data-slot="phone-offline" class="mt-2 text-sm text-[#e08a6c]">Je telefoon heeft nu zelf geen netwerk.</p>

      <div class="mt-8 flex w-full flex-col items-center gap-3">
        <Button
          v-if="hasData"
          data-slot="browse"
          size="lg"
          class="h-auto min-h-12 w-full max-w-xs py-2.5 whitespace-normal"
          @click="connection.browse()"
        >
          <BookOpen aria-hidden="true" />
          <span class="flex flex-col items-start text-left leading-tight">
            <span>{{ BROWSE_LABEL }}</span>
            <span v-if="connection.knownAt" class="text-[0.8rem] font-normal opacity-80">
              bijgewerkt <RelativeTime :value="connection.knownAt" />
            </span>
          </span>
        </Button>

        <Button data-slot="retry" variant="outline" :disabled="connection.checking" @click="connection.retry()">
          <RefreshCw :class="connection.checking && 'animate-spin motion-reduce:animate-none'" aria-hidden="true" />
          {{ RETRY_LABEL }}
        </Button>
        <p data-slot="retry-hint" class="text-sm text-muted-light/80">{{ hint }}</p>
      </div>
    </section>
  </div>
</template>
