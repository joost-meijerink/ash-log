// @vitest-environment jsdom
// The three real views together under the real shell (App.vue, AppHeader, <KeepAlive>). The other
// suites each take one real view and stand-ins for the other two; here a real link in one view
// lands in another real view that was kept: 'Show on map', a map card into Collections, the
// header tabs, back and forward. Plus a seeded random walk: after every step the address, the
// view memory and what is on screen must agree.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import App from '@/App.vue'
import { L } from '@/components/map/leaflet'
import { api } from '@/lib/api'
import { emptyOverrides, emptyProgress } from '@/lib/normalize'
import type { AppData, AppQuest, MapCategory, MapPoint, Reward, Vault } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { TAB_REPEAT_MS, useViewMemoryStore, type ViewName } from '@/stores/viewMemory'
import CollectionsView from '@/views/CollectionsView.vue'
import MapView from '@/views/MapView.vue'
import QuestsView from '@/views/QuestsView.vue'

vi.mock('@/lib/api', () => ({
  api: {
    data: vi.fn(),
    progress: vi.fn(),
    saveProgress: vi.fn(async (p: unknown) => p),
    saveOverrides: vi.fn(),
    startSync: vi.fn(),
    syncStatus: vi.fn(),
    serverStatus: vi.fn(async () => ({ mode: 'dev', local: true, live: false, port: 5173, urls: [] })),
  },
}))

const LORE = 'lore-scraps:29118:156991'
const VAULT = 'vaults:37482:191753'
const BOOK = 'recipe-books:201455:34717'

const categories: MapCategory[] = [
  { id: 'vaults', label: 'Vaults', group: 'vault', sources: [], count: 1, wikiPage: 'Vaults' },
  { id: 'lore-scraps', label: 'Lore Scraps', group: 'lore', sources: [], count: 1, wikiPage: 'Lore Scraps' },
  { id: 'treasure-chest', label: 'Treasure Chest', group: 'chest', sources: [], count: 2 },
  { id: 'vannaka', label: 'Vannaka', group: 'npc', sources: [], count: 1, wikiPage: 'Vannaka' },
  { id: 'recipe-books', label: 'Recipe Books', group: 'unique', sources: [], count: 1 },
]

const points: MapPoint[] = [
  { id: VAULT, categoryId: 'vaults', x: 37482, y: 191753, region: 'Brynmoor', description: 'The location of the Takla Kara vault' },
  { id: LORE, categoryId: 'lore-scraps', x: 29118, y: 156991, name: 'Scrawled Diary Page', region: 'Brynmoor' },
  { id: 'treasure-chest:10786:169394', categoryId: 'treasure-chest', x: 10786, y: 169394, power: 2, region: 'Brynmoor' },
  { id: 'treasure-chest:103571:-47340', categoryId: 'treasure-chest', x: 103571, y: -47340, power: 5, region: 'Fellhollow' },
  { id: 'vannaka:15183:178853', categoryId: 'vannaka', x: 15183, y: 178853, region: 'Brynmoor' },
  { id: BOOK, categoryId: 'recipe-books', x: 201455, y: 34717 },
]

const vaults: Vault[] = [
  {
    id: 'Takla Kara',
    name: 'Takla Kara',
    order: 1,
    power: 2,
    area: 'Temple Woods',
    region: 'Brynmoor',
    recipes: [{ name: "Paladin's helm", set: 'Paladin armour set' }],
    pointId: VAULT,
  },
]

/** The recipe book point holds unlocks of two kinds: its card links to all kinds. */
const rewards: Reward[] = [
  { id: 'vestige:wooden-training-sword', kind: 'vestige', name: 'Wooden Training Sword', recipe: 'An Educational Blade', group: 'Brynmoor' },
  { id: 'quest:anti-dragon-shield', kind: 'quest', name: 'Anti-Dragon Shield', requirement: 'x', questId: 'Ratcatcher' },
  { id: 'effigy:paladins-helm', kind: 'effigy', name: "Paladin's Helm", group: 'Ghornfell', set: 'Paladin armour set', vaultId: 'Takla Kara' },
  { id: 'recipe-book:meat-sandwich', kind: 'recipe-book', name: 'Meat Sandwich', pointIds: [BOOK] },
  { id: 'effigy:meat-idol', kind: 'effigy', name: 'Meat Idol', pointIds: [BOOK] },
]

