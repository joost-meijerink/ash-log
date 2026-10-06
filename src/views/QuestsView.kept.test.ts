// @vitest-environment jsdom
// The quests view under the real shell (App.vue, AppHeader, <KeepAlive>): what it keeps while the
// map is on screen, what a return restores, what a link from another view changes and what it
// leaves alone, and that a view that is not on screen does nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, type Router } from 'vue-router'
import App from '@/App.vue'
import { provideViewRoute } from '@/composables/useViewRoute'
import { api } from '@/lib/api'
import { emptyOverrides, emptyProgress } from '@/lib/normalize'
import type { AppData, AppQuest, Progress } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useViewMemoryStore } from '@/stores/viewMemory'
import QuestsView from './QuestsView.vue'

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

function quest(id: string, partial: Partial<AppQuest> = {}): AppQuest {
  return {
    id,
    name: id,
    kind: 'primary',
    location: 'Speak to Zanik.',
    steps: [
      { id: `${id}:s:1`, text: 'Do the first thing.' },
      { id: `${id}:s:2`, text: 'Do the second thing.' },
      { id: `${id}:s:3`, text: 'Do the third thing.' },
    ],
    stepsSource: 'walkthrough',
    items: [{ id: `${id}:i:rope`, name: 'Rope', qty: 1 }],
    rewards: [],
    requires: [],
    wikiUrl: `https://dragonwilds.runescape.wiki/w/${id}`,
    itemsOverridden: false,
    ...partial,
  }
}

const QUESTS = [
  quest('First Steps', { order: 1 }),
  quest('Rune Mysteries', { order: 2, requires: ['First Steps'] }),
  quest('Restless Ghost', { order: 3, requires: ['Rune Mysteries'] }),
  quest('Mirror, Mirror', { kind: 'secondary', order: 1, region: 'Fellhollow' }),
]

function appData(quests: AppQuest[] = QUESTS): AppData {
  return {
    ready: true,
    meta: {
      syncedAt: new Date().toISOString(),
      durationMs: 1000,
      domains: ['quests'],
      counts: { categories: 0, points: 0, quests: quests.length, vaults: 0, rewards: 0 },
      revisions: {},
    },
    map: { categories: [], points: [] },
    quests,
    vaults: [],
    rewards: [],
    overrides: emptyOverrides(),
  }
}

function someProgress(): Progress {
  return {
    ...emptyProgress(),
    quests: {
      'First Steps': { done: true, steps: [], items: [] },
      'Rune Mysteries': { steps: ['Rune Mysteries:s:1'], items: [] },
    },
  }
}

/** The map as far as the quests view cares: another kept view with links to quests. */
const MapStub = defineComponent({
  name: 'MapStub',
  setup() {
    provideViewRoute('map')
    const link = (id: string, to: string) => h(RouterLink, { to, 'data-link': id }, { default: () => id })
    return () =>
      h('div', { 'data-view': 'map' }, [
        link('mirror', '/quests/Mirror%2C%20Mirror'),
        link('rune', '/quests/Rune%20Mysteries'),
        link('ghost-done', '/quests/Restless%20Ghost?status=done'),
        link('ghost-loose', '/quests/restless_ghost'),
      ])
  },
})

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/quests' },
      { path: '/quests/:questId?', name: 'quests', component: QuestsView },
      { path: '/map', name: 'map', component: MapStub },
      { path: '/collections', name: 'collections', component: { render: () => h('p', 'collections') } },
    ],
  })
}

/** From lg up the list and the quest sit side by side; jsdom has no matchMedia at all (= a phone). */
function screen(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }))
}

/** Every app of a test is taken down afterwards: a view left behind would keep its window listeners. */
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

