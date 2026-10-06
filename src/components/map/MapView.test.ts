// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, type VNode } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { L } from '@/components/map/leaflet'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptyOverrides } from '@/lib/normalize'
import { MULT } from '@/lib/projection'
import type { AppData, AppQuest, MapCategory, MapPoint, Overrides, Reward, Vault } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import { useViewMemoryStore, type ViewName } from '@/stores/viewMemory'
import MapView from '@/views/MapView.vue'

// Never talk to the middleware from tests.
const saved: Overrides[] = []
vi.mock('@/lib/api', () => ({
  api: {
    data: vi.fn(async () => currentData()),
    progress: vi.fn(),
    saveProgress: vi.fn(async (p: unknown) => p),
    saveOverrides: vi.fn(async (o: Overrides) => {
      saved.push(o)
      overrides = o
      return o
    }),
    startSync: vi.fn(),
    syncStatus: vi.fn(),
  },
}))

const categories: MapCategory[] = [
  { id: 'vaults', label: 'Vaults', group: 'vault', sources: [], count: 1, wikiPage: 'Vaults' },
  { id: 'lore-scraps', label: 'Lore Scraps', group: 'lore', sources: [], count: 2, wikiPage: 'Lore Scraps' },
  { id: 'treasure-chest', label: 'Treasure Chest', group: 'chest', sources: [], count: 2 },
  { id: 'net-fishing-spot', label: 'Net Fishing Spot', group: 'resource', sources: [], count: 2 },
  { id: 'vannaka', label: 'Vannaka', group: 'npc', sources: [], count: 1, wikiPage: 'Vannaka' },
  // A large group (more than LARGE_GROUP_SIZE categories).
  ...Array.from({ length: 15 }, (_, i): MapCategory => ({
    id: `monster-${i + 1}`,
    label: `Monster ${i + 1}`,
    group: 'monster',
    sources: [],
    count: 1,
  })),
]

const points: MapPoint[] = [
  { id: 'vaults:37482:191753', categoryId: 'vaults', x: 37482, y: 191753, region: 'Brynmoor', description: 'The location of the Crasorak Kara vault in Temple Woods' },
  { id: 'lore-scraps:29118:156991', categoryId: 'lore-scraps', x: 29118, y: 156991, name: 'Scrawled Diary Page', region: 'Brynmoor', regionGuessed: true },
  { id: 'lore-scraps:-480000:-460000', categoryId: 'lore-scraps', x: -480000, y: -460000 },
  { id: 'treasure-chest:10786:169394', categoryId: 'treasure-chest', x: 10786, y: 169394, power: 2, region: 'Brynmoor' },
  { id: 'treasure-chest:103571:-47340', categoryId: 'treasure-chest', x: 103571, y: -47340, power: 5, region: 'Fellhollow' },
  { id: 'net-fishing-spot:1000:2000', categoryId: 'net-fishing-spot', x: 1000, y: 2000, name: 'Net Fishing Spot (Lobster)', region: 'Brynmoor' },
  { id: 'net-fishing-spot:3000:4000', categoryId: 'net-fishing-spot', x: 3000, y: 4000, name: 'Net Fishing Spot (Shrimp)', region: 'Fellhollow' },
  { id: 'vannaka:15183:178853', categoryId: 'vannaka', x: 15183, y: 178853, region: 'Brynmoor' },
]

const vaults: Vault[] = [
  { id: 'Crasorak Kara', name: 'Crasorak Kara', order: 1, power: 2, area: 'Temple Woods', region: 'Brynmoor', recipes: [], pointId: 'vaults:37482:191753' },
]

function quest(id: string, extra: Partial<AppQuest> = {}): AppQuest {
  return {
    id,
    name: id,
    kind: 'primary',
    location: 'Speak to Vannaka south of the Windmill.',
    steps: [],
    stepsSource: 'walkthrough',
    items: [],
    rewards: [],
    requires: [],
    wikiUrl: '',
    itemsOverridden: false,
    ...extra,
  }
}

let overrides: Overrides = emptyOverrides()
/** Per test: extra map data, rewards and a broken overrides.json. */
let extraCategories: MapCategory[] = []
let extraPoints: MapPoint[] = []
let rewards: Reward[] = []
let overridesError: string | undefined

function currentData(): AppData {
  const start = overrides.questStart.Ratcatcher
  // The middleware applies overrides.categoryGroup.
  const merged = [...categories, ...extraCategories].map((c) =>
    overrides.categoryGroup[c.id] ? { ...c, group: overrides.categoryGroup[c.id]! } : c,
  )
  return {
    ready: true,
    meta: { syncedAt: '2026-09-28T12:00:00Z', durationMs: 1, domains: [], counts: { categories: 5, points: 8, quests: 2, vaults: 1, rewards: 0 }, revisions: {} },
    map: { categories: merged, points: [...points, ...extraPoints] },
    quests: [
      quest('Ratcatcher', {
        order: 3,
        startPointId: 'vannaka:15183:178853',
        start: start
          ? { ...start, source: 'override' }
          : { x: 15183, y: 178853, pointId: 'vannaka:15183:178853', source: 'wiki' },
      }),
      quest('First Steps', { order: 1, location: 'Speak to the Wise Old Man in the Temple.' }),
    ],
    vaults,
    rewards,
    overrides,
    ...(overridesError ? { overridesError } : {}),
  }
}

let router: Router
let wrapper: VueWrapper | undefined

