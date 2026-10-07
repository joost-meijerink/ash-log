// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptyOverrides } from '@/lib/normalize'
import type { AppData, MapCategory, MapPoint, Reward } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import ChestMatrix from './ChestMatrix.vue'
import RewardBrowser from './RewardBrowser.vue'

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

const rewards: Reward[] = [
  { id: 'plan:blue-standing-torch', kind: 'plan', name: 'Blue Standing Torch', recipe: 'PLAN: Blue Standing Torch', group: 'Lighting', source: 'Dropped by monsters' },
  { id: 'plan:garou-rug', kind: 'plan', name: 'Garou Rug', recipe: 'PLAN: Garou Rug', group: 'Garou' },
  { id: 'vestige:wooden-training-sword', kind: 'vestige', name: 'Wooden Training Sword', recipe: 'An Educational Blade', group: 'Brynmoor' },
  { id: 'vestige:garou-greataxe', kind: 'vestige', name: 'Garou Greataxe', recipe: 'A Brutal Bladehead', group: 'Ghornfell' },
  { id: 'quest:anti-dragon-shield', kind: 'quest', name: 'Anti-Dragon Shield', requirement: 'Vertentis Kara', questId: 'Dragon Slayer' },
  { id: 'effigy:paladins-helm', kind: 'effigy', name: "Paladin's Helm", group: 'Ghornfell', set: 'Paladin armour set', source: 'Dragonkin effigy in Takla Kara', vaultId: 'Takla Kara' },
]

const cat = (id: string, label: string, group: MapCategory['group'], count: number): MapCategory => ({ id, label, group, sources: [], count })
const categories = [cat('treasure-chest', 'Treasure Chest', 'chest', 3), cat('buried-treasure', 'Buried Treasure', 'chest', 1), cat('gold-ore-node', 'Gold Ore Node', 'resource', 1)]
const points: MapPoint[] = [
  { id: 'treasure-chest:1:1', categoryId: 'treasure-chest', x: 1, y: 1, region: 'Brynmoor', power: 2 },
  { id: 'treasure-chest:2:2', categoryId: 'treasure-chest', x: 2, y: 2, region: 'Dowdun Reach', power: 6 },
  { id: 'treasure-chest:3:3', categoryId: 'treasure-chest', x: 3, y: 3, region: 'Dowdun Reach' },
  { id: 'buried-treasure:4:4', categoryId: 'buried-treasure', x: 4, y: 4, region: 'Brynmoor', power: 2 },
  { id: 'gold-ore-node:5:5', categoryId: 'gold-ore-node', x: 5, y: 5, region: 'Brynmoor' },
  // No level and nothing in the region to estimate one from: stays Unknown.
  { id: 'treasure-chest:6:6', categoryId: 'treasure-chest', x: 6, y: 6, region: 'Scorned Wilderness' },
]

function seed() {
  const data = useDataStore()
  const app: AppData = {
    ready: true,
    map: { categories, points },
    quests: [],
    vaults: [],
    rewards,
    overrides: emptyOverrides(),
  }
  data.data = app
}

function makeRouter(): Router {
  const Empty = defineComponent({ render: () => null })
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/collections', name: 'collections', component: Empty },
      { path: '/map', name: 'map', component: Empty },
      { path: '/quests/:questId?', name: 'quests', component: Empty },
    ],
  })
}

async function mountWith(router: Router, render: () => ReturnType<typeof h>) {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, render) })
  const w = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  await router.isReady()
  await flushPromises()
  return w
}