async function mountApp(path: string, options: { progress?: Promise<Progress> | Progress } = {}): Promise<Mounted> {
  vi.mocked(api.data).mockResolvedValue(appData())
  const progress = options.progress ?? someProgress()
  vi.mocked(api.progress).mockImplementation(() => Promise.resolve(progress))
  vi.mocked(api.syncStatus).mockResolvedValue({ running: false, log: [] })
  const router = testRouter()
  // As in main.ts: the memory follows the router from before its first navigation.
  useViewMemoryStore().attach(router)
  await router.push(path)
  // Where every replace and push goes, resolved at the moment of the call.
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

/** The wide and the narrow navigation both hold a tab for every view. */
async function clickTab(wrapper: VueWrapper, label: string) {
  await wrapper
    .findAll('nav a')
    .filter((a) => a.text() === label)[0]!
    .trigger('click')
  await flushPromises()
}

async function clickLink(wrapper: VueWrapper, id: string) {
  await wrapper.get(`[data-link="${id}"]`).trigger('click')
  await flushPromises()
}

async function clickRow(wrapper: VueWrapper, questId: string) {
  await wrapper.get(`[data-quest-id="${questId}"]`).trigger('click')
  await flushPromises()
}

const title = (wrapper: VueWrapper) => wrapper.get('h1').text()
const searchField = (wrapper: VueWrapper) => wrapper.get('input[type="search"]')
const searchText = (wrapper: VueWrapper) => (searchField(wrapper).element as HTMLInputElement).value
const chip = (wrapper: VueWrapper, label: string) =>
  wrapper.findAll('button[aria-pressed]').filter((b) => b.text().startsWith(label))[0]!
const pressed = (wrapper: VueWrapper, label: string) => chip(wrapper, label).attributes('aria-pressed')
const listShown = (wrapper: VueWrapper) => !wrapper.get('aside[aria-label="Quest list"]').classes().includes('hidden')
const detailScroller = (wrapper: VueWrapper) => wrapper.get('article').element.parentElement!.parentElement!
const listScroller = (wrapper: VueWrapper) => wrapper.get('nav[aria-label="Quests"]').element as HTMLElement

/** The user scrolls: the browser moves the element and fires a scroll event. */
function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

/** What a browser does to a scroller that is taken out of the page (jsdom keeps the value). */
function lose(...els: HTMLElement[]) {
  for (const el of els) el.scrollTop = 0
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('QuestsView while another view is on screen', () => {
  it('keeps the quest, the filters and what is open in the quest, and writes nothing on the way back', async () => {
    const { wrapper, router, replaced, pushed, reset } = await mountApp('/quests/Rune%20Mysteries')
    await searchField(wrapper).setValue('r')
    await chip(wrapper, 'In progress').trigger('click')
    await chip(wrapper, 'Hide ticked').trigger('click')
    await wrapper.get('[data-edit-items]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries?q=r&status=active')
    const heading = wrapper.get('h1').element
    reset()

    await clickTab(wrapper, 'Map')
    expect(router.currentRoute.value.fullPath).toBe('/map')
    expect(heading.isConnected).toBe(false)
    expect(wrapper.find('aside[aria-label="Quest list"]').exists()).toBe(false)

    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries?q=r&status=active')
    // The same quest sheet, not a new one: what was open in it is still open.
    expect(wrapper.get('h1').element).toBe(heading)
    expect(searchText(wrapper)).toBe('r')
    expect(pressed(wrapper, 'In progress')).toBe('true')
    expect(pressed(wrapper, 'Hide ticked')).toBe('true')
    expect(wrapper.find('form[aria-label="Edit items needed"]').exists()).toBe(true)
    // Two tab clicks and nothing else: the view itself did not navigate.
    expect(pushed()).toEqual(['/map', '/quests/Rune%20Mysteries?q=r&status=active'])
    expect(replaced()).toEqual([])
  })

  it('never reacts to the route of the other view', async () => {
    const { wrapper, router, replaced, reset } = await mountApp('/quests/Rune%20Mysteries?q=rune')
    // A chip inside the quest links to another quest with the list filters of this view.
    const relation = wrapper.get('[data-slot="quest-chip"]').element
    expect(relation.getAttribute('href')).toBe('/quests/First%20Steps?q=rune')
    await clickTab(wrapper, 'Map')
    reset()

    // The map has a ?q= and a ?status= of its own.
    await router.replace('/map?q=vault&status=open')
    await flushPromises()
    expect(replaced()).toEqual(['/map?q=vault&status=open'])
    expect(relation.getAttribute('href')).toBe('/quests/First%20Steps?q=rune')

    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries?q=rune')
    expect(searchText(wrapper)).toBe('rune')
    expect(pressed(wrapper, 'All')).toBe('true')
    expect(title(wrapper)).toBe('Rune Mysteries')
  })

  it('does not navigate when the data changes while it is away, and shows the new data when it is back', async () => {
    const { wrapper, router, replaced, pushed, reset } = await mountApp('/quests/Rune%20Mysteries')
    await clickTab(wrapper, 'Map')
    reset()

    // A sync that finished: one quest more, and the selected one got another name.
    useDataStore().data = appData([
      ...QUESTS.map((q) => (q.id === 'Rune Mysteries' ? { ...q, name: 'Rune Mysteries II' } : q)),
      quest('Lost Cat', { kind: 'secondary' }),
    ])
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/map')
    expect([...replaced(), ...pushed()]).toEqual([])

    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries')
    expect(title(wrapper)).toBe('Rune Mysteries II')
    expect(wrapper.findAll('[data-quest-row]')).toHaveLength(5)
    expect(replaced()).toEqual([])
  })

  it('picks the default quest only once it is back, when progress came in while it was away', async () => {
    let arrive!: (p: Progress) => void
    const later = new Promise<Progress>((resolve) => (arrive = resolve))
    const { wrapper, router, replaced, reset } = await mountApp('/quests', { progress: later })
    // No progress yet: no pick, the address stays bare.
    expect(router.currentRoute.value.fullPath).toBe('/quests')
    await clickTab(wrapper, 'Map')
    reset()

    arrive(someProgress())
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/map')
    expect(replaced()).toEqual([])

    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries')
    expect(replaced()).toEqual(['/quests/Rune%20Mysteries'])
    expect(title(wrapper)).toBe('Rune Mysteries')
  })

  it('opens the default quest when the quest it was left at is gone after a sync, instead of the unknown-quest message', async () => {
    const { wrapper, router, replaced, reset } = await mountApp('/quests/Mirror%2C%20Mirror')
    await searchField(wrapper).setValue('r')
    await flushPromises()
    await clickTab(wrapper, 'Map')
    reset()

    // The wiki renamed the quest: the old id is gone.
    useDataStore().data = appData([...QUESTS.filter((q) => q.id !== 'Mirror, Mirror'), quest('Mirror Image', { kind: 'secondary' })])
    await flushPromises()
    expect(replaced()).toEqual([])

    // The tab still names the old quest, and coming back there is a return.
    await clickTab(wrapper, 'Quests')
    expect(useViewMemoryStore().arrival).toMatchObject({ view: 'quests', kind: 'return' })
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries?q=r')
    expect(replaced()).toEqual(['/quests/Rune%20Mysteries?q=r'])
    expect(title(wrapper)).toBe('Rune Mysteries')
    expect(wrapper.text()).not.toContain("I don't know this quest")
    expect(searchText(wrapper)).toBe('r')
  })

  it('still says so when a link asks for a quest that does not exist', async () => {
    const { wrapper, router } = await mountApp('/quests/Rune%20Mysteries')
    await clickTab(wrapper, 'Map')
    await router.push('/quests/No%20Such%20Quest')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/No%20Such%20Quest')
    expect(wrapper.text()).toContain("I don't know this quest")
  })

  it('treats back and forward to where it was left as a return', async () => {
    const { wrapper, router, replaced, reset } = await mountApp('/quests/Rune%20Mysteries')
    await searchField(wrapper).setValue('r')
    await flushPromises()
    const heading = wrapper.get('h1').element
    await clickTab(wrapper, 'Map')
    reset()

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries?q=r')
    expect(useViewMemoryStore().arrival).toMatchObject({ view: 'quests', kind: 'return', via: 'history' })
    expect(wrapper.get('h1').element).toBe(heading)
    expect(searchText(wrapper)).toBe('r')
    expect(replaced()).toEqual([])
  })
})

describe('QuestsView: a link from another view', () => {
  it('opens the quest it names and keeps the list filters, which go back into the address with a replace', async () => {
    const { wrapper, router, replaced, pushed, reset } = await mountApp('/quests/Rune%20Mysteries')
    await searchField(wrapper).setValue('r')
    await chip(wrapper, 'Not started').trigger('click')
    await flushPromises()
    await clickTab(wrapper, 'Map')
    reset()

    await clickLink(wrapper, 'mirror')
    expect(title(wrapper)).toBe('Mirror, Mirror')
    expect(searchText(wrapper)).toBe('r')
    expect(pressed(wrapper, 'Not started')).toBe('true')
    expect(router.currentRoute.value.params).toEqual({ questId: 'Mirror, Mirror' })
    expect(router.currentRoute.value.query).toEqual({ q: 'r', status: 'open' })
    // One history entry for the link; the filters were added to it with one replace.
    expect(pushed()).toEqual(['/quests/Mirror%2C%20Mirror'])
    expect(replaced()).toEqual([router.currentRoute.value.fullPath])
    // Focus is left alone, as on a first visit: not pulled to the title of the quest.
    expect(document.activeElement).toBe(document.body)
    // The list still links with those filters.
    expect(wrapper.get('[data-quest-id="Restless Ghost"]').attributes('href')).toBe('/quests/Restless%20Ghost?q=r&status=open')
  })

  it('lets a filter that the link names win, and keeps the other one', async () => {
    const { wrapper, router, replaced, reset } = await mountApp('/quests/Rune%20Mysteries?q=s&status=open')
    await clickTab(wrapper, 'Map')
    reset()
    await clickLink(wrapper, 'ghost-done')
    expect(title(wrapper)).toBe('Restless Ghost')
    expect(searchText(wrapper)).toBe('s')
    expect(pressed(wrapper, 'Done')).toBe('true')
    expect(router.currentRoute.value.query).toEqual({ q: 's', status: 'done' })
    // One write, although the filters changed on the way.
    expect(replaced()).toEqual([router.currentRoute.value.fullPath])
  })

  it('rewrites a loose match to the exact id together with the kept filters, in one replace', async () => {
    const { wrapper, router, replaced, reset } = await mountApp('/quests/Rune%20Mysteries?status=open')
    await clickTab(wrapper, 'Map')
    reset()
    await clickLink(wrapper, 'ghost-loose')
    expect(title(wrapper)).toBe('Restless Ghost')
    expect(router.currentRoute.value.fullPath).toBe('/quests/Restless%20Ghost?status=open')
    expect(replaced()).toEqual(['/quests/Restless%20Ghost?status=open'])
  })

  it('to the quest that was already open changes nothing but the top of the quest', async () => {
    screen(true)
    const { wrapper, router, replaced, reset } = await mountApp('/quests/Rune%20Mysteries?q=r')
    const heading = wrapper.get('h1').element
    const detail = detailScroller(wrapper)
    const list = listScroller(wrapper)
    scrollTo(detail, 400)
    scrollTo(list, 150)
    await clickTab(wrapper, 'Map')
    lose(detail, list)
    reset()

    await clickLink(wrapper, 'rune')
    expect(useViewMemoryStore().arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'link' })
    expect(wrapper.get('h1').element).toBe(heading)
    expect(searchText(wrapper)).toBe('r')
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries?q=r')
    expect(replaced()).toEqual(['/quests/Rune%20Mysteries?q=r'])
    expect(detailScroller(wrapper)).toBe(detail)
    expect(detail.scrollTop).toBe(0)
    expect(list.scrollTop).toBe(150)
  })

  it('to exactly the address it was left at is still a link: the quest starts at its top, nothing is written', async () => {
    screen(true)
    const { wrapper, router, replaced, reset } = await mountApp('/quests/Rune%20Mysteries')
    await chip(wrapper, 'Hide ticked').trigger('click')
    const detail = detailScroller(wrapper)
    scrollTo(detail, 400)
    await clickTab(wrapper, 'Map')
    lose(detail)
    reset()

    await clickLink(wrapper, 'rune')
    expect(useViewMemoryStore().arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'link' })
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries')
    expect(replaced()).toEqual([])
    expect(detail.scrollTop).toBe(0)
    // Still the same sheet with what was set in it.
    expect(pressed(wrapper, 'Hide ticked')).toBe('true')
  })
})

