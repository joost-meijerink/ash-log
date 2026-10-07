<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { SearchX, Sparkles } from 'lucide-vue-next'
import { EmptyState, ParchmentPanel, SearchInput, SectionHeading, ToggleChip } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  buildRewardList,
  collectionQuery,
  KIND_FILTERS,
  kindLabel,
  kindTallies,
  mergeCollectionQuery,
  parseCollectionQuery,
  sameCollectionState,
  targetsUnlockList,
  trackedRewards,
  viaText,
  type CollectionUrlState,
  type KindFilter,
} from '@/lib/collections-rewards'
import { tallyText } from '@/lib/collections-shared'
import { useViewRoute } from '@/composables/useViewRoute'
import { useDataStore } from '@/stores/data'
import RewardNoteText from './RewardNoteText.vue'
import RewardRow from './RewardRow.vue'

/**
 * The unique unlocks: kind chips with counts, search, 'Hide what I have' and the list
 * grouped by kind and region. A region heading spans the panel with its rows in two columns
 * below it (one on phones), so a region never breaks across columns. What a group's rewards
 * share (via, a long source) is shown once under its heading instead of on every row. Kind and
 * the hide switch are in the URL too (?kind=<kind>&hide=1), the search text is not.
 */
const props = defineProps<{
  owned: ReadonlySet<string>
  /** Reward id -> search text (see useCollections). */
  haystacks: ReadonlyMap<string, string>
  /** Reward id -> region (see useCollections). Without it, rewards group by wiki sub-heading. */
  regions?: ReadonlyMap<string, string>
  disabled?: boolean
}>()

const data = useDataStore()
/** Plans are not tracked (see REWARD_KINDS). */
const tracked = computed(() => trackedRewards(data.rewards))
// The route of the Collections view itself: while another view is on screen it keeps its last
// value, so a ?kind= or a hash of the map or the quests never gets in here.
const view = useViewRoute()
const route = view.route

const query = ref('')
/**
 * Kind and the hide switch. They are kept here and mirrored in the address, so they are still
 * there after a link from another view that does not name them (see the watcher below).
 */
const state = shallowRef<CollectionUrlState>(parseCollectionQuery(route.query))
const kind = computed(() => state.value.kind)
const hideOwned = computed(() => state.value.hideOwned)

/**
 * Puts kind and the hide switch in the address, on the path and the hash of this view. A replace,
 * so no history entry, and nothing at all while another view is on screen (view.replace).
 */
function writeUrl() {
  void view.replace({ path: route.path, query: collectionQuery(state.value, route.query) as typeof route.query, hash: route.hash })
}

function setUrlState(next: { kind?: KindFilter; hideOwned?: boolean }) {
  state.value = { ...state.value, ...next }
  writeUrl()
}

// The address of this view changed, or the view is back on screen. One watcher for both, so it
// does not matter which of the two is noticed first.
watch([() => route.query, view.arrival], ([q, arrival], [, before]) => {
  const named = parseCollectionQuery(q)
  if (arrival === before) {
    // Moved inside the view (back, forward, the tab of this view): the address says it all.
    if (!sameCollectionState(named, state.value)) state.value = named
    return
  }
  // A link from another view: what it names wins, the rest stays as it was. Coming back to
  // where the view was left changes nothing.
  if (arrival?.kind === 'fresh') {
    // A link to the unlocks themselves (from a map card) must show what it points at: the search
    // text cannot be named by a link and would hide it, and so would a kept 'Hide what I have'.
    const toList = targetsUnlockList(q, route.hash)
    if (toList) query.value = ''
    const next = mergeCollectionQuery(q, state.value, toList)
    if (!sameCollectionState(next, state.value)) state.value = next
  }
  // The address has to say what is on screen: a link that left them out, or a write that was cut
  // off by leaving. After a link also in the usual words ('?kind=all' is how a link asks for
  // 'All'; the address of 'All' has no ?kind).
  const written = collectionQuery(state.value, q)
  const tidy = arrival?.kind !== 'fresh' || (written.kind === q.kind && written.hide === q.hide)
  if (!tidy || !sameCollectionState(named, state.value)) writeUrl()
})

const tallies = computed(() => kindTallies(tracked.value, props.owned))
/** All, plus every kind that has rewards (and the selected one, so it never vanishes). */
const kindOptions = computed(() => KIND_FILTERS.filter((k) => k === 'all' || k === kind.value || (tallies.value[k]?.total ?? 0) > 0))
const list = computed(() =>
  buildRewardList(
    tracked.value,
    props.owned,
    { kind: kind.value, query: query.value, hideOwned: hideOwned.value },
    props.haystacks,
    props.regions,
  ),
)
const filtering = computed(() => !!query.value.trim() || hideOwned.value)

