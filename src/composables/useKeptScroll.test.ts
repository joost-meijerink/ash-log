// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, nextTick, ref, type Ref, type VNode } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { useViewMemoryStore, type ViewName } from '@/stores/viewMemory'
import { useKeptScroll, type KeptScroll } from './useKeptScroll'
import { provideViewRoute } from './useViewRoute'

// jsdom keeps scrollTop on an element that leaves the page; a browser does not. The tests wipe
// it by hand while the view is away (lose()), so a pass means the composable put it back.

let list!: KeptScroll
let card!: KeptScroll
let side!: KeptScroll
let showCard!: Ref<boolean>
let cardKey!: Ref<number>

/** A child with a scroller of its own, like the map sidebar. */
const Side = defineComponent({
  setup() {
    const el = ref<HTMLElement | null>(null)
    side = useKeptScroll(el)
    return () => h('div', { ref: el, 'data-scroller': 'side' })
  },
})

const Quests = defineComponent({
  setup() {
    provideViewRoute('quests')
    const listEl = ref<HTMLElement | null>(null)
    const cardEl = ref<HTMLElement | null>(null)
    showCard = ref(true)
    cardKey = ref(1)
    list = useKeptScroll(listEl)
    card = useKeptScroll(cardEl)
    return () =>
      h('div', { 'data-view': 'quests' }, [
        h('div', { ref: listEl, 'data-scroller': 'list' }),
        showCard.value ? h('div', { ref: cardEl, key: cardKey.value, 'data-scroller': 'card' }) : null,
        h(Side),
      ])
  },
})

const Map = defineComponent({
  setup() {
    provideViewRoute('map')
    return () => h('div', { 'data-view': 'map' })
  },
})

const Shell = defineComponent({
  setup: () => () =>
    h(RouterView, null, {
      default: ({ Component }: { Component?: VNode }) => h(KeepAlive, null, { default: () => (Component ? h(Component) : null) }),
    }),
})

async function setup() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/quests/:questId?', name: 'quests', component: Quests },
      { path: '/map', name: 'map', component: Map },
    ],
  })
  useViewMemoryStore().attach(router)
  await router.push('/quests/A')
  const wrapper = mount(Shell, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return { router, wrapper }
}

const scroller = (name: string) => document.querySelector<HTMLElement>(`[data-scroller="${name}"]`)!

/** The user scrolls: the browser moves the element and fires a scroll event. */
function scrollTo(el: HTMLElement, top: number, left = 0) {
  el.scrollTop = top
  el.scrollLeft = left
  el.dispatchEvent(new Event('scroll'))
}

/** What a browser does to a scroller that is taken out of the page. */
function lose(...els: HTMLElement[]) {
  for (const el of els) {
    el.scrollTop = 0
    el.scrollLeft = 0
  }
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
})