function quest(id: string, extra: Partial<AppQuest> = {}): AppQuest {
  return {
    id,
    name: id,
    kind: 'primary',
    location: 'Speak to Vannaka south of the Windmill.',
    steps: [
      { id: `${id}:s:1`, text: 'Do the first thing.' },
      { id: `${id}:s:2`, text: 'Do the second thing.' },
    ],
    stepsSource: 'walkthrough',
    items: [],
    rewards: [],
    requires: [],
    wikiUrl: '',
    itemsOverridden: false,
    ...extra,
  }
}

const QUESTS: AppQuest[] = [
  quest('Ratcatcher', {
    order: 1,
    startPointId: 'vannaka:15183:178853',
    start: { x: 15183, y: 178853, pointId: 'vannaka:15183:178853', source: 'wiki' },
  }),
  quest('First Steps', { order: 2, start: { x: 29118, y: 156991, source: 'wiki' } }),
  quest('Mirror, Mirror', { kind: 'secondary', order: 1, region: 'Fellhollow' }),
]

function appData(over: Partial<AppData> = {}): AppData {
  return {
    ready: true,
    meta: {
      syncedAt: '2026-09-28T12:00:00Z',
      durationMs: 1,
      domains: [],
      counts: { categories: categories.length, points: points.length, quests: QUESTS.length, vaults: 1, rewards: rewards.length },
      revisions: {},
    },
    map: { categories, points },
    quests: QUESTS,
    vaults,
    rewards,
    overrides: emptyOverrides(),
    ...over,
  }
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/quests' },
      { path: '/quests/:questId?', name: 'quests', component: QuestsView },
      { path: '/map', name: 'map', component: MapView },
      { path: '/collections', name: 'collections', component: CollectionsView },
      { path: '/:pathMatch(.*)*', redirect: '/quests' },
    ],
  })
}

/** From lg up the views show their columns side by side; jsdom has no matchMedia at all. */
function screen(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && /min-width: (1024|640)px/.test(query),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }))
}

let mounted: VueWrapper[] = []

interface Mounted {
  wrapper: VueWrapper
  router: Router
  main: HTMLElement
  /** router.replace and router.push calls since the last reset(). */
  replaced: () => string[]
  pushed: () => string[]
  reset: () => void
}

async function mountApp(path: string): Promise<Mounted> {
  vi.mocked(api.data).mockImplementation(async () => appData())
  vi.mocked(api.progress).mockImplementation(async () => emptyProgress())
  vi.mocked(api.syncStatus).mockResolvedValue({ running: false, log: [] })
  const router = testRouter()
  // As in main.ts: the memory follows the router from before its first navigation.
  useViewMemoryStore().attach(router)
  await router.push(path)
  const calls = { replace: [] as string[], push: [] as string[] }
  for (const kind of ['replace', 'push'] as const) {
    const real = router[kind].bind(router)
    vi.spyOn(router, kind).mockImplementation((to) => {
      calls[kind].push(router.resolve(to).fullPath)
      return real(to)
    })
  }
  const wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  await flushPromises()
  return {
    wrapper,
    router,
    main: wrapper.get('main').element as HTMLElement,
    replaced: () => [...calls.replace],
    pushed: () => [...calls.push],
    reset: () => {
      calls.replace = []
      calls.push = []
    },
  }
}

const tabOf = (wrapper: VueWrapper, label: string) =>
  wrapper.findAll('nav[aria-label="Main menu"] a').filter((a) => a.text() === label)[0]!

async function clickTab(wrapper: VueWrapper, label: string) {
  await tabOf(wrapper, label).trigger('click')
  await flushPromises()
  await flushPromises()
}

const linkWith = (wrapper: VueWrapper, text: string) => wrapper.findAll('main a').filter((a) => a.text().includes(text))[0]!

async function clickLink(wrapper: VueWrapper, text: string) {
  await linkWith(wrapper, text).trigger('click')
  await flushPromises()
  await flushPromises()
}

