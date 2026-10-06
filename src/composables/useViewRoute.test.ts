// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, onActivated, onDeactivated, watch, type ComputedRef, type VNode } from 'vue'
import { createMemoryHistory, createRouter, RouterView, useRoute, type Router } from 'vue-router'
import { useViewMemoryStore, type ViewName } from '@/stores/viewMemory'
import { provideViewRoute, useViewActive, useViewRoute, type ViewRoute } from './useViewRoute'

/** What the watchers and hooks of the dummy views saw, in order. */
let log: string[] = []
let views: Partial<Record<ViewName, ViewRoute>> = {}
let children: Partial<Record<ViewName, ViewRoute>> = {}
let childActive: Partial<Record<ViewName, ComputedRef<boolean>>> = {}

/** A child somewhere inside a view: reads the view's route without being told which view it is in. */
const Child = defineComponent({
  props: { of: { type: String, required: true } },
  setup(props) {
    const view = useViewRoute()
    children[props.of as ViewName] = view
    childActive[props.of as ViewName] = useViewActive()
    return () => h('p', { 'data-child': props.of }, `${view.route.fullPath} ${view.active.value ? 'on' : 'off'}`)
  },
})

function dummyView(name: ViewName) {
  return defineComponent({
    name: `Dummy-${name}`,
    setup() {
      const view = provideViewRoute(name)
      views[name] = view
      const global = useRoute()
      const note = (what: string) => log.push(`${name} ${what}`)
      watch(() => view.route.fullPath, (v) => note(`sync ${v}`), { flush: 'sync' })
      watch(() => view.route.query, () => note(`pre ${view.route.fullPath}`))
      watch(() => view.route.fullPath, (v) => note(`post ${v}`), { flush: 'post' })
      watch(() => global.fullPath, (v) => note(`global ${v}`))
      watch(
        () => view.arrival.value,
        (a) => note(`arrival ${a?.kind} ${a?.via} active=${view.active.value} route=${view.route.fullPath}`),
      )
      onActivated(() => note(`activated ${view.arrival.value?.kind} ${view.route.fullPath}`))
      onDeactivated(() => note('deactivated'))
      return () => h('div', { 'data-view': name }, [h(Child, { of: name }), h('input', { 'data-field': name })])
    },
  })
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/quests/:questId?', name: 'quests', component: dummyView('quests') },
      { path: '/kaart', name: 'map', component: dummyView('map') },
    ],
  })
}

const KeptViews = defineComponent({
  setup: () => () =>
    h(RouterView, null, {
      default: ({ Component }: { Component?: VNode }) => h(KeepAlive, null, { default: () => (Component ? h(Component) : null) }),
    }),
})

async function setup(path: string, shell = KeptViews) {
  const router = testRouter()
  const memory = useViewMemoryStore()
  memory.attach(router)
  await router.push(path)
  const wrapper = mount(shell, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  log = []
  return { router, memory, wrapper }
}

async function tab(router: Router, view: ViewName) {
  const memory = useViewMemoryStore()
  const to = memory.linkTo(view)
  memory.announceReturn(view)
  await router.push(to)
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  log = []
  views = {}
  children = {}
  childActive = {}
})

