<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { Wifi, WifiOff } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LIVE_POLL_MS, useServerStore } from '@/stores/server'
import LiveDialog from './LiveDialog.vue'

/**
 * Header button for 'Live op wifi', with a gold dot while live. Opens the live dialog.
 * The header shows it only on the computer itself under the app server (server.canManage).
 */
const server = useServerStore()
const open = ref(false)

// Refresh while the dialog is open, so a phone that just paired shows up.
let timer: ReturnType<typeof setInterval> | undefined
function stopPolling() {
  if (timer) clearInterval(timer)
  timer = undefined
}
watch(open, (isOpen) => {
  stopPolling()
  if (isOpen) {
    void server.load()
    timer = setInterval(() => void server.load(), LIVE_POLL_MS)
  } else {
    server.clearPairing()
  }
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button
        variant="ghost"
        size="sm"
        data-slot="live-control"
        aria-haspopup="dialog"
        :aria-label="server.live ? 'Live op wifi: aan' : 'Live op wifi: uit'"
        :class="cn(server.live ? 'text-gold hover:text-gold' : 'text-muted-light')"
        @click="open = true"
      >
        <span class="relative grid place-content-center">
          <Wifi v-if="server.live" :stroke-width="1.75" aria-hidden="true" />
          <WifiOff v-else :stroke-width="1.75" aria-hidden="true" />
          <span
            v-if="server.live"
            data-slot="live-dot"
            aria-hidden="true"
            class="absolute -top-1 -right-1.5 size-2 rounded-full bg-gold ring-2 ring-leather"
          />
        </span>
        <span class="hidden font-display text-[0.72rem] font-semibold tracking-[0.14em] uppercase xl:inline">Live</span>
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom">
      {{ server.live ? 'Live op wifi staat aan: je telefoon kan erbij' : 'Live op wifi staat uit' }}
    </TooltipContent>
  </Tooltip>
  <LiveDialog v-model:open="open" />
</template>
