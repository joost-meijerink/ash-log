// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import App from '@/App.vue'
import AppHeader from '@/components/AppHeader.vue'
import QuestDetailHeader from '@/components/quests/QuestDetailHeader.vue'
import QuestItems from '@/components/quests/QuestItems.vue'
import QuestSteps from '@/components/quests/QuestSteps.vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { emptyOverrides, emptyProgress } from '@/lib/normalize'
import type { AppData, AppQuest } from '@/lib/types'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import OfflineScreen from './OfflineScreen.vue'
import { OFFLINE_TEXT, OFFLINE_TITLE, retryHint } from './texts'

vi.mock('@/lib/api', () => ({
  api: {
    data: vi.fn(),
    progress: vi.fn(),
    saveProgress: vi.fn(async (p: unknown) => p),
    saveOverrides: vi.fn(async (o: unknown) => o),
    startSync: vi.fn(),
    syncStatus: vi.fn(),
    serverStatus: vi.fn(async () => ({ mode: 'app', local: false, live: true, port: 5199, urls: [] })),
  },
}))

const quest: AppQuest = {
  id: 'Ratcatcher',
  name: 'Ratcatcher',
  kind: 'primary',
  location: 'Fellhollow',
  steps: [
    { id: 'Ratcatcher:s:1', text: 'Talk to Bert.' },
    { id: 'Ratcatcher:s:2', text: 'Kill four rats.' },
  ],
  stepsSource: 'quick-guide',
  items: [{ id: 'Ratcatcher:i:ash-log', name: 'Ash log', qty: 6 }],
  rewards: [],
  requires: [],
  wikiUrl: 'https://dragonwilds.runescape.wiki/w/Ratcatcher',
  itemsOverridden: false,
}

function appData(): AppData {
  return {
    ready: true,
    meta: {
      syncedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      durationMs: 1000,
      domains: ['quests'],
      counts: { categories: 0, points: 0, quests: 1, vaults: 0, rewards: 0 },
      revisions: {},
    },
    map: { categories: [], points: [] },
    quests: [quest],
    vaults: [],
    rewards: [],
    overrides: emptyOverrides(),
  }
}

function withTooltips(component: unknown, props: Record<string, unknown> = {}) {
  return defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(component as never, props) }) })
}

function testRouter() {
  const page = (text: string) => ({ render: () => h('p', { 'data-page': text }, text) })
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/quests' },
      { path: '/quests', component: page('quests') },
      { path: '/kaart', component: page('kaart') },
      { path: '/verzamelingen', component: page('verzamelingen') },
    ],
  })
}

/** A phone that cannot reach the Mac. */
function offlinePhone(knownAt: string | null = null) {
  const connection = useConnectionStore()
  connection.remote = true
  connection.state = 'offline'
  connection.offlineCopyAt = knownAt
  return connection
}

let health: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  health = vi.fn(async () => {
    throw new TypeError('Load failed')
  })
  vi.stubGlobal('fetch', health)
})