const resultText = computed(() => {
  const { visible, total } = list.value
  if (!filtering.value) return `${total} ${total === 1 ? 'unlock' : 'unlocks'}`
  return `${visible} of ${total} shown`
})

const questName = (id?: string) => (id ? data.questById.get(id)?.name : undefined)
const vaultName = (id?: string) => (id ? data.vaultById.get(id)?.name : undefined)

function resetFilters() {
  query.value = ''
  if (hideOwned.value) setUrlState({ hideOwned: false })
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Controls, on leather -->
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-5">
        <SearchInput v-model="query" placeholder="Search by name, recipe, source or region" class="sm:max-w-md" />
        <Label for="hide-owned" class="min-h-11 cursor-pointer gap-3 text-text-light">
          <Switch id="hide-owned" :model-value="hideOwned" @update:model-value="(v) => setUrlState({ hideOwned: !!v })" />
          Hide what I have
        </Label>
      </div>

      <div role="group" aria-label="Kind of unlock" class="flex flex-wrap gap-x-2 gap-y-2.5">
        <ToggleChip
          v-for="k in kindOptions"
          :key="k"
          :pressed="kind === k"
          :count="tallies[k] ? `${tallies[k].done}/${tallies[k].total}` : null"
          @update:pressed="setUrlState({ kind: k })"
        >
          {{ kindLabel(k) }}
        </ToggleChip>
      </div>

      <p class="text-sm text-muted-light" aria-live="polite">{{ resultText }}</p>
    </div>

    <!-- List, on parchment: one panel per kind -->
    <ParchmentPanel v-for="block in list.blocks" :key="block.kind" as="div">
      <div class="mb-2 flex items-baseline justify-between gap-3">
        <h3
          :id="`unlocks-${block.kind}`"
          class="font-display text-base font-semibold tracking-[0.1em] text-text-parchment uppercase"
          :class="kind !== 'all' && 'sr-only'"
        >
          {{ block.label }}
        </h3>
        <span v-if="kind === 'all'" class="text-sm text-text-parchment/65 tabular-nums">
          {{ tallyText(block.tally) }}<span class="sr-only"> ticked off</span>
        </span>
      </div>

      <div class="flex flex-col gap-4">
        <div v-for="group in block.groups" :key="group.key" data-reward-group>
          <SectionHeading v-if="group.label" as="h4" :count="tallyText(group.tally)" class="mb-0.5 px-2.5">
            <span :lang="group.fallback ? undefined : 'en'">{{ group.label }}</span>
          </SectionHeading>
          <p
            v-if="group.note"
            data-group-note
            class="mb-1 flex flex-col gap-0.5 px-2.5 text-sm leading-snug text-text-parchment/70"
          >
            <span v-if="group.note.via.length">{{ viaText(group.note.via) }}</span>
            <RewardNoteText
              v-if="group.note.shared"
              :note="group.note.shared"
              :prefix="group.note.shared.count < group.note.total ? `For ${group.note.shared.count} of the ${group.note.total}:` : undefined"
            />
          </p>
          <ul class="gap-x-10 lg:columns-2">
            <li v-for="reward in group.rewards" :key="reward.id" class="break-inside-avoid">
              <RewardRow
                :reward="reward"
                :checked="owned.has(reward.id)"
                :disabled="disabled"
                :quest-name="questName(reward.questId)"
                :vault-name="vaultName(reward.vaultId)"
                :group-note="group.note"
              />
            </li>
          </ul>
        </div>
      </div>
    </ParchmentPanel>

    <!-- Nothing to show -->
    <template v-if="!list.blocks.length">
      <ParchmentPanel v-if="!tracked.length">
        <EmptyState
          compact
          :icon="Sparkles"
          title="No unlocks yet"
          text="The list comes from the Consumable Recipes wiki page. Run a sync to fetch it."
        />
      </ParchmentPanel>
      <ParchmentPanel v-else-if="hideOwned && !query.trim()">
        <EmptyState compact :icon="Sparkles" title="Got them all" :text="`You already have all ${kind === 'all' ? 'unlocks' : kindLabel(kind).toLowerCase()}.`">
          <template #action>
            <Button variant="outline" size="sm" @click="setUrlState({ hideOwned: false })">Show them again</Button>
          </template>
        </EmptyState>
      </ParchmentPanel>
      <ParchmentPanel v-else>
        <EmptyState compact :icon="SearchX" title="Nothing found" :text="kind === 'all' ? 'Try another word.' : 'Try another word, or look under All.'">
          <template #action>
            <Button variant="outline" size="sm" @click="resetFilters">Clear search and filters</Button>
            <Button v-if="kind !== 'all'" variant="ghost" size="sm" @click="setUrlState({ kind: 'all' })">Show all</Button>
          </template>
        </EmptyState>
      </ParchmentPanel>
    </template>
  </div>
</template>
