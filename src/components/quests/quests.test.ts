// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { REWARD_VIA_LABEL } from '@/lib/collections-rewards'
import { emptyOverrides } from '@/lib/normalize'
import type { AppData, AppQuest, Overrides, Reward } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import QuestItemsEditor from './QuestItemsEditor.vue'
import QuestRewards from './QuestRewards.vue'
import QuestRewardTree from './QuestRewardTree.vue'
import QuestSteps from './QuestSteps.vue'
import { rewardTree } from '@/lib/quests-detail'

// Never talk to the middleware from tests.
vi.mock('@/lib/api', () => ({
  api: {
    data: vi.fn(),
    progress: vi.fn(),
    saveProgress: vi.fn(async (p: unknown) => p),
    saveOverrides: vi.fn(async (o: unknown) => o),
    startSync: vi.fn(),
    syncStatus: vi.fn(),
  },
}))

const quest: AppQuest = {
  id: 'Ratcatcher',
  name: 'Ratcatcher',
  kind: 'primary',
  order: 3,
  region: 'Temple Woods',
  location: 'Speak to Vannaka south of the Windmill.',
  steps: [
    { id: 'Ratcatcher:s:1', text: 'Talk to Vannaka.', section: 'Part I: Rats' },
    { id: 'Ratcatcher:s:2', text: 'Kill four rats.', section: 'Part I: Rats' },
    { id: 'Ratcatcher:s:3', text: 'Cook the meat.', section: 'The kitchen' },
  ],
  stepsSource: 'quick-guide',
  items: [
    { id: 'Ratcatcher:i:raw-rat-meat', name: 'Raw rat meat', qty: 4 },
    { id: 'Ratcatcher:i:ash-log', name: 'Ash log', qty: 6 },
  ],
  rewards: [],
  requires: [],
  wikiUrl: 'https://dragonwilds.runescape.wiki/w/Ratcatcher',
  itemsOverridden: false,
}

function appData(overrides: Overrides = emptyOverrides(), quests: AppQuest[] = [quest], rewards: Reward[] = []): AppData {
  return { ready: true, map: { categories: [], points: [] }, quests, vaults: [], rewards, overrides }
}

/** IconButton needs the TooltipProvider that App.vue sets up. */
function withTooltips<P extends Record<string, unknown>>(component: unknown, props: P) {
  return defineComponent({
    setup: () => () => h(TooltipProvider, null, { default: () => h(component as never, props) }),
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api.saveOverrides).mockReset().mockImplementation(async (o: unknown) => o as Overrides)
  vi.mocked(api.data).mockReset().mockResolvedValue(appData())
})

function checkItems(ids: string[]) {
  const progress = useProgressStore()
  progress.state.quests.Ratcatcher = { steps: ['Ratcatcher:s:1'], items: ids }
  progress.loaded = true
  return progress
}

