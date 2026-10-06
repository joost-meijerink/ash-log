<script setup lang="ts">
import { computed } from 'vue'
import { MapPin, ScrollText, Vault as VaultIcon } from 'lucide-vue-next'
import { CheckRow } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { isEmptyNote, rowNote, type GroupNote } from '@/lib/collections-rewards'
import { vaultAnchor } from '@/lib/collections-vaults'
import type { Reward } from '@/lib/types'
import { useProgressStore } from '@/stores/progress'
import AnchorLink from './AnchorLink.vue'
import RewardNoteText from './RewardNoteText.vue'
import { inlineLink } from './styles'

/**
 * One unique unlock as a check row: name and set, then how you get it (recipe consumable,
 * requirement, quest, vault or map link) and the source: via labels in the interface font, the
 * wiki text in italics. What the whole group shares (groupNote) is shown above the group instead.
 */
const props = defineProps<{
  reward: Reward
  checked: boolean
  disabled?: boolean
  /** Display name of reward.questId, when the quest exists. */
  questName?: string
  /** Display name of reward.vaultId, when the vault exists. */
  vaultName?: string
  /** What the reward's group shares, already shown under the group heading. */
  groupNote?: GroupNote
}>()

const progress = useProgressStore()

const questHref = computed(() => (props.reward.questId ? `/quests/${encodeURIComponent(props.reward.questId)}` : ''))
/** First map spot where this unlock is picked up. */
const mapPoint = computed(() => props.reward.pointIds?.[0])

/** Via and source minus the group's shared part, and minus a source that only repeats the vault link. */
const note = computed(() => rowNote(props.reward, props.groupNote, props.vaultName ?? props.reward.vaultId))
const showNote = computed(() => !isEmptyNote(note.value))

const hasLine = computed(
  () => !!(props.reward.recipe || props.reward.requirement || props.reward.questId || props.reward.vaultId || mapPoint.value),
)
</script>

<template>
  <CheckRow
    :checked="checked"
    :disabled="disabled"
    :strike="false"
    :aria-label="reward.set ? `${reward.name} (${reward.set})` : reward.name"
    class="break-inside-avoid"
    @update:checked="(value) => progress.toggleReward(reward.id, value)"
  >
    <span lang="en" :class="checked ? 'text-text-parchment' : 'text-text-parchment/90'">{{ reward.name }}</span>
    <Badge v-if="reward.set" lang="en" variant="outline" class="ml-2 translate-y-[-1px] align-middle">{{ reward.set }}</Badge>

    <template v-if="hasLine || showNote" #note>
      <span class="flex flex-col gap-1">
        <span v-if="hasLine" class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span v-if="reward.recipe">via <span lang="en" class="text-text-parchment/85">{{ reward.recipe }}</span></span>
          <span v-if="reward.requirement">Needs: <span lang="en" class="text-text-parchment/85">{{ reward.requirement }}</span></span>
          <RouterLink v-if="reward.questId" :to="questHref" :class="inlineLink">
            <ScrollText aria-hidden="true" />
            <span><span class="sr-only">Quest: </span><span lang="en">{{ questName ?? reward.questId }}</span></span>
          </RouterLink>
          <AnchorLink v-if="reward.vaultId" :to="vaultAnchor(reward.vaultId)" :class="inlineLink">
            <VaultIcon aria-hidden="true" />
            <span><span class="sr-only">Vault: </span><span lang="en">{{ vaultName ?? reward.vaultId }}</span></span>
          </AnchorLink>
          <RouterLink v-if="mapPoint" :to="{ path: '/map', query: { focus: mapPoint } }" :class="inlineLink" data-map-link>
            <MapPin aria-hidden="true" />
            <span>Show on map<span class="sr-only">: <span lang="en">{{ reward.name }}</span></span></span>
          </RouterLink>
        </span>
        <RewardNoteText v-if="showNote" :note="note" />
      </span>
    </template>
  </CheckRow>
</template>