describe('useViewRoute in kept-alive views', () => {
  it('gives the view and its children the route of their own view', async () => {
    const { wrapper } = await setup('/quests/A?q=rune')
    expect(views.quests!.name).toBe('quests')
    expect(views.quests!.route.fullPath).toBe('/quests/A?q=rune')
    expect(views.quests!.route.params).toEqual({ questId: 'A' })
    expect(views.quests!.route.query).toEqual({ q: 'rune' })
    expect(views.quests!.route.name).toBe('quests')
    expect(views.quests!.active.value).toBe(true)
    // The child got the same object without being told the view name.
    expect(children.quests).toBe(views.quests)
    expect(wrapper.get('[data-child="quests"]').text()).toBe('/quests/A?q=rune on')
    wrapper.unmount()
  })

  it('freezes the route while another view is on screen: no watcher of the view ever sees the other route', async () => {
    const { router, wrapper } = await setup('/quests/A?q=rune')
    await router.push('/kaart?focus=p1')
    await router.replace('/kaart?focus=p1&c=vaults')
    await flushPromises()

    expect(views.quests!.route.fullPath).toBe('/quests/A?q=rune')
    expect(views.quests!.route.query).toEqual({ q: 'rune' })
    expect(views.quests!.route.params).toEqual({ questId: 'A' })
    expect(views.quests!.active.value).toBe(false)
    expect(views.map!.route.fullPath).toBe('/kaart?focus=p1&c=vaults')
    expect(views.map!.active.value).toBe(true)
    expect(wrapper.find('[data-view="quests"]').exists()).toBe(false)

    const quests = log.filter((l) => l.startsWith('quests '))
    // The global route did show the map to the quests view; its own route never did.
    expect(quests).toEqual(['quests global /kaart?focus=p1', 'quests deactivated', 'quests global /kaart?focus=p1&c=vaults'])
    wrapper.unmount()
  })

  it('follows navigation inside the view, for sync, pre and post watchers', async () => {
    const { router, wrapper } = await setup('/quests/A')
    await router.replace({ query: { q: 'rune' } })
    await flushPromises()
    expect(log).toEqual([
      'quests sync /quests/A?q=rune',
      'quests pre /quests/A?q=rune',
      'quests global /quests/A?q=rune',
      'quests post /quests/A?q=rune',
    ])
    expect(wrapper.get('[data-child="quests"]').text()).toBe('/quests/A?q=rune on')
    wrapper.unmount()
  })

  it('a return fires no route watcher; the arrival is known in watchers and in onActivated', async () => {
    const { router, wrapper } = await setup('/quests/A?q=rune')
    const questsRoute = useViewMemoryStore().routes.quests
    await router.push('/kaart?focus=p1')
    await flushPromises()
    log = []

    await tab(router, 'quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/A?q=rune')
    // Watchers before the render (their order within one view is not fixed), then the hooks.
    expect([...log].sort()).toEqual([
      'map deactivated',
      'map global /quests/A?q=rune',
      'quests activated return /quests/A?q=rune',
      'quests arrival return tab active=true route=/quests/A?q=rune',
      'quests global /quests/A?q=rune',
    ])
    expect(log.slice(-2)).toEqual(['map deactivated', 'quests activated return /quests/A?q=rune'])
    expect(useViewMemoryStore().routes.quests).toBe(questsRoute)
    expect(wrapper.get('[data-child="quests"]').text()).toBe('/quests/A?q=rune on')
    wrapper.unmount()
  })

  it('a fresh navigation updates the route before the arrival watcher and the activation hook run', async () => {
    const { router, wrapper } = await setup('/quests/A?q=rune')
    await router.push('/kaart?focus=p1')
    await flushPromises()
    log = []

    // A link from the map to another quest.
    await router.push('/quests/B')
    await flushPromises()
    const quests = log.filter((l) => l.startsWith('quests '))
    expect(quests[0]).toBe('quests sync /quests/B')
    expect(quests.slice(1, 4).sort()).toEqual([
      'quests arrival fresh link active=true route=/quests/B',
      'quests global /quests/B',
      'quests pre /quests/B',
    ])
    expect(quests.slice(4)).toEqual(['quests post /quests/B', 'quests activated fresh /quests/B'])

    // The same link again after a return to the map: same address, so only the arrival tells.
    await tab(router, 'map')
    log = []
    await router.push('/quests/B')
    await flushPromises()
    expect(log.filter((l) => l.startsWith('quests ')).sort()).toEqual([
      'quests activated fresh /quests/B',
      'quests arrival fresh link active=true route=/quests/B',
      'quests global /quests/B',
    ])
    expect(log.at(-1)).toBe('quests activated fresh /quests/B')
    wrapper.unmount()
  })

  it('back to the remembered location is a return as well', async () => {
    const { router, wrapper } = await setup('/quests/A')
    await router.push('/kaart?focus=p1')
    await flushPromises()
    log = []
    router.back()
    await flushPromises()
    expect(log).toContain('quests arrival return history active=true route=/quests/A')
    expect(log.some((l) => /^quests (sync|pre|post)/.test(l))).toBe(false)
    wrapper.unmount()
  })

  it('does not navigate for a view that is not on screen', async () => {
    const { router, wrapper } = await setup('/quests/A')
    await router.push('/kaart?focus=p1')
    await flushPromises()

    // A query-only location would rewrite the address of the map.
    await expect(views.quests!.replace({ query: { q: 'late' } })).resolves.toBeUndefined()
    await expect(views.quests!.push('/quests/B')).resolves.toBeUndefined()
    expect(router.currentRoute.value.fullPath).toBe('/kaart?focus=p1')
    expect(useViewMemoryStore().locations.quests).toBe('/quests/A')

    await views.map!.replace({ query: { focus: 'p2' } })
    expect(router.currentRoute.value.fullPath).toBe('/kaart?focus=p2')
    await views.map!.push('/quests/C')
    expect(router.currentRoute.value.fullPath).toBe('/quests/C')
    wrapper.unmount()
  })

  it('does not navigate while a navigation to another view is on its way, so that one is not cancelled', async () => {
    const { router, wrapper } = await setup('/quests/A')
    let loaded!: () => void
    router.addRoute({
      path: '/traag',
      name: 'collections',
      component: () => new Promise((resolve) => (loaded = () => resolve({ render: () => h('p', 'traag') }))),
    })
    // The header tab was clicked; the code of that view is still loading.
    const going = router.push('/traag')
    await flushPromises()
    expect(views.quests!.active.value).toBe(true)
    // A write of the view that lands in that gap (a debounce, data that came in).
    await expect(views.quests!.replace({ query: { q: 'late' } })).resolves.toBeUndefined()
    await expect(views.quests!.push('/quests/B')).resolves.toBeUndefined()
    loaded()
    await going
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/traag')
    expect(useViewMemoryStore().locations.quests).toBe('/quests/A')

    // Back on screen the view can write again.
    await tab(router, 'quests')
    await views.quests!.replace({ query: { q: 'late' } })
    expect(router.currentRoute.value.fullPath).toBe('/quests/A?q=late')
    wrapper.unmount()
  })

  it('lets go of the focus inside a view that leaves the page, while it is still there', async () => {
    const { router, wrapper } = await setup('/quests/A')
    const field = wrapper.get('[data-field="quests"]').element as HTMLInputElement
    const blurs: boolean[] = []
    field.addEventListener('blur', () => blurs.push(field.isConnected))
    field.focus()
    expect(document.activeElement).toBe(field)
    // Back or forward: no click that moves the focus first.
    await router.push('/kaart')
    expect(blurs).toEqual([true])
    await flushPromises()
    expect(document.activeElement).toBe(document.body)
    expect(blurs).toHaveLength(1)
    wrapper.unmount()
  })

  it('leaves the focus alone when it is outside the view (the header tab that was clicked)', async () => {
    const { router, wrapper } = await setup('/quests/A')
    const tabLink = document.createElement('button')
    document.body.appendChild(tabLink)
    tabLink.focus()
    await router.push('/kaart')
    await flushPromises()
    expect(document.activeElement).toBe(tabLink)
    // Navigation inside the view does not touch the focus either.
    const field = wrapper.get('[data-field="map"]').element as HTMLInputElement
    field.focus()
    await router.replace('/kaart?focus=p1')
    await flushPromises()
    expect(document.activeElement).toBe(field)
    wrapper.unmount()
  })

  it('tells components below a view whether their view is on screen', async () => {
    const { router, wrapper } = await setup('/quests/A')
    expect(childActive.quests!.value).toBe(true)
    expect(childActive.quests).toBe(views.quests!.active)
    await router.push('/kaart')
    expect(childActive.quests!.value).toBe(false)
    await flushPromises()
    expect(childActive.map!.value).toBe(true)
    wrapper.unmount()
  })

  it('calls onLeave hooks in the navigation, while the view is still in the page, and drops them with the view', async () => {
    const { router, memory, wrapper } = await setup('/quests/A')
    const el = wrapper.get('[data-view="quests"]').element
    const seen: string[] = []
    views.quests!.onLeave(() => seen.push(`connected=${el.isConnected} active=${views.quests!.active.value}`))
    const leaving = router.push('/kaart')
    expect(seen).toEqual([])
    await leaving
    // Straight after the navigation, before the render that detaches the view.
    expect(seen).toEqual(['connected=true active=true'])
    await flushPromises()
    expect(el.isConnected).toBe(false)

    // The hook goes away with the view (kept alive until the shell unmounts).
    wrapper.unmount()
    memory.attach(router)
    await router.push('/quests/A')
    await router.push('/kaart')
    expect(seen).toHaveLength(1)
  })

  it('counts the mounted views, so a view that is gone is not returned to', async () => {
    const Plain = defineComponent({ setup: () => () => h(RouterView) })
    const { router, memory, wrapper } = await setup('/quests/A', Plain)
    await router.push('/kaart')
    await flushPromises()
    // Without KeepAlive the quests view was unmounted.
    await tab(router, 'quests')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'tab', first: true })
    expect(views.quests!.route.fullPath).toBe('/quests/A')
    wrapper.unmount()
  })

  it('passes scrollMain on for its own view only', async () => {
    const { router, memory, wrapper } = await setup('/quests/A')
    const main = document.createElement('main')
    memory.setMain(main)
    views.quests!.scrollMain(120)
    expect(main.scrollTop).toBe(120)
    await router.push('/kaart')
    await flushPromises()
    memory.settleMain()
    views.quests!.scrollMain(999)
    expect(main.scrollTop).toBe(0)
    views.map!.scrollMain(15)
    expect(main.scrollTop).toBe(15)
    views.map!.scrollMain('top')
    expect(main.scrollTop).toBe(0)
    wrapper.unmount()
  })
})

