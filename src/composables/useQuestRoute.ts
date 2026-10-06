// Route state of the quests view: the selected quest from /quests/:questId, the list filters
// in ?q= and ?status=, the default quest when the URL has none, and links that keep the filters.
//
// The view stays alive while another view is on screen, so everything here reads the view's own
// route (useViewRoute): it keeps its last value while the map or the collections are shown, and
// nothing is written to the address from a view that is not on screen.

import { computed, reactive, watch, type ComputedRef } from 'vue'
import type { LocationQuery, RouteLocationRaw } from 'vue-router'
import { pickDefaultQuestId, type QuestEntry } from '@/lib/quests-list'
import {
  listStateQuery,
  paramValue,
  questPath,
  readArrivalListState,
  readListState,
  resolveQuestId,
  type QuestListState,
} from '@/lib/quests-route'
import type { AppQuest } from '@/lib/types'
import { useViewRoute } from './useViewRoute'

/** Link to a quest that keeps the current list filters. Works anywhere inside the quests view. */
export function useQuestLink(): (questId: string) => RouteLocationRaw {
  const { route } = useViewRoute()
  return (questId) => ({ path: questPath(questId), query: listStateQuery(readListState(route.query)) })
}

function sameQuery(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false
  return true
}

export function useQuestRoute(options: {
  entries: ComputedRef<QuestEntry<AppQuest>[]>
  /** True once data and progress are in, so the default pick sees the real progress. */
  canPickDefault: ComputedRef<boolean>
}): {
  /** The raw :questId param, if any. */
  requestedId: ComputedRef<string | undefined>
  /** The quest id the URL resolves to. */
  selectedId: ComputedRef<string | undefined>
  /** Set when the URL names a quest that does not exist. */
  unknownId: ComputedRef<string | undefined>
  /** List filters, two-way bound to the URL query. */
  listState: QuestListState
  questLink: (questId: string) => RouteLocationRaw
  clearFilters: () => void
} {
  const view = useViewRoute()
  const route = view.route

  const requestedId = computed(() => paramValue(route.params.questId as string | string[] | undefined))
  const ids = computed(() => options.entries.value.map((e) => e.quest.id))
  const selectedId = computed(() => resolveQuestId(requestedId.value, ids.value))
  const unknownId = computed(() =>
    requestedId.value && ids.value.length && !selectedId.value ? requestedId.value : undefined,
  )

  const listState = reactive<QuestListState>(readListState(route.query))

  function questLink(questId: string): RouteLocationRaw {
    return { path: questPath(questId), query: listStateQuery(listState) }
  }

  /** The query that has been taken over into the list filters. */
  let readQuery: LocationQuery = route.query
  /** The last switch to this view that has been handled. The one that created the view needs nothing. */
  let seenArrival = view.arrival.value?.seq ?? 0

  /**
   * URL to state: back and forward, links with filters. A link from another view (a quest on a
   * map card) says nothing about the list, so there the filters stay as they were and only what
   * the link names itself is taken over. Coming back to where the view was left changes nothing.
   */
  function readUrl() {
    const arrival = view.arrival.value
    const fresh = !!arrival && arrival.seq !== seenArrival && arrival.kind === 'fresh'
    if (arrival) seenArrival = arrival.seq
    const query = route.query
    if (!fresh && query === readQuery) return
    readQuery = query
    const next = fresh ? readArrivalListState(query, listState) : readListState(query)
    if (next.q !== listState.q) listState.q = next.q
    if (next.status !== listState.status) listState.status = next.status
  }

  /**
   * The quest the address should name instead: the default one when it has none, the exact id
   * after a loose match. `gone`: the view came back to a quest that a sync removed or renamed in
   * the meantime; that gets the default quest too, like the Quests tab always did, instead of
   * 'Deze quest ken ik niet' (which stays for an address that was asked for).
   */
  function questToWrite(gone = false): string | undefined {
    if (!requestedId.value || gone) return options.canPickDefault.value ? pickDefaultQuestId(options.entries.value) : undefined
    return selectedId.value && selectedId.value !== requestedId.value ? selectedId.value : undefined
  }

  /** The write that is on its way: asking for the same one again would only cancel it. */
  let writing: string | null = null

  /** Never a push: the address follows the state without adding history entries. */
  function replace(to: RouteLocationRaw) {
    const key = `${route.fullPath} > ${JSON.stringify(to)}`
    if (writing === key) return
    writing = key
    void view.replace(to).finally(() => {
      if (writing === key) writing = null
    })
  }

  /** State to URL. */
  function writeUrl(gone = false) {
    const id = questToWrite(gone)
    if (id) return replace(questLink(id))
    const rest: LocationQuery = { ...route.query }
    delete rest.q
    delete rest.status
    const query = { ...rest, ...listStateQuery(listState) }
    if (!sameQuery(query, route.query)) replace({ query })
  }

  // One watcher for both directions, so the order is fixed: first take in what the address says,
  // then bring the address in line. Only while the view is on screen. Becoming active is a source
  // too: what could not be written while the view was away (progress that came in, so the default
  // quest can be picked) is written then; coming back to a complete address writes nothing.
  watch(
    [
      () => route.query,
      view.arrival,
      view.active,
      requestedId,
      selectedId,
      ids,
      options.canPickDefault,
      () => listState.q,
      () => listState.status,
    ],
    () => {
      if (!view.active.value) return
      const arrival = view.arrival.value
      const returned = !!arrival && arrival.seq !== seenArrival && arrival.kind === 'return'
      readUrl()
      writeUrl(returned && !!unknownId.value)
    },
  )

  // On the way in only the quest: no quest in the URL opens the default one.
  if (view.active.value) {
    const id = questToWrite()
    if (id) replace(questLink(id))
  }

  function clearFilters() {
    listState.q = ''
    listState.status = 'all'
  }

  return { requestedId, selectedId, unknownId, listState, questLink, clearFilters }
}
