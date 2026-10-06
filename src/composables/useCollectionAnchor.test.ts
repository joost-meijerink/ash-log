// @vitest-environment jsdom
// Anchors of the Collections view under kept-alive views: a first visit and a link from
// another view reveal the anchor, a hash change on screen scrolls there, and coming back to
// where the view was left does nothing at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, nextTick, onBeforeUnmount, onMounted, ref, watch, type VNode } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, RouterView, type Router } from 'vue-router'
import AnchorLink from '@/components/collections/AnchorLink.vue'
import { useViewMemoryStore, type ViewName } from '@/stores/viewMemory'
import { hashToId, useCollectionAnchor, type AnchorNavigator } from './useCollectionAnchor'
import { provideViewRoute } from './useViewRoute'

describe('hashToId', () => {
  it('strips the hash sign and decodes', () => {
    expect(hashToId('#vault-takla-kara')).toBe('vault-takla-kara')
    expect(hashToId('#caf%C3%A9')).toBe('café')
  })

  it('handles empty and malformed hashes', () => {
    expect(hashToId('')).toBe('')
    expect(hashToId(undefined)).toBe('')
    expect(hashToId('#%E0%A4%A')).toBe('%E0%A4%A')
  })
})

/** Where each anchor sits in <main>: what the stand-in for scrollIntoView scrolls to. */
const TOPS: Record<string, number> = { vaults: 100, 'vault-a': 300, 'vault-b': 700, 'vault-c': 900 }

/** Every scrollIntoView call: which element and how. */
let reveals: { id: string; behavior: string | undefined }[] = []
let anchor: AnchorNavigator | null = null
/** How long the highlight stays in the dummy view. */
let durationMs = 1800
let setups = 0

const Collections = defineComponent({
  name: 'DummyCollections',
  setup() {
    setups++
    provideViewRoute('collections')
    const nav = useCollectionAnchor({ highlight: (id) => id.startsWith('vault-'), durationMs })
    anchor = nav
    return () =>
      h('div', { 'data-view': 'collections' }, [
        h('section', { id: 'vaults', tabindex: -1 }),
        ...['vault-a', 'vault-b', 'vault-c'].map((id) =>
          h('article', { id, tabindex: -1, 'data-lit': nav.highlighted.value === id ? '' : undefined }),
        ),
        h(AnchorLink, { to: 'vault-b', 'data-go': 'vault-b' }, { default: () => 'b' }),
      ])
  },
})

/** Another view, with links into the Collections view. An element here shares an id with an anchor there. */
const Quests = defineComponent({
  name: 'DummyQuests',
  setup() {
    provideViewRoute('quests')
    const links: Record<string, string> = {
      a: '/collections#vault-a',
      b: '/collections#vault-b',
      gone: '/collections#vault-nowhere',
      page: '/collections',
    }
    return () =>
      h('div', { 'data-view': 'quests' }, [
        h('p', { id: 'vault-c', tabindex: -1 }),
        ...Object.entries(links).map(([id, to]) => h(RouterLink, { to, 'data-link': id }, { default: () => id })),
      ])
  },
})

/**
 * The shell: <main> around the kept-alive views. Like App.vue it places <main> after a switch,
 * before the activation hooks of the views; 'late' does it after them.
 */
function shell(settle: 'post' | 'late') {
  return defineComponent({
    setup() {
      const memory = useViewMemoryStore()
      const main = ref<HTMLElement | null>(null)
      onMounted(() => memory.setMain(main.value))
      onBeforeUnmount(() => memory.setMain(null))
      watch(
        () => memory.arrival,
        () => {
          if (settle === 'post') memory.settleMain()
          else void nextTick(() => memory.settleMain())
        },
        { flush: 'post' },
      )
      return () =>
        h('main', { ref: main }, [
          h(RouterView, null, {
            default: ({ Component }: { Component?: VNode }) => h(KeepAlive, null, { default: () => (Component ? h(Component) : null) }),
          }),
        ])
    },
  })
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/quests/:questId?', name: 'quests', component: Quests },
      { path: '/collections', name: 'collections', component: Collections },
    ],
  })
}

let wrapper: VueWrapper | null = null

