// @vitest-environment jsdom
// The Collections view in the real shell (App.vue, the header, kept-alive views), next to two
// dummy views. What it must do: be exactly as it was left after a round trip, keep what a link
// from another view does not name, and do nothing while another view is on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, type RouteLocationRaw, type Router } from 'vue-router'
import App from '@/App.vue'
import { provideViewRoute } from '@/composables/useViewRoute'
import { api } from '@/lib/api'
import { emptyOverrides, emptyProgress } from '@/lib/normalize'
import type { AppData, MapCategory, MapPoint, Reward, Vault } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useViewMemoryStore, type ViewName } from '@/stores/viewMemory'
import CollectionsView from './CollectionsView.vue'

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

const rewards: Reward[] = [
  { id: 'vestige:wooden-training-sword', kind: 'vestige', name: 'Wooden Training Sword', recipe: 'An Educational Blade', group: 'Brynmoor' },
  { id: 'vestige:garou-greataxe', kind: 'vestige', name: 'Garou Greataxe', recipe: 'A Brutal Bladehead', group: 'Ghornfell' },
  { id: 'quest:anti-dragon-shield', kind: 'quest', name: 'Anti-Dragon Shield', requirement: 'Vertentis Kara', questId: 'Dragon Slayer' },
  { id: 'effigy:paladins-helm', kind: 'effigy', name: "Paladin's Helm", group: 'Ghornfell', set: 'Paladin armour set', vaultId: 'Takla Kara' },
]

const vaults: Vault[] = [
  {
    id: 'Takla Kara',
    name: 'Takla Kara',
    order: 4,
    power: 3,
    area: 'Fractured Plains',
    region: 'Ghornfell',
    recipes: [{ name: "Paladin's helm", set: 'Paladin armour set' }],
    pointId: 'vaults:73020:118948',
  },
]

const cat = (id: string, label: string, group: MapCategory['group'], count: number): MapCategory => ({ id, label, group, sources: [], count })
const categories = [cat('treasure-chest', 'Treasure Chest', 'chest', 2), cat('buried-treasure', 'Buried Treasure', 'chest', 1)]
const points: MapPoint[] = [
  { id: 'treasure-chest:1:1', categoryId: 'treasure-chest', x: 1, y: 1, region: 'Brynmoor', power: 2 },
  { id: 'treasure-chest:2:2', categoryId: 'treasure-chest', x: 2, y: 2, region: 'Dowdun Reach', power: 6 },
  { id: 'buried-treasure:4:4', categoryId: 'buried-treasure', x: 4, y: 4, region: 'Brynmoor', power: 2 },
]

function appData(extra: Reward[] = []): AppData {
  return {
    ready: true,
    meta: {
      syncedAt: new Date().toISOString(),
      durationMs: 1000,
      domains: ['rewards'],
      counts: { categories: 2, points: 3, quests: 0, vaults: 1, rewards: rewards.length + extra.length },
      revisions: {},
    },
    map: { categories, points },
    quests: [],
    vaults,
    rewards: [...rewards, ...extra],
    overrides: emptyOverrides(),
  }
}

/** Links from the other views into Collections, as the quests and the map have them. */
const LINKS: Record<string, RouteLocationRaw> = {
  vault: '/collections#vault-takla-kara',
  page: '/collections',
  'quest-kind': { path: '/collections', query: { kind: 'quest' }, hash: '#unlocks' },
  'all-kinds': '/collections?kind=all#unlocks',
  'vestiges-to-do': '/collections?kind=vestige&hide=1#unlocks',
  'show-owned': '/collections?hide=0',
}

function dummyView(name: ViewName) {
  return defineComponent({
    name: `Dummy-${name}`,
    setup() {
      provideViewRoute(name)
      return () =>
        h(
          'div',
          { 'data-view': name },
          Object.entries(LINKS).map(([id, to]) => h(RouterLink, { to, 'data-link': id }, { default: () => id })),
        )
    },
  })
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/quests' },
      { path: '/quests/:questId?', name: 'quests', component: dummyView('quests') },
      { path: '/map', name: 'map', component: dummyView('map') },
      { path: '/collections', name: 'collections', component: CollectionsView },
    ],
  })
}

/** Every scrollIntoView call: which element and how. */
let reveals: { id: string; behavior: string | undefined }[] = []
let wrapper: VueWrapper | null = null

async function mountApp(path: string) {
  vi.mocked(api.data).mockResolvedValue(appData())
  vi.mocked(api.progress).mockResolvedValue(emptyProgress())
  vi.mocked(api.syncStatus).mockResolvedValue({ running: false, log: [] })
  const router = testRouter()
  // As in main.ts: the memory follows the router from before its first navigation.
  const memory = useViewMemoryStore()
  memory.attach(router)
  await router.push(path)
  wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  const main = wrapper.get('main').element as HTMLElement
  return { wrapper, router, memory, main }
}

const tabs = (label: string) => wrapper!.findAll('nav a').filter((a) => a.text() === label)

async function clickTab(label: string) {
  await tabs(label)[0]!.trigger('click')
  await flushPromises()
}