const at = (router: Router) => router.currentRoute.value.fullPath
const questSearch = (wrapper: VueWrapper) => wrapper.get('aside[aria-label="Quest list"] input[type="search"]')
const mapSearch = (wrapper: VueWrapper) => wrapper.get('#map-filters input[type="search"]')
const unlockSearch = (wrapper: VueWrapper) => wrapper.get('#unlocks input[type="search"]')
const valueOf = (field: { element: Element }) => (field.element as HTMLInputElement).value
const unlocks = (wrapper: VueWrapper) => wrapper.findAll('#unlocks [data-slot="check-row"]').map((row) => row.text())
const kindChip = (wrapper: VueWrapper, label: string) =>
  wrapper.findAll('[aria-label="Kind of unlock"] [data-slot="toggle-chip"]').find((chip) => chip.text().startsWith(label))!

/** Time passes: a click on the tab of the view you are on is a click of its own again. */
function later() {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + TAB_REPEAT_MS + 1)
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  Element.prototype.scrollIntoView = function () {}
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the three views under the shell: the header tabs', () => {
  beforeEach(() => screen(true))

  it('go back to where each view was left, and the views write nothing on the way', async () => {
    const { wrapper, router, replaced, pushed, reset } = await mountApp('/quests/Ratcatcher')
    await questSearch(wrapper).setValue('rat')
    await flushPromises()
    expect(at(router)).toBe('/quests/Ratcatcher?q=rat')
    await clickTab(wrapper, 'Map')
    expect(at(router)).toBe('/map')
    await clickTab(wrapper, 'Collections')
    await kindChip(wrapper, 'Vestiges').trigger('click')
    await unlockSearch(wrapper).setValue('sword')
    await flushPromises()
    expect(at(router)).toBe('/collections?kind=vestige')
    reset()

    await clickTab(wrapper, 'Quests')
    expect(at(router)).toBe('/quests/Ratcatcher?q=rat')
    expect(valueOf(questSearch(wrapper))).toBe('rat')
    await clickTab(wrapper, 'Map')
    await clickTab(wrapper, 'Collections')
    expect(at(router)).toBe('/collections?kind=vestige')
    expect(valueOf(unlockSearch(wrapper))).toBe('sword')
    expect(useViewMemoryStore().arrival).toMatchObject({ view: 'collections', kind: 'return', via: 'tab' })
    // Also not a little later (the map writes its search text after 300 ms).
    await new Promise((resolve) => setTimeout(resolve, 350))
    await flushPromises()
    expect(replaced()).toEqual([])
    expect(pushed()).toEqual(['/quests/Ratcatcher?q=rat', '/map', '/collections?kind=vestige'])
  })

  it('a double click on the tab of another view still ends where that view was left', async () => {
    const { wrapper, router } = await mountApp('/quests/Mirror%2C%20Mirror')
    await questSearch(wrapper).setValue('mir')
    await flushPromises()
    const left = at(router)
    await clickTab(wrapper, 'Map')

    await clickTab(wrapper, 'Quests')
    expect(at(router)).toBe(left)
    // The second click of the same gesture: the tab links to the base path by now.
    expect(tabOf(wrapper, 'Quests').attributes('href')).toBe('/quests')
    tabOf(wrapper, 'Quests').element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }))
    await flushPromises()
    await flushPromises()
    expect(at(router)).toBe(left)
    expect(valueOf(questSearch(wrapper))).toBe('mir')
    expect(wrapper.get('h1').text()).toBe('Mirror, Mirror')

    // A click of its own, later: the tab of the view you are on, as always.
    later()
    await clickTab(wrapper, 'Quests')
    expect(at(router)).toBe('/quests/Ratcatcher')
    expect(valueOf(questSearch(wrapper))).toBe('')
  })
})