describe('useViewRoute outside the views', () => {
  it('follows the global route for a component that is mounted on its own', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/verzamelingen', component: { render: () => null } },
        { path: '/kaart', component: { render: () => null } },
      ],
    })
    await router.push('/verzamelingen?soort=spell')
    let view!: ViewRoute
    const Lone = defineComponent({
      setup() {
        view = useViewRoute()
        return () => h('p', view.route.fullPath)
      },
    })
    const wrapper = mount(Lone, { global: { plugins: [router] } })
    expect(view.name).toBeNull()
    expect(view.active.value).toBe(true)
    expect(view.arrival.value).toBeNull()
    expect(wrapper.text()).toBe('/verzamelingen?soort=spell')

    await view.replace({ query: { soort: 'weapon' } })
    await flushPromises()
    expect(wrapper.text()).toBe('/verzamelingen?soort=weapon')
    await router.push('/kaart')
    await flushPromises()
    expect(wrapper.text()).toBe('/kaart')
    // No store involved.
    expect(useViewMemoryStore().active).toBeNull()
    view.onLeave(() => undefined)
    view.scrollMain('top')
    wrapper.unmount()
  })

  it('counts as on screen for a component without a view around it, and needs no router for that', () => {
    let active!: ComputedRef<boolean>
    const Lone = defineComponent({
      setup() {
        active = useViewActive()
        return () => h('p')
      },
    })
    const wrapper = mount(Lone)
    expect(active.value).toBe(true)
    wrapper.unmount()
  })

  it('follows the global route in a view under a router without named view routes', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/quests', component: dummyView('quests') },
        { path: '/kaart', component: { render: () => null } },
      ],
    })
    await router.push('/quests?q=a')
    const wrapper = mount(KeptViews, { global: { plugins: [router] } })
    await flushPromises()
    expect(views.quests!.name).toBe('quests')
    expect(views.quests!.route.fullPath).toBe('/quests?q=a')
    expect(views.quests!.active.value).toBe(true)
    await router.push('/kaart')
    expect(views.quests!.route.fullPath).toBe('/kaart')
    expect(views.quests!.active.value).toBe(true)
    wrapper.unmount()
  })
})