async function setup(path: string, settle: 'post' | 'late' = 'post') {
  const router = testRouter()
  const memory = useViewMemoryStore()
  memory.attach(router)
  await router.push(path)
  wrapper = mount(shell(settle), { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  const main = wrapper.get('main').element as HTMLElement
  return { router, memory, wrapper, main }
}

/** The header tab of a view: to where it was left, announced as a return. */
async function tab(router: Router, view: ViewName) {
  const memory = useViewMemoryStore()
  const to = memory.linkTo(view)
  memory.announceReturn(view)
  await router.push(to)
  await flushPromises()
}

async function click(selector: string) {
  await wrapper!.get(selector).trigger('click')
  await flushPromises()
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const lit = () => wrapper!.findAll('[data-lit]').map((el) => el.attributes('id'))
const focused = () => document.activeElement?.id ?? ''

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  reveals = []
  anchor = null
  durationMs = 1800
  setups = 0
  // jsdom has no layout: scrolling an element into view puts <main> at that element's place.
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    reveals.push({ id: this.id, behavior: typeof arg === 'object' ? arg.behavior : undefined })
    const main = this.closest('main')
    if (main) main.scrollTop = TOPS[this.id] ?? 0
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

describe('the first visit', () => {
  it('jumps to the anchor after a frame, without animation, and focuses and highlights it', async () => {
    const { main } = await setup('/collections#vault-a')
    expect(reveals).toEqual([])
    await frame()
    await flushPromises()
    expect(reveals).toEqual([{ id: 'vault-a', behavior: 'auto' }])
    expect(main.scrollTop).toBe(300)
    expect(focused()).toBe('vault-a')
    expect(lit()).toEqual(['vault-a'])
  })

  it('takes the highlight away by itself', async () => {
    durationMs = 20
    await setup('/collections#vault-a')
    await frame()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await flushPromises()
    expect(lit()).toEqual([])
  })

  it('only highlights what the view asks for', async () => {
    await setup('/collections#vaults')
    await frame()
    await flushPromises()
    expect(reveals).toEqual([{ id: 'vaults', behavior: 'auto' }])
    expect(focused()).toBe('vaults')
    expect(lit()).toEqual([])
  })

  it('works the same when the view is created for a link later in the session', async () => {
    const { main } = await setup('/quests/A')
    await click('[data-link="b"]')
    await frame()
    await flushPromises()
    // Once: the activation of a new view is not a second reveal.
    expect(reveals).toEqual([{ id: 'vault-b', behavior: 'auto' }])
    expect(main.scrollTop).toBe(700)
    expect(lit()).toEqual(['vault-b'])
  })

  it('does not jump when the view is left before the frame', async () => {
    const { router } = await setup('/collections#vault-a')
    await router.push('/quests/A')
    await flushPromises()
    await frame()
    expect(reveals).toEqual([])
    // Coming back is a return: still nothing.
    await tab(router, 'collections')
    await frame()
    expect(reveals).toEqual([])
    expect(lit()).toEqual([])
  })
})

describe('coming back to where the view was left', () => {
  it('does nothing with the hash that is still in the address: no scroll, no focus, no highlight', async () => {
    const { router, main } = await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    main.scrollTop = 450
    reveals = []

    await tab(router, 'quests')
    expect(main.scrollTop).toBe(0)
    // The highlight went when the view was left, so it cannot flash on the way back.
    expect(anchor!.highlighted.value).toBe(null)

    await tab(router, 'collections')
    await frame()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/collections#vault-a')
    expect(setups).toBe(1)
    expect(reveals).toEqual([])
    expect(main.scrollTop).toBe(450)
    expect(focused()).toBe('')
    expect(lit()).toEqual([])
  })

  it('also through back and forward', async () => {
    const { router, main, memory } = await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    main.scrollTop = 450
    reveals = []

    await router.push('/quests/A')
    await flushPromises()
    router.back()
    await flushPromises()
    await frame()
    expect(memory.arrival).toMatchObject({ view: 'collections', kind: 'return', via: 'history' })
    expect(reveals).toEqual([])
    expect(main.scrollTop).toBe(450)
    expect(lit()).toEqual([])
  })

  it('is put back by a shell that places main after the view, too', async () => {
    const { router, main } = await setup('/collections#vault-a', 'late')
    await frame()
    await flushPromises()
    main.scrollTop = 450
    reveals = []
    await tab(router, 'quests')
    await tab(router, 'collections')
    expect(reveals).toEqual([])
    expect(main.scrollTop).toBe(450)
  })
})

describe('a link from another view', () => {
  it('reveals its anchor at once: no animation, once, and not undone by the scroll to the top', async () => {
    const { router, main } = await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    main.scrollTop = 450
    await tab(router, 'quests')
    reveals = []

    await click('[data-link="b"]')
    // No frame needed: it happened in the flush of the switch.
    expect(router.currentRoute.value.fullPath).toBe('/collections#vault-b')
    expect(reveals).toEqual([{ id: 'vault-b', behavior: 'auto' }])
    expect(main.scrollTop).toBe(700)
    expect(focused()).toBe('vault-b')
    expect(lit()).toEqual(['vault-b'])
    await frame()
    await flushPromises()
    expect(reveals).toHaveLength(1)
    expect(setups).toBe(1)
  })

  it('reveals the anchor again when the link names the one that was already in the address', async () => {
    const { router, main, memory } = await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    main.scrollTop = 450
    await tab(router, 'quests')
    reveals = []

    await click('[data-link="a"]')
    expect(memory.arrival).toMatchObject({ view: 'collections', kind: 'fresh', via: 'link' })
    expect(reveals).toEqual([{ id: 'vault-a', behavior: 'auto' }])
    expect(main.scrollTop).toBe(300)
    expect(lit()).toEqual(['vault-a'])
  })

  it('without an anchor starts at the top and reveals nothing', async () => {
    const { router, main } = await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    main.scrollTop = 450
    await tab(router, 'quests')
    reveals = []

    await click('[data-link="page"]')
    await frame()
    await flushPromises()
    expect(reveals).toEqual([])
    expect(main.scrollTop).toBe(0)
    expect(lit()).toEqual([])
  })

  it('to an anchor that does not exist starts at the top', async () => {
    const { router, main } = await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    main.scrollTop = 450
    await tab(router, 'quests')
    reveals = []

    await click('[data-link="gone"]')
    expect(reveals).toEqual([])
    expect(main.scrollTop).toBe(0)
  })

  it('ends at the anchor whether the shell places main before or after the view', async () => {
    const { router, main } = await setup('/collections#vault-a', 'late')
    await frame()
    await flushPromises()
    main.scrollTop = 450
    await tab(router, 'quests')
    reveals = []

    await click('[data-link="b"]')
    expect(reveals).toEqual([{ id: 'vault-b', behavior: 'auto' }])
    expect(main.scrollTop).toBe(700)
  })

  it('over back and forward to another address than the remembered one reveals that anchor', async () => {
    const { router, main, memory } = await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    await click('[data-go="vault-b"]')
    await router.push('/quests/A')
    await flushPromises()
    main.scrollTop = 40
    reveals = []

    // Two steps back: past the remembered /collections#vault-b, straight to #vault-a.
    router.go(-2)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/collections#vault-a')
    expect(memory.arrival).toMatchObject({ view: 'collections', kind: 'fresh', via: 'history' })
    expect(reveals).toEqual([{ id: 'vault-a', behavior: 'auto' }])
    expect(main.scrollTop).toBe(300)
    expect(lit()).toEqual(['vault-a'])
  })
})

describe('the hash changing while the view is on screen', () => {
  it('scrolls smoothly to the new anchor, and again when the same anchor is asked for', async () => {
    const { router } = await setup('/collections?kind=vestige#vault-a')
    await frame()
    await flushPromises()
    reveals = []

    await click('[data-go="vault-b"]')
    // The query of the view is kept.
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige#vault-b')
    expect(reveals).toEqual([{ id: 'vault-b', behavior: 'smooth' }])
    expect(focused()).toBe('vault-b')
    expect(lit()).toEqual(['vault-b'])

    // Already in the address: no navigation, just the scroll.
    await click('[data-go="vault-b"]')
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige#vault-b')
    expect(reveals).toEqual([
      { id: 'vault-b', behavior: 'smooth' },
      { id: 'vault-b', behavior: 'smooth' },
    ])

    // Back inside the view is a hash change like any other.
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/collections?kind=vestige#vault-a')
    expect(reveals.at(-1)).toEqual({ id: 'vault-a', behavior: 'smooth' })
    expect(lit()).toEqual(['vault-a'])
  })

  it('does not animate with prefers-reduced-motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query }))
    await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    reveals = []
    await click('[data-go="vault-b"]')
    expect(reveals).toEqual([{ id: 'vault-b', behavior: 'auto' }])
  })

  it('after a link from another view still scrolls smoothly', async () => {
    const { router } = await setup('/collections#vault-a')
    await frame()
    await flushPromises()
    await tab(router, 'quests')
    await click('[data-link="a"]')
    reveals = []
    await click('[data-go="vault-b"]')
    expect(reveals).toEqual([{ id: 'vault-b', behavior: 'smooth' }])
  })
})

describe('while another view is on screen', () => {
  it('does nothing: no navigation, no scroll, no focus, not even for an id that exists in the other view', async () => {
    const { router, main } = await setup('/collections#vault-c')
    await frame()
    await flushPromises()
    await tab(router, 'quests')
    reveals = []
    main.scrollTop = 25

    // The anchor of the address (the quests view has an element with that id too), and another one.
    anchor!.goTo('vault-c')
    anchor!.goTo('vault-a')
    await flushPromises()
    await frame()
    expect(router.currentRoute.value.fullPath).toBe('/quests')
    expect(reveals).toEqual([])
    expect(focused()).toBe('')
    expect(main.scrollTop).toBe(25)

    // A hash in the address of the other view is not this view's business.
    await router.push('/quests/A#vault-c')
    await flushPromises()
    await frame()
    expect(reveals).toEqual([])
    expect(anchor!.highlighted.value).toBe(null)
  })
})