describe('the three views under the shell: links from one view into another', () => {
  beforeEach(() => screen(true))

  it("'Show on map' flies there, back and forward are returns, and the same link again flies again", async () => {
    const { wrapper, router, replaced, reset } = await mountApp('/quests/Ratcatcher')
    const memory = useViewMemoryStore()
    const flyTo = vi.spyOn(L.Map.prototype, 'flyTo')
    await clickLink(wrapper, 'Show on map')
    expect(at(router)).toBe('/map?quest=Ratcatcher')
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'fresh', first: true })
    expect(wrapper.find('#map-filters').exists()).toBe(true)
    expect(wrapper.get('article').text()).toContain('Ratcatcher')
    flyTo.mockClear()

    router.back()
    await flushPromises()
    expect(at(router)).toBe('/quests/Ratcatcher')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'return', via: 'history' })
    router.forward()
    await flushPromises()
    expect(at(router)).toBe('/map?quest=Ratcatcher')
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'return', via: 'history' })
    expect(flyTo).not.toHaveBeenCalled()

    router.back()
    await flushPromises()
    reset()
    await clickLink(wrapper, 'Show on map')
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'fresh', via: 'link', first: false })
    expect(flyTo).toHaveBeenCalledTimes(1)
    expect(replaced()).toEqual([])
  })

  it('a quest on a map card opens that quest and keeps the list filter of the quests view', async () => {
    const { wrapper, router } = await mountApp('/quests/Mirror%2C%20Mirror')
    await questSearch(wrapper).setValue('r')
    await flushPromises()
    await clickTab(wrapper, 'Map')
    await router.push('/map?quest=Ratcatcher')
    await flushPromises()

    const open = wrapper.findAll('main a').filter((a) => (a.attributes('href') ?? '').startsWith('/quests/'))[0]!
    await open.trigger('click')
    await flushPromises()
    await flushPromises()
    expect(at(router)).toBe('/quests/Ratcatcher?q=r')
    expect(wrapper.get('h1').text()).toBe('Ratcatcher')
    expect(valueOf(questSearch(wrapper))).toBe('r')

    // The map is still where it was: its tab goes back to the quest card.
    await clickTab(wrapper, 'Map')
    expect(at(router)).toBe('/map?quest=Ratcatcher')
    expect(wrapper.get('article').text()).toContain('Ratcatcher')
  })

  it('search text typed on the map just before a link away is there after going back, and the address follows with a replace', async () => {
    const { wrapper, router, replaced, pushed, reset } = await mountApp('/map?quest=Ratcatcher')
    await mapSearch(wrapper).setValue('diary')
    const open = wrapper.findAll('main a').filter((a) => (a.attributes('href') ?? '').startsWith('/quests/'))[0]!
    await open.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('quests')
    const questsAt = at(router)
    reset()
    // The debounced write of the map falls while it is away: nothing happens.
    await new Promise((resolve) => setTimeout(resolve, 400))
    await flushPromises()
    expect(at(router)).toBe(questsAt)
    expect(replaced()).toEqual([])

    router.back()
    await flushPromises()
    await flushPromises()
    expect(useViewMemoryStore().arrivals.map).toMatchObject({ kind: 'return', via: 'history' })
    expect(valueOf(mapSearch(wrapper))).toBe('diary')
    expect(router.currentRoute.value.query).toMatchObject({ q: 'diary', quest: 'Ratcatcher' })
    expect(pushed()).toEqual([])
  })

  it('a vault on a map card goes to that vault and keeps kind, hide switch and search text', async () => {
    const { wrapper, router } = await mountApp('/collections')
    await kindChip(wrapper, 'Vestiges').trigger('click')
    await wrapper.get('#hide-owned').trigger('click')
    await unlockSearch(wrapper).setValue('sword')
    await flushPromises()
    await clickTab(wrapper, 'Map')
    await router.push(`/map?focus=${VAULT}`)
    await flushPromises()

    await clickLink(wrapper, 'View in Collections')
    expect(at(router)).toBe('/collections?kind=vestige&hide=1#vault-takla-kara')
    expect(document.activeElement?.id).toBe('vault-takla-kara')
    expect(valueOf(unlockSearch(wrapper))).toBe('sword')
    expect(unlocks(wrapper)).toHaveLength(1)
  })

  it("'View in Unique unlocks' shows the unlocks of the point, whatever the list was narrowed to before", async () => {
    const { wrapper, router } = await mountApp('/collections')
    // Narrowed to something else: a kind, a search text and the hide switch.
    await kindChip(wrapper, 'Vestiges').trigger('click')
    await wrapper.get('#hide-owned').trigger('click')
    await unlockSearch(wrapper).setValue('sword')
    await flushPromises()
    expect(unlocks(wrapper)).toHaveLength(1)
    await clickTab(wrapper, 'Map')
    await router.push(`/map?focus=${BOOK}`)
    await flushPromises()

    // Unlocks of two kinds at this point: the link asks for all kinds.
    expect(linkWith(wrapper, 'View in Unique unlocks').attributes('href')).toBe('/collections?kind=all#unlocks')
    await clickLink(wrapper, 'View in Unique unlocks')
    expect(useViewMemoryStore().arrival).toMatchObject({ view: 'collections', kind: 'fresh', via: 'link', first: false })
    expect(at(router)).toBe('/collections#unlocks')
    expect(valueOf(unlockSearch(wrapper))).toBe('')
    expect(wrapper.get('#hide-owned').attributes('aria-checked')).toBe('false')
    expect(unlocks(wrapper).some((text) => text.includes('Meat Sandwich'))).toBe(true)
    expect(unlocks(wrapper).some((text) => text.includes('Meat Idol'))).toBe(true)
    expect(document.activeElement?.id).toBe('unlocks')
  })
})

