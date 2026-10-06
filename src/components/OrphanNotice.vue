<script setup lang="ts">
import { computed, ref } from 'vue'
import { Unlink } from 'lucide-vue-next'
import OrphanCleanupDialog from '@/components/common/OrphanCleanupDialog.vue'
import { Button } from '@/components/ui/button'
import { useOrphans } from '@/composables/useOrphans'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'
import { useSyncStore } from '@/stores/sync'

// Slim banner under the header while ticks point at things the wiki no longer has.
const { count } = useOrphans()
const data = useDataStore()
const sync = useSyncStore()
const connection = useConnectionStore()
const confirmOpen = ref(false)

const message = computed(() =>
  count.value === 1 ? '1 tick points at nothing anymore.' : `${count.value} ticks point at nothing anymore.`,
)

function view() {
  const report = sync.report ?? data.lastReport
  if (report) sync.openReport(report)
  else sync.panelOpen = true
}
</script>

<template>
  <div
    v-if="count > 0"
    role="status"
    class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-ember/40 bg-[#2a1a13] px-3 py-1 text-sm text-text-light sm:px-5"
  >
    <Unlink class="size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
    <p class="min-w-0 flex-1">
      {{ message }}
      <span class="text-muted-light">The wiki changed since you set them.</span>
    </p>
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="sm" @click="view">View</Button>
      <Button variant="outline" size="sm" :disabled="connection.readOnly" @click="confirmOpen = true">Clean up</Button>
    </div>
  </div>
  <OrphanCleanupDialog v-model:open="confirmOpen" />
</template>