describe('useKeptScroll', () => {
  it('puts the position back when the view returns, top and left, also in a child component', async () => {
    const { router, wrapper } = await setup()
    const listEl = scroller('list')
    const sideEl = scroller('side')
    scrollTo(listEl, 240, 12)
    scrollTo(sideEl, 90)
    expect(list.position()).toEqual({ top: 240, left: 12 })
    expect(side.position()).toEqual({ top: 90, left: 0 })

    await router.push('/map')
    await flushPromises()
    expect(listEl.isConnected).toBe(false)
    lose(listEl, sideEl)

    await tab(router, 'quests')
    expect(listEl.isConnected).toBe(true)
    expect([listEl.scrollTop, listEl.scrollLeft]).toEqual([240, 12])
    expect(sideEl.scrollTop).toBe(90)
    wrapper.unmount()
  })

  it('reads the exact position in the navigation that leaves, without a scroll event', async () => {
    const { router, wrapper } = await setup()
    const listEl = scroller('list')
    // Scrolled by code in the same frame as the navigation: no event yet.
    listEl.scrollTop = 515
    await router.push('/map')
    await flushPromises()
    expect(list.position()).toEqual({ top: 515, left: 0 })
    lose(listEl)
    await tab(router, 'quests')
    expect(listEl.scrollTop).toBe(515)
    wrapper.unmount()
  })

  it('ignores scroll events while the view is away', async () => {
    const { router, wrapper } = await setup()
    const listEl = scroller('list')
    scrollTo(listEl, 240)
    await router.push('/map')
    await flushPromises()
    scrollTo(listEl, 0)
    scrollTo(listEl, 33)
    expect(list.position()).toEqual({ top: 240, left: 0 })
    await tab(router, 'quests')
    expect(listEl.scrollTop).toBe(240)
    // Back in the page it records again.
    scrollTo(listEl, 60)
    expect(list.position()).toEqual({ top: 60, left: 0 })
    wrapper.unmount()
  })

  it('reset: at once while in the page, and instead of the remembered position when away', async () => {
    const { router, wrapper } = await setup()
    const listEl = scroller('list')
    scrollTo(listEl, 240, 5)
    list.reset()
    expect([listEl.scrollTop, listEl.scrollLeft]).toEqual([0, 0])

    scrollTo(listEl, 240)
    await router.push('/map')
    await flushPromises()
    // jsdom still has 240 on the detached element: reset must not touch it, only the memory.
    list.reset()
    expect(list.position()).toEqual({ top: 0, left: 0 })
    await tab(router, 'quests')
    expect(listEl.scrollTop).toBe(0)
    wrapper.unmount()
  })

  it('set while away is applied on the return, whatever ran first', async () => {
    const { router, wrapper } = await setup()
    const listEl = scroller('list')
    scrollTo(listEl, 240)
    await router.push('/map')
    await flushPromises()
    lose(listEl)
    // A watcher of the view runs when the route is back but the view is not in the page yet.
    const back = tab(router, 'quests')
    list.set({ top: 77 })
    await back
    expect(listEl.scrollTop).toBe(77)

    // In the page: at once, and only the given axis.
    list.set({ left: 9 })
    expect([listEl.scrollTop, listEl.scrollLeft]).toEqual([77, 9])
    expect(list.position()).toEqual({ top: 77, left: 9 })
    wrapper.unmount()
  })

  it('follows an element that is replaced or comes and goes', async () => {
    const { router, wrapper } = await setup()
    const first = scroller('card')
    scrollTo(first, 130)
    expect(card.position().top).toBe(130)

    // Another card: a new element that starts at the top.
    cardKey.value = 2
    await nextTick()
    const second = scroller('card')
    expect(second).not.toBe(first)
    expect(card.position().top).toBe(0)
    scrollTo(first, 999)
    expect(card.position().top).toBe(0)
    scrollTo(second, 45)
    expect(card.position().top).toBe(45)

    // Gone and back while in the page.
    showCard.value = false
    await nextTick()
    showCard.value = true
    await nextTick()
    expect(card.position().top).toBe(0)
    scrollTo(scroller('card'), 70)

    // Replaced while the view is away (a data reload): the new element gets the position.
    await router.push('/map')
    await flushPromises()
    cardKey.value = 3
    await nextTick()
    await tab(router, 'quests')
    const fresh = scroller('card')
    expect(fresh.isConnected).toBe(true)
    expect(fresh.scrollTop).toBe(70)
    wrapper.unmount()
  })

  it('forgets the position when the element is gone on the return', async () => {
    const { router, wrapper } = await setup()
    scrollTo(scroller('card'), 70)
    await router.push('/map')
    await flushPromises()
    showCard.value = false
    await nextTick()
    await tab(router, 'quests')
    expect(document.querySelector('[data-scroller="card"]')).toBeNull()
    expect(card.position()).toEqual({ top: 0, left: 0 })
    // A card that is opened later starts at the top.
    showCard.value = true
    await nextTick()
    expect(scroller('card').scrollTop).toBe(0)
    wrapper.unmount()
  })

  it('applies a set to an element that appears with the return or, on screen, a little later', async () => {
    const { router, wrapper } = await setup()
    showCard.value = false
    await nextTick()
    await router.push('/map')
    await flushPromises()

    // The view opens a card for the target of a link and wants it at a given place.
    const back = router.push('/quests/B')
    showCard.value = true
    card.set({ top: 40 })
    await back
    await flushPromises()
    expect(scroller('card').scrollTop).toBe(40)

    showCard.value = false
    await nextTick()
    card.set({ top: 25 })
    showCard.value = true
    await nextTick()
    expect(scroller('card').scrollTop).toBe(25)
    wrapper.unmount()
  })

  it('remembers where it really ended up when the content is shorter on the return', async () => {
    const { router, wrapper } = await setup()
    const listEl = scroller('list')
    scrollTo(listEl, 800)
    await router.push('/map')
    await flushPromises()
    // The list got shorter while away: the browser clamps.
    let top = 0
    Object.defineProperty(listEl, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.min(v, 300)
      },
    })
    await tab(router, 'quests')
    expect(listEl.scrollTop).toBe(300)
    expect(list.position().top).toBe(300)
    wrapper.unmount()
  })

  describe('a scroller that is hidden (display: none on it or above it)', () => {
    /** jsdom has no layout and no checkVisibility(): this one makes `el` a box that can be switched off. */
    function box(el: HTMLElement) {
      const state = { shown: true, real: 0 }
      el.checkVisibility = () => state.shown
      // Like a browser: no box, no scroll position. It reads 0 and cannot be set.
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => (state.shown ? state.real : 0),
        set: (v: number) => {
          if (state.shown) state.real = v
        },
      })
      return state
    }

    it('keeps what it remembered over a round trip and puts it back when it is shown and asked to', async () => {
      const { router, wrapper } = await setup()
      const sideEl = scroller('side')
      const state = box(sideEl)
      scrollTo(sideEl, 140)
      expect(side.position().top).toBe(140)
      // 'Hide filters'. The browser drops the position of an element without a box.
      state.shown = false
      state.real = 0

      await router.push('/map')
      await flushPromises()
      // Nothing was read from the hidden element in the navigation that left.
      expect(side.position().top).toBe(140)
      await tab(router, 'quests')
      // And nothing was put on it (it cannot be) or read back as 0.
      expect(side.position().top).toBe(140)

      state.shown = true
      side.set(side.position())
      expect(sideEl.scrollTop).toBe(140)
      wrapper.unmount()
    })

    it('counts a scroll after it is shown again, also when nothing put the old position back', async () => {
      const { router, wrapper } = await setup()
      const sideEl = scroller('side')
      const state = box(sideEl)
      scrollTo(sideEl, 140)
      state.shown = false
      state.real = 0
      await router.push('/map')
      await flushPromises()
      await tab(router, 'quests')

      state.shown = true
      scrollTo(sideEl, 60)
      expect(side.position().top).toBe(60)
      await router.push('/map')
      await flushPromises()
      state.real = 0
      await tab(router, 'quests')
      expect(sideEl.scrollTop).toBe(60)
      wrapper.unmount()
    })

    it('ignores a position that is set while it is hidden until it is shown', async () => {
      const { wrapper } = await setup()
      const sideEl = scroller('side')
      const state = box(sideEl)
      scrollTo(sideEl, 140)
      state.shown = false
      state.real = 0
      side.set({ top: 75 })
      expect(sideEl.scrollTop).toBe(0)
      expect(side.position().top).toBe(75)
      state.shown = true
      side.set(side.position())
      expect(sideEl.scrollTop).toBe(75)
      wrapper.unmount()
    })
  })

  it('works under a plain KeepAlive, from the scroll events alone', async () => {
    let kept!: KeptScroll
    const Lone = defineComponent({
      setup() {
        const el = ref<HTMLElement | null>(null)
        kept = useKeptScroll(el)
        return () => h('div', { ref: el, 'data-scroller': 'lone' })
      },
    })
    const Other = defineComponent({ render: () => h('p') })
    const which = ref<'lone' | 'other'>('lone')
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Other }] })
    await router.push('/')
    const wrapper = mount(
      defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => h(which.value === 'lone' ? Lone : Other) }) }),
      { global: { plugins: [router] }, attachTo: document.body },
    )
    await flushPromises()
    const el = scroller('lone')
    scrollTo(el, 150)
    which.value = 'other'
    await nextTick()
    lose(el)
    el.dispatchEvent(new Event('scroll'))
    which.value = 'lone'
    await nextTick()
    expect(el.scrollTop).toBe(150)
    expect(kept.position().top).toBe(150)
    wrapper.unmount()
  })
})