describe('the three views under the shell: a sync while a view is away', () => {
  beforeEach(() => screen(true))

  it('a point and a quest that are gone do not come back with the tab: the map drops the card, quests opens another quest', async () => {
    const { wrapper, router } = await mountApp(`/map?focus=${LORE}`)
    expect(wrapper.get('article').text()).toContain('Scrawled Diary Page')
    await clickTab(wrapper, 'Quests')
    expect(at(router)).toBe('/quests/Ratcatcher')
    await clickTab(wrapper, 'Collections')

    useDataStore().data = appData({
      map: { categories, points: points.filter((p) => p.id !== LORE) },
      quests: [...QUESTS.filter((q) => q.id !== 'Ratcatcher'), quest('Brand New', { order: 1 })],
    })
    await flushPromises()
    expect(at(router)).toBe('/collections')

    await clickTab(wrapper, 'Map')
    expect(router.currentRoute.value.query.focus).toBeUndefined()
    expect(wrapper.find('article').exists()).toBe(false)
    await clickTab(wrapper, 'Quests')
    expect(at(router)).toBe('/quests/Brand%20New')
    expect(wrapper.text()).not.toContain("I don't know this quest")
    expect(wrapper.get('h1').text()).toBe('Brand New')
  })
})

/* ------------------------------------------------------------------ */
/* Random walks                                                        */
/* ------------------------------------------------------------------ */

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The query keys each view may have in its address: a key of another view is a leak. */
const OWN_KEYS: Record<ViewName, string[]> = {
  quests: ['q', 'status'],
  map: ['c', 'p', 'ps', 'r', 'q', 'h', 'qs', 'focus', 'quest', 'pin'],
  collections: ['kind', 'hide'],
}
const STATUS: Record<string, string> = { All: '', 'Not started': 'open', 'In progress': 'active', Done: 'done' }

interface Step {
  name: string
  run: () => unknown
}

