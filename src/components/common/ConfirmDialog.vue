<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * Small confirm dialog for actions that throw away progress or edits.
 * The default slot holds optional details under the description (for example what gets removed).
 */
withDefaults(
  defineProps<{
    title: string
    description: string
    confirmLabel: string
    cancelLabel?: string
    /** Ember confirm button. Default true. */
    destructive?: boolean
  }>(),
  { cancelLabel: 'Cancel', destructive: true },
)

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ confirm: [] }>()

function confirm() {
  emit('confirm')
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription class="leading-relaxed">{{ description }}</DialogDescription>
      </DialogHeader>
      <div v-if="$slots.default" class="max-h-[40dvh] overflow-y-auto text-sm">
        <slot />
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ cancelLabel }}</Button>
        <Button :variant="destructive ? 'destructive' : 'default'" @click="confirm">{{ confirmLabel }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