describe('QuestsView inside the view', () => {
  it('still follows back and forward: the quest and the filters come from the address', async () => {
    const { wrapper, router } = await mountApp('/quests/Rune%20Mysteries')
    await clickRow(wrapper, 'Restless Ghost')
    expect(title(wrapper)).toBe('Restless Ghost')
    await router.push('/quests/First%20Steps?q=mirror&status=open')
    await flushPromises()
    expect(searchText(wrapper)).toBe('mirror')
    expect(pressed(wrapper, 'Not started')).toBe('true')

    router.back()
    await flushPromises()
    expect(title(wrapper)).toBe('Restless Ghost')
    expect(searchText(wrapper)).toBe('')
    expect(pressed(wrapper, 'All')).toBe('true')
    router.back()
    await flushPromises()
    expect(title(wrapper)).toBe('Rune Mysteries')
  })

  it('the Quests tab of the view itself goes to the base path, as before: filters gone, default quest', async () => {
    const { wrapper, router } = await mountApp('/quests/Restless%20Ghost?q=ghost')
    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries')
    expect(searchText(wrapper)).toBe('')
  })
})

describe('QuestsView on a phone (the list or the quest)', () => {
  it('still shows the quest after a visit to the map, not the list', async () => {
    const { wrapper } = await mountApp('/quests/Rune%20Mysteries')
    expect(listShown(wrapper)).toBe(false)
    await clickTab(wrapper, 'Map')
    await clickTab(wrapper, 'Quests')
    expect(listShown(wrapper)).toBe(false)
    expect(title(wrapper)).toBe('Rune Mysteries')
  })

  it('still shows the list after a visit to the map when the list was open, at the same place', async () => {
    const { wrapper, main } = await mountApp('/quests')
    expect(listShown(wrapper)).toBe(true)
    main.scrollTop = 640
    await clickTab(wrapper, 'Map')
    expect(main.scrollTop).toBe(0)
    await clickTab(wrapper, 'Quests')
    expect(listShown(wrapper)).toBe(true)
    expect(main.scrollTop).toBe(640)
  })

  it('shows the quest for a link from the map, also when the list was open, and starts at its top', async () => {
    const { wrapper, main } = await mountApp('/quests')
    expect(listShown(wrapper)).toBe(true)
    main.scrollTop = 640
    await clickTab(wrapper, 'Map')
    await clickLink(wrapper, 'mirror')
    expect(listShown(wrapper)).toBe(false)
    expect(title(wrapper)).toBe('Mirror, Mirror')
    expect(main.scrollTop).toBe(0)

    // The list is still where it was left before the map.
    await wrapper.findAll('button').filter((b) => b.text() === 'Back to list')[0]!.trigger('click')
    await flushPromises()
    expect(listShown(wrapper)).toBe(true)
    expect(main.scrollTop).toBe(640)
  })

  it('brings the list back where it was with Back to list, and opens a quest at its top', async () => {
    const { wrapper, main } = await mountApp('/quests')
    main.scrollTop = 700
    await clickRow(wrapper, 'Restless Ghost')
    expect(listShown(wrapper)).toBe(false)
    expect(title(wrapper)).toBe('Restless Ghost')
    expect(main.scrollTop).toBe(0)

    main.scrollTop = 300
    await wrapper.findAll('button').filter((b) => b.text() === 'Back to list')[0]!.trigger('click')
    await flushPromises()
    expect(listShown(wrapper)).toBe(true)
    expect(main.scrollTop).toBe(700)
    expect(document.activeElement).toBe(wrapper.get('[data-quest-id="Restless Ghost"]').element)

    // The same quest again: from its top.
    await clickRow(wrapper, 'Restless Ghost')
    expect(main.scrollTop).toBe(0)
  })
})