async function open(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/kaart', name: 'map', component: MapView },
      { path: '/quests/:questId?', name: 'quests', component: { render: () => h('p', 'quests') } },
      { path: '/verzamelingen', name: 'collections', component: { render: () => h('p', 'collections') } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const Host = defineComponent({ render: () => h(TooltipProvider, null, { default: () => h(RouterView) }) })
  wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** The views stay alive, as in App.vue, and the view memory follows the router from the start. */
const KeptHost = defineComponent({
  render: () =>
    h(TooltipProvider, null, {
      default: () =>
        h(RouterView, null, {
          default: ({ Component }: { Component?: VNode }) => h(KeepAlive, null, { default: () => (Component ? h(Component) : null) }),
        }),
    }),
})

async function openKept(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/kaart', name: 'map', component: MapView },
      { path: '/quests/:questId?', name: 'quests', component: { render: () => h('p', 'quests') } },
      { path: '/verzamelingen', name: 'collections', component: { render: () => h('p', 'collections') } },
    ],
  })
  useViewMemoryStore().attach(router)
  await router.push(path)
  await router.isReady()
  wrapper = mount(KeptHost, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** A header tab: to where that view was left, announced as a return (see AppHeader). */
async function tab(view: ViewName) {
  const memory = useViewMemoryStore()
  const to = memory.linkTo(view)
  memory.announceReturn(view)
  await router.push(to)
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  overrides = emptyOverrides()
  extraCategories = []
  extraPoints = []
  rewards = []
  overridesError = undefined
  saved.length = 0
  useDataStore().data = currentData()
  useProgressStore().loaded = true
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Checkbox of a category row, opening its group first when it is collapsed. */
async function checkbox(w: VueWrapper, group: string, label: string) {
  const section = w.findAll('[data-slot="map-filter-group"]').find((g) => g.get('h3 .font-display').text() === group)
  if (!section) throw new Error(`no group ${group}`)
  const toggle = section.get('h3 button')
  if (toggle.attributes('aria-expanded') !== 'true') await toggle.trigger('click')
  const row = section.findAll('[data-slot="map-category-row"]').find((r) => r.text().includes(label))
  if (!row) throw new Error(`no row for ${label}`)
  return row.get('input[type="checkbox"]')
}

describe('MapView', () => {
  it('shows vaults and quest starts by default, with groups in order', async () => {
    const w = await open('/kaart')
    expect(router.currentRoute.value.query).toEqual({})
    const headings = w.findAll('[data-slot="map-filter-group"] h3 .font-display').map((h) => h.text())
    expect(headings).toEqual(['Grondstoffen', 'Chests', 'Lore', 'Vaults', "NPC's", 'Monsters'])
    const vaultsGroup = w.findAll('[data-slot="map-filter-group"]')[3]!
    expect(vaultsGroup.get('h3 button').attributes('aria-expanded')).toBe('true')
    expect(((await checkbox(w, 'Vaults', 'Vaults')).element as HTMLInputElement).checked).toBe(true)
    expect(((await checkbox(w, 'Chests', 'Treasure Chest')).element as HTMLInputElement).checked).toBe(false)
    expect(w.text()).toContain('1 punt')
  })

  it('writes a toggled category and the power filter to the URL', async () => {
    const w = await open('/kaart')
    await (await checkbox(w, 'Chests', 'Treasure Chest')).setValue(true)
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ c: 'treasure-chest,vaults', qs: '1' })
    const pl5 = w.findAll('[data-slot="toggle-chip"]').find((b) => b.text() === 'PL 5')!
    await pl5.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.p).toBe('5')
    expect(w.text()).toContain('1 punt')
  })

  it('keeps rapid changes when URL writes overlap', async () => {
    const w = await open('/kaart')
    const a = await checkbox(w, 'Chests', 'Treasure Chest')
    const b = await checkbox(w, 'Grondstoffen', 'Net Fishing Spot')
    ;(a.element as HTMLInputElement).checked = true
    void a.trigger('change')
    ;(b.element as HTMLInputElement).checked = true
    void b.trigger('change')
    await flushPromises()
    await new Promise((r) => setTimeout(r, 5))
    await flushPromises()
    expect(router.currentRoute.value.query.c).toBe('net-fishing-spot,treasure-chest,vaults')
    expect((a.element as HTMLInputElement).checked).toBe(true)
    expect((b.element as HTMLInputElement).checked).toBe(true)
  })

  it('applies navigation to a URL it wrote before', async () => {
    const w = await open('/kaart')
    const chest = await checkbox(w, 'Chests', 'Treasure Chest')
    await chest.setValue(true)
    await flushPromises()
    const written = router.currentRoute.value.fullPath
    await chest.setValue(false)
    await flushPromises()
    await new Promise((r) => setTimeout(r, 5))
    expect(router.currentRoute.value.query).toEqual({})
    await router.push(written)
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ c: 'treasure-chest,vaults' })
    expect(((await checkbox(w, 'Chests', 'Treasure Chest')).element as HTMLInputElement).checked).toBe(true)
  })

  it('shows skipped instanced points and found / total for lore', async () => {
    const w = await open('/kaart?c=lore-scraps')
    await checkbox(w, 'Lore', 'Lore Scraps')
    const row = w.findAll('[data-slot="map-category-row"]').find((r) => r.text().includes('Lore Scraps'))!
    expect(row.text()).toContain('1 in instanced gebieden')
    expect(row.text()).toContain('0 / 1')
  })

  it('opens a focused point: category on, card with found checkbox', async () => {
    const w = await open('/kaart?focus=lore-scraps:29118:156991')
    expect(String(router.currentRoute.value.query.c)).toContain('lore-scraps')
    const card = w.get('article')
    expect(card.text()).toContain('Scrawled Diary Page')
    expect(card.text()).toContain('Brynmoor (geschat)')
    expect(card.text()).toContain('x 29118 · y 156991')
    await card.get('[data-slot="check-row"] input').setValue(true)
    expect(useProgressStore().state.points['lore-scraps:29118:156991']).toBeDefined()
    await card.get('button[aria-label="Sluiten"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.focus).toBeUndefined()
    expect(w.find('article').exists()).toBe(false)
  })

  it('links a vault point to Verzamelingen with the vault power', async () => {
    const w = await open('/kaart?focus=vaults:37482:191753')
    const card = w.get('article')
    expect(card.get('a[href="/verzamelingen#vault-crasorak-kara"]').text()).toContain('Bekijk in Verzamelingen')
    expect(card.text()).toContain('PL 2')
    expect(card.find('[data-slot="check-row"]').exists()).toBe(false)
  })

  it('links a quest start NPC to its quest', async () => {
    const w = await open('/kaart?focus=vannaka:15183:178853')
    expect(w.get('article a[href="/quests/Ratcatcher"]').text()).toContain('Open quest')
  })

  it('opens a quest card and enters pin mode from it', async () => {
    const w = await open('/kaart?quest=Ratcatcher')
    const card = w.get('article')
    expect(card.text()).toContain('Ratcatcher')
    expect(card.text()).toContain('Startpunt volgens de wiki')
    const move = card.findAll('button').find((b) => b.text().includes('Pin verplaatsen'))!
    await move.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.pin).toBe('Ratcatcher')
    expect(w.text()).toContain('Klik op de kaart om de start van Ratcatcher te zetten')
    expect(w.text()).not.toContain('Pin verwijderen')
  })

  it('offers to place a pin for a quest without a start', async () => {
    const w = await open('/kaart?quest=First%20Steps')
    expect(w.get('article').text()).toContain('Pin zetten')
  })

  it('removes a manual pin and returns to the quest', async () => {
    overrides = { ...emptyOverrides(), questStart: { Ratcatcher: { x: 1, y: 2 } } }
    useDataStore().data = currentData()
    const w = await open('/kaart?pin=Ratcatcher')
    const remove = w.findAll('button').find((b) => b.text().includes('Pin verwijderen'))!
    await remove.trigger('click')
    await flushPromises()
    expect(saved.at(-1)?.questStart).toEqual({})
    expect(router.currentRoute.value.query.quest).toBe('Ratcatcher')
    expect(router.currentRoute.value.query.pin).toBeUndefined()
  })

  it('searches point names and flies to a result', async () => {
    vi.useFakeTimers()
    try {
      const w = await open('/kaart')
      await w.get('input[type="search"]').setValue('lobster')
      expect(w.text()).toContain('Net Fishing Spot (Lobster)')
      vi.advanceTimersByTime(400)
      await flushPromises()
      expect(router.currentRoute.value.query.q).toBe('lobster')
      const hit = w.findAll('button').find((b) => b.text().includes('Net Fishing Spot (Lobster)'))!
      await hit.trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.query.focus).toBe('net-fishing-spot:1000:2000')
      expect(String(router.currentRoute.value.query.c)).toContain('net-fishing-spot')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores unknown ids in the URL and cleans them up', async () => {
    await open('/kaart?c=vaults,nope&focus=gone:1:2&p=42')
    expect(router.currentRoute.value.query).toEqual({ c: 'vaults' })
  })

  it('keeps large groups closed with chips, and filters them locally', async () => {
    const w = await open('/kaart?c=monster-2,monster-12')
    const group = () => w.findAll('[data-slot="map-filter-group"]').find((g) => g.get('h3 .font-display').text() === 'Monsters')!
    expect(group().get('h3 button').attributes('aria-expanded')).toBe('false')
    expect(group().text()).toContain('2 aan')
    const chip = group().findAll('[data-slot="toggle-chip"]').find((c) => c.text() === 'Monster 12')!
    await chip.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.c).toBe('monster-2')

    await group().get('h3 button').trigger('click')
    await group().get('input[type="search"]').setValue('monster 1')
    // Monster 1 and Monster 10 to 15.
    expect(group().findAll('[data-slot="map-category-row"]')).toHaveLength(7)
    const all = group().findAll('button').find((b) => b.text() === 'Selectie aan')!
    await all.trigger('click')
    await flushPromises()
    expect(String(router.currentRoute.value.query.c).split(',')).toEqual([
      'monster-1',
      'monster-10',
      'monster-11',
      'monster-12',
      'monster-13',
      'monster-14',
      'monster-15',
      'monster-2',
    ])
  })

  it('clears every filter with Wis filters', async () => {
    const w = await open('/kaart?c=treasure-chest&p=2&h=1')
    const clear = w.findAll('button').find((b) => b.text() === 'Wis filters')!
    await clear.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ c: '' })
    expect(w.text()).toContain('Nog niets op de kaart')
  })

  describe('strict power level', () => {
    beforeEach(() => {
      extraCategories = [{ id: 'buried-treasure', label: 'Buried Treasure', group: 'chest', sources: [], count: 1 }]
      extraPoints = [{ id: 'buried-treasure:12000:170000', categoryId: 'buried-treasure', x: 12000, y: 170000, region: 'Brynmoor' }]
      useDataStore().data = currentData()
    })

    const strictChip = (w: VueWrapper) => w.findAll('[data-slot="toggle-chip"]').find((b) => b.text().includes('Alleen met power level'))

    it('hides chests without a level with ps=1, like the chest overview counts', async () => {
      const w = await open('/kaart?c=buried-treasure,treasure-chest&p=2&r=Brynmoor')
      const buried = () => w.findAll('[data-slot="map-category-row"]').find((r) => r.text().includes('Buried Treasure'))!
      expect(w.text()).toContain('2 punten')
      expect(buried().text()).toContain('1 punt')
      expect(w.text()).toContain('punten zonder level blijven staan')
      await strictChip(w)!.trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.query).toMatchObject({ p: '2', ps: '1' })
      expect(w.text()).toContain('1 punt')
      expect(buried().text()).toContain('0 punten')
      expect(w.text()).toContain('Alleen punten met een gekozen level blijven staan')
    })

    it('reads ps=1 from a link, and drops it with the last level', async () => {
      const w = await open('/kaart?c=buried-treasure,treasure-chest&p=2&ps=1')
      expect(w.text()).toContain('1 punt')
      expect(strictChip(w)!.attributes('aria-pressed')).toBe('true')
      const pl2 = w.findAll('[data-slot="toggle-chip"]').find((b) => b.text() === 'PL 2')!
      await pl2.trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.query.p).toBeUndefined()
      expect(router.currentRoute.value.query.ps).toBeUndefined()
      expect(strictChip(w)).toBeUndefined()
      expect(w.text()).toContain('3 punten')
    })
  })

  describe('remembered filters', () => {
    it('brings your filters back when you return through a plain /kaart link', async () => {
      const w = await open('/kaart')
      await (await checkbox(w, 'Chests', 'Treasure Chest')).setValue(true)
      await flushPromises()
      await router.push('/quests')
      await flushPromises()
      await router.push('/kaart')
      await flushPromises()
      expect(router.currentRoute.value.query).toMatchObject({ c: 'treasure-chest,vaults', qs: '1' })
      expect(((await checkbox(w, 'Chests', 'Treasure Chest')).element as HTMLInputElement).checked).toBe(true)
    })

    it('keeps them with ?quest= and lets explicit filter params win', async () => {
      await open('/kaart?c=treasure-chest&p=5&ps=1')
      await router.push('/quests')
      await router.push('/kaart?quest=Ratcatcher')
      await flushPromises()
      expect(router.currentRoute.value.query).toEqual({ c: 'treasure-chest', p: '5', ps: '1', quest: 'Ratcatcher' })
      await router.push('/kaart?c=vaults')
      await flushPromises()
      expect(router.currentRoute.value.query).toEqual({ c: 'vaults' })
    })

    it('remembers search text that is not in the URL yet', async () => {
      const w = await open('/kaart')
      await w.get('input[type="search"]').setValue('lobster')
      await router.push('/quests')
      await router.push('/kaart')
      await flushPromises()
      expect(router.currentRoute.value.query.q).toBe('lobster')
    })
  })

  describe('found state', () => {
    it('counts a tick on a merged twin for the kept point, in counts, hide-found and the card', async () => {
      extraPoints = [
        { id: 'lore-scraps:20000:160000', categoryId: 'lore-scraps', x: 20000, y: 160000, name: "Ravanna's First Journal", aliases: ['ravannas-first-journal:20000:160000'] },
      ]
      useDataStore().data = currentData()
      const progress = useProgressStore()
      progress.state.points['ravannas-first-journal:20000:160000'] = { foundAt: '2026-09-28T12:00:00Z' }

      const w = await open('/kaart?c=lore-scraps')
      await checkbox(w, 'Lore', 'Lore Scraps')
      const row = () => w.findAll('[data-slot="map-category-row"]').find((r) => r.text().includes('Lore Scraps'))!
      expect(row().text()).toContain('1 / 2')
      expect(w.text()).toContain('2 punten')

      await router.push('/kaart?c=lore-scraps&h=1')
      await flushPromises()
      expect(w.text()).toContain('1 punt')

      await router.push('/kaart?c=lore-scraps&focus=lore-scraps:20000:160000')
      await flushPromises()
      const box = w.get('article [data-slot="check-row"] input')
      expect((box.element as HTMLInputElement).checked).toBe(true)
      await box.setValue(false)
      expect(progress.state.points).toEqual({})
      expect(row().text()).toContain('0 / 2')
    })

    it('opens the kept point for a focus link to a merged twin', async () => {
      extraPoints = [{ id: 'lore-scraps:20000:160000', categoryId: 'lore-scraps', x: 20000, y: 160000, aliases: ['ravannas-first-journal:20000:160000'] }]
      useDataStore().data = currentData()
      const w = await open('/kaart?focus=ravannas-first-journal:20000:160000')
      expect(router.currentRoute.value.query.focus).toBe('lore-scraps:20000:160000')
      expect(w.find('article').exists()).toBe(true)
    })

    it('ticks a unique spot through its reward, shared with Verzamelingen', async () => {
      extraCategories = [{ id: 'recipe-books', label: 'Recipe Books', group: 'unique', sources: [], count: 1 }]
      extraPoints = [{ id: 'recipe-books:201455:34717', categoryId: 'recipe-books', x: 201455, y: 34717 }]
      rewards = [{ id: 'recipe-book:meat-sandwich', kind: 'recipe-book', name: 'Meat Sandwich', pointIds: ['recipe-books:201455:34717'] }]
      useDataStore().data = currentData()
      const progress = useProgressStore()

      const w = await open('/kaart?focus=recipe-books:201455:34717')
      const card = w.get('article')
      const rows = card.findAll('[data-slot="check-row"]')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.text()).toContain('Meat Sandwich')
      expect(rows[0]!.get('[lang="en"]').text()).toBe('Meat Sandwich')
      expect(card.get('a[href="/verzamelingen?soort=recipe-book#unlocks"]').text()).toContain('Unieke unlocks')

      await rows[0]!.get('input').setValue(true)
      expect(progress.state.rewards['recipe-book:meat-sandwich']).toBeDefined()
      expect(progress.state.points).toEqual({})
      const row = w.findAll('[data-slot="map-category-row"]').find((r) => r.text().includes('Recipe Books'))!
      expect(row.text()).toContain('1 / 1')
    })

    it('shows an old map tick on a reward spot so it can be undone', async () => {
      extraCategories = [{ id: 'recipe-books', label: 'Recipe Books', group: 'unique', sources: [], count: 1 }]
      extraPoints = [{ id: 'recipe-books:201455:34717', categoryId: 'recipe-books', x: 201455, y: 34717 }]
      rewards = [{ id: 'recipe-book:meat-sandwich', kind: 'recipe-book', name: 'Meat Sandwich', pointIds: ['recipe-books:201455:34717'] }]
      useDataStore().data = currentData()
      const progress = useProgressStore()
      progress.state.points['recipe-books:201455:34717'] = { foundAt: '2026-09-28T12:00:00Z' }

      const w = await open('/kaart?focus=recipe-books:201455:34717')
      const mark = w.findAll('article [data-slot="check-row"]').find((r) => r.text().includes('Gevonden'))!
      expect(mark.text()).toContain('telt niet in Verzamelingen')
      await mark.get('input').setValue(false)
      expect(progress.state.points).toEqual({})
    })

    it('locks the found checkbox until progress is loaded', async () => {
      useProgressStore().loaded = false
      const w = await open('/kaart?focus=lore-scraps:29118:156991')
      const row = w.get('article [data-slot="check-row"]')
      expect((row.get('input').element as HTMLInputElement).disabled).toBe(true)
      expect(row.text()).toContain('Voortgang niet geladen')
    })
  })

  describe('wiki text and labels', () => {
    it('labels quest kinds in Dutch and marks quest names as English', async () => {
      const w = await open('/kaart?quest=Ratcatcher')
      const card = w.get('article')
      expect(card.text()).toContain('Hoofdverhaal · 3')
      expect(card.text()).not.toContain('Primary quest')
      expect(card.get('h2').attributes('lang')).toBe('en')
    })

    it('marks point names, descriptions and category labels as English', async () => {
      const w = await open('/kaart?focus=lore-scraps:29118:156991')
      const card = w.get('article')
      expect(card.get('h2').attributes('lang')).toBe('en')
      expect(card.get('[lang="nl"]').text()).toBe('(geschat)')
      const label = w.findAll('[data-slot="map-category-row"] [lang="en"]').map((e) => e.text())
      expect(label).toContain('Lore Scraps')
    })
  })

  describe('category group picker', () => {
    const picker = (w: VueWrapper, label: string) => {
      const li = w.findAll('li').find((l) => l.find('[data-slot="map-category-row"]').exists() && l.text().includes(label))
      if (!li) throw new Error(`no row for ${label}`)
      return li.get('[data-slot="map-group-picker"] select')
    }

    it('moves a category to another group by hand, and back', async () => {
      const w = await open('/kaart?c=vannaka')
      await checkbox(w, "NPC's", 'Vannaka')
      const select = picker(w, 'Vannaka')
      expect((select.element as HTMLSelectElement).value).toBe('')
      expect(select.find('option').text()).toBe("Automatisch: NPC's")
      await select.setValue('lore')
      await flushPromises()
      expect(saved.at(-1)?.categoryGroup).toEqual({ vannaka: 'lore' })
      expect(useDataStore().categoryById.get('vannaka')?.group).toBe('lore')
      expect(w.get('[data-slot="map-group-status"]').text()).toContain('Vannaka staat nu onder Lore')

      await checkbox(w, 'Lore', 'Vannaka')
      const again = picker(w, 'Vannaka')
      expect((again.element as HTMLSelectElement).value).toBe('lore')
      await again.setValue('')
      await flushPromises()
      expect(saved.at(-1)?.categoryGroup).toEqual({})
      expect(useDataStore().categoryById.get('vannaka')?.group).toBe('npc')
      expect(w.get('[data-slot="map-group-status"]').text()).toContain('Vannaka volgt weer de sync')
    })

    it('is read-only while overrides.json cannot be read', async () => {
      overridesError = 'overrides.json is geen geldige JSON'
      useDataStore().data = currentData()
      const w = await open('/kaart?c=vannaka')
      await checkbox(w, "NPC's", 'Vannaka')
      expect((picker(w, 'Vannaka').element as HTMLSelectElement).disabled).toBe(true)
    })
  })
})

