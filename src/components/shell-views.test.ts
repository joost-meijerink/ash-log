// @vitest-environment jsdom
// The shell with kept-alive views: the real App.vue and AppHeader, a real router and three dummy
// views. Covers what the views build on: they stay alive, each one sees only its own route, the
// header tabs go back to where a view was left, a return differs from a fresh navigation and
// <main> gets its scroll position back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, onActivated, ref, watch } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, type Router } from 'vue-router'
import App from '@/App.vue'
import { provideViewRoute, type ViewRoute } from '@/composables/useViewRoute'
import { api } from '@/lib/api'
import { emptyOverrides, emptyProgress } from '@/lib/normalize'
import type { AppData } from '@/lib/types'
import { TAB_REPEAT_MS, useViewMemoryStore, type MainPosition, type ViewName } from '@/stores/viewMemory'

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

function appData(): AppData {
  return {
    ready: true,
    meta: {
      syncedAt: new Date().toISOString(),
      durationMs: 1000,
      domains: ['quests'],
      counts: { categories: 0, points: 0, quests: 0, vaults: 0, rewards: 0 },
      revisions: {},
    },
    map: { categories: [], points: [] },
    quests: [],
    vaults: [],
    rewards: [],
    overrides: emptyOverrides(),
  }
}

/** Per dummy view: how often it was set up, its context and what it saw. */
let setups: Record<string, number> = {}
let views: Partial<Record<ViewName, ViewRoute>> = {}
let log: string[] = []
/** What a view asks of <main> when it arrives: in a watcher (before the render) or on activation. */
let onArrive: { when: 'watcher' | 'activated'; kind: 'return' | 'fresh'; position: MainPosition } | null = null
/** Where <main> was when a view's activation hook ran. */
let mainAtActivation: number[] = []

function dummyView(name: ViewName, links: Record<string, string> = {}) {
  return defineComponent({
    name: `Dummy-${name}`,
    setup() {
      setups[name] = (setups[name] ?? 0) + 1
      const view = provideViewRoute(name)
      views[name] = view
      // State that only survives when the view stays alive.
      const typed = ref('')
      watch(
        () => view.route.fullPath,
        (v) => log.push(`${name} route ${v}`),
      )
      watch(
        () => view.arrival.value,
        (a) => {
          if (onArrive?.when === 'watcher' && a?.kind === onArrive.kind) view.scrollMain(onArrive.position)
        },
      )
      onActivated(() => {
        const a = view.arrival.value
        log.push(`${name} activated ${a?.kind} ${a?.via} first=${a?.first}`)
        mainAtActivation.push(document.querySelector('main')?.scrollTop ?? -1)
        if (onArrive?.when === 'activated' && a?.kind === onArrive.kind) view.scrollMain(onArrive.position)
      })
      return () =>
        h('div', { 'data-view': name }, [
          h('input', { value: typed.value, onInput: (e: Event) => (typed.value = (e.target as HTMLInputElement).value) }),
          h('p', { 'data-own': '' }, view.route.fullPath),
          ...Object.entries(links).map(([id, to]) => h(RouterLink, { to, 'data-link': id }, { default: () => id })),
        ])
    },
  })
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/quests' },
      {
        path: '/quests/:questId?',
        name: 'quests',
        component: dummyView('quests', { 'to-map': '/map?focus=p1', 'to-vault': '/collections#vault-a' }),
      },
      { path: '/map', name: 'map', component: dummyView('map', { 'to-quest': '/quests/B' }) },
      { path: '/collections', name: 'collections', component: dummyView('collections') },
    ],
  })
}

async function mountApp(path: string) {
  vi.mocked(api.data).mockResolvedValue(appData())
  vi.mocked(api.progress).mockResolvedValue(emptyProgress())
  vi.mocked(api.syncStatus).mockResolvedValue({ running: false, log: [] })
  const router = testRouter()
  // As in main.ts: the memory follows the router from before its first navigation.
  const memory = useViewMemoryStore()
  memory.attach(router)
  await router.push(path)
  const wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  log = []
  const main = wrapper.get('main').element as HTMLElement
  return { wrapper, router, memory, main }
}

