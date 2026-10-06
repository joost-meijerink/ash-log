// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptyOverrides } from '@/lib/normalize'
import type { AppData, AppQuest } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import QuestsView from './QuestsView.vue'

vi.mock('@/lib/api', () => ({
  api: {
    data: vi.fn(),
    progress: vi.fn(),
    saveProgress: vi.fn(async (p: unknown) => p),
    saveOverrides: vi.fn(),
    startSync: vi.fn(),
    syncStatus: vi.fn(),
  },
}))

function quest(id: string, partial: Partial<AppQuest> = {}): AppQuest {
  return {
    id,
    name: id,
    kind: 'primary',
    location: 'Speak to Zanik.',
    steps: [{ id: `${id}:s:1`, text: 'Do the thing.' }],
    stepsSource: 'walkthrough',
    items: [],
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
  quest('Mirror, Mirror', { kind: 'secondary', order: 1, region: 'Fellhollow' }),
]

function appData(): AppData {
  return { ready: true, map: { categories: [], points: [] }, quests: QUESTS, vaults: [], rewards: [], overrides: emptyOverrides() }
}

async function setup(path: string, progressLoaded = true) {
  setActivePinia(createPinia())
  useDataStore().data = appData()
  const progress = useProgressStore()
  if (progressLoaded) {
    progress.state.quests['Rune Mysteries'] = { steps: ['Rune Mysteries:s:0'], items: [] }
    progress.state.quests['First Steps'] = { done: true, steps: [], items: [] }
    progress.loaded = true
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/quests/:questId?', name: 'quests', component: QuestsView },
      { path: '/map', name: 'map', component: { render: () => h('p', 'map') } },
    ],
  })
  await router.push(path)
  const App = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(RouterView) }) })
  const wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, router, progress }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('QuestsView routing', () => {
  it('opens the first open main story quest when the URL has none', async () => {
    const { wrapper, router } = await setup('/quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/Rune%20Mysteries')
    expect(wrapper.get('h1').text()).toBe('Rune Mysteries')
    wrapper.unmount()
  })

  it('waits for progress before picking', async () => {
    const { router, progress, wrapper } = await setup('/quests', false)
    expect(router.currentRoute.value.fullPath).toBe('/quests')
    progress.state.quests['Mirror, Mirror'] = { steps: ['Mirror, Mirror:s:1'], items: [] }
    progress.state.quests['First Steps'] = { done: true, steps: [], items: [] }
    progress.state.quests['Rune Mysteries'] = { done: true, steps: [], items: [] }
    progress.loaded = true
    await flushPromises()
    // Mirror, Mirror is done (its only step is checked), so the pick falls back to the first quest.
    expect(router.currentRoute.value.params.questId).toBe('First Steps')
    wrapper.unmount()
  })

  it('shows a friendly message and the list for an unknown quest', async () => {
    const { wrapper, router } = await setup('/quests/Dragon%20Slayer%20II')
    expect(router.currentRoute.value.params.questId).toBe('Dragon Slayer II')
    expect(wrapper.text()).toContain("I don't know this quest")
    expect(wrapper.text()).toContain('Dragon Slayer II')
    expect(wrapper.findAll('[data-quest-row]')).toHaveLength(3)
    wrapper.unmount()
  })

  it('rewrites a loose match to the exact id', async () => {
    const { wrapper, router } = await setup('/quests/mirror,_mirror')
    expect(router.currentRoute.value.params.questId).toBe('Mirror, Mirror')
    expect(wrapper.get('h1').text()).toBe('Mirror, Mirror')
    wrapper.unmount()
  })

  it('keeps the list filters in the URL and on quest links', async () => {
    const { wrapper, router } = await setup('/quests/First%20Steps')
    await wrapper.get('input[type="search"]').setValue('mirror')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ q: 'mirror' })
    const rows = wrapper.findAll('[data-quest-row]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.attributes('href')).toBe('/quests/Mirror%2C%20Mirror?q=mirror')
    wrapper.unmount()
  })

  it('does not pull you back when you leave for another view', async () => {
    const { wrapper, router } = await setup('/quests/First%20Steps')
    await router.push('/map')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/map')
    wrapper.unmount()
  })
})

describe('QuestsView languages', () => {
  it('marks wiki text and the region groups as English', async () => {
    const { wrapper } = await setup('/quests/First%20Steps')
    useDataStore().data = { ...appData(), quests: [...QUESTS, quest('Lost Cat', { kind: 'secondary' })] }
    await flushPromises()

    expect(wrapper.get('h1').attributes('lang')).toBe('en')
    const groups = wrapper.findAll('nav h3').map((h) => [h.text(), h.attributes('lang')])
    expect(groups).toEqual([
      ['Fellhollow', 'en'],
      ['Other', 'en'],
    ])
    expect(wrapper.findAll('[data-quest-row] span[lang="en"]').map((s) => s.text())).toEqual([
      'First Steps',
      'Rune Mysteries',
      'Mirror, Mirror',
      'Lost Cat',
    ])
    wrapper.unmount()
  })
})
