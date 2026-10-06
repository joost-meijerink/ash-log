<script setup lang="ts">
import { ref } from 'vue'
import ParchmentPanel from '@/components/common/ParchmentPanel.vue'
import type { AppQuest } from '@/lib/types'
import QuestDetailHeader from './QuestDetailHeader.vue'
import QuestItems from './QuestItems.vue'
import QuestLocation from './QuestLocation.vue'
import QuestRelations from './QuestRelations.vue'
import QuestRewards from './QuestRewards.vue'
import QuestSteps from './QuestSteps.vue'

/**
 * One quest on a parchment sheet. Narrow: one column (start, order, items, steps, reward).
 * Wide: the steps get the reading column and the rest sits in a rail on the right.
 */
defineProps<{ quest: AppQuest }>()

const header = ref<InstanceType<typeof QuestDetailHeader> | null>(null)

defineExpose({ focusTitle: () => header.value?.focusTitle() })
</script>

<template>
  <ParchmentPanel as="article" :padded="false" class="px-4 py-6 sm:px-8 sm:py-8 xl:px-10" :aria-label="quest.name">
    <QuestDetailHeader ref="header" :quest="quest" />

    <!-- The rail layout depends on the sheet's own width, not the viewport (the list takes a column too). -->
    <div class="@container mt-8 border-t border-gold-ink/20 pt-7">
      <div class="grid grid-cols-1 gap-y-9 @4xl:grid-cols-[minmax(0,1fr)_19rem] @4xl:grid-rows-[auto_1fr] @4xl:gap-x-10 @4xl:gap-y-0">
        <div class="flex min-w-0 flex-col gap-8 @4xl:col-start-2 @4xl:row-start-1 @4xl:border-l @4xl:border-gold-ink/15 @4xl:pl-8">
          <QuestLocation :quest="quest" />
          <QuestRelations :quest="quest" />
          <QuestItems :quest="quest" />
        </div>

        <QuestSteps :quest="quest" class="min-w-0 @4xl:col-start-1 @4xl:row-span-2 @4xl:row-start-1" />

        <QuestRewards
          :quest="quest"
          class="min-w-0 @4xl:col-start-2 @4xl:row-start-2 @4xl:border-l @4xl:border-gold-ink/15 @4xl:pt-9 @4xl:pl-8"
        />
      </div>
    </div>
  </ParchmentPanel>
</template>
