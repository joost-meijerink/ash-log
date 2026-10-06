// @vitest-environment jsdom
// The tooltip of an icon button is drawn in the body. Its view stays alive while another view is
// on screen, so a tooltip that is open when the view leaves (back or forward with the pointer on
// the button: no pointerleave comes from a button that is taken out of the page) has to go with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, type VNode } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { provideViewRoute } from '@/composables/useViewRoute'
import { useViewMemoryStore } from '@/stores/viewMemory'
import IconButton from './IconButton.vue'

const MapStub = defineComponent({
  setup() {
    provideViewRoute('map')
    return () => h('div', { 'data-view': 'map' }, [h(IconButton, { label: 'Zoom in' }, { default: () => '+' })])
  },
})

const QuestsStub = defineComponent({
  setup() {
    provideViewRoute('quests')
    return () => h('div', { 'data-view': 'quests' }, 'quests')
  },
})

let router: Router
let wrapper: VueWrapper | undefined

async function open(path: string, delay: number) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/map', name: 'map', component: MapStub },
      { path: '/quests/:questId?', name: 'quests', component: QuestsStub },
    ],
  })
  useViewMemoryStore().attach(router)
  await router.push(path)
  const Host = defineComponent({
    render: () =>
      h(TooltipProvider, { delayDuration: delay }, {
        default: () =>
          h(RouterView, null, {
            default: ({ Component }: { Component?: VNode }) => h(KeepAlive, null, { default: () => (Component ? h(Component) : null) }),
          }),
      }),
  })
  wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** The pointer comes to rest on the button. */
function hover(el: Element) {
  const move = new Event('pointermove', { bubbles: true })
  Object.defineProperty(move, 'pointerType', { value: 'mouse' })
  el.dispatchEvent(move)
}

const tooltips = () => [...document.body.querySelectorAll('[role="tooltip"]')].map((t) => t.textContent)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

describe('IconButton tooltip in a view that stays alive', () => {
  it('closes when its view leaves the page with the pointer still on the button', async () => {
    const w = await open('/map', 0)
    hover(w.get('button[aria-label="Zoom in"]').element)
    await wait(20)
    await flushPromises()
    expect(tooltips()).toEqual(['Zoom in'])

    // Back or forward: the pointer did not move.
    await router.push('/quests')
    await flushPromises()
    await wait(20)
    expect(w.text()).toBe('quests')
    expect(tooltips()).toEqual([])
    expect(document.body.querySelector('[data-slot="tooltip-content"]')).toBeNull()

    // Back on the map it is closed, and works as before once the pointer comes by again.
    await router.push('/map')
    await flushPromises()
    expect(tooltips()).toEqual([])
    w.get('button[aria-label="Zoom in"]').element.dispatchEvent(new Event('pointerleave'))
    hover(w.get('button[aria-label="Zoom in"]').element)
    await wait(20)
    await flushPromises()
    expect(tooltips()).toEqual(['Zoom in'])
  })

  it('does not open over another view when its delay runs out after the view was left', async () => {
    const w = await open('/map', 60)
    hover(w.get('button[aria-label="Zoom in"]').element)
    await router.push('/quests')
    await flushPromises()
    await wait(120)
    await flushPromises()
    expect(tooltips()).toEqual([])
    // Not waiting to pop up on the way back either.
    await router.push('/map')
    await flushPromises()
    await wait(20)
    expect(tooltips()).toEqual([])
  })

  it('works on a button outside the views (the header)', async () => {
    const lone = mount(
      defineComponent({ render: () => h(TooltipProvider, { delayDuration: 0 }, { default: () => h(IconButton, { label: 'Last sync report' }, { default: () => 'r' }) }) }),
      { attachTo: document.body },
    )
    hover(lone.get('button').element)
    await wait(20)
    await flushPromises()
    expect(tooltips()).toEqual(['Last sync report'])
    lone.unmount()
  })
})