async function clickLink(id: string) {
  await wrapper!.get(`[data-link="${id}"]`).trigger('click')
  await flushPromises()
}

const chip = (label: string) => wrapper!.findAll('[data-slot="toggle-chip"]').find((c) => c.text().startsWith(label))!
const pressed = (label: string) => chip(label).attributes('aria-pressed') === 'true'
const hideSwitch = () => wrapper!.get('#hide-owned')
const hiding = () => hideSwitch().attributes('aria-checked') === 'true'
const search = () => wrapper!.get('input[type="search"]')
const searchText = () => (search().element as HTMLInputElement).value
const rows = () => wrapper!.findAll('#unlocks [data-slot="check-row"]').length
const lit = () => wrapper!.findAll('article').filter((a) => a.classes().includes('ring-gold')).map((a) => a.attributes('id'))

async function press(label: string) {
  await chip(label).trigger('click')
  await flushPromises()
}

async function toggleHide() {
  await hideSwitch().trigger('click')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  reveals = []
  // jsdom has no layout: an element scrolled into view puts <main> at 500.
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    reveals.push({ id: this.id, behavior: typeof arg === 'object' ? arg.behavior : undefined })
    const main = this.closest('main')
    if (main) main.scrollTop = 500
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

describe('a round trip to another view', () => {
  it('leaves the view exactly as it was: address, search, kind, hide switch, chest kinds and scroll', async () => {
    const { router, main } = await mountApp('/collections')
    const root = wrapper!.get('#vaults').element
    await search().setValue('gar')
    await press('Vestiges')
    await toggleHide()
    await press('Buried Treasure')
    const table = wrapper!.get('[aria-labelledby="chest-caption"]').element as HTMLElement
    table.scrollLeft = 120
    main.scrollTop = 640
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige&hide=1')
    expect(rows()).toBe(1)

    await clickTab('Map')
    expect(wrapper!.find('#vaults').exists()).toBe(false)
    expect(main.scrollTop).toBe(0)
    // A browser forgets the scroll position of an element that is taken out of the page.
    expect(table.isConnected).toBe(false)
    table.scrollLeft = 0

    await clickTab('Collections')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige&hide=1')
    // The same elements: nothing was set up again.
    expect(wrapper!.get('#vaults').element).toBe(root)
    expect(searchText()).toBe('gar')
    expect(pressed('Vestiges')).toBe(true)
    expect(hiding()).toBe(true)
    expect(pressed('Buried Treasure')).toBe(false)
    expect(pressed('Treasure Chest')).toBe(true)
    expect(rows()).toBe(1)
    expect(main.scrollTop).toBe(640)
    expect(wrapper!.get('[aria-labelledby="chest-caption"]').element).toBe(table)
    expect(table.scrollLeft).toBe(120)
    expect(reveals).toEqual([])
  })

  it('does not reveal, focus or highlight the anchor that is still in the address', async () => {
    const { router, main } = await mountApp('/collections')
    await clickTab('Quests')
    await clickLink('vault')
    expect(reveals).toEqual([{ id: 'vault-takla-kara', behavior: 'auto' }])
    expect(lit()).toEqual(['vault-takla-kara'])
    main.scrollTop = 80
    reveals = []

    await clickTab('Map')
    await clickTab('Collections')
    expect(router.currentRoute.value.fullPath).toBe('/collections#vault-takla-kara')
    expect(reveals).toEqual([])
    expect(lit()).toEqual([])
    expect(document.activeElement?.id).not.toBe('vault-takla-kara')
    expect(main.scrollTop).toBe(80)
  })

  it('shows the data that was reloaded in the meantime', async () => {
    const { router } = await mountApp('/collections?kind=vestige')
    expect(rows()).toBe(2)
    await clickTab('Map')
    useDataStore().data = appData([{ id: 'vestige:new-blade', kind: 'vestige', name: 'New Blade', group: 'Brynmoor' }])
    await flushPromises()
    // Nothing moved while it was away.
    expect(router.currentRoute.value.fullPath).toBe('/map')

    await clickTab('Collections')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige')
    expect(pressed('Vestiges')).toBe(true)
    expect(rows()).toBe(3)
    expect(wrapper!.text()).toContain('New Blade')
  })

  it('brings the address in line when leaving cut a write off', async () => {
    const { router } = await mountApp('/collections')
    // The chip starts a replace; the push right behind it wins and the replace is dropped.
    const click = chip('Vestiges').trigger('click')
    const leave = router.push('/map')
    await Promise.all([click, leave])
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/map')
    expect(useViewMemoryStore().locations.collections).toBe('/collections')

    await clickTab('Collections')
    expect(pressed('Vestiges')).toBe(true)
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige')
  })
})

describe('a link from another view', () => {
  it('to a vault keeps kind, hide switch and search, and writes them into the address with a replace', async () => {
    const { router, main } = await mountApp('/collections')
    await search().setValue('gar')
    await press('Vestiges')
    await toggleHide()
    main.scrollTop = 640
    await clickTab('Quests')

    await clickLink('vault')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige&hide=1#vault-takla-kara')
    expect(pressed('Vestiges')).toBe(true)
    expect(hiding()).toBe(true)
    expect(searchText()).toBe('gar')
    // The target of the link is handled as always: there at once, in focus, highlighted.
    expect(reveals).toEqual([{ id: 'vault-takla-kara', behavior: 'auto' }])
    expect(main.scrollTop).toBe(500)
    expect(document.activeElement?.id).toBe('vault-takla-kara')
    expect(lit()).toEqual(['vault-takla-kara'])

    // No extra history entry: one step back is the view the link was in.
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('quests')
    // And forward is a return to the address as it was rewritten.
    router.forward()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige&hide=1#vault-takla-kara')
    expect(useViewMemoryStore().arrival).toMatchObject({ view: 'collections', kind: 'return', via: 'history' })
    expect(reveals).toHaveLength(1)
  })

  it('to the unlocks of a kind shows them: that kind, no search text left, nothing hidden', async () => {
    const { router } = await mountApp('/collections')
    await press('Vestiges')
    await toggleHide()
    // A search text that the unlock of the link does not match. No link can name it.
    await search().setValue('gar')
    expect(rows()).toBe(1)
    await clickTab('Map')

    await clickLink('quest-kind')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=quest#unlocks')
    expect(pressed('Quest rewards')).toBe(true)
    expect(pressed('Vestiges')).toBe(false)
    expect(hiding()).toBe(false)
    expect(searchText()).toBe('')
    expect(wrapper!.get('#unlocks').text()).toContain('Anti-Dragon Shield')
    expect(rows()).toBe(1)
    expect(reveals).toEqual([{ id: 'unlocks', behavior: 'auto' }])
  })

  it('that asks for all kinds, or for the hide switch on or off, gets that and keeps the rest', async () => {
    const { router } = await mountApp('/collections')
    await press('Vestiges')
    await toggleHide()
    await clickTab('Map')

    // The unlocks of a map point with several kinds: all of them, none hidden.
    await clickLink('all-kinds')
    expect(pressed('All')).toBe(true)
    expect(hiding()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/collections#unlocks')

    // A link to the list that asks for the switch gets it.
    await clickTab('Map')
    await clickLink('vestiges-to-do')
    expect(pressed('Vestiges')).toBe(true)
    expect(hiding()).toBe(true)
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige&hide=1#unlocks')

    // Not a link to the list: only what it names changes, the search text stays.
    await search().setValue('gar')
    await clickTab('Map')
    await clickLink('show-owned')
    expect(hiding()).toBe(false)
    expect(pressed('Vestiges')).toBe(true)
    expect(searchText()).toBe('gar')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige')
  })

  it('to the page itself starts at the top with everything kept', async () => {
    const { router, main } = await mountApp('/collections')
    await press('Vestiges')
    await press('Buried Treasure')
    main.scrollTop = 640
    await clickTab('Quests')

    await clickLink('page')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige')
    expect(pressed('Vestiges')).toBe(true)
    expect(pressed('Buried Treasure')).toBe(false)
    expect(main.scrollTop).toBe(0)
    expect(reveals).toEqual([])
  })

  it('on the first visit of the session is read as it is', async () => {
    const { router } = await mountApp('/quests')
    await clickLink('quest-kind')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=quest#unlocks')
    expect(hiding()).toBe(false)
    expect(pressed('Vestiges')).toBe(false)
    expect(rows()).toBe(1)
  })
})

describe('while another view is on screen', () => {
  it('never reads or writes the address of that view', async () => {
    const { router } = await mountApp('/collections?kind=vestige')
    await clickTab('Map')
    // The map with params and a hash that mean something in Collections.
    await router.push('/map?kind=quest&hide=1#vault-takla-kara')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/map?kind=quest&hide=1#vault-takla-kara')
    expect(useViewMemoryStore().locations.collections).toBe('/collections?kind=vestige')
    expect(reveals).toEqual([])

    await clickTab('Collections')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige')
    expect(pressed('Vestiges')).toBe(true)
    expect(hiding()).toBe(false)
    expect(reveals).toEqual([])
  })
})

describe('inside the view', () => {
  it('the address is followed: its own tab goes to the base path, the search text stays', async () => {
    const { router, main } = await mountApp('/collections?kind=vestige&hide=1')
    expect(pressed('Vestiges')).toBe(true)
    expect(hiding()).toBe(true)
    await search().setValue('gar')
    main.scrollTop = 300

    await clickTab('Collections')
    expect(router.currentRoute.value.fullPath).toBe('/collections')
    expect(pressed('All')).toBe(true)
    expect(hiding()).toBe(false)
    expect(searchText()).toBe('gar')
    expect(main.scrollTop).toBe(300)

    await router.push('/collections?kind=quest')
    await flushPromises()
    expect(pressed('All')).toBe(false)
    router.back()
    await flushPromises()
    expect(pressed('All')).toBe(true)
  })

  it('a change of kind keeps the hash and adds no history entry', async () => {
    const { router } = await mountApp('/quests')
    await clickLink('vault')
    await press('Vestiges')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige#vault-takla-kara')
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests')
  })
})