describe('RewardBrowser', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seed()
  })

  function render() {
    const progress = useProgressStore()
    const owned = computed(() => new Set(Object.keys(progress.state.rewards)))
    return () => h(RewardBrowser, { owned: owned.value, haystacks: new Map() })
  }

  it('shows the tracked kinds under All (no plans) and switches kind through ?kind=', async () => {
    const router = makeRouter()
    await router.push('/collections#vault-takla-kara')
    const w = await mountWith(router, render())
    expect(w.findAll('[data-slot="check-row"]')).toHaveLength(rewards.filter((r) => r.kind !== 'plan').length)
    expect(w.text()).not.toContain('Blue Standing Torch')

    const chips = w.findAll('[data-slot="toggle-chip"]')
    const chipTexts = chips.map((c) => c.text().replace(/\s+/g, ''))
    expect(chipTexts.some((t) => t.startsWith('Plans'))).toBe(false)
    expect(chipTexts).toContain('Vestiges0/2')
    // Kinds without any reward get no chip.
    expect(chipTexts.some((t) => t.startsWith('Patterns'))).toBe(false)
    await chips.find((c) => c.text().startsWith('Vestiges'))!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ kind: 'vestige' })
    expect(router.currentRoute.value.hash).toBe('#vault-takla-kara')
    expect(w.findAll('[data-slot="check-row"]')).toHaveLength(2)
    expect(w.text()).toContain('via An Educational Blade')
  })

  it('searches and hides owned rewards, keeping counts', async () => {
    const router = makeRouter()
    await router.push('/collections?hide=1')
    const w = await mountWith(router, render())
    useProgressStore().toggleReward('vestige:wooden-training-sword', true)
    await flushPromises()
    expect(w.text()).not.toContain('Wooden Training Sword')
    expect(w.text().replace(/\s+/g, '')).toContain('Vestiges1/2')

    await w.get('input[type="search"]').setValue('garou')
    expect(w.findAll('[data-slot="check-row"]')).toHaveLength(1)
    expect(w.text()).toContain('Garou Greataxe')
    expect(w.text()).toContain('1 of 4 shown')

    await w.get('input[type="search"]').setValue('zzz')
    expect(w.text()).toContain('Nothing found')
  })

  it('links quests and vaults', async () => {
    const router = makeRouter()
    await router.push('/collections')
    const w = await mountWith(router, render())
    const hrefs = w.findAll('a').map((a) => a.attributes('href'))
    expect(hrefs).toContain('/quests/Dragon%20Slayer')
    expect(hrefs).toContain('#vault-takla-kara')
    // The effigy source only repeats the vault link, so it is left out.
    expect(w.text()).not.toContain('Dragonkin effigy in Takla Kara')
  })
})

describe('RewardBrowser notes and map links', () => {
  const graveSource = 'PLAN: headstone 01 and PLAN: grave 1 are available from 3 spectral platforming chests.'
  const grave = (n: number): Reward => ({
    id: `vestige:grave-0${n}`,
    kind: 'vestige',
    name: `Grave 0${n}`,
    group: 'Fellhollow',
    via: ['drops'],
    source: graveSource,
  })
  const list: Reward[] = [
    grave(1),
    grave(2),
    grave(3),
    { id: 'vestige:spectral-book', kind: 'vestige', name: 'Spectral Book', group: 'Fellhollow', via: ['drops'], source: 'Reward from the activity X Marks the Spot.' },
    {
      id: 'vestige:black-sword',
      kind: 'vestige',
      name: 'Black Sword',
      group: 'Dowdun Reach',
      via: ['shops', 'drops'],
      source: 'Also found in chests in Dowdun Reach.',
      pointIds: ['vestige-spot:10:20', 'vestige-spot:30:40'],
    },
  ]

  beforeEach(() => {
    setActivePinia(createPinia())
    seed()
    const data = useDataStore()
    data.data = { ...data.data!, rewards: list }
  })

  const render = () => () => h(RewardBrowser, { owned: new Set<string>(), haystacks: new Map() })

  it('shows what a group shares once under its heading: via as interface text, the source as wiki text', async () => {
    const router = makeRouter()
    await router.push('/collections')
    const w = await mountWith(router, render())

    const notes = w.findAll('[data-group-note]')
    expect(notes).toHaveLength(1)
    const note = notes[0]!
    expect(note.text()).toContain('Dropped by monsters')
    expect(note.text()).toContain('For 3 of the 4:')
    expect(note.get('[data-slot="location-text"]').attributes('lang')).toBe('en')
    // The long source is shown once, not on every grave.
    expect(w.text().split(graveSource)).toHaveLength(2)

    const rows = w.findAll('[data-slot="check-row"]')
    const row = (name: string) => rows.find((r) => r.text().includes(name))!
    expect(row('Grave 01').find('[data-slot="reward-note"]').exists()).toBe(false)
    expect(row('Spectral Book').text()).toContain('Reward from the activity X Marks the Spot.')
    expect(row('Spectral Book').text()).not.toContain('Dropped by monsters')

    // A group of one keeps everything on its row, labels in the interface font.
    const sword = row('Black Sword')
    expect(sword.get('[data-slot="reward-via"]').text()).toBe('Dropped by monsters, sold in shops')
    expect(sword.get('[data-slot="reward-via"]').attributes('lang')).toBeUndefined()
    expect(sword.get('[data-slot="location-text"]').text()).toBe('Also found in chests in Dowdun Reach.')
    expect(sword.get('[data-slot="location-text"]').attributes('lang')).toBe('en')
    expect(sword.get('span[lang="en"]').text()).toBe('Black Sword')
  })

  it('links an unlock to its first map spot', async () => {
    const router = makeRouter()
    await router.push('/collections')
    const w = await mountWith(router, render())
    const links = w.findAll('a[data-map-link]')
    expect(links).toHaveLength(1)
    expect(links[0]!.text()).toContain('Show on map')
    expect(decodeURIComponent(links[0]!.attributes('href')!)).toBe('/map?focus=vestige-spot:10:20')
  })

  it('finds unlocks by their via label and by a shared source', async () => {
    const router = makeRouter()
    await router.push('/collections')
    const w = await mountWith(router, render())
    await w.get('input[type="search"]').setValue('sold in shops')
    expect(w.findAll('[data-slot="check-row"]').map((r) => r.text())).toEqual([expect.stringContaining('Black Sword')])
    await w.get('input[type="search"]').setValue('spectral platforming')
    expect(w.findAll('[data-slot="check-row"]')).toHaveLength(3)
    // The shared note stays under the heading while searching.
    expect(w.get('[data-group-note]').text()).toContain(graveSource)
  })
})