describe('QuestsView from lg up (list and quest side by side)', () => {
  beforeEach(() => screen(true))

  it('puts the list and the quest back where they were scrolled to', async () => {
    const { wrapper } = await mountApp('/quests/Rune%20Mysteries')
    const detail = detailScroller(wrapper)
    const list = listScroller(wrapper)
    scrollTo(detail, 420)
    scrollTo(list, 180)

    await clickTab(wrapper, 'Map')
    expect(detail.isConnected).toBe(false)
    lose(detail, list)
    await clickTab(wrapper, 'Quests')
    expect(detailScroller(wrapper)).toBe(detail)
    expect(detail.scrollTop).toBe(420)
    expect(list.scrollTop).toBe(180)
  })

  it('a link to another quest starts that quest at the top and keeps the list position', async () => {
    const { wrapper } = await mountApp('/quests/Rune%20Mysteries')
    const detail = detailScroller(wrapper)
    const list = listScroller(wrapper)
    scrollTo(detail, 420)
    scrollTo(list, 180)

    await clickTab(wrapper, 'Map')
    lose(detail, list)
    await clickLink(wrapper, 'mirror')
    expect(title(wrapper)).toBe('Mirror, Mirror')
    expect(detail.scrollTop).toBe(0)
    expect(list.scrollTop).toBe(180)
  })

  it('only scrolls the list for a link from another view, and then only as far as needed', async () => {
    const into = vi.fn()
    Element.prototype.scrollIntoView = into
    try {
      const { wrapper } = await mountApp('/quests/Rune%20Mysteries')
      // jsdom has no stylesheet: say by hand that the list scrolls on its own.
      listScroller(wrapper).style.overflowY = 'auto'
      await clickTab(wrapper, 'Map')
      into.mockClear()

      await clickTab(wrapper, 'Quests')
      await flushPromises()
      expect(into).not.toHaveBeenCalled()

      await clickTab(wrapper, 'Map')
      await clickLink(wrapper, 'mirror')
      await flushPromises()
      expect(into).toHaveBeenCalled()
      expect(into.mock.contexts.every((row) => (row as HTMLElement).dataset.questId === 'Mirror, Mirror')).toBe(true)
      expect(into.mock.calls.every(([options]) => (options as ScrollIntoViewOptions).block === 'nearest')).toBe(true)

      // A link to the quest that is open already: no other quest to react to, the row is still checked.
      await clickTab(wrapper, 'Map')
      into.mockClear()
      await clickLink(wrapper, 'mirror')
      await flushPromises()
      expect(into).toHaveBeenCalledTimes(1)
      expect((into.mock.contexts[0] as HTMLElement).dataset.questId).toBe('Mirror, Mirror')
      expect(into.mock.calls[0]).toEqual([{ block: 'nearest' }])
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})

describe('QuestsView from lg up: the list position and the row of a link', () => {
  beforeEach(() => screen(true))

  it('checks the row of a link to the quest that is open already after the list is back where it was', async () => {
    const { wrapper } = await mountApp('/quests/Mirror%2C%20Mirror')
    const list = listScroller(wrapper)
    // jsdom has no stylesheet: say by hand that the list scrolls on its own.
    list.style.overflowY = 'auto'
    scrollTo(list, 300)
    await clickTab(wrapper, 'Map')
    lose(list)

    // Where the list stood at the moment the row was scrolled into view.
    const seen: number[] = []
    Element.prototype.scrollIntoView = function () {
      seen.push(list.scrollTop)
    }
    try {
      await clickLink(wrapper, 'mirror')
      await flushPromises()
      expect(seen).toEqual([300])
      expect(list.scrollTop).toBe(300)
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})

describe('QuestsView does nothing while it is not on screen', () => {
  /** jsdom does no layout: the list counts as visible while it is in the page. */
  function layout() {
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
      return this.isConnected ? document.body : null
    })
  }

  function slash(): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    return event
  }

  it("ignores the '/' shortcut", async () => {
    layout()
    const { wrapper } = await mountApp('/quests/Rune%20Mysteries')
    const field = searchField(wrapper).element as HTMLInputElement
    expect(slash().defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(field)
    field.blur()

    await clickTab(wrapper, 'Map')
    // The list is detached, which a browser reports as offsetParent null: the guard under test
    // is the one on the view, so pretend the list is still laid out.
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body)
    expect(slash().defaultPrevented).toBe(false)

    await clickTab(wrapper, 'Quests')
    // Coming back does not move focus into the view.
    expect(document.activeElement).not.toBe(field)
    expect(slash().defaultPrevented).toBe(true)
  })

  it('closes a confirm dialog that was left open, so it does not hang over the other view', async () => {
    const { wrapper, router } = await mountApp('/quests/Rune%20Mysteries')
    await wrapper.get('button[aria-label="Clear progress"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    // Back or forward in the browser: the header cannot be reached behind a dialog.
    await router.push('/map')
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await clickTab(wrapper, 'Quests')
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not move focus when it returns', async () => {
    const { wrapper } = await mountApp('/quests/Rune%20Mysteries')
    await clickTab(wrapper, 'Map')
    const tab = wrapper.findAll('nav a').filter((a) => a.text() === 'Quests')[0]!
    ;(tab.element as HTMLElement).focus()
    await tab.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(tab.element)
  })
})
