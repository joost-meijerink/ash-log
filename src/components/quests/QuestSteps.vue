<script setup lang="ts">
import { computed, ref } from 'vue'
import { BookOpen, ListChecks } from 'lucide-vue-next'
import CheckRow from '@/components/common/CheckRow.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SectionHeading from '@/components/common/SectionHeading.vue'
import ToggleChip from '@/components/common/ToggleChip.vue'
import WikiLink from '@/components/common/WikiLink.vue'
import { cn } from '@/lib/utils'
import { groupSteps, placeNeeds, stepsSourceLabel } from '@/lib/quests-detail'
import { questState } from '@/lib/progress'
import type { AppQuest } from '@/lib/types'
import { useProgressStore } from '@/stores/progress'
import QuestNeeds from './QuestNeeds.vue'

/**
 * The quest steps as a checklist under their walkthrough headings. Steps are often long
 * paragraphs, so a checked step dims instead of getting struck through, and the first open
 * step is marked so you can find your place again. What a section needs ({{Needed}} on the
 * wiki) sits under its heading; needs without a matching section go above the steps.
 */
const props = defineProps<{ quest: AppQuest }>()

const progress = useProgressStore()
const qp = computed(() => progress.state.quests[props.quest.id])
const checked = computed(() => new Set(qp.value?.steps ?? []))
const isChecked = (stepId: string) => checked.value.has(stepId)

const total = computed(() => props.quest.steps.length)
const done = computed(() => props.quest.steps.filter((s) => checked.value.has(s.id)).length)
const questDone = computed(() => questState(props.quest, qp.value) === 'done')
const nextStepId = computed(() => (questDone.value ? undefined : props.quest.steps.find((s) => !checked.value.has(s.id))?.id))

const hideChecked = ref(false)
const allGroups = computed(() => groupSteps(props.quest.steps))
const needs = computed(() => placeNeeds(allGroups.value, props.quest.needs))
const groups = computed(() => {
  const all = allGroups.value
  if (!hideChecked.value) return all
  return all.map((g) => ({ ...g, steps: g.steps.filter((s) => !checked.value.has(s.id)) })).filter((g) => g.steps.length)
})
const hiddenCount = computed(() => (hideChecked.value ? done.value : 0))
</script>

<template>
  <section aria-labelledby="quest-steps-heading">
    <SectionHeading id="quest-steps-heading" title="Stappen" :count="total ? `${done} / ${total}` : null">
      <template v-if="done > 0 && (done < total || hideChecked)" #right>
        <ToggleChip v-model:pressed="hideChecked">Verberg afgevinkt</ToggleChip>
      </template>
    </SectionHeading>

    <template v-if="total">
      <p class="mt-1 flex items-center gap-1.5 text-sm text-text-parchment/65">
        <BookOpen class="size-3.5 shrink-0" aria-hidden="true" />
        {{ stepsSourceLabel(quest.stepsSource) }}
      </p>

      <QuestNeeds v-if="needs.before.length" :needs="needs.before" show-section class="mt-3" />

      <div class="mt-4 flex flex-col gap-5">
        <div
          v-for="group in groups"
          :key="group.key"
          :class="cn(group.level === 2 && 'ml-2.5 border-l border-gold-ink/20 pl-2 sm:ml-3 sm:pl-3')"
        >
          <component
            :is="group.level === 1 ? 'h3' : 'h4'"
            v-if="group.section"
            lang="en"
            :class="
              cn(
                'mb-1 px-2.5 leading-snug text-pretty',
                group.level === 1
                  ? 'font-display text-[1.02rem] font-semibold tracking-[0.03em] text-text-parchment'
                  : 'font-serif text-[1.02rem] text-text-parchment/80 italic',
              )
            "
          >
            {{ group.section }}
          </component>
          <QuestNeeds v-if="needs.byGroup.has(group.key)" :needs="needs.byGroup.get(group.key)!" class="mb-1.5 px-2.5" />
          <ul class="flex flex-col gap-0.5" role="list">
            <li v-for="step in group.steps" :key="step.id">
              <CheckRow
                :checked="isChecked(step.id)"
                :strike="false"
                :disabled="!progress.canEdit"
                :class="cn(step.id === nextStepId && 'bg-parchment-deep/45 shadow-[inset_2px_0_0_#7a561a]')"
                @update:checked="progress.toggleStep(quest.id, step.id, $event)"
              >
                <span
                  :class="
                    cn(
                      'block max-w-[70ch] text-[1rem] leading-relaxed text-pretty transition-colors',
                      isChecked(step.id) && 'text-text-parchment/50',
                    )
                  "
                >
                  <span v-if="step.id === nextStepId" class="sr-only">Volgende stap: </span><span lang="en">{{ step.text }}</span>
                </span>
              </CheckRow>
            </li>
          </ul>
        </div>
      </div>

      <p v-if="hiddenCount" class="mt-4 px-2.5 text-sm text-text-parchment/65">
        {{ hiddenCount === 1 ? '1 afgevinkte stap verborgen.' : `${hiddenCount} afgevinkte stappen verborgen.` }}
      </p>
    </template>

    <template v-else>
      <QuestNeeds v-if="needs.before.length" :needs="needs.before" show-section class="mt-3" />
      <EmptyState
        compact
        :icon="ListChecks"
        title="Geen stappen"
        text="De wiki heeft voor deze quest nog geen walkthrough. Markeer hem als voltooid als je klaar bent."
      >
        <WikiLink :href="quest.wikiUrl">Bekijk de questpagina</WikiLink>
      </EmptyState>
    </template>
  </section>
</template>
