<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRight, MapPin } from 'lucide-vue-next'
import CheckRow from '@/components/common/CheckRow.vue'
import SectionHeading from '@/components/common/SectionHeading.vue'
import RewardNoteText from '@/components/collections/RewardNoteText.vue'
import { inlineLink } from '@/components/collections/styles'
import { isEmptyNote, rewardNote, type RewardNote } from '@/lib/collections-rewards'
import { REWARD_KIND_LABEL, rewardTree } from '@/lib/quests-detail'
import type { AppQuest, Reward } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import QuestRewardTree from './QuestRewardTree.vue'

/** The reward text from the wiki, plus the unique unlocks from this quest as a checklist. */
const props = defineProps<{ quest: AppQuest }>()

const data = useDataStore()
const progress = useProgressStore()

interface Unlock {
  reward: Reward
  /** Via labels and wiki source. */
  note: RewardNote
  /** First map spot where the unlock is picked up. */
  mapPoint?: string
}

const tree = computed(() => rewardTree(props.quest.rewards))
const unlocks = computed<Unlock[]>(() =>
  data.rewards
    .filter((r) => r.questId === props.quest.id)
    .map((reward) => ({ reward, note: rewardNote(reward), mapPoint: reward.pointIds?.[0] })),
)
const unlocked = computed(() => unlocks.value.filter((u) => progress.hasReward(u.reward.id)).length)

const hasNote = (u: Unlock) => !!(u.reward.requirement || !isEmptyNote(u.note) || u.mapPoint)
</script>

<template>
  <section aria-labelledby="quest-rewards-heading">
    <SectionHeading id="quest-rewards-heading" title="Rewards" />
    <QuestRewardTree v-if="tree.length" :nodes="tree" class="mt-2.5" />
    <p v-else class="mt-2 text-text-parchment/70">The wiki doesn't list a reward.</p>

    <div v-if="unlocks.length" class="mt-6">
      <SectionHeading as="h3" title="Unique unlocks" :count="`${unlocked} / ${unlocks.length}`" />
      <ul class="mt-1.5 flex flex-col gap-0.5" role="list">
        <li v-for="u in unlocks" :key="u.reward.id">
          <CheckRow
            :checked="progress.hasReward(u.reward.id)"
            :disabled="!progress.canEdit"
            :aria-label="u.reward.name"
            @update:checked="progress.toggleReward(u.reward.id, $event)"
          >
            <span lang="en">{{ u.reward.name }}</span>
            <template v-if="u.reward.kind !== 'quest'" #meta>{{ REWARD_KIND_LABEL[u.reward.kind] }}</template>
            <template v-if="hasNote(u)" #note>
              <span class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span v-if="u.reward.requirement" lang="en" class="font-serif italic">{{ u.reward.requirement }}</span>
                <RewardNoteText v-else-if="!isEmptyNote(u.note)" :note="u.note" />
                <RouterLink v-if="u.mapPoint" :to="{ path: '/map', query: { focus: u.mapPoint } }" :class="inlineLink" data-map-link>
                  <MapPin aria-hidden="true" />
                  <span>Show on map<span class="sr-only">: <span lang="en">{{ u.reward.name }}</span></span></span>
                </RouterLink>
              </span>
            </template>
          </CheckRow>
        </li>
      </ul>
      <RouterLink
        to="/collections"
        class="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm px-2.5 text-[0.95rem] text-gold-ink underline decoration-gold-ink/35 underline-offset-[3px] outline-none hover:decoration-gold-ink focus-visible:ring-2 focus-visible:ring-gold-ink/50"
      >
        All collections
        <ArrowRight class="size-4" aria-hidden="true" />
      </RouterLink>
    </div>
  </section>
</template>
