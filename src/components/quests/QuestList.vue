<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { SearchX } from 'lucide-vue-next'
import EmptyState from '@/components/common/EmptyState.vue'
import LocationText from '@/components/common/LocationText.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import SectionHeading from '@/components/common/SectionHeading.vue'
import ToggleChip from '@/components/common/ToggleChip.vue'
import { Button } from '@/components/ui/button'
import {
  STATUS_FILTERS,
  buildSections,
  countByStatus,
  countDone,
  filterEntries,
  searchEntries,
  type QuestEntry,
  type StatusFilter,
} from '@/lib/quests-list'
import type { AppQuest, QuestKind } from '@/lib/types'
import { useKeptScroll } from '@/composables/useKeptScroll'
import { useViewRoute } from '@/composables/useViewRoute'
import QuestListRow from './QuestListRow.vue'

/**
 * Left column of the quests view: overall progress, search, status chips and the quest list
 * (main story as a numbered path, side quests by region).
 */
const props = defineProps<{
  /** All quests with progress, in list order. */
  entries: QuestEntry<AppQuest>[]
  selectedId?: string
  linkFor: (questId: string) => RouteLocationRaw
}>()

const q = defineModel<string>('q', { required: true })
const status = defineModel<StatusFilter>('status', { required: true })

const emit = defineEmits<{
  /** A row was clicked (before the route changes). */
  select: [questId: string]
  clearFilters: []
}>()

const searched = computed(() => searchEntries(props.entries, q.value))
const counts = computed(() => countByStatus(searched.value))
const sections = computed(() => buildSections(filterEntries(props.entries, { q: q.value, status: status.value })))
const overall = computed(() => countDone(props.entries))
const filtering = computed(() => !!q.value.trim() || status.value !== 'all')

const kindCount = computed(() => {
  const out = {} as Record<QuestKind, { done: number; total: number }>
  for (const kind of ['primary', 'secondary', 'tertiary'] as const) {
    out[kind] = countDone(props.entries.filter((e) => e.quest.kind === kind))
  }
  return out
})

function setStatus(value: StatusFilter, pressed: boolean) {
  status.value = pressed || value === 'all' ? value : 'all'
}

/** The main story path only makes sense on the full, unfiltered sequence. */
function pathFor(list: QuestEntry<AppQuest>[], i: number, kind: QuestKind) {
  if (kind !== 'primary' || filtering.value) return { above: undefined, below: undefined }
  const cur = list[i]!
  const prev = list[i - 1]
  const next = list[i + 1]
  const ordered = (e: QuestEntry | undefined) => e?.quest.order !== undefined
  return {
    above: ordered(cur) && ordered(prev) ? (prev!.state === 'done' ? 'done' : 'todo') : undefined,
    below: ordered(cur) && ordered(next) ? (cur.state === 'done' ? 'done' : 'todo') : undefined,
  } as const
}

/* The quests view stays alive while another view is on screen: nothing here may react then. */
const view = useViewRoute()

/* Keyboard: arrows move between rows, '/' jumps to the search field. */
const navEl = ref<HTMLElement | null>(null)
const search = ref<InstanceType<typeof SearchInput> | null>(null)

// The list scrolls on its own from lg up: it is back at the same spot when the view returns.
useKeptScroll(navEl)

function rows(): HTMLElement[] {
  return navEl.value ? [...navEl.value.querySelectorAll<HTMLElement>('[data-quest-row]')] : []
}