/** The wide and the narrow navigation both hold a tab for every view. */
function tabs(wrapper: VueWrapper, label: string) {
  return wrapper.findAll('nav a').filter((a) => a.text() === label)
}
const hrefs = (wrapper: VueWrapper, label: string) => tabs(wrapper, label).map((a) => a.attributes('href'))
const brand = (wrapper: VueWrapper) => wrapper.get('a[aria-label="Ash Log, go to Quests"]')

async function clickTab(wrapper: VueWrapper, label: string, which = 0) {
  await tabs(wrapper, label)[which]!.trigger('click')
  await flushPromises()
}

/** Time passes: a click on the tab of the view you are on is a click of its own again. */
function later() {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + TAB_REPEAT_MS + 1)
}

async function clickLink(wrapper: VueWrapper, id: string) {
  await wrapper.get(`[data-link="${id}"]`).trigger('click')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  setups = {}
  views = {}
  log = []
  onArrive = null
  mainAtActivation = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the shell keeps the views alive', () => {
  it('sets a view up once, keeps its state and only shows the view of the route', async () => {
    const { wrapper } = await mountApp('/quests/A?q=rune')
    await wrapper.get('[data-view="quests"] input').setValue('half typed')

    await clickTab(wrapper, 'Map')
    expect(wrapper.find('[data-view="quests"]').exists()).toBe(false)
    expect(wrapper.get('[data-view="map"]').classes()).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']))
    await clickTab(wrapper, 'Collections')
    await clickTab(wrapper, 'Quests')
    await clickTab(wrapper, 'Map')
    await clickTab(wrapper, 'Quests')

    expect(setups).toEqual({ quests: 1, map: 1, collections: 1 })
    expect((wrapper.get('[data-view="quests"] input').element as HTMLInputElement).value).toBe('half typed')
    expect(wrapper.get('[data-view="quests"]').classes()).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']))
    expect(wrapper.findAll('[data-view]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('gives every view its own route: a view that is away never sees the route of another', async () => {
    const { wrapper, router } = await mountApp('/quests/A?q=rune')
    await clickLink(wrapper, 'to-map')
    await router.replace('/map?focus=p1&c=vaults')
    await clickTab(wrapper, 'Collections')
    await flushPromises()

    expect(views.quests!.route.fullPath).toBe('/quests/A?q=rune')
    expect(views.map!.route.fullPath).toBe('/map?focus=p1&c=vaults')
    expect(views.collections!.route.fullPath).toBe('/collections')
    expect([views.quests!.active.value, views.map!.active.value, views.collections!.active.value]).toEqual([false, false, true])
    expect(log.filter((l) => l.includes(' route '))).toEqual(['map route /map?focus=p1&c=vaults'])

    await clickTab(wrapper, 'Quests')
    expect(wrapper.get('[data-view="quests"] [data-own]').text()).toBe('/quests/A?q=rune')
    expect(log.filter((l) => l.startsWith('quests route'))).toEqual([])
    wrapper.unmount()
  })
})

describe('header tabs', () => {
  it('link to the base paths at first, in both navigations and for the brand', async () => {
    const { wrapper } = await mountApp('/quests/A?q=rune')
    expect(hrefs(wrapper, 'Quests')).toEqual(['/quests', '/quests'])
    expect(hrefs(wrapper, 'Map')).toEqual(['/map', '/map'])
    expect(hrefs(wrapper, 'Collections')).toEqual(['/collections', '/collections'])
    expect(brand(wrapper).attributes('href')).toBe('/quests')
    expect(tabs(wrapper, 'Quests').map((a) => a.attributes('aria-current'))).toEqual(['page', 'page'])
    expect(tabs(wrapper, 'Map').map((a) => a.attributes('aria-current'))).toEqual([undefined, undefined])
    wrapper.unmount()
  })

  it('link to where another view was left, and to the base path of the view you are on', async () => {
    const { wrapper, router } = await mountApp('/quests/A?q=rune')
    await clickLink(wrapper, 'to-vault')
    expect(router.currentRoute.value.fullPath).toBe('/collections#vault-a')
    expect(hrefs(wrapper, 'Quests')).toEqual(['/quests/A?q=rune', '/quests/A?q=rune'])
    expect(brand(wrapper).attributes('href')).toBe('/quests/A?q=rune')
    expect(hrefs(wrapper, 'Collections')).toEqual(['/collections', '/collections'])
    expect(tabs(wrapper, 'Collections').map((a) => a.attributes('aria-current'))).toEqual(['page', 'page'])
    expect(tabs(wrapper, 'Quests').map((a) => a.attributes('aria-current'))).toEqual([undefined, undefined])

    // Navigation inside a view (a replace from the view itself) moves its remembered location.
    await router.replace('/collections?kind=spell#vault-a')
    await clickTab(wrapper, 'Map')
    await flushPromises()
    expect(hrefs(wrapper, 'Collections')).toEqual(['/collections?kind=spell#vault-a', '/collections?kind=spell#vault-a'])
    expect(hrefs(wrapper, 'Map')).toEqual(['/map', '/map'])
    wrapper.unmount()
  })

  it('a tab of another view is a return, the narrow tab and the brand too; the active tab goes to the base path', async () => {
    const { wrapper, router, memory } = await mountApp('/quests/A?q=rune')
    await clickLink(wrapper, 'to-map')
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'fresh', via: 'link', first: true })

    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/A?q=rune')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'return', via: 'tab', first: false })
    expect(log.at(-1)).toBe('quests activated return tab first=false')

    await clickTab(wrapper, 'Map', 1)
    expect(router.currentRoute.value.fullPath).toBe('/map?focus=p1')
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'return', via: 'tab' })

    await brand(wrapper).trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/A?q=rune')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'return', via: 'tab' })

    // The tab of the view you are on: its base path, as before, and no arrival.
    const seq = memory.arrival!.seq
    later()
    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests')
    expect(memory.arrival!.seq).toBe(seq)
    expect(views.quests!.route.fullPath).toBe('/quests')
    wrapper.unmount()
  })

  it('ignores the second click of a double click on the tab of another view: the view stays where it was left', async () => {
    const { wrapper, router, memory } = await mountApp('/quests/A?q=rune')
    await clickLink(wrapper, 'to-map')
    const push = vi.spyOn(router, 'push')

    // Two clicks of one gesture; the first navigation is done in between and the tab links to the base path by then.
    await clickTab(wrapper, 'Quests')
    expect(hrefs(wrapper, 'Quests')).toEqual(['/quests', '/quests'])
    const second = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 })
    tabs(wrapper, 'Quests')[0]!.element.dispatchEvent(second)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/A?q=rune')
    expect(push).toHaveBeenCalledTimes(1)
    // The browser must not follow the link either.
    expect(second.defaultPrevented).toBe(true)
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'return', via: 'tab' })

    // An impatient second tap is a click of its own (detail 1): it is ignored for a moment as well,
    // on the narrow tab and the brand too.
    await clickTab(wrapper, 'Quests', 1)
    await brand(wrapper).trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/A?q=rune')
    expect(push).toHaveBeenCalledTimes(1)

    // A click later on is the tab of the view you are on: the base path.
    later()
    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests')
    wrapper.unmount()
  })

  it('ignores the second click of a double click on the tab of the view you are on, whenever it comes', async () => {
    const { wrapper, router } = await mountApp('/quests/A?q=rune')
    const push = vi.spyOn(router, 'push')
    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests')
    await router.replace('/quests/C')
    const second = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 })
    tabs(wrapper, 'Quests')[0]!.element.dispatchEvent(second)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/C')
    expect(push).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('a quick click on the tab of the view you are on still goes to the base path after a link or back brought you there', async () => {
    const { wrapper, router } = await mountApp('/quests/A?q=rune')
    await clickLink(wrapper, 'to-map')
    await clickTab(wrapper, 'Map')
    expect(router.currentRoute.value.fullPath).toBe('/map')
    router.back()
    await flushPromises()
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/A?q=rune')
    await clickTab(wrapper, 'Quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests')
    wrapper.unmount()
  })

  it('a link with a target is fresh, also when it names the remembered address again', async () => {
    const { wrapper, router, memory } = await mountApp('/quests/A?q=rune')
    await clickLink(wrapper, 'to-map')
    await clickTab(wrapper, 'Quests')
    log = []
    await clickLink(wrapper, 'to-map')
    expect(router.currentRoute.value.fullPath).toBe('/map?focus=p1')
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'fresh', via: 'link', first: false })
    expect(log.at(-1)).toBe('map activated fresh link first=false')
    wrapper.unmount()
  })

  it('a tab click with a modifier key is left to the browser and announces nothing', async () => {
    const { wrapper, router, memory } = await mountApp('/quests/A?q=rune')
    await clickLink(wrapper, 'to-map')
    await tabs(wrapper, 'Quests')[0]!.trigger('click', { ctrlKey: true })
    await tabs(wrapper, 'Quests')[0]!.trigger('click', { metaKey: true })
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/map?focus=p1')
    // A link to the same address afterwards is not mistaken for that tab.
    await router.push('/quests/A?q=rune')
    await flushPromises()
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'link' })
    wrapper.unmount()
  })

  it('back and forward to the remembered location are a return', async () => {
    const { wrapper, router, memory } = await mountApp('/quests/A?q=rune')
    await clickLink(wrapper, 'to-map')
    router.back()
    await flushPromises()
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'return', via: 'history' })
    router.forward()
    await flushPromises()
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'return', via: 'history' })
    expect(setups).toEqual({ quests: 1, map: 1 })
    wrapper.unmount()
  })
})

