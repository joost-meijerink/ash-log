<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { ArrowLeft, ScrollText } from 'lucide-vue-next'
import EmptyState from '@/components/common/EmptyState.vue'
import ParchmentPanel from '@/components/common/ParchmentPanel.vue'
import QuestDetail from '@/components/quests/QuestDetail.vue'
import QuestList from '@/components/quests/QuestList.vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useKeptScroll } from '@/composables/useKeptScroll'
import { useQuestEntries } from '@/composables/useQuestEntries'
import { useQuestRoute } from '@/composables/useQuestRoute'
import { provideViewRoute } from '@/composables/useViewRoute'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'

// Quests: list on leather (left, or its own screen on phones) and the selected quest on parchment.
//
// The view stays alive while the map or the collections are on screen, so the selected quest, the
// filters, what is open in the quest and the scroll positions are still there when you come back.
// Everything below reads the view's own route (first line of the setup): it never sees /map.

const view = provideViewRoute('quests')

const data = useDataStore()
const progress = useProgressStore()
const { entries, entryById } = useQuestEntries()

// Wait for progress before picking a default quest, so 'the first quest in progress' is real.
const canPickDefault = computed(() => data.ready && (progress.loaded || !!progress.error) && entries.value.length > 0)
const { requestedId, selectedId, unknownId, listState, questLink, clearFilters } = useQuestRoute({ entries, canPickDefault })

const selected = computed(() => (selectedId.value ? entryById.value.get(selectedId.value)?.quest : undefined))

/* Narrow screens show the list or the quest. Arriving without a quest in the URL starts on the list. */
const wide = useMediaQuery('(min-width: 1024px)')
const listOpen = ref(!requestedId.value)
// Back to /quests without a quest (the Quests tab in the header): show the list again.
watch(requestedId, (id) => {
  if (!id) listOpen.value = true
})
const showList = computed(() => listOpen.value || !selected.value)
const showDetail = computed(() => (selected.value ? !listOpen.value : !!unknownId.value))

const root = ref<HTMLElement | null>(null)
const detailScroller = ref<HTMLElement | null>(null)
const list = ref<InstanceType<typeof QuestList> | null>(null)
const detail = ref<InstanceType<typeof QuestDetail> | null>(null)

/* Scroll. From lg up the list and the quest scroll on their own and get their position back when
   the view returns (the list keeps its own, see QuestList). Below lg the page (main) scrolls and
   the shell puts it back. */
const detailScroll = useKeptScroll(detailScroller)

/* Phones: the list and the quest take turns in the same page scroll. Where the list was is
   noted when it makes way for a quest, so 'Back to list' brings it back at that spot. */
let listPlace: { top: number; questId: string | undefined } | null = null
const mainTop = () => root.value?.closest('main')?.scrollTop ?? 0
// Leaving with the list on screen: a link from another view may open a quest over it.
view.onLeave(() => {
  if (!wide.value && showList.value) listPlace = { top: mainTop(), questId: selectedId.value }
})
watch(wide, () => {
  listPlace = null
})

let focusNextQuest = false
/** The quest on screen came with a link from another view: focus stays alone, as on a first visit. */
let arriving = false

/** A row was clicked. On phones: switch to the quest, start at its top and put focus on its title. */
function onSelect(questId: string) {
  if (wide.value) return
  if (showList.value) listPlace = { top: mainTop(), questId }
  listOpen.value = false
  if (questId !== selectedId.value) {
    focusNextQuest = true
    return
  }
  void nextTick(() => {
    view.scrollMain('top')
    detail.value?.focusTitle()
  })
}

function backToList() {
  listOpen.value = true
  const place = listPlace
  void nextTick(() => {
    // Never saw the list (the quest came from a link): bring its row to the middle, as before.
    if (!place) return list.value?.focusSelected()
    view.scrollMain(place.top)
    // The quest that was opened from there is in view already; another one (reached through a
    // chip in the quest) is only scrolled to when it is out of view.
    list.value?.focusSelected(place.questId === selectedId.value ? false : 'nearest')
  })
}

// A link from another view to a quest while this view was kept (a quest on a map card): show
// what it names, like a first visit would: the quest instead of the list, at its top. The list,
// its filters and its scroll position stay (useQuestRoute keeps the filters in the address).
// Coming back through the header tab or back/forward is a return: nothing happens here.
watch(view.arrival, (arrival) => {
  if (arrival?.kind !== 'fresh') return
  listOpen.value = !requestedId.value
  detailScroll.reset()
  arriving = true
  void nextTick(() => {
    arriving = false
  })
})

// Another quest: start reading at the top (main only moves on a switch between views). Move focus
// to its title when it came from the list on a phone, or when the focused link went away
// (a quest chip inside the old detail). Not while another view is on screen.
watch(
  selectedId,
  (id, old) => {
    if (!id || id === old || !view.active.value) return
    detailScroll.reset()
    if (!wide.value && !listOpen.value) view.scrollMain('top')
    const lost = !document.activeElement || document.activeElement === document.body
    if (old && !arriving && (focusNextQuest || lost)) detail.value?.focusTitle()
    focusNextQuest = false
  },
  { flush: 'post' },
)
</script>

<template>
  <div ref="root" class="flex flex-col lg:min-h-0 lg:flex-row">
    <div v-if="!entries.length" class="grid flex-1 place-items-center px-4 py-10">
      <EmptyState
        :icon="ScrollText"
        title="No quests yet"
        text="Quests come from the wiki. Start a sync with the button at the top right to fetch them."
      />
    </div>

    <template v-else>
      <aside
        aria-label="Quest list"
        :class="
          cn(
            'flex-col border-line-dark bg-leather lg:flex lg:w-[21rem] lg:shrink-0 lg:border-r xl:w-[23rem]',
            showList ? 'flex' : 'hidden',
          )
        "
      >
        <QuestList
          ref="list"
          v-model:q="listState.q"
          v-model:status="listState.status"
          :entries="entries"
          :selected-id="selectedId"
          :link-for="questLink"
          @select="onSelect"
          @clear-filters="clearFilters"
        />
      </aside>

      <div
        ref="detailScroller"
        :class="
          cn(
            'min-w-0 flex-1 lg:block lg:overflow-y-auto lg:overscroll-contain',
            'bg-[radial-gradient(120%_60%_at_50%_0%,rgba(201,162,74,0.06),transparent_70%)]',
            showDetail ? 'block' : 'hidden',
            unknownId && 'order-first lg:order-none',
          )
        "
      >
        <div class="mx-auto w-full max-w-[76rem] px-3 pt-3 pb-12 sm:px-6 sm:pt-6 lg:px-8 lg:pt-8">
          <Button v-if="selected" variant="ghost" size="sm" class="mb-3 -ml-1 lg:hidden" @click="backToList">
            <ArrowLeft aria-hidden="true" />
            Back to list
          </Button>

          <QuestDetail v-if="selected" ref="detail" :key="selected.id" :quest="selected" />

          <ParchmentPanel v-else-if="unknownId" shade="deep">
            <EmptyState compact :icon="ScrollText" title="I don't know this quest">
              There's no quest called
              <span class="font-serif text-text-parchment italic">{{ unknownId }}</span>.
              Maybe the wiki names it differently. Pick one from the list.
            </EmptyState>
          </ParchmentPanel>
        </div>
      </div>
    </template>
  </div>
</template>