afterEach(() => {
  useConnectionStore().stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('retryHint', () => {
  it('says what happens next', () => {
    expect(retryHint({ checking: true, secondsLeft: 4 })).toBe('Even kijken of je computer er weer is...')
    expect(retryHint({ checking: false, secondsLeft: 12 })).toBe('Ash Log probeert het over 12 s vanzelf opnieuw.')
    expect(retryHint({ checking: false, secondsLeft: 0 })).toBe('Ash Log probeert het zo opnieuw.')
    expect(retryHint({ checking: false, secondsLeft: null })).toBe('Ash Log probeert het vanzelf opnieuw.')
  })
})

describe('OfflineScreen', () => {
  it('without data: says what is wrong, offers a retry and nothing to browse', async () => {
    const connection = offlinePhone()
    connection.nextCheckAt = Date.now() + 12_000
    const w = mount(OfflineScreen, { attachTo: document.body })
    expect(w.get('h1').text()).toBe(OFFLINE_TITLE)
    expect(w.text()).toContain(OFFLINE_TEXT)
    expect(w.find('[data-slot="browse"]').exists()).toBe(false)
    expect(w.get('[data-slot="retry-hint"]').text()).toBe('Ash Log probeert het over 12 s vanzelf opnieuw.')
    // The screen takes focus, so a screen reader announces it.
    expect(document.activeElement).toBe(w.get('h1').element)
    expect(w.get('img').attributes('alt')).toBe('')

    let fail: (err: Error) => void = () => {}
    health.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    await w.get('[data-slot="retry"]').trigger('click')
    expect(health).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }))
    expect(w.get('[data-slot="retry"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-slot="retry-hint"]').text()).toBe('Even kijken of je computer er weer is...')
    fail(new TypeError('Load failed'))
    await flushPromises()
    expect(w.get('[data-slot="retry"]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('with data: offers the last known data with its age', async () => {
    const connection = offlinePhone(new Date(Date.now() - 5 * 60_000).toISOString())
    useDataStore().data = appData()
    const w = mount(OfflineScreen)
    const browse = w.get('[data-slot="browse"]')
    expect(browse.text()).toContain('Laatst bekende gegevens bekijken')
    expect(browse.text()).toContain('bijgewerkt 5 min geleden')
    await browse.trigger('click')
    expect(connection.browsing).toBe(true)
    w.unmount()
  })
})

describe('App on a phone without its Mac', () => {
  async function mountApp() {
    vi.mocked(api.data).mockResolvedValue(appData())
    vi.mocked(api.progress).mockResolvedValue(emptyProgress())
    vi.mocked(api.syncStatus).mockResolvedValue({ running: false, log: [] })
    const router = testRouter()
    await router.push('/quests')
    const w = mount(App, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    return w
  }

  it('covers the app with the screen, then shows the last known data read-only with a banner', async () => {
    useConnectionStore().remote = true
    const w = await mountApp()
    expect(w.find('[data-offline-screen]').exists()).toBe(false)
    expect(w.find('[data-slot="offline-banner"]').exists()).toBe(false)

    const connection = offlinePhone(new Date(Date.now() - 2 * 60_000).toISOString())
    await flushPromises()
    const screen = w.get('[data-offline-screen]')
    expect(screen.text()).toContain(OFFLINE_TITLE)
    // The app stays underneath (it keeps its place) but cannot be reached.
    const app = w.get('[inert]')
    expect(app.find('[data-page="quests"]').exists()).toBe(true)
    expect(app.attributes('aria-hidden')).toBe('true')

    await screen.get('[data-slot="browse"]').trigger('click')
    expect(w.find('[data-offline-screen]').exists()).toBe(false)
    expect(w.find('[inert]').exists()).toBe(false)
    const banner = w.get('[data-slot="offline-banner"]')
    expect(banner.text()).toContain('Offline: alleen lezen, laatst bijgewerkt 2 min geleden.')
    expect(banner.text()).toContain('Wijzigingen kunnen weer zodra je computer bereikbaar is.')
    // Sync waits.
    expect(w.get('button[aria-label="Wiki bijwerken"]').attributes('disabled')).toBeDefined()

    // The Mac is back: read-only ends on its own.
    connection.state = 'online'
    await flushPromises()
    expect(w.find('[data-slot="offline-banner"]').exists()).toBe(false)
    expect(w.get('button[aria-label="Wiki bijwerken"]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('shows the screen without a browse button when there is nothing to show', async () => {
    useConnectionStore().remote = true
    vi.mocked(api.data).mockRejectedValue(new TypeError('Load failed'))
    vi.mocked(api.progress).mockRejectedValue(new TypeError('Load failed'))
    vi.mocked(api.syncStatus).mockRejectedValue(new TypeError('Load failed'))
    const router = testRouter()
    await router.push('/quests')
    const w = mount(App, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    offlinePhone()
    await flushPromises()
    expect(w.get('[data-offline-screen]').text()).toContain(OFFLINE_TITLE)
    expect(w.find('[data-slot="browse"]').exists()).toBe(false)
    w.unmount()
  })

  it('keeps the old error on the Mac itself', async () => {
    vi.mocked(api.data).mockRejectedValue(new TypeError('Load failed'))
    vi.mocked(api.progress).mockRejectedValue(new TypeError('Load failed'))
    vi.mocked(api.syncStatus).mockRejectedValue(new TypeError('Load failed'))
    const router = testRouter()
    await router.push('/quests')
    const w = mount(App, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    // Even a state that says offline changes nothing on the Mac.
    useConnectionStore().state = 'offline'
    await flushPromises()
    expect(w.find('[data-offline-screen]').exists()).toBe(false)
    expect(w.text()).toContain('Het logboek is niet bereikbaar')
    w.unmount()
  })
})

describe('read-only', () => {
  function loadedProgress() {
    const progress = useProgressStore()
    progress.state.quests.Ratcatcher = { steps: ['Ratcatcher:s:1'], items: [] }
    progress.loaded = true
    return progress
  }

  it('disables the step checkboxes and refuses a toggle', async () => {
    const progress = loadedProgress()
    useDataStore().data = appData()
    const w = mount(withTooltips(QuestSteps, { quest }))
    expect(w.findAll('input[type="checkbox"]').every((i) => !(i.element as HTMLInputElement).disabled)).toBe(true)

    offlinePhone()
    await flushPromises()
    const boxes = w.findAll('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
    expect(boxes.every((i) => (i.element as HTMLInputElement).disabled)).toBe(true)
    progress.toggleStep('Ratcatcher', 'Ratcatcher:s:2')
    expect(progress.state.quests.Ratcatcher!.steps).toEqual(['Ratcatcher:s:1'])
    w.unmount()
  })

  it('disables done, reset, item checkboxes and the item editor', async () => {
    loadedProgress()
    useDataStore().data = appData()
    offlinePhone()
    const header = mount(withTooltips(QuestDetailHeader, { quest }))
    expect(header.get('button:not([aria-label])').text()).toContain('Markeer als voltooid')
    expect(header.get('button:not([aria-label])').attributes('disabled')).toBeDefined()
    expect(header.get('button[aria-label="Voortgang wissen"]').attributes('disabled')).toBeDefined()
    header.unmount()

    const items = mount(withTooltips(QuestItems, { quest }))
    expect((items.get('input[type="checkbox"]').element as HTMLInputElement).disabled).toBe(true)
    const edit = items.get('[data-edit-items]')
    expect(edit.attributes('disabled')).toBeDefined()
    expect(edit.attributes('aria-label')).toBe('Lijst aanpassen kan weer zodra je computer bereikbaar is')
    items.unmount()
  })

  it('disables the sync button in the header and shows the offline state', async () => {
    useDataStore().data = appData()
    loadedProgress()
    offlinePhone()
    const router = testRouter()
    await router.push('/quests')
    const w = mount(withTooltips(AppHeader), { global: { plugins: [router] } })
    await flushPromises()
    expect(w.get('button[aria-label="Wiki bijwerken"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-slot="progress-offline"]').text()).toContain('Offline, alleen lezen')
    w.unmount()
  })
})