function onNavKeydown(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const all = rows()
  if (!all.length) return
  const i = all.indexOf(document.activeElement as HTMLElement)
  let next = i
  if (event.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(all.length - 1, i + 1)
  if (event.key === 'ArrowUp') next = i < 0 ? 0 : Math.max(0, i - 1)
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = all.length - 1
  event.preventDefault()
  all[next]?.focus()
}

function onWindowKeydown(event: KeyboardEvent) {
  // The listener stays on the window while the map or the collections are shown.
  if (!view.active.value) return
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
  if (!navEl.value?.offsetParent) return
  event.preventDefault()
  search.value?.focus()
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

const searchField = () => (search.value?.$el as HTMLElement | undefined)?.querySelector<HTMLInputElement>('input')

function selectedRow(): HTMLElement | undefined {
  return rows().find((el) => el.dataset.questId === props.selectedId)
}

/**
 * Keep the selected quest in view when the list scrolls on its own (wide screens), e.g. after
 * following a link. On phones the page scrolls, and jumping it around would lose the filters.
 */
function revealSelected() {
  const nav = navEl.value
  if (!view.active.value || !nav?.isConnected || getComputedStyle(nav).overflowY !== 'auto') return
  // 'nearest' leaves the list alone when the row is in view already.
  selectedRow()?.scrollIntoView?.({ block: 'nearest' })
}
watch(
  () => props.selectedId,
  () => void nextTick(revealSelected),
  { flush: 'post' },
)
onMounted(revealSelected)
// Back on screen. A return leaves the list exactly where it was. A link from another view that
// names a quest keeps the list position too and only scrolls when that quest is out of view.
// A tick later: the list gets its position back in an activation hook as well (useKeptScroll),
// and hooks of one component do not run in the order they were registered. Still before the paint.
onActivated(() => {
  const arrival = view.arrival.value
  if (arrival?.kind === 'fresh' && !arrival.first) void nextTick(revealSelected)
})

defineExpose({
  /**
   * Focuses the selected row (or the search field when it is filtered out). `reveal` says how
   * the row is scrolled into view: to the middle, only when it is out of view ('nearest'), or
   * not at all (false: the caller put the list where it should be).
   */
  focusSelected(reveal: 'center' | 'nearest' | false = 'center') {
    const row = selectedRow()
    if (row) {
      if (reveal) row.scrollIntoView?.({ block: reveal })
      row.focus({ preventScroll: true })
    } else if (reveal === 'center') search.value?.focus()
    else searchField()?.focus({ preventScroll: true })
  },
})
</script>

<template>
  <div class="flex flex-col lg:min-h-0 lg:flex-1">
    <div class="shrink-0 space-y-4 border-b border-line-dark px-4 pt-5 pb-4 sm:px-5">
      <ProgressBar
        size="md"
        tone="dark"
        label="Progress"
        :value="overall.total ? overall.done / overall.total : 0"
        :detail="`${overall.done} / ${overall.total} done`"
      />
      <SearchInput ref="search" v-model="q" tone="dark" placeholder="Search by name, region or place" />
      <div role="group" aria-label="Filter by status" class="flex flex-wrap gap-2">
        <ToggleChip
          v-for="f in STATUS_FILTERS"
          :key="f.value"
          tone="dark"
          :pressed="status === f.value"
          :count="counts[f.value]"
          @update:pressed="setStatus(f.value, $event)"
        >
          {{ f.label }}
        </ToggleChip>
      </div>
    </div>

    <nav
      ref="navEl"
      aria-label="Quests"
      class="px-2 pt-4 pb-8 sm:px-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain"
      @keydown="onNavKeydown"
    >
      <section v-for="section in sections" :key="section.kind" :aria-labelledby="`quest-section-${section.kind}`" class="mb-6 last:mb-0">
        <SectionHeading
          :id="`quest-section-${section.kind}`"
          :title="section.title"
          :count="`${kindCount[section.kind].done} / ${kindCount[section.kind].total}`"
          tone="dark"
          class="mb-1 px-2"
        />
        <template v-for="group in section.groups" :key="group.key">
          <LocationText
            v-if="group.label"
            as="h3"
            tone="dark"
            lang="en"
            class="block px-2 pt-3 pb-1 text-[0.95rem] text-muted-light"
          >
            {{ group.label }}
          </LocationText>
          <component :is="section.kind === 'primary' ? 'ol' : 'ul'" class="flex flex-col" role="list">
            <li v-for="(entry, i) in group.entries" :key="entry.quest.id">
              <QuestListRow
                :entry="entry"
                :to="linkFor(entry.quest.id)"
                :selected="entry.quest.id === selectedId"
                :numbered="section.kind === 'primary'"
                :path-above="pathFor(group.entries, i, section.kind).above"
                :path-below="pathFor(group.entries, i, section.kind).below"
                @select="emit('select', $event)"
              />
            </li>
          </component>
        </template>
      </section>

      <EmptyState
        v-if="!sections.length"
        compact
        tone="dark"
        :icon="SearchX"
        title="Nothing found"
        text="No quest matches your search or filter."
      >
        <template #action>
          <Button variant="outline" size="sm" tone="dark" @click="emit('clearFilters')">Clear filters</Button>
        </template>
      </EmptyState>
    </nav>
  </div>
</template>
