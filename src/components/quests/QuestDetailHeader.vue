<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, RotateCcw, Undo2 } from 'lucide-vue-next'
import IconButton from '@/components/common/IconButton.vue'
import LocationText from '@/components/common/LocationText.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import WikiLink from '@/components/common/WikiLink.vue'
import { Button } from '@/components/ui/button'
import { questKindLabel } from '@/lib/quests-detail'
import { questEntry } from '@/lib/quests-list'
import type { AppQuest } from '@/lib/types'
import { useProgressStore } from '@/stores/progress'
import QuestConfirmDialog from './QuestConfirmDialog.vue'

/** Title block of a quest: kind, name, region, description and the done/reset actions. */
const props = defineProps<{ quest: AppQuest }>()

const progress = useProgressStore()
const qp = computed(() => progress.state.quests[props.quest.id])
const entry = computed(() => questEntry(props.quest, qp.value))
const manualDone = computed(() => !!qp.value?.done)
const hasProgress = computed(() => !!qp.value && (!!qp.value.done || qp.value.steps.length > 0 || qp.value.items.length > 0))

const stepsDetail = computed(() => {
  const { stepsDone, stepsTotal } = entry.value
  if (!stepsTotal) return 'No steps'
  const base = `${stepsDone} / ${stepsTotal}`
  return manualDone.value && stepsDone < stepsTotal ? `${base}, marked done by hand` : base
})

const confirmReset = ref(false)
const title = ref<HTMLElement | null>(null)

defineExpose({ focusTitle: () => title.value?.focus({ preventScroll: true }) })
</script>

<template>
  <header class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p class="font-display text-[0.72rem] font-semibold tracking-[0.2em] text-gold-ink uppercase">
        {{ questKindLabel(quest) }}
      </p>
      <StatusBadge :state="entry.state" class="ml-auto" />
    </div>

    <h1
      ref="title"
      lang="en"
      tabindex="-1"
      class="font-display text-[1.7rem] leading-[1.12] font-semibold tracking-[0.02em] text-balance text-text-parchment outline-none sm:text-[2.1rem]"
    >
      {{ quest.name }}
    </h1>

    <p class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[0.95rem]">
      <LocationText v-if="quest.region" lang="en">{{ quest.region }}</LocationText>
      <span v-if="quest.region" aria-hidden="true" class="text-text-parchment/35">·</span>
      <WikiLink :href="quest.wikiUrl">On the wiki</WikiLink>
    </p>

    <LocationText
      v-if="quest.description"
      as="p"
      lang="en"
      class="max-w-[60ch] text-[1.15rem] leading-relaxed text-pretty text-text-parchment"
    >
      {{ quest.description }}
    </LocationText>

    <div
      class="mt-2 flex flex-col gap-3 rounded-md border border-gold-ink/15 bg-parchment-deep/55 p-3 sm:flex-row sm:items-center sm:gap-5 sm:p-4"
    >
      <ProgressBar class="sm:flex-1" size="md" label="Steps" :value="entry.fraction" :detail="stepsDetail" />
      <div class="flex items-center gap-2">
        <Button v-if="entry.state !== 'done'" :disabled="!progress.canEdit" @click="progress.setQuestDone(quest.id, true)">
          <Check aria-hidden="true" />
          Mark as done
        </Button>
        <Button v-else-if="manualDone" variant="outline" :disabled="!progress.canEdit" @click="progress.setQuestDone(quest.id, false)">
          <Undo2 aria-hidden="true" />
          Not done after all
        </Button>
        <p v-else class="px-1 text-sm text-text-parchment/70">All steps ticked off</p>
        <IconButton label="Clear progress" :disabled="!hasProgress || !progress.canEdit" @click="confirmReset = true">
          <RotateCcw aria-hidden="true" />
        </IconButton>
      </div>
    </div>

    <QuestConfirmDialog
      v-model:open="confirmReset"
      :title="`Clear progress for ${quest.name}?`"
      description="All ticks on the steps and items go away, and the quest is back to not started. Unique unlocks stay."
      confirm-label="Clear progress"
      @confirm="progress.resetQuest(quest.id)"
    />
  </header>
</template>