describe('the scroll position of main', () => {
  it('comes back on a return and starts at the top on a fresh navigation', async () => {
    const { wrapper, main } = await mountApp('/quests/A')
    main.scrollTop = 420
    await clickLink(wrapper, 'to-map')
    expect(main.scrollTop).toBe(0)
    main.scrollTop = 35

    await clickTab(wrapper, 'Quests')
    expect(main.scrollTop).toBe(420)
    await clickTab(wrapper, 'Map')
    expect(main.scrollTop).toBe(35)

    // A link with a target: the top, and the place in quests is kept for the next return.
    await clickLink(wrapper, 'to-quest')
    expect(main.scrollTop).toBe(0)
    main.scrollTop = 60
    await clickTab(wrapper, 'Collections')
    expect(main.scrollTop).toBe(0)
    await clickTab(wrapper, 'Quests')
    expect(main.scrollTop).toBe(60)
    wrapper.unmount()
  })

  it('is in place before the activation hooks of the view run', async () => {
    const { wrapper, main } = await mountApp('/quests/A')
    main.scrollTop = 420
    mainAtActivation = []
    await clickLink(wrapper, 'to-map')
    main.scrollTop = 35
    await clickTab(wrapper, 'Quests')
    await clickTab(wrapper, 'Map')
    expect(mainAtActivation).toEqual([0, 420, 35])
    wrapper.unmount()
  })

  it('stays where it is for navigation inside a view', async () => {
    const { wrapper, router, main } = await mountApp('/quests/A')
    main.scrollTop = 420
    await router.replace('/quests/A?q=rune')
    await router.push('/quests/B?q=rune')
    await flushPromises()
    expect(main.scrollTop).toBe(420)
    wrapper.unmount()
  })

  it('back and forward restore it too', async () => {
    const { wrapper, router, main } = await mountApp('/quests/A')
    main.scrollTop = 420
    await clickLink(wrapper, 'to-map')
    main.scrollTop = 35
    router.back()
    await flushPromises()
    expect(main.scrollTop).toBe(420)
    router.forward()
    await flushPromises()
    expect(main.scrollTop).toBe(35)
    wrapper.unmount()
  })

  it.each(['watcher', 'activated'] as const)('lets a view overrule it from a %s, whichever comes first', async (when) => {
    const { wrapper, main } = await mountApp('/quests/A')
    main.scrollTop = 420
    await clickLink(wrapper, 'to-map')

    // A return that starts at the top after all.
    onArrive = { when, kind: 'return', position: 'top' }
    await clickTab(wrapper, 'Quests')
    expect(main.scrollTop).toBe(0)

    main.scrollTop = 420
    await clickTab(wrapper, 'Map')
    // A fresh navigation that keeps the place, and one that reveals something further down.
    onArrive = { when, kind: 'fresh', position: 'saved' }
    await clickLink(wrapper, 'to-quest')
    expect(main.scrollTop).toBe(420)
    await clickTab(wrapper, 'Map')
    onArrive = { when, kind: 'fresh', position: 250 }
    await clickLink(wrapper, 'to-quest')
    expect(main.scrollTop).toBe(250)
    wrapper.unmount()
  })
})
