<script setup lang="ts">
import { Crosshair, LoaderCircle, MapPinOff } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import type { AppQuest } from '@/lib/types'

/** Pin mode banner: tells what the next click does, with a way out. */
defineProps<{
  quest: AppQuest
  /** A manual pin exists and can be removed. */
  hasManualPin: boolean
  saving: boolean
  error: string | null
}>()

const emit = defineEmits<{ cancel: []; remove: [] }>()
</script>

<template>
  <div
    role="status"
    aria-live="polite"
    class="pointer-events-auto flex max-w-[min(40rem,calc(100%-1.5rem))] flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-gold/60 bg-leather/95 px-3 py-2 text-text-light shadow-[0_12px_30px_-12px_rgba(0,0,0,0.9)] backdrop-blur-sm sm:px-4"
  >
    <span class="grid size-8 shrink-0 place-content-center rounded-full border border-gold/50 text-gold">
      <LoaderCircle v-if="saving" aria-hidden="true" class="size-4 animate-spin motion-reduce:animate-none" />
      <Crosshair v-else aria-hidden="true" class="size-4" />
    </span>
    <p class="min-w-0 flex-1 basis-56 leading-snug">
      <template v-if="saving">Pin opslaan...</template>
      <template v-else>
        Klik op de kaart om de start van <span lang="en" class="font-semibold text-gold">{{ quest.name }}</span> te zetten
      </template>
      <span v-if="error" class="mt-0.5 block text-sm text-[#e08a6c]">{{ error }}</span>
    </p>
    <div class="flex shrink-0 items-center gap-1.5">
      <Button v-if="hasManualPin" variant="ghost" size="sm" :disabled="saving" @click="emit('remove')">
        <MapPinOff aria-hidden="true" />
        Pin verwijderen
      </Button>
      <Button variant="outline" size="sm" :disabled="saving" @click="emit('cancel')">Annuleren</Button>
    </div>
  </div>
</template>
