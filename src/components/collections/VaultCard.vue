<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Circle, Info, MapPin, ScrollText, X } from 'lucide-vue-next'
import { CheckRow, IconButton, LocationText, ParchmentPanel, PowerBadge, WikiLink } from '@/components/common'
import { Button } from '@/components/ui/button'
import { tallyText } from '@/lib/collections-shared'
import { uncheckedVaultRewards, vaultRewardTally } from '@/lib/collections-vaults'
import { REWARD_KIND_LABEL } from '@/lib/collections-rewards'
import { cn } from '@/lib/utils'
import type { VaultCardData } from '@/composables/useCollections'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import { capsLabel, inlineLink } from './styles'

/**
 * A Dragonkin vault: order, name, power level, where it is, its recipes (grouped by armour
 * set, tickable when they match a unique unlock), and 'Voltooid'. Vault cores respawn in the game, so they are not tracked.
 * The root carries id 'vault-<slug>' for deep links.
 */
const props = defineProps<{
  card: VaultCardData
  owned: ReadonlySet<string>
  /** Briefly true after a deep link lands here. */
  highlighted?: boolean
  /** Progress is not loaded yet: toggles are off. */
  disabled?: boolean
}>()

const data = useDataStore()
const progress = useProgressStore()

const vault = computed(() => props.card.vault)
const done = computed(() => progress.isVaultDone(vault.value.id))
const titleId = computed(() => `${props.card.anchor}-title`)
const place = computed(() => {
  const { area, region } = vault.value
  return region && region !== area ? `${area}, ${region}` : area
})
const hasSets = computed(() => props.card.groups.some((g) => g.set && !g.extra))
const tally = computed(() => vaultRewardTally(props.card.groups, props.owned))
const unchecked = computed(() => uncheckedVaultRewards(props.card.groups, props.owned))
const rowCount = computed(() => props.card.groups.reduce((n, g) => n + g.rows.length, 0))

// Non-blocking offer after marking the vault done.
const offer = ref(false)
watch(done, (isDone) => {
  if (!isDone) offer.value = false
})

function toggleDone() {
  const next = !done.value
  progress.setVaultDone(vault.value.id, next)
  offer.value = next && unchecked.value.length > 0
}

function checkAllRecipes() {
  for (const reward of unchecked.value) progress.toggleReward(reward.id, true)
  offer.value = false
}

function groupLabel(group: VaultCardData['groups'][number]): string | undefined {
  if (group.extra) return group.set ? `${group.set} (ook uit deze vault)` : 'Ook uit deze vault'
  if (group.set) return group.set
  return hasSets.value ? 'Losse recepten' : undefined
}

const questName = (id: string) => data.questById.get(id)?.name ?? id
</script>

