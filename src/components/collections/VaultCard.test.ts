// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { indexRewardsByName, vaultAnchor, vaultRecipeGroups } from '@/lib/collections-vaults'
import type { Reward, Vault } from '@/lib/types'
import { useProgressStore } from '@/stores/progress'
import VaultCard from './VaultCard.vue'

// Never talk to the middleware from tests.
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

const takla: Vault = {
  id: 'Takla Kara',
  name: 'Takla Kara',
  order: 4,
  power: 3,
  area: 'Fractured Plains',
  region: 'Ghornfell',
  recipes: [
    { name: "Paladin's helm", set: 'Paladin armour set' },
    { name: "Paladin's platebody", set: 'Paladin armour set' },
    { name: 'Mystery shortbow' },
  ],
  pointId: 'vaults:73020:118948',
  wikiUrl: 'https://dragonwilds.runescape.wiki/w/Takla_Kara',
}

const rewards: Reward[] = [
  { id: 'effigy:paladins-helm', kind: 'effigy', name: "Paladin's Helm", set: 'Paladin armour set', vaultId: 'Takla Kara' },
  { id: 'effigy:paladins-platebody', kind: 'effigy', name: "Paladin's Platebody", set: 'Paladin armour set', vaultId: 'Takla Kara' },
]

function mountCard(vault: Vault = takla) {
  const card = { vault, anchor: vaultAnchor(vault.id), groups: vaultRecipeGroups(vault, indexRewardsByName(rewards), rewards) }
  const Host = defineComponent({
    setup() {
      const progress = useProgressStore()
      const owned = computed(() => new Set(Object.keys(progress.state.rewards)))
      return () => h(TooltipProvider, null, () => h(VaultCard, { card, owned: owned.value }))
    },
  })
  return mount(Host, { global: { stubs: { RouterLink: RouterLinkStub } }, attachTo: document.body })
}

describe('VaultCard', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders the anchor, the set and tickable recipes, and plain text for unmatched ones', () => {
    const w = mountCard()
    expect(w.get('article').attributes('id')).toBe('vault-takla-kara')
    expect(w.text()).toContain('Paladin armour set')
    expect(w.text()).toContain('Other recipes')
    expect(w.findAll('[data-slot="check-row"]')).toHaveLength(2)
    expect(w.text()).toContain('Mystery shortbow')
    expect(w.text()).toContain('Fractured Plains, Ghornfell')
    const map = w.findAllComponents(RouterLinkStub).find((l) => typeof l.props('to') === 'object')
    expect(map?.props('to')).toEqual({ path: '/map', query: { focus: 'vaults:73020:118948' } })
  })

  it('marks wiki text as English and its own labels as page language', () => {
    const w = mountCard()
    expect(w.get('h3 span[lang="en"]').text()).toBe('Takla Kara')
    expect(w.get('[data-slot="location-text"]').attributes('lang')).toBe('en')
    const labels = w.findAll('p.italic').map((p) => [p.text(), p.attributes('lang')])
    expect(labels).toContainEqual(['Paladin armour set', 'en'])
    expect(labels).toContainEqual(['Other recipes', undefined])
    expect(w.findAll('[data-slot="check-row"] span[lang="en"]').map((x) => x.text())).toEqual([
      "Paladin's helm",
      "Paladin's platebody",
    ])
  })

  it('binds recipe rows to rewards in progress', async () => {
    const w = mountCard()
    const progress = useProgressStore()
    await w.findAll('[data-slot="check-row"] input')[0]!.setValue(true)
    expect(progress.hasReward('effigy:paladins-helm')).toBe(true)
  })

  it('has no vault core toggles (cores respawn in the game)', () => {
    const w = mountCard()
    expect(w.findAll('button[aria-label^="Core "]')).toHaveLength(0)
    expect(w.text()).not.toMatch(/vault cores?/i)
  })

  it('offers to tick the remaining recipes after marking the vault done', async () => {
    const w = mountCard()
    const progress = useProgressStore()
    progress.toggleReward('effigy:paladins-helm', true)
    await w.vm.$nextTick()

    const done = w.findAll('button').find((b) => b.text().trim() === 'Done')!
    await done.trigger('click')
    expect(progress.isVaultDone('Takla Kara')).toBe(true)
    expect(done.attributes('aria-pressed')).toBe('true')
    expect(w.get('article').attributes('data-shade')).toBe('light')

    const offer = w.findAll('button').find((b) => b.text().includes("Tick off this vault's recipes too"))
    expect(offer).toBeTruthy()
    expect(w.text()).toContain('1 recipe still open')
    await offer!.trigger('click')
    expect(progress.hasReward('effigy:paladins-platebody')).toBe(true)
    expect(w.text()).not.toContain("Tick off this vault's recipes too")
  })

  it('makes no offer when every recipe is already ticked', async () => {
    const w = mountCard()
    const progress = useProgressStore()
    for (const r of rewards) progress.toggleReward(r.id, true)
    await w.vm.$nextTick()
    await w.findAll('button').find((b) => b.text().trim() === 'Done')!.trigger('click')
    expect(w.text()).not.toContain("Tick off this vault's recipes too")
  })

  it('says so when a vault has no recipes and no wiki page', () => {
    const w = mountCard({ id: 'Uzzer Kara', name: 'Uzzer Kara', order: 11, power: 7, area: 'Umbral Sands', region: 'Umbral Sands', recipes: [] })
    expect(w.text()).toContain('No recipes known')
    expect(w.text()).toContain('No wiki page yet')
    expect(w.text()).not.toContain('Show on map')
    expect(w.text()).toContain('Umbral Sands')
    expect(w.text()).not.toContain('Umbral Sands, Umbral Sands')
  })
})
