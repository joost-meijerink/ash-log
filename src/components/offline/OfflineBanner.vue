<script setup lang="ts">
import { CloudOff, RefreshCw } from 'lucide-vue-next'
import RelativeTime from '@/components/common/RelativeTime.vue'
import { Button } from '@/components/ui/button'
import { useConnectionStore } from '@/stores/connection'
import { RETRY_LABEL } from './texts'

/** Slim banner under the header while a phone looks at the last known data, read-only. */
const connection = useConnectionStore()
</script>

<template>
  <div
    role="status"
    data-slot="offline-banner"
    class="flex shrink-0 items-center gap-x-3 border-b border-gold/25 bg-[#241d14] px-3 py-1 text-sm sm:px-5"
  >
    <CloudOff class="size-4 shrink-0 text-gold" aria-hidden="true" />
    <p class="min-w-0 flex-1 py-1.5">
      <strong class="font-semibold">Offline:</strong> alleen lezen<template v-if="connection.knownAt">, laatst bijgewerkt <RelativeTime :value="connection.knownAt" /></template>.
      <span class="text-muted-light">Wijzigingen kunnen weer zodra je computer bereikbaar is.</span>
    </p>
    <!-- Icon only on a phone, so the text keeps the width -->
    <Button variant="ghost" size="sm" :disabled="connection.checking" class="-mr-1 min-w-11 shrink-0" @click="connection.retry()">
      <RefreshCw :class="connection.checking && 'animate-spin motion-reduce:animate-none'" aria-hidden="true" />
      <span class="sr-only sm:not-sr-only">{{ RETRY_LABEL }}</span>
    </Button>
  </div>
</template>