/** Everything a user could do now. Nothing here ticks a box: the walk is about navigation. */
function stepsFrom(wrapper: VueWrapper, router: Router, rand: () => number): Step[] {
  const out: Step[] = []
  const name = router.currentRoute.value.name as ViewName
  for (const label of ['Quests', 'Map', 'Collections']) out.push({ name: `tab:${label}`, run: () => tabOf(wrapper, label).trigger('click') })
  out.push({ name: 'back', run: () => router.back() })
  out.push({ name: 'forward', run: () => router.forward() })
  out.push({
    name: 'reload-data',
    run: () => {
      useDataStore().data = appData()
    },
  })
  const words = ['', 'a', 'rat', 'mir', 'vault', 'sw']
  const word = () => words[Math.floor(rand() * words.length)]!
  const links = (to: RegExp) => wrapper.findAll('main a').filter((a) => to.test(a.attributes('href') ?? ''))
  if (name === 'quests') {
    const text = word()
    out.push({ name: `q.search:${text}`, run: () => questSearch(wrapper).setValue(text) })
    for (const chip of wrapper.findAll('aside[aria-label="Quest list"] [role="group"] button[aria-pressed]')) {
      out.push({ name: `q.chip:${chip.text()}`, run: () => chip.trigger('click') })
    }
    for (const row of wrapper.findAll('[data-quest-id]')) out.push({ name: `q.row:${row.attributes('data-quest-id')}`, run: () => row.trigger('click') })
    for (const a of links(/^\/(map|collections)/)) out.push({ name: `q.link:${a.attributes('href')}`, run: () => a.trigger('click') })
  }
  if (name === 'map') {
    const text = word()
    out.push({ name: `m.search:${text}`, run: () => mapSearch(wrapper).setValue(text) })
    for (const a of links(/^\/(quests|collections)/)) out.push({ name: `m.link:${a.attributes('href')}`, run: () => a.trigger('click') })
    out.push({ name: 'm.focus-book', run: () => router.push(`/map?focus=${BOOK}`) })
    out.push({ name: 'm.focus-vault', run: () => router.push(`/map?focus=${VAULT}`) })
    out.push({ name: 'm.quest', run: () => router.push('/map?quest=Ratcatcher') })
  }
  if (name === 'collections') {
    for (const chip of wrapper.findAll('[aria-label="Kind of unlock"] [data-slot="toggle-chip"]')) {
      out.push({ name: `c.kind:${chip.text()}`, run: () => chip.trigger('click') })
    }
    out.push({ name: 'c.hide', run: () => wrapper.get('#hide-owned').trigger('click') })
    const text = word()
    out.push({ name: `c.search:${text}`, run: () => unlockSearch(wrapper).setValue(text) })
    for (const a of links(/^\/(quests|map)/)) out.push({ name: `c.link:${a.attributes('href')}`, run: () => a.trigger('click') })
    for (const a of links(/^#/)) out.push({ name: `c.anchor:${a.attributes('href')}`, run: () => a.trigger('click') })
  }
  return out
}

/** What does not add up. `settled`: the debounced writes have landed, so the fields match the address too. */
function problems(wrapper: VueWrapper, router: Router, settled: boolean): string[] {
  const out: string[] = []
  const memory = useViewMemoryStore()
  const route = router.currentRoute.value
  const name = route.name as ViewName
  if (memory.active !== name) out.push(`active ${memory.active} != ${name}`)
  if (memory.locations[name] !== route.fullPath) out.push(`remembered ${memory.locations[name]} != ${route.fullPath}`)
  for (const key of Object.keys(route.query)) if (!OWN_KEYS[name].includes(key)) out.push(`foreign key ${key} on ${name}: ${route.fullPath}`)
  const inPage: Record<ViewName, boolean> = {
    quests: wrapper.find('aside[aria-label="Quest list"]').exists(),
    map: wrapper.find('#map-filters').exists(),
    collections: wrapper.find('#unlocks').exists(),
  }
  for (const [view, on] of Object.entries(inPage)) if (on !== (view === name)) out.push(`view ${view} in page: ${on}, while on ${name}`)
  if (document.body.querySelectorAll('[role="tooltip"], [role="dialog"]').length) out.push('an overlay is left in the body')
  if (!settled || out.length) return out

  if (name === 'quests') {
    const q = valueOf(questSearch(wrapper))
    if (q.trim() !== String(route.query.q ?? '').trim()) out.push(`quests search '${q}' != address '${route.query.q ?? ''}'`)
    const on = wrapper
      .findAll('aside[aria-label="Quest list"] [role="group"] button[aria-pressed="true"]')
      .map((chip) => STATUS[chip.text().replace(/\d+$/, '').trim()])
    if (on.length !== 1 || on[0] !== String(route.query.status ?? '')) out.push(`quests status ${JSON.stringify(on)} != address '${route.query.status ?? ''}'`)
    const id = route.params.questId as string
    if (!id) out.push('quests: no quest in the address')
    else if (wrapper.get('h1').text() !== id) out.push(`quests shows '${wrapper.get('h1').text()}', the address names '${id}'`)
  }
  if (name === 'map') {
    const q = valueOf(mapSearch(wrapper))
    if (q.trim() !== String(route.query.q ?? '').trim()) out.push(`map search '${q}' != address '${route.query.q ?? ''}'`)
    const state = !!(route.query.focus || route.query.quest)
    if (wrapper.find('#map-card-title').exists() !== state && wrapper.findAll('main article').length > 0 !== state) out.push(`map card does not match ${route.fullPath}`)
  }
  if (name === 'collections') {
    const on = wrapper.findAll('[aria-label="Kind of unlock"] [data-slot="toggle-chip"][aria-pressed="true"]').map((chip) => chip.text())
    const kind = String(route.query.kind ?? '')
    if (on.length !== 1 || (kind === '') !== on[0]!.startsWith('All')) out.push(`collections kind ${JSON.stringify(on)} != address '${kind}'`)
    const hide = wrapper.get('#hide-owned').attributes('aria-checked') === 'true'
    if (hide !== (route.query.hide === '1')) out.push(`collections hide ${hide} != address '${route.query.hide}'`)
  }
  return out
}

describe('the three views under the shell: random walks', () => {
  const SEEDS = 16
  const STEPS = 30
  const STARTS = ['/quests', '/map', '/collections', '/quests/Ratcatcher?q=rat', '/map?quest=Ratcatcher', '/collections?kind=vestige#unlocks']

  it.each([true, false])('keep the address, the memory and the screen in step (wide screen: %s)', async (wide) => {
    const failures: string[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
      setActivePinia(createPinia())
      document.body.innerHTML = ''
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      screen(wide)
      const rand = rng(seed)
      /** Lets pending timers and navigations land; `ms` on top for the debounced writes. */
      const settle = async (ms = 0) => {
        await flushPromises()
        await vi.advanceTimersByTimeAsync(1 + ms)
        await flushPromises()
        await vi.advanceTimersByTimeAsync(1)
        await flushPromises()
      }
      const app = await mountApp(STARTS[Math.floor(rand() * STARTS.length)]!)
      const { wrapper, router } = app
      const memory = useViewMemoryStore()
      await settle(400)
      const trail = [`start ${at(router)}`]
      let bad: string[] = []
      for (let i = 0; i < STEPS && !bad.length; i++) {
        const options = stepsFrom(wrapper, router, rand)
        const step = options[Math.floor(rand() * options.length)]!
        const before = memory.arrival?.seq ?? 0
        app.reset()
        await step.run()
        // Half of the steps follow at once (a second click lands within the double click time),
        // the others after a while.
        const wait = rand() < 0.5
        await settle(wait ? TAB_REPEAT_MS + 100 : 0)
        trail.push(`${step.name}${wait ? ' +wait' : ''} -> ${at(router)}`)
        // On a phone the quest list and the quest take turns, so only the wide screen is read in full.
        bad = problems(wrapper, router, wait && wide)
        const arrival = memory.arrival
        if (arrival && arrival.seq !== before && arrival.kind === 'return') {
          const now = router.currentRoute.value
          const was = router.resolve(arrival.fullPath)
          // The one thing a return may add: the map's search text that was typed just before
          // leaving (its filters are then written out in full, where the defaults have no params).
          const selection = ['focus', 'quest', 'pin']
          const rest = (query: Record<string, unknown>) =>
            JSON.stringify(Object.entries(query).filter(([key]) => arrival.view !== 'map' || selection.includes(key)).sort())
          if (was.path !== now.path || was.hash !== now.hash || rest(was.query) !== rest(now.query)) bad.push(`a return ended elsewhere: ${arrival.fullPath} -> ${now.fullPath}`)
          if (app.replaced().length > (arrival.view === 'map' ? 1 : 0)) bad.push(`a return wrote the address: ${app.replaced().join(', ')}`)
        }
        if (app.pushed().length > 1) bad.push(`more than one history entry for one step: ${app.pushed().join(', ')}`)
      }
      if (!bad.length) {
        await settle(400)
        bad = problems(wrapper, router, wide)
      }
      if (bad.length) failures.push(`seed ${seed}: ${bad.join(' | ')}\n  ${trail.join('\n  ')}`)
      wrapper.unmount()
      mounted = mounted.filter((w) => w !== wrapper)
      vi.useRealTimers()
    }
    expect(failures).toEqual([])
  }, 120_000)
})