<template>
  <ParchmentPanel
    :id="card.anchor"
    as="article"
    tabindex="-1"
    :shade="done ? 'light' : 'deep'"
    :aria-labelledby="titleId"
    :data-done="done || undefined"
    :class="
      cn(
        'flex scroll-mt-20 flex-col outline-none transition-[box-shadow] duration-700 ease-out motion-reduce:transition-none',
        highlighted && 'ring-[3px] ring-gold ring-offset-4 ring-offset-ink duration-150',
      )
    "
  >
    <!-- Header: order, name, power level, place -->
    <header class="flex items-start gap-3.5">
      <span
        aria-hidden="true"
        :class="
          cn(
            'relative -mt-0.5 grid size-12 shrink-0 place-content-center font-display text-[1.45rem] leading-none font-semibold tabular-nums',
            `before:absolute before:inset-2 before:rotate-45 before:rounded-[4px] before:border-[1.5px] before:content-['']`,
            done ? 'text-parchment before:border-gold-ink before:bg-gold-ink' : 'text-gold-ink before:border-gold-ink/40',
          )
        "
      >
        <span class="relative">{{ vault.order }}</span>
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 :id="titleId" class="font-display text-[1.15rem] leading-tight font-semibold tracking-[0.05em]">
            <span class="sr-only">Vault {{ vault.order }}: </span><span lang="en">{{ vault.name }}</span>
          </h3>
          <PowerBadge :power="vault.power" />
        </div>
        <LocationText as="p" pin lang="en" class="mt-1 text-[0.98rem]">{{ place }}</LocationText>
      </div>
    </header>

    <!-- Recipes -->
    <section class="mt-4 border-t border-gold-ink/15 pt-3" :aria-labelledby="`${card.anchor}-recipes`">
      <div class="flex items-baseline justify-between gap-3 px-2.5">
        <h4 :id="`${card.anchor}-recipes`" :class="capsLabel">Recepten</h4>
        <span v-if="tally.total" class="text-sm text-text-parchment/65 tabular-nums">
          {{ tallyText(tally) }}<span class="sr-only"> afgevinkt</span>
        </span>
      </div>

      <p v-if="!rowCount" class="px-2.5 pt-2 text-[0.95rem] text-text-parchment/60">Nog geen recepten bekend op de wiki.</p>

      <div v-for="group in card.groups" :key="group.key" class="mt-1.5">
        <p
          v-if="groupLabel(group)"
          :lang="group.set && !group.extra ? 'en' : undefined"
          class="px-2.5 pt-1.5 font-serif text-[0.95rem] text-text-parchment/70 italic"
        >
          {{ groupLabel(group) }}
        </p>
        <ul :class="group.set || group.extra ? 'border-l border-gold-ink/20 ml-2.5' : ''">
          <li v-for="row in group.rows" :key="row.key">
            <CheckRow
              v-if="row.reward"
              :checked="owned.has(row.reward.id)"
              :disabled="disabled"
              :strike="false"
              :aria-label="row.name"
              @update:checked="(value) => progress.toggleReward(row.reward!.id, value)"
            >
              <span lang="en" :class="done ? 'font-semibold' : ''">{{ row.name }}</span>
              <template v-if="row.note || row.reward.kind !== 'effigy'" #note>
                <span class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span v-if="row.reward.kind === 'quest' && row.reward.questId">
                    Questbeloning uit
                    <RouterLink :to="`/quests/${encodeURIComponent(row.reward.questId)}`" :class="inlineLink">
                      <ScrollText aria-hidden="true" /><span lang="en">{{ questName(row.reward.questId) }}</span>
                    </RouterLink>
                  </span>
                  <span v-else-if="row.reward.kind !== 'effigy'">{{ REWARD_KIND_LABEL[row.reward.kind] }}</span>
                  <LocationText v-if="row.note" lang="en">{{ row.note }}</LocationText>
                </span>
              </template>
            </CheckRow>
            <div
              v-else
              class="flex min-h-11 items-start gap-3 px-2.5 py-[11px] text-[0.975rem] leading-snug"
              title="Staat niet in de lijst met unieke unlocks"
            >
              <span aria-hidden="true" class="grid size-5 shrink-0 place-content-center">
                <span class="block size-1.5 rotate-45 bg-gold-ink/50" />
              </span>
              <span class="flex min-w-0 flex-col gap-0.5">
                <span lang="en" :class="done ? 'font-semibold' : ''">{{ row.name }}</span>
                <LocationText v-if="row.note" lang="en" class="text-sm">{{ row.note }}</LocationText>
              </span>
            </div>
          </li>
        </ul>
      </div>

      <p v-if="vault.note" class="mt-2 flex items-start gap-2 px-2.5 text-sm text-text-parchment/70">
        <Info class="mt-0.5 size-3.5 shrink-0 text-gold-ink" aria-hidden="true" />
        <LocationText lang="en">{{ vault.note }}</LocationText>
      </p>
    </section>

    <!-- Done, links -->
    <footer class="mt-auto pt-4">
      <div class="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-gold-ink/15 pt-3">
        <Button
          :variant="done ? 'default' : 'outline'"
          size="sm"
          :aria-pressed="done"
          :disabled="disabled"
          @click="toggleDone"
        >
          <Check v-if="done" aria-hidden="true" :stroke-width="2.5" />
          <Circle v-else aria-hidden="true" />
          Voltooid
        </Button>
      </div>

      <div aria-live="polite">
        <div
          v-if="offer && unchecked.length"
          class="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-gold-ink/25 bg-gold-ink/[0.07] py-1.5 pr-1 pl-3"
        >
          <p class="min-w-0 flex-1 text-sm text-text-parchment/80">
            Vault voltooid. Nog {{ unchecked.length === 1 ? '1 recept' : `${unchecked.length} recepten` }} open.
          </p>
          <Button variant="link" size="sm" :disabled="disabled" @click="checkAllRecipes">Ook de recepten van deze vault afvinken</Button>
          <IconButton label="Niet nodig" size="icon-sm" @click="offer = false">
            <X aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 px-0.5 text-[0.95rem]">
        <RouterLink v-if="vault.pointId" :to="{ path: '/kaart', query: { focus: vault.pointId } }" :class="cn(inlineLink, 'py-2.5')">
          <MapPin aria-hidden="true" />Toon op kaart
        </RouterLink>
        <WikiLink v-if="vault.wikiUrl" :href="vault.wikiUrl" class="py-2.5">Op de wiki</WikiLink>
        <span v-else class="py-2.5 text-text-parchment/55">Nog geen wikipagina</span>
      </div>
    </footer>
  </ParchmentPanel>
</template>
