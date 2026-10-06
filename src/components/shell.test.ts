// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import App from '@/App.vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { emptyOverrides, emptyProgress } from '@/lib/normalize'
import type { AppData, AppQuest } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { PROGRESS_RELOADED_MESSAGE, useProgressStore } from '@/stores/progress'
import { useSyncStore } from '@/stores/sync'
import SourceCredit from './SourceCredit.vue'
import AppHeader from './AppHeader.vue'
import OrphanNotice from './OrphanNotice.vue'
import SyncReportPanel from './SyncReportPanel.vue'

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

const quest: AppQuest = {
  id: 'Ratcatcher',
  name: 'Ratcatcher',
  kind: 'primary',
  location: 'Fellhollow',
  steps: [{ id: 'Ratcatcher:s:1', text: 'Talk to Bert.' }],
  stepsSource: 'quick-guide',
  items: [],
  rewards: [],
  requires: [],
  wikiUrl: 'https://dragonwilds.runescape.wiki/w/Ratcatcher',
  itemsOverridden: false,
}

function appData(partial: Partial<AppData> = {}): AppData {
  return {
    ready: true,
    meta: {
      syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      durationMs: 1000,
      domains: ['quests'],
      counts: { categories: 1, points: 1, quests: 1, vaults: 0, rewards: 0 },
      revisions: {},
    },
    map: {
      categories: [{ id: 'lore-scraps', label: 'Lore Scraps', group: 'lore', sources: [], count: 1 }],
      points: [{ id: 'lore-scraps:1:1', categoryId: 'lore-scraps', x: 1, y: 1 }],
    },
    quests: [quest],
    vaults: [],
    rewards: [],
    overrides: emptyOverrides(),
    ...partial,
  }
}

/** Two orphaned steps of Ratcatcher, one of a quest that is gone, one lost lore scrap. */
function withOrphans() {
  useDataStore().data = appData()
  const progress = useProgressStore()
  progress.state = {
    ...emptyProgress(),
    quests: {
      Ratcatcher: { steps: ['Ratcatcher:s:1', 'Ratcatcher:s:old', 'Ratcatcher:s:older'], items: [] },
      'Gone Quest': { done: true, steps: [], items: [] },
    },
    points: { 'lore-scraps:1:1': { foundAt: 'x' }, 'lore-scraps:9:9': { foundAt: 'x' } },
  }
  progress.loaded = true
  return progress
}

function withTooltips(component: unknown) {
  return defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(component as never) }) })
}

function testRouter() {
  const page = (text: string) => ({ render: () => h('p', text) })
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/quests' },
      { path: '/quests', component: page('quests') },
      { path: '/map', component: page('map') },
      { path: '/collections', component: page('collections') },
    ],
  })
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')
function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`No button "${text}"`)
  return button
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrphanNotice', () => {
  it('asks before cleaning up, with counts per kind and the quests involved', async () => {
    const progress = withOrphans()
    const w = mount(OrphanNotice, { attachTo: document.body })
    expect(w.text()).toContain('4 ticks point at nothing anymore.')

    await w.findAll('button').find((b) => b.text() === 'Clean up')!.trigger('click')
    await flushPromises()
    const d = dialog()!
    expect(d.textContent).toContain('Clean up orphaned ticks?')
    expect(d.textContent).toContain('4 ticks will be gone for good.')
    expect(d.textContent).toContain('Quest steps')
    expect(d.querySelector('[lang="en"]')?.textContent).toContain('Gone Quest')
    expect(d.textContent).toContain('Ratcatcher')
    expect(d.textContent).toContain('Lore Scraps')
    // Nothing is removed yet.
    expect(progress.state.quests['Gone Quest']).toBeDefined()

    buttonIn(d, 'Clean up').click()
    await flushPromises()
    expect(progress.state.quests).toEqual({ Ratcatcher: { steps: ['Ratcatcher:s:1'], items: [] } })
    expect(Object.keys(progress.state.points)).toEqual(['lore-scraps:1:1'])
    w.unmount()
  })

  it('keeps everything when the dialog is cancelled', async () => {
    const progress = withOrphans()
    const w = mount(OrphanNotice, { attachTo: document.body })
    await w.findAll('button').find((b) => b.text() === 'Clean up')!.trigger('click')
    await flushPromises()
    buttonIn(dialog()!, 'Cancel').click()
    await flushPromises()
    expect(progress.state.quests['Gone Quest']).toBeDefined()
    expect(Object.keys(progress.state.points)).toHaveLength(2)
    w.unmount()
  })
})

