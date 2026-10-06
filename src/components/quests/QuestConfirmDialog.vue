<script setup lang="ts">
import { watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useViewRoute } from '@/composables/useViewRoute'

/** Small confirm dialog for actions that throw away progress or edits. */
withDefaults(
  defineProps<{
    title: string
    description: string
    confirmLabel: string
    cancelLabel?: string
    /** Ember confirm button. Default true. */
    destructive?: boolean
  }>(),
  { cancelLabel: 'Annuleren', destructive: true },
)

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ confirm: [] }>()

// The dialog is drawn in the body, outside the view. The view stays alive while another one is
// on screen, so a dialog left open (back or forward in the browser) would hang over that one.
const view = useViewRoute()
watch(view.active, (active) => {
  if (!active) open.value = false
})

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
      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ cancelLabel }}</Button>
        <Button :variant="destructive ? 'destructive' : 'default'" @click="confirm">{{ confirmLabel }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