describe('MapView kept alive', () => {
  const LORE = 'lore-scraps:29118:156991'
  const group = (w: VueWrapper, label: string) =>
    w.findAll('[data-slot="map-filter-group"]').find((g) => g.get('h3 .font-display').text() === label)!
  const mainSearch = (w: VueWrapper) => w.get('#map-filters input[type="search"]')

  /** Everything that moves the Leaflet map. */
  function spyOnMoves() {
    return {
      flyTo: vi.spyOn(L.Map.prototype, 'flyTo'),
      fitBounds: vi.spyOn(L.Map.prototype, 'fitBounds'),
      setView: vi.spyOn(L.Map.prototype, 'setView'),
      invalidateSize: vi.spyOn(L.Map.prototype, 'invalidateSize'),
    }
  }

  describe('coming back through the header tab', () => {
    it('shows the map as it was left: same view, filters, open groups, local filter and card', async () => {
      const w = await openKept('/kaart?c=monster-2,treasure-chest&p=2')
      // Open the large group and filter it locally, open a card.
      await group(w, 'Monsters').get('h3 button').trigger('click')
      await group(w, 'Monsters').get('input[type="search"]').setValue('monster 1')
      await router.push(`/kaart?c=monster-2,treasure-chest&p=2&focus=${LORE}`)
      await flushPromises()
      const root = w.get('#map-filters').element
      const mapEl = w.get('.ash-map').element
      const left = router.currentRoute.value.fullPath
      expect(w.get('article').text()).toContain('Scrawled Diary Page')
      const moves = spyOnMoves()
      const replace = vi.spyOn(router, 'replace')

      await tab('quests')
      expect(w.find('#map-filters').exists()).toBe(false)
      expect(w.text()).toContain('quests')
      await tab('map')

      expect(router.currentRoute.value.fullPath).toBe(left)
      expect(w.get('#map-filters').element).toBe(root)
      expect(w.get('.ash-map').element).toBe(mapEl)
      expect(group(w, 'Monsters').get('h3 button').attributes('aria-expanded')).toBe('true')
      expect((group(w, 'Monsters').get('input[type="search"]').element as HTMLInputElement).value).toBe('monster 1')
      expect(group(w, 'Monsters').findAll('[data-slot="map-category-row"]')).toHaveLength(7)
      expect(w.get('article').text()).toContain('Scrawled Diary Page')
      expect(w.findAll('[data-slot="toggle-chip"]').find((b) => b.text() === 'PL 2')!.attributes('aria-pressed')).toBe('true')
      // No fly, no fit, no resize handling, and nothing written to the address.
      expect(moves.flyTo).not.toHaveBeenCalled()
      expect(moves.fitBounds).not.toHaveBeenCalled()
      expect(moves.setView).not.toHaveBeenCalled()
      expect(moves.invalidateSize).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
    })

    it('keeps search text typed just before leaving, and never writes the address while away', async () => {
      vi.useFakeTimers()
      try {
        const w = await openKept('/kaart')
        await mainSearch(w).setValue('lobster')
        // Gone before the debounced write (300 ms).
        vi.advanceTimersByTime(100)
        await tab('quests')
        const replace = vi.spyOn(router, 'replace')
        const push = vi.spyOn(router, 'push')
        vi.advanceTimersByTime(1000)
        await flushPromises()
        expect(replace).not.toHaveBeenCalled()
        expect(router.currentRoute.value.fullPath).toBe('/quests')
        expect(useViewMemoryStore().locations.map).toBe('/kaart')

        await tab('map')
        vi.advanceTimersByTime(10)
        await flushPromises()
        expect((mainSearch(w).element as HTMLInputElement).value).toBe('lobster')
        expect(w.text()).toContain('Net Fishing Spot (Lobster)')
        // The address is brought in line with a replace, not with a new history entry.
        expect(router.currentRoute.value.query).toEqual({ c: 'vaults', q: 'lobster', qs: '1' })
        expect(replace).toHaveBeenCalledTimes(1)
        expect(push).toHaveBeenCalledTimes(1)
        expect(useViewMemoryStore().locations.map).toBe(router.currentRoute.value.fullPath)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not cancel a switch that is still loading the other view with a late write', async () => {
      vi.useFakeTimers()
      try {
        const w = await openKept('/kaart')
        let loaded!: () => void
        router.addRoute({
          path: '/traag',
          name: 'collections',
          component: () => new Promise((resolve) => (loaded = () => resolve({ render: () => h('p', 'collections') }))),
        })
        const replace = vi.spyOn(router, 'replace')
        await mainSearch(w).setValue('lobster')
        const leaving = router.push('/traag')
        // The debounced write falls in the time the other view needs to load.
        await vi.advanceTimersByTimeAsync(400)
        expect(replace).not.toHaveBeenCalled()
        loaded()
        await leaving
        await flushPromises()
        expect(router.currentRoute.value.fullPath).toBe('/traag')

        await tab('map')
        await flushPromises()
        expect(router.currentRoute.value.query.q).toBe('lobster')
      } finally {
        vi.useRealTimers()
      }
    })

    it('restores the scroll position of the sidebar and the card', async () => {
      const w = await openKept(`/kaart?focus=${LORE}`)
      const list = w.get('#map-filters .overflow-y-auto').element as HTMLElement
      const card = w.get('article').element.parentElement as HTMLElement
      list.scrollTop = 140
      list.dispatchEvent(new Event('scroll'))
      card.scrollTop = 60
      card.dispatchEvent(new Event('scroll'))

      await tab('quests')
      // A browser drops the scroll position of a detached element.
      list.scrollTop = 0
      card.scrollTop = 0
      await tab('map')

      expect(w.get('#map-filters .overflow-y-auto').element).toBe(list)
      expect(list.scrollTop).toBe(140)
      expect((w.get('article').element.parentElement as HTMLElement).scrollTop).toBe(60)
    })

    it('gives a sidebar that was hidden when you left its scroll position back when it shows again', async () => {
      // A wide screen: the sidebar is a column that can be hidden.
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }))
      const w = await openKept('/kaart')
      const list = w.get('#map-filters .overflow-y-auto').element as HTMLElement
      list.scrollTop = 140
      list.dispatchEvent(new Event('scroll'))
      await w.get('button[aria-label="Filters verbergen"]').trigger('click')
      expect((w.get('#map-filters').element as HTMLElement).style.display).toBe('none')
      // A hidden element has no scroll position, and a detached one loses it.
      list.scrollTop = 0

      await tab('quests')
      await tab('map')
      expect(list.scrollTop).toBe(0)
      await w.findAll('button').find((b) => b.text().startsWith('Filters'))!.trigger('click')
      await flushPromises()
      expect((w.get('#map-filters').element as HTMLElement).style.display).toBe('')
      expect(list.scrollTop).toBe(140)
    })

    it('puts the scroll position back on a sidebar that really has no box while it is hidden', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }))
      const w = await openKept('/kaart')
      const aside = w.get('#map-filters').element as HTMLElement
      const list = w.get('#map-filters .overflow-y-auto').element as HTMLElement
      // Like a browser: under display: none the list has no box, reads 0 and cannot be scrolled.
      const shown = () => aside.style.display !== 'none'
      let real = 0
      list.checkVisibility = shown
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => (shown() ? real : 0),
        set: (v: number) => {
          if (shown()) real = v
        },
      })
      list.scrollTop = 140
      list.dispatchEvent(new Event('scroll'))
      await w.get('button[aria-label="Filters verbergen"]').trigger('click')
      expect(shown()).toBe(false)

      await tab('quests')
      // The detached list lost its position.
      real = 0
      await tab('map')
      await w.findAll('button').find((b) => b.text().startsWith('Filters'))!.trigger('click')
      await flushPromises()
      expect(shown()).toBe(true)
      expect(list.scrollTop).toBe(140)

      // Hidden and shown again without a trip: a browser that resets it gets it back too.
      await w.get('button[aria-label="Filters verbergen"]').trigger('click')
      real = 0
      await w.findAll('button').find((b) => b.text().startsWith('Filters'))!.trigger('click')
      await flushPromises()
      expect(list.scrollTop).toBe(140)
    })

    it('drops a selected point that a sync removed while away, and cleans the address', async () => {
      const w = await openKept(`/kaart?c=lore-scraps&focus=${LORE}`)
      expect(w.get('article').text()).toContain('Scrawled Diary Page')
      await tab('quests')
      const gone = points.findIndex((p) => p.id === LORE)
      const [removed] = points.splice(gone, 1)
      try {
        useDataStore().data = { ...currentData(), meta: { ...currentData().meta!, syncedAt: '2026-09-29T08:00:00Z' } }
        await flushPromises()
        const replace = vi.spyOn(router, 'replace')
        // The tab still names the point; coming back is a return to that address.
        expect(useViewMemoryStore().linkTo('map')).toBe(`/kaart?c=lore-scraps&focus=${LORE}`)
        await tab('map')
        await flushPromises()
        expect(useViewMemoryStore().arrivals.map).toMatchObject({ kind: 'return' })
        expect(router.currentRoute.value.query).toEqual({ c: 'lore-scraps' })
        expect(replace).toHaveBeenCalledTimes(1)
        expect(w.find('article').exists()).toBe(false)
        expect(useViewMemoryStore().locations.map).toBe('/kaart?c=lore-scraps')
      } finally {
        points.splice(gone, 0, removed!)
      }
    })

    it('drops a quest card and pin mode for a quest that a sync removed while away', async () => {
      const w = await openKept('/kaart?quest=Ratcatcher')
      expect(w.get('article').text()).toContain('Ratcatcher')
      await tab('quests')
      const data = currentData()
      useDataStore().data = { ...data, quests: data.quests.filter((q) => q.id !== 'Ratcatcher') }
      await flushPromises()
      await tab('map')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/kaart')
      expect(w.find('article').exists()).toBe(false)

      // The same for a quest that was being pinned.
      useDataStore().data = currentData()
      await router.replace('/kaart?pin=Ratcatcher')
      await flushPromises()
      expect(w.text()).toContain('Klik op de kaart om de start van Ratcatcher te zetten')
      await tab('quests')
      useDataStore().data = { ...data, quests: data.quests.filter((q) => q.id !== 'Ratcatcher') }
      await flushPromises()
      await tab('map')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/kaart')
      expect(w.text()).not.toContain('Klik op de kaart om de start')
    })

    it('stays in pin mode', async () => {
      const w = await openKept('/kaart?pin=Ratcatcher')
      await tab('quests')
      await tab('map')
      expect(router.currentRoute.value.query.pin).toBe('Ratcatcher')
      expect(w.text()).toContain('Klik op de kaart om de start van Ratcatcher te zetten')
    })

    it('brings the address in line when a pin was saved while away', async () => {
      overrides = { ...emptyOverrides(), questStart: { Ratcatcher: { x: 1, y: 2 } } }
      useDataStore().data = currentData()
      const w = await openKept('/kaart?pin=Ratcatcher')
      const remove = w.findAll('button').find((b) => b.text().includes('Pin verwijderen'))!
      // The save is still on its way when you switch to another view.
      void remove.trigger('click')
      await tab('quests')
      await flushPromises()
      expect(saved.at(-1)?.questStart).toEqual({})
      expect(router.currentRoute.value.fullPath).toBe('/quests')

      await tab('map')
      await flushPromises()
      expect(router.currentRoute.value.query).toEqual({ quest: 'Ratcatcher' })
      expect(w.text()).not.toContain('Klik op de kaart om de start')
      expect(w.get('article').text()).toContain('Ratcatcher')
    })

    it('counts back and forward to where the map was left as coming back', async () => {
      const w = await openKept(`/kaart?focus=${LORE}`)
      const left = router.currentRoute.value.fullPath
      await tab('quests')
      const moves = spyOnMoves()
      router.back()
      await flushPromises()
      expect(useViewMemoryStore().arrival).toMatchObject({ view: 'map', kind: 'return', via: 'history' })
      expect(router.currentRoute.value.fullPath).toBe(left)
      expect(w.get('article').text()).toContain('Scrawled Diary Page')
      expect(moves.flyTo).not.toHaveBeenCalled()
      expect(moves.fitBounds).not.toHaveBeenCalled()
    })
  })

  describe('while another view is on screen', () => {
    it('leaves Escape alone', async () => {
      const w = await openKept(`/kaart?focus=${LORE}`)
      await tab('quests')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
      await tab('map')
      expect(router.currentRoute.value.query.focus).toBe(LORE)
      expect(w.find('article').exists()).toBe(true)

      // On screen it still closes the card.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
      expect(router.currentRoute.value.query.focus).toBeUndefined()
    })

    /** A key as Leaflet reads it (keyCode). */
    function key(target: EventTarget, keyCode: number) {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'keyCode', { value: keyCode })
      target.dispatchEvent(e)
      return e
    }

    /** A text field of the view that is on screen now. */
    function fieldElsewhere() {
      const field = document.createElement('input')
      document.body.appendChild(field)
      field.focus()
      return field
    }

    it('leaves the keys alone that Leaflet takes while its map has focus: 6, minus, plus and the arrows', async () => {
      const w = await openKept('/kaart')
      const container = w.get('.ash-map').element as HTMLElement
      // What Leaflet does on every mousedown on the map: its keydown listener goes on the document.
      container.focus()
      expect(document.activeElement).toBe(container)
      expect(key(container, 54).defaultPrevented).toBe(true)

      // Back or forward: no click that moves the focus away first.
      await router.push('/quests')
      await flushPromises()
      expect(w.find('.ash-map').exists()).toBe(false)
      const moves = spyOnMoves()
      const setZoom = vi.spyOn(L.Map.prototype, 'setZoom')
      const panBy = vi.spyOn(L.Map.prototype, 'panBy')
      const field = fieldElsewhere()
      for (const code of [54, 189, 187, 37, 38, 39, 40]) expect(key(field, code).defaultPrevented).toBe(false)
      expect(setZoom).not.toHaveBeenCalled()
      expect(panBy).not.toHaveBeenCalled()
      expect(moves.setView).not.toHaveBeenCalled()
      field.remove()

      // Back on the map the keys work again once it has focus.
      await tab('map')
      const again = w.get('.ash-map').element as HTMLElement
      again.focus()
      expect(key(again, 54).defaultPrevented).toBe(true)
    })

    it('also when the browser sends no blur for the map that leaves the page', async () => {
      const w = await openKept('/kaart')
      const container = w.get('.ash-map').element as HTMLElement
      container.focus()
      // A browser that lets go of the focus without telling.
      container.blur = () => undefined
      await router.push('/quests')
      await flushPromises()
      const field = fieldElsewhere()
      expect(key(field, 54).defaultPrevented).toBe(false)
      expect(key(field, 37).defaultPrevented).toBe(false)
      field.remove()
    })

    it('picks up new data without touching the address', async () => {
      const w = await openKept('/kaart?c=lore-scraps')
      await tab('quests')
      const replace = vi.spyOn(router, 'replace')
      extraPoints = [{ id: 'lore-scraps:20000:160000', categoryId: 'lore-scraps', x: 20000, y: 160000, name: 'New Page' }]
      useDataStore().data = { ...currentData(), meta: { ...currentData().meta!, syncedAt: '2026-09-29T08:00:00Z' } }
      await flushPromises()
      expect(replace).not.toHaveBeenCalled()

      await tab('map')
      expect(w.text()).toContain('2 punten')
      expect(router.currentRoute.value.fullPath).toBe('/kaart?c=lore-scraps')
    })
  })

  describe('a link from another view', () => {
    it('flies to its target, once, after the map is back in the page with its real size, and keeps the filters', async () => {
      // jsdom has no layout: give the map container a size while it is in the page.
      let size = { width: 800, height: 600 }
      const sized = (el: Element) => el.isConnected && el.classList.contains('ash-map')
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
        return sized(this) ? size.width : 0
      })
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
        return sized(this) ? size.height : 0
      })
      const w = await openKept('/kaart?c=treasure-chest&p=5&ps=1')
      await group(w, 'Monsters').get('h3 button').trigger('click')
      await tab('quests')
      // The window was resized while the map was away.
      size = { width: 500, height: 700 }
      const seen: Array<{ connected: boolean; size: L.Point }> = []
      const flyTo = vi.spyOn(L.Map.prototype, 'flyTo').mockImplementation(function (this: L.Map) {
        seen.push({ connected: this.getContainer().isConnected, size: this.getSize() })
        return this
      })

      await router.push('/kaart?quest=Ratcatcher')
      await flushPromises()
      expect(useViewMemoryStore().arrival).toMatchObject({ view: 'map', kind: 'fresh', via: 'link', first: false })
      expect(flyTo).toHaveBeenCalledTimes(1)
      expect(seen).toEqual([{ connected: true, size: L.point(500, 700) }])
      // The quest start, moved up by a quarter of the new height so the bottom sheet does not cover it.
      const target = flyTo.mock.calls[0]![0] as L.LatLng
      expect(target.lng).toBeCloseTo(15183, 0)
      expect(target.lat).toBeCloseTo(178853 + 175 / (2 ** 3.5 * MULT), 0)
      expect(router.currentRoute.value.query).toEqual({ c: 'treasure-chest', p: '5', ps: '1', quest: 'Ratcatcher' })
      expect(w.get('article').text()).toContain('Ratcatcher')
      // What the link does not mention stays: the open group.
      expect(group(w, 'Monsters').get('h3 button').attributes('aria-expanded')).toBe('true')
    })

    it('flies again for the target that is already selected', async () => {
      const w = await openKept(`/kaart?focus=${LORE}`)
      const left = router.currentRoute.value.fullPath
      await tab('quests')
      const flyTo = vi.spyOn(L.Map.prototype, 'flyTo')

      // Exactly the address the map was left at, but through a link: 'Toon op kaart' once more.
      await router.push(left)
      await flushPromises()
      expect(useViewMemoryStore().arrival).toMatchObject({ view: 'map', kind: 'fresh', via: 'link' })
      expect(flyTo).toHaveBeenCalledTimes(1)
      expect(w.get('article').text()).toContain('Scrawled Diary Page')

      // And a bare link to the same point, after the filters changed.
      await (await checkbox(w, 'Chests', 'Treasure Chest')).setValue(true)
      await flushPromises()
      await tab('quests')
      await router.push(`/kaart?focus=${LORE}`)
      await flushPromises()
      expect(flyTo).toHaveBeenCalledTimes(2)
      expect(String(router.currentRoute.value.query.c)).toContain('treasure-chest')
      expect(router.currentRoute.value.query.focus).toBe(LORE)
    })

    it('turns the category of a focused point back on', async () => {
      const w = await openKept(`/kaart?focus=${LORE}`)
      await (await checkbox(w, 'Lore', 'Lore Scraps')).setValue(false)
      await flushPromises()
      expect(String(router.currentRoute.value.query.c)).not.toContain('lore-scraps')
      await tab('quests')
      await router.push(`/kaart?focus=${LORE}`)
      await flushPromises()
      expect(String(router.currentRoute.value.query.c)).toContain('lore-scraps')
    })

    it('opens another card at the top', async () => {
      const w = await openKept(`/kaart?focus=${LORE}`)
      const card = w.get('article').element.parentElement as HTMLElement
      card.scrollTop = 80
      card.dispatchEvent(new Event('scroll'))
      await tab('quests')
      await router.push('/kaart?focus=vaults:37482:191753')
      await flushPromises()
      const next = w.get('article').element.parentElement as HTMLElement
      expect(next).not.toBe(card)
      expect(w.get('article').text()).toContain('Bekijk in Verzamelingen')
      expect(next.scrollTop).toBe(0)
    })

    it('closes the drawer on a narrow screen, which the tab leaves as it was', async () => {
      const w = await openKept('/kaart')
      const open = () => w.get('#map-filters').classes().includes('translate-x-0')
      expect(open()).toBe(false)
      await w.findAll('button').find((b) => b.text().startsWith('Filters'))!.trigger('click')
      expect(open()).toBe(true)

      await tab('quests')
      await tab('map')
      expect(open()).toBe(true)

      await tab('quests')
      await router.push('/kaart?quest=Ratcatcher')
      await flushPromises()
      expect(open()).toBe(false)
      expect(w.get('article').text()).toContain('Ratcatcher')
    })

    it('shows the whole land for filters without a spot, and drops the old selection', async () => {
      const w = await openKept(`/kaart?focus=${LORE}`)
      await tab('quests')
      const moves = spyOnMoves()
      await router.push('/kaart?c=treasure-chest&r=Brynmoor&p=2&ps=1')
      await flushPromises()
      expect(moves.fitBounds).toHaveBeenCalledTimes(1)
      expect(moves.flyTo).not.toHaveBeenCalled()
      expect(router.currentRoute.value.query).toEqual({ c: 'treasure-chest', r: 'Brynmoor', p: '2', ps: '1' })
      expect(w.find('article').exists()).toBe(false)
      expect(w.text()).toContain('1 punt')
    })

    it('handles back to an older address of the map like a link', async () => {
      const w = await openKept(`/kaart?focus=${LORE}`)
      const first = router.currentRoute.value.fullPath
      await tab('quests')
      await router.push('/kaart?quest=Ratcatcher')
      await flushPromises()
      const flyTo = vi.spyOn(L.Map.prototype, 'flyTo')
      // Back to quests, and back once more to the map as it was at first.
      router.back()
      await flushPromises()
      expect(router.currentRoute.value.name).toBe('quests')
      router.back()
      await flushPromises()
      expect(useViewMemoryStore().arrival).toMatchObject({ view: 'map', kind: 'fresh', via: 'history' })
      expect(router.currentRoute.value.fullPath).toBe(first)
      expect(flyTo).toHaveBeenCalledTimes(1)
      expect(w.get('article').text()).toContain('Scrawled Diary Page')
    })
  })

  it('goes to the base path from its own tab: selection gone, filters kept', async () => {
    const w = await openKept(`/kaart?c=lore-scraps,treasure-chest&focus=${LORE}`)
    // The tab of the view you are on links to its base path.
    expect(useViewMemoryStore().linkTo('map')).toBe('/kaart')
    await router.push('/kaart')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ c: 'lore-scraps,treasure-chest' })
    expect(w.find('article').exists()).toBe(false)
  })
})
