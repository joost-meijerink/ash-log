<script setup lang="ts">
import { computed } from 'vue'
import { Gem, ScrollText, Sparkles, X } from 'lucide-vue-next'
import CheckRow from '@/components/common/CheckRow.vue'
import IconButton from '@/components/common/IconButton.vue'
import LocationText from '@/components/common/LocationText.vue'
import ParchmentPanel from '@/components/common/ParchmentPanel.vue'
import PowerBadge from '@/components/common/PowerBadge.vue'
import WikiIcon from '@/components/common/WikiIcon.vue'
import WikiLink from '@/components/common/WikiLink.vue'
import { Button } from '@/components/ui/button'
import { slug } from '@/lib/ids'
import { isInWorld } from '@/lib/map-filter'
import { markIds, pointFoundState } from '@/lib/map-found'
import { GROUP_LABEL, isTrackableGroup } from '@/lib/map-groups'
import { questLinksForPoint, vaultForPoint } from '@/lib/map-links'
import { estimateNote } from '@/lib/map-power'
import type { MapPoint } from '@/lib/types'
import { useMapContext } from '@/composables/useMapContext'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import MapGlyph from './MapGlyph.vue'

/**
 * Card for the selected map point, on parchment. Lore and unique spots can be ticked off; a spot
 * where you pick up a reward is ticked through that reward, so it also counts in Collections.
 */
const props = defineProps<{ point: MapPoint }>()
const emit = defineEmits<{ close: [] }>()

const data = useDataStore()
const progress = useProgressStore()
const connection = useConnectionStore()
const { model } = useMapContext()

const category = computed(() => data.categoryById.get(props.point.categoryId))
const title = computed(() => props.point.name ?? category.value?.label ?? props.point.categoryId)
const showCategory = computed(() => !!category.value && category.value.label !== title.value)
const groupLabel = computed(() => (category.value ? GROUP_LABEL[category.value.group] : ''))
/** Level from the wiki, or estimated from the region for a chest without one (map-power.ts). */
const power = computed(() => model.pointPower(props.point))
const powerNote = computed(() => (power.value?.estimate ? estimateNote(power.value.estimate) : ''))
const trackable = computed(() => isTrackableGroup(category.value?.group))
/** Same rule as the markers and counters (map-found.ts). */
const foundState = computed(() => pointFoundState(props.point, model.links.value, model.marks.value, model.owned.value))
const found = computed(() => foundState.value.found)
/** Rewards picked up here: those are what you tick. */
const rewards = computed(() => (trackable.value ? foundState.value.rewards : []))
/** The plain 'Found' tick: always without rewards, and with rewards only to undo an old tick. */
const showMark = computed(() => trackable.value && (rewards.value.length === 0 || foundState.value.marked))
/** Ticks wait until progress.json is loaded, so nothing gets lost, and while the Mac cannot be reached. */
const locked = computed(() => !progress.canEdit)
const lockedNote = computed(() => (connection.readOnly ? 'Offline: read-only' : "Progress isn't loaded"))

const markNote = computed(() => {
  if (locked.value) return lockedNote.value
  if (rewards.value.length) return "Map-only tick, doesn't count in Collections"
  return found.value ? 'Ticked off in your log' : "Tick it once you've read or picked this up"
})

/** Unticking clears the point and its merged twins, so no old tick keeps it found. */
function setMarked(on: boolean) {
  if (on) progress.togglePoint(props.point.id, true)
  else for (const id of markIds(props.point)) progress.togglePoint(id, false)
}

/**
 * Collections, on the unlocks of this kind (?kind= is the collections URL state). The kind is
 * always named, 'all' for unlocks of several kinds: that view is kept with its filters, and a
 * kind that is still selected there would hide what this link is about.
 */
const collectionsLink = computed(() => {
  const kinds = new Set(rewards.value.map((r) => r.kind))
  if (kinds.size === 0) return null
  return { path: '/collections', query: { kind: kinds.size === 1 ? [...kinds][0]! : 'all' }, hash: '#unlocks' }
})
const onMap = computed(() => isInWorld(props.point))
const wikiPage = computed(() => props.point.link ?? category.value?.wikiPage)
const questLinks = computed(() => questLinksForPoint(props.point, category.value, data.quests))
const vault = computed(() => vaultForPoint(props.point, category.value, model.vaultIndex.value))

function questPath(id: string) {
  return `/quests/${encodeURIComponent(id)}`
}
</script>

