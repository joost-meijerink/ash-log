<script setup lang="ts">
import { computed } from 'vue'
import { Map as MapIcon, MapPinPlus } from 'lucide-vue-next'
import LocationText from '@/components/common/LocationText.vue'
import SectionHeading from '@/components/common/SectionHeading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { mapPinLink, mapQuestLink } from '@/lib/quests-route'
import type { AppQuest } from '@/lib/types'
import { useConnectionStore } from '@/stores/connection'

/** Where the quest starts, with links to the map to show or place the start pin. */
const props = defineProps<{ quest: AppQuest }>()
const connection = useConnectionStore()

const start = computed(() => props.quest.start)
const manual = computed(() => start.value?.source === 'override')
const guessed = computed(() => start.value?.source === 'wiki' && props.quest.startMatch === 'npc-name')
</script>

<template>
  <section aria-labelledby="quest-start-heading">
    <SectionHeading id="quest-start-heading" title="Startpunt" />

    <LocationText v-if="quest.location" as="p" pin lang="en" class="mt-2 text-[1.05rem] leading-relaxed">
      {{ quest.location }}
    </LocationText>
    <p v-else class="mt-2 text-text-parchment/70">De wiki noemt geen startpunt.</p>

    <p v-if="manual" class="mt-2.5 flex flex-wrap items-center gap-2 text-sm text-text-parchment/70">
      <Badge variant="ember">Handmatige pin</Badge>
      Door jou op de kaart gezet.
    </p>
    <p v-else-if="guessed" class="mt-2.5 text-sm leading-snug text-text-parchment/70">
      Pin gekoppeld op de naam van de NPC. Staat hij verkeerd? Verplaats hem.
    </p>
    <p v-else-if="!start" class="mt-2.5 text-sm text-text-parchment/70">Nog geen pin op de kaart.</p>

    <div class="mt-3 flex flex-wrap gap-2">
      <Button v-if="start" as-child variant="outline" size="sm">
        <RouterLink :to="mapQuestLink(quest.id)">
          <MapIcon aria-hidden="true" />
          Toon op kaart
        </RouterLink>
      </Button>
      <!-- Placing a pin writes overrides: not while the Mac cannot be reached -->
      <Button v-if="!connection.readOnly" as-child :variant="start ? 'ghost' : 'outline'" size="sm">
        <RouterLink :to="mapPinLink(quest.id)">
          <MapPinPlus aria-hidden="true" />
          {{ start ? 'Pin verplaatsen' : 'Pin zetten' }}
        </RouterLink>
      </Button>
    </div>
  </section>
</template>
