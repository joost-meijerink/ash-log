<script setup lang="ts">
import { computed } from 'vue'
import { useOrphans } from '@/composables/useOrphans'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * Asks before orphaned ticks are removed for good, with what goes per kind.
 * A quest page that is broken on the wiki for a moment drops out of the data, so its
 * ticks look orphaned until the next sync brings it back.
 */
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ cleaned: [count: number] }>()

const { count, summary, cleanUp } = useOrphans()

const description = computed(() => {
  const n = count.value
  const what = n === 1 ? '1 tick' : `${n} ticks`
  return `${what} will be gone for good. If something is just missing from the wiki for a moment, better wait for the next sync.`
})

function confirm() {
  emit('cleaned', cleanUp())
}
</script>

<template>
  <ConfirmDialog
    v-model:open="open"
    title="Clean up orphaned ticks?"
    :description="description"
    confirm-label="Clean up"
    @confirm="confirm"
  >
    <ul class="divide-y divide-line-dark rounded-md border border-line-dark">
      <li v-for="group in summary" :key="group.kind" class="px-3 py-2">
        <p class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 font-medium">{{ group.label }}</span>
          <span class="shrink-0 tabular-nums text-muted-light">{{ group.count }}</span>
        </p>
        <p v-if="group.names.length" lang="en" class="mt-0.5 break-words text-muted-light">
          {{ group.names.join(', ') }}
        </p>
      </li>
    </ul>
  </ConfirmDialog>
</template>