describe('SyncReportPanel', () => {
  it('lists orphans by readable name and confirms before cleaning up', async () => {
    const progress = withOrphans()
    useSyncStore().panelOpen = true
    const w = mount(SyncReportPanel, { attachTo: document.body })
    await flushPromises()

    const panel = dialog()!
    expect(panel.textContent).toContain('Ratcatcher (old)')
    expect(panel.textContent).toContain('Lore Scraps (9, 9)')
    expect(panel.textContent).not.toContain('Ratcatcher:s:old')

    buttonIn(panel, 'Clean up').click()
    await flushPromises()
    const confirm = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) =>
      d.textContent?.includes('Clean up orphaned ticks?'),
    )!
    expect(progress.state.quests['Gone Quest']).toBeDefined()
    buttonIn(confirm, 'Clean up').click()
    await flushPromises()
    expect(progress.state.quests['Gone Quest']).toBeUndefined()
    expect(dialog()!.textContent).toContain('4 ticks cleaned up.')
    w.unmount()
  })
})

describe('AppHeader', () => {
  async function mountHeader() {
    const router = testRouter()
    await router.push('/quests')
    const w = mount(withTooltips(AppHeader), { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    return w
  }

  it('shows the last sync time below xl in a compact form', async () => {
    useDataStore().data = appData()
    const w = await mountHeader()
    const compact = w.get('[data-slot="sync-time-compact"]')
    expect(compact.classes()).toContain('xl:hidden')
    expect(compact.classes()).not.toContain('hidden')
    expect(compact.classes()).toContain('min-w-0')
    expect(compact.text()).toBe('Synced5 min')
    expect(compact.get('time').attributes('title')).toBeTruthy()
    w.unmount()
  })

  it('shows a reload after a conflict as a notice that a click dismisses', async () => {
    useDataStore().data = appData()
    const progress = useProgressStore()
    progress.loaded = true
    progress.error = PROGRESS_RELOADED_MESSAGE
    progress.conflict = true
    const flush = vi.spyOn(progress, 'flush')
    const w = await mountHeader()
    const button = w.findAll('button').find((b) => b.text().includes('Reloaded'))!
    await button.trigger('click')
    expect(flush).not.toHaveBeenCalled()
    expect(progress.error).toBeNull()
    expect(progress.conflict).toBe(false)
    w.unmount()
  })
})

describe('SourceCredit', () => {
  it('gives the attribution links a 44px target and marks them English', () => {
    const w = mount(SourceCredit)
    const links = w.findAll('a')
    expect(links).toHaveLength(2)
    for (const a of links) {
      expect(a.classes()).toContain('min-h-11')
      expect(a.attributes('lang')).toBe('en')
    }
  })
})

describe('App', () => {
  async function mountApp(data: AppData) {
    vi.mocked(api.data).mockResolvedValue(data)
    vi.mocked(api.progress).mockResolvedValue(emptyProgress())
    vi.mocked(api.syncStatus).mockResolvedValue({ running: false, log: [] })
    const router = testRouter()
    await router.push('/quests')
    const w = mount(App, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    return w
  }

  it('warns that overrides.json is broken and edits wait until it is fixed', async () => {
    const w = await mountApp(appData({ overridesError: 'overrides.json is not valid JSON: Unexpected token' }))
    const alert = w.findAll('[role="alert"]').find((a) => a.text().includes('overrides.json'))!
    expect(alert.text()).toContain("data/overrides.json can't be read.")
    expect(alert.text()).toContain('editing waits until you fix the file')
    expect(alert.text()).toContain('Unexpected token')
    w.unmount()
  })

  it('shows no overrides warning when the file is fine', async () => {
    const w = await mountApp(appData())
    expect(w.text()).not.toContain('overrides.json')
    w.unmount()
  })

  it('reloads progress and data when the tab gets focus again', async () => {
    const w = await mountApp(appData())
    const progress = useProgressStore()
    const data = useDataStore()
    const refreshProgress = vi.spyOn(progress, 'refresh')
    const refreshData = vi.spyOn(data, 'refresh')
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(refreshProgress).toHaveBeenCalledTimes(1)
    expect(refreshData).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})