describe('ChestMatrix', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seed()
  })

  it('counts chest points per region and power level and links to the map', async () => {
    const router = makeRouter()
    await router.push('/collections')
    const w = await mountWith(router, () => h(ChestMatrix))
    const rows = w.findAll('tbody tr').map((tr) => tr.findAll('th, td').map((c) => c.text().replace(/\s+/g, ' ').trim()))
    // Columns: region, PL 2, PL 6, Unknown, Total. The Dowdun Reach chest without a level gets
    // the estimate from the other chest there (map-power.ts), marked with an asterisk.
    expect(rows).toEqual([
      ['Brynmoor', '2', '·0', '·0', '2'],
      ['Dowdun Reach', '·0', '2 *', '·0', '2'],
      ['Scorned Wilderness', '·0', '·0', '1', '1'],
    ])
    const estimated = w.get('a[href*="Dowdun+Reach&p=6"]')
    expect(estimated.attributes('title')).toBe('1 of these 2 has an estimated level: the wiki lists none')
    expect(estimated.attributes('aria-label')).toBe('2 chests in Dowdun Reach, power level 6 (1 estimated): show on the map')
    expect(w.find('[data-estimate-note]').exists()).toBe(true)
    const hrefs = w.findAll('tbody a').map((a) => decodeURIComponent(a.attributes('href')!))
    // A power level cell uses the strict power filter, so the map shows exactly that count.
    expect(hrefs).toContain('/map?c=buried-treasure,treasure-chest&r=Brynmoor&p=2&ps=1')
    expect(hrefs).toContain('/map?c=buried-treasure,treasure-chest&r=Dowdun+Reach&p=6&ps=1')
    // Totals have no power filter, so they also show chests without a level.
    expect(hrefs).toContain('/map?c=buried-treasure,treasure-chest&r=Dowdun+Reach')
    const footHrefs = w.findAll('tfoot a').map((a) => decodeURIComponent(a.attributes('href')!))
    expect(footHrefs).toEqual([
      '/map?c=buried-treasure,treasure-chest&p=2&ps=1',
      '/map?c=buried-treasure,treasure-chest&p=6&ps=1',
      '/map?c=buried-treasure,treasure-chest',
    ])
    expect(w.text()).toContain("To see those chests on the map, pick a total")
    expect(w.get('tbody th').attributes('lang')).toBe('en')

    // Switch Buried Treasure off: counts and links follow.
    await w.findAll('[data-slot="toggle-chip"]').find((c) => c.text().startsWith('Buried Treasure'))!.trigger('click')
    const first = w.findAll('tbody tr')[0]!.findAll('td')
    expect(first[0]!.text()).toBe('1')
    expect(decodeURIComponent(first[0]!.get('a').attributes('href')!)).toBe('/map?c=treasure-chest&r=Brynmoor&p=2&ps=1')
  })
})