<template>
  <ParchmentPanel as="article" :padded="false" class="flex flex-col" aria-labelledby="map-card-title">
    <header class="flex items-start gap-3 px-4 pt-4 sm:px-5">
      <span class="mt-0.5 grid size-10 shrink-0 place-content-center rounded-full border border-gold-ink/25 bg-[#f6eedb]">
        <WikiIcon :file="point.icon ?? category?.icon" :size="28">
          <template #fallback><MapGlyph :glyph="category?.group ?? 'other'" :size="22" on-parchment /></template>
        </WikiIcon>
      </span>
      <div class="min-w-0 flex-1 pt-0.5">
        <p class="font-display text-[0.7rem] font-semibold tracking-[0.14em] text-gold-ink uppercase">
          {{ groupLabel }}<template v-if="showCategory"> · <span lang="en">{{ category?.label }}</span></template>
        </p>
        <h2 id="map-card-title" lang="en" class="mt-0.5 font-display text-lg leading-snug font-semibold text-balance break-words">
          {{ title }}
        </h2>
      </div>
      <IconButton label="Close" size="icon-sm" class="-mt-1 -mr-2 shrink-0" @click="emit('close')">
        <X />
      </IconButton>
    </header>

    <div class="flex flex-col gap-3 px-4 pt-3 pb-4 sm:px-5">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.95rem]">
        <LocationText v-if="point.region" pin lang="en">
          {{ point.region }}<span v-if="point.regionGuessed" class="not-italic text-text-parchment/60"> (estimated)</span>
        </LocationText>
        <span v-if="power" class="inline-flex items-center gap-1.5" data-point-power>
          <PowerBadge :power="power.level" />
          <span v-if="power.estimate" class="text-sm text-text-parchment/60">(estimated)</span>
        </span>
        <span class="font-sans text-sm text-text-parchment/65 tabular-nums">
          <span class="sr-only">Coordinates: </span>x {{ Math.round(point.x) }} · y {{ Math.round(point.y) }}
        </span>
      </div>

      <p v-if="powerNote" class="-mt-1.5 text-sm leading-snug text-text-parchment/70" data-power-note>{{ powerNote }}</p>

      <LocationText v-if="point.description" as="p" lang="en" class="leading-relaxed">{{ point.description }}</LocationText>

      <p v-if="!onMap" class="rounded-md bg-parchment-deep px-3 py-2 text-sm text-text-parchment/80">
        This point is in a vault or another instanced area, off this map.
      </p>

      <div v-if="rewards.length || showMark" class="-mx-2.5 flex flex-col divide-y divide-gold-ink/15 border-y border-gold-ink/15">
        <CheckRow
          v-for="reward in rewards"
          :key="reward.id"
          data-reward-row
          :checked="progress.hasReward(reward.id)"
          :disabled="locked"
          :strike="false"
          :aria-label="reward.name"
          @update:checked="(v) => progress.toggleReward(reward.id, v)"
        >
          <span lang="en">{{ reward.name }}</span>
          <template #note>
            {{ locked ? lockedNote : progress.hasReward(reward.id) ? 'In your collection' : 'Tick it once you have this unlock' }}
          </template>
        </CheckRow>
        <CheckRow v-if="showMark" :checked="foundState.marked" :disabled="locked" @update:checked="setMarked">
          Found
          <template #note>{{ markNote }}</template>
        </CheckRow>
      </div>

      <div v-if="questLinks.length || vault || collectionsLink" class="flex flex-col gap-2">
        <Button v-for="link in questLinks" :key="link.quest.id" as-child :variant="link.relation === 'start' ? 'default' : 'outline'" class="justify-start">
          <RouterLink :to="questPath(link.quest.id)">
            <ScrollText aria-hidden="true" />
            <span class="truncate">Open quest: <span lang="en">{{ link.quest.name }}</span></span>
          </RouterLink>
        </Button>
        <Button v-if="vault" as-child variant="outline" class="justify-start">
          <RouterLink :to="`/collections#vault-${slug(vault.id)}`">
            <Gem aria-hidden="true" />
            <span class="truncate">View in Collections</span>
          </RouterLink>
        </Button>
        <Button v-if="collectionsLink" as-child variant="outline" class="justify-start">
          <RouterLink :to="collectionsLink">
            <Sparkles aria-hidden="true" />
            <span class="truncate">View in Unique unlocks</span>
          </RouterLink>
        </Button>
      </div>

      <WikiLink v-if="wikiPage" :page="wikiPage" class="self-start text-[0.95rem]"><span lang="en">{{ wikiPage }}</span> on the wiki</WikiLink>
    </div>
  </ParchmentPanel>
</template>