describe('QuestItemsEditor', () => {
  it('saves the edited list as an override with ids from the names', async () => {
    const data = useDataStore()
    // saveOverrides reloads first, so what is "on disk" (api.data) is what the update starts from.
    vi.mocked(api.data).mockResolvedValue(appData({ ...emptyOverrides(), questItems: { Other: [] } }))
    data.data = appData({ ...emptyOverrides(), questItems: { Other: [] } })
    const onClose = vi.fn()
    const w = mount(withTooltips(QuestItemsEditor, { quest, onClose }), { attachTo: document.body })

    const names = w.findAll('input[data-field="name"]')
    await names[1]!.setValue('Ash logs')
    await w.findAll('input[data-field="qty"]')[1]!.setValue('8x')
    await w.get('form').trigger('submit')
    await flushPromises()

    expect(api.saveOverrides).toHaveBeenCalledWith({
      ...emptyOverrides(),
      questItems: {
        Other: [],
        Ratcatcher: [
          { id: 'Ratcatcher:i:raw-rat-meat', name: 'Raw rat meat', qty: 4 },
          { id: 'Ratcatcher:i:ash-logs', name: 'Ash logs', qty: 8 },
        ],
      },
    })
    expect(onClose).toHaveBeenCalled()
    w.unmount()
  })

  it('drops checkmarks of items that are no longer in the saved list', async () => {
    useDataStore().data = appData()
    const progress = checkItems(['Ratcatcher:i:ash-log', 'Ratcatcher:i:raw-rat-meat', 'Ratcatcher:i:gone-before'])
    const onClose = vi.fn()
    const w = mount(withTooltips(QuestItemsEditor, { quest, onClose }), { attachTo: document.body })

    await w.findAll('input[data-field="name"]')[1]!.setValue('Ash logs')
    await w.get('form').trigger('submit')
    await flushPromises()

    expect(onClose).toHaveBeenCalled()
    expect(progress.state.quests.Ratcatcher).toEqual({ steps: ['Ratcatcher:s:1'], items: ['Ratcatcher:i:raw-rat-meat'] })
    w.unmount()
  })

  it('keeps every checkmark when saving fails', async () => {
    useDataStore().data = appData()
    vi.mocked(api.saveOverrides).mockRejectedValue(new Error('Disk full'))
    const progress = checkItems(['Ratcatcher:i:ash-log'])
    const onClose = vi.fn()
    const w = mount(withTooltips(QuestItemsEditor, { quest, onClose }), { attachTo: document.body })

    await w.findAll('input[data-field="name"]')[1]!.setValue('Ash logs')
    await w.get('form').trigger('submit')
    await flushPromises()

    expect(onClose).not.toHaveBeenCalled()
    expect(w.text()).toContain("Couldn't save: Disk full")
    expect(progress.state.quests.Ratcatcher?.items).toEqual(['Ratcatcher:i:ash-log'])
    w.unmount()
  })

  it('does not touch checkmarks before progress is loaded', async () => {
    useDataStore().data = appData()
    const progress = useProgressStore()
    progress.state.quests.Ratcatcher = { steps: [], items: ['Ratcatcher:i:ash-log'] }
    const w = mount(withTooltips(QuestItemsEditor, { quest }), { attachTo: document.body })

    await w.findAll('input[data-field="name"]')[1]!.setValue('Ash logs')
    await w.get('form').trigger('submit')
    await flushPromises()

    expect(api.saveOverrides).toHaveBeenCalled()
    expect(progress.state.quests.Ratcatcher?.items).toEqual(['Ratcatcher:i:ash-log'])
    w.unmount()
  })

  it('keeps only checkmarks on wiki items after going back to the wiki list', async () => {
    const own: AppQuest = { ...quest, items: [{ id: 'Ratcatcher:i:rope', name: 'Rope' }, { id: 'Ratcatcher:i:ash-log', name: 'Ash log' }], itemsOverridden: true }
    const ownOverrides = { ...emptyOverrides(), questItems: { Ratcatcher: own.items } }
    useDataStore().data = appData(ownOverrides, [own])
    // First load (before the write) still has the own list, the reload after it the wiki list.
    vi.mocked(api.data).mockResolvedValueOnce(appData(ownOverrides, [own])).mockResolvedValue(appData())
    const progress = checkItems(['Ratcatcher:i:rope', 'Ratcatcher:i:ash-log'])
    const onClose = vi.fn()
    const w = mount(withTooltips(QuestItemsEditor, { quest: own, onClose }), { attachTo: document.body })

    await w.findAll('button').find((b) => b.text().includes('Back to the wiki list'))!.trigger('click')
    await flushPromises()
    const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Use wiki list'))
    expect(document.body.textContent).toContain('the rest go')
    confirm!.click()
    await flushPromises()

    expect(api.saveOverrides).toHaveBeenCalledWith(emptyOverrides())
    expect(onClose).toHaveBeenCalled()
    expect(progress.state.quests.Ratcatcher?.items).toEqual(['Ratcatcher:i:ash-log'])
    w.unmount()
  })

  it('leaves checkmarks alone when the reload after going back fails', async () => {
    const own: AppQuest = { ...quest, items: [{ id: 'Ratcatcher:i:rope', name: 'Rope' }], itemsOverridden: true }
    const ownOverrides = { ...emptyOverrides(), questItems: { Ratcatcher: own.items } }
    useDataStore().data = appData(ownOverrides, [own])
    vi.mocked(api.data).mockResolvedValueOnce(appData(ownOverrides, [own])).mockRejectedValue(new Error('offline'))
    const progress = checkItems(['Ratcatcher:i:rope'])
    const w = mount(withTooltips(QuestItemsEditor, { quest: own }), { attachTo: document.body })

    await w.findAll('button').find((b) => b.text().includes('Back to the wiki list'))!.trigger('click')
    await flushPromises()
    ;[...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Use wiki list'))!.click()
    await flushPromises()

    expect(api.saveOverrides).toHaveBeenCalled()
    expect(progress.state.quests.Ratcatcher?.items).toEqual(['Ratcatcher:i:rope'])
    w.unmount()
  })

  it('shows errors and does not save an invalid list', async () => {
    useDataStore().data = appData()
    const w = mount(withTooltips(QuestItemsEditor, { quest }), { attachTo: document.body })

    await w.findAll('input[data-field="name"]')[1]!.setValue('raw rat meat')
    await w.findAll('input[data-field="qty"]')[0]!.setValue('0')
    await w.get('form').trigger('submit')
    await flushPromises()

    expect(api.saveOverrides).not.toHaveBeenCalled()
    expect(w.text()).toContain('A whole number from 1')
    expect(w.text()).toContain("This item's already on the list")
    expect(w.findAll('[aria-invalid="true"]')).toHaveLength(2)
    w.unmount()
  })
})

describe('QuestSteps', () => {
  it('groups steps under their headings and toggles progress', async () => {
    const progress = useProgressStore()
    progress.loaded = true
    const w = mount(QuestSteps, { props: { quest } })

    expect(w.findAll('h3').map((x) => x.text())).toEqual(['Part I: Rats'])
    expect(w.findAll('h4').map((x) => x.text())).toEqual(['The kitchen'])
    expect(w.text()).toContain('From the Quick guide')

    await w.findAll('input[type="checkbox"]')[0]!.setValue(true)
    expect(progress.state.quests.Ratcatcher?.steps).toEqual(['Ratcatcher:s:1'])
    expect(w.text()).toContain('1 / 3')
  })

  it('disables the checkboxes until progress is loaded', () => {
    const w = mount(QuestSteps, { props: { quest } })
    expect(w.findAll('input[type="checkbox"]').every((i) => (i.element as HTMLInputElement).disabled)).toBe(true)
  })

  it('marks the wiki text as English', () => {
    const w = mount(QuestSteps, { props: { quest } })
    expect(w.get('h3').attributes('lang')).toBe('en')
    const texts = w.findAll('[data-slot="check-row-label"] span[lang="en"]').map((x) => x.text())
    expect(texts).toEqual(['Talk to Vannaka.', 'Kill four rats.', 'Cook the meat.'])
  })

  it('shows what a section needs under its heading, the rest above the steps', () => {
    const withNeeds: AppQuest = {
      ...quest,
      needs: [
        { section: 'The kitchen', needed: 'A cooking range.', recommended: '2 ash logs' },
        { recommended: 'Food and a weapon.' },
        { section: 'Gone section', needed: 'A torch.' },
      ],
    }
    const w = mount(QuestSteps, { props: { quest: withNeeds } })
    const blocks = w.findAll('[data-slot="quest-needs"]')
    expect(blocks).toHaveLength(2)

    // Above the steps: the need without a section, and the one whose section has no steps (with its name).
    const before = blocks[0]!
    expect(before.text()).toContain('Recommended: Food and a weapon.')
    expect(before.text()).toContain('Gone section')
    expect(before.text()).toContain('Needed: A torch.')
    expect(before.element.compareDocumentPosition(w.get('ul').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Under 'The kitchen', between its heading and its steps.
    const kitchen = blocks[1]!
    expect(kitchen.text()).toContain('Needed: A cooking range.')
    expect(kitchen.text()).toContain('Recommended: 2 ash logs')
    expect(kitchen.element.previousElementSibling?.textContent?.trim()).toBe('The kitchen')
    expect(kitchen.findAll('[data-slot="location-text"]').map((x) => x.attributes('lang'))).toEqual(['en', 'en'])
    // Step ids are untouched.
    expect(w.findAll('input[type="checkbox"]')).toHaveLength(3)
  })

  it('shows needs above the empty state when there are no steps', () => {
    const w = mount(QuestSteps, { props: { quest: { ...quest, steps: [], needs: [{ needed: 'A torch.' }] } } })
    expect(w.get('[data-slot="quest-needs"]').text()).toContain('Needed: A torch.')
    expect(w.text()).toContain('No steps')
  })
})

describe('QuestRewards', () => {
  const unlocks: Reward[] = [
    { id: 'recipe-book:meat-pie', kind: 'recipe-book', name: 'Meat Pie', questId: 'Ratcatcher', via: ['shops'], source: 'Also in Brynmoor.', pointIds: ['recipe-book-spot:5:6'] },
    { id: 'quest:rat-hat', kind: 'quest', name: 'Rat Hat', questId: 'Ratcatcher', requirement: 'Finish the quest' },
    { id: 'plan:other', kind: 'plan', name: 'Other', questId: 'Other quest' },
  ]

  async function mountRewards() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] })
    useDataStore().data = appData(emptyOverrides(), [quest], unlocks)
    const w = mount(QuestRewards, { props: { quest }, global: { plugins: [router] } })
    await router.isReady()
    return w
  }

  it('lists the quest unlocks with via labels, wiki text and a map link', async () => {
    const w = await mountRewards()
    const rows = w.findAll('[data-slot="check-row"]')
    expect(rows).toHaveLength(2)
    const pie = rows.find((r) => r.text().includes('Meat Pie'))!
    expect(pie.get('[data-slot="reward-via"]').text()).toBe(REWARD_VIA_LABEL.shops)
    expect(pie.get('[data-slot="location-text"]').attributes('lang')).toBe('en')
    expect(decodeURIComponent(pie.get('a[data-map-link]').attributes('href')!)).toBe('/map?focus=recipe-book-spot:5:6')
    const hat = rows.find((r) => r.text().includes('Rat Hat'))!
    expect(hat.get('span[lang="en"].italic').text()).toBe('Finish the quest')
    expect(hat.find('a[data-map-link]').exists()).toBe(false)
  })
})

describe('QuestRewardTree', () => {
  it('renders indented reward lines as nested lists', () => {
    const w = mount(QuestRewardTree, {
      props: { nodes: rewardTree(['Reward pack', '  Tome of the Titan', '    +750 XP', 'Recipe']) },
    })
    const top = w.get('ul')
    expect(top.findAll(':scope > li')).toHaveLength(2)
    expect(w.findAll('ul')).toHaveLength(3)
    expect(w.findAll('ul ul ul li')[0]!.text()).toBe('+750 XP')
  })
})
