import { describe, expect, it } from 'vitest'
import {
  buildSections,
  countByStatus,
  countDone,
  filterEntries,
  matchesSearch,
  orderEntries,
  pickDefaultQuestId,
  questEntry,
  searchEntries,
  type QuestEntry,
} from './quests-list'
import type { Quest, QuestProgress } from './types'

function quest(id: string, partial: Partial<Quest> = {}): Quest {
  return {
    id,
    name: id,
    kind: 'secondary',
    location: '',
    steps: [
      { id: `${id}:s:1`, text: 'One' },
      { id: `${id}:s:2`, text: 'Two' },
    ],
    stepsSource: 'walkthrough',
    items: [],
    rewards: [],
    requires: [],
    wikiUrl: `https://dragonwilds.runescape.wiki/w/${id}`,
    ...partial,
  }
}

const ACTIVE: QuestProgress = { steps: [], items: [] }
const entry = (q: Quest, qp?: QuestProgress) => questEntry(q, qp)
const ids = (entries: QuestEntry[]) => entries.map((e) => e.quest.id)

// A slice of the real list: order and regions as on the wiki's Quests page.
const QUESTS: Quest[] = [
  quest('Dog Days', { order: 8, region: 'Ghornfell', location: 'Speak to Vannaka at the centre of Stormtouched Highlands.' }),
  quest('Warding Off Danger', { kind: 'primary', location: 'Speak to the Wise Old Man, north-east of the Bramblemead Valley ruins.' }),
  quest('Growing Pains', { order: 1, region: 'Brynmoor' }),
  quest('Ratcatcher', { kind: 'primary', order: 3, region: 'Temple Woods', location: 'Speak to Vannaka south of the Windmill.' }),
  quest('Goblin Diplomacy', { order: 4, region: 'Brynmoor' }),
  quest('First Steps', { kind: 'primary', order: 1, region: 'Temple Woods' }),
  quest('Heartstrings', { order: 7, region: 'Ghornfell' }),
  quest('Lost Letter', {}),
]

describe('questEntry', () => {
  it('counts only checked steps that still exist', () => {
    const q = quest('A')
    const e = entry(q, { steps: ['A:s:1', 'A:s:gone'], items: [] })
    expect(e.stepsDone).toBe(1)
    expect(e.stepsTotal).toBe(2)
    expect(e.state).toBe('active')
    expect(e.fraction).toBe(0.5)
  })

  it('is done when marked by hand or when every step is checked', () => {
    expect(entry(quest('A'), { done: true, steps: [], items: [] }).state).toBe('done')
    expect(entry(quest('A'), { steps: ['A:s:1', 'A:s:2'], items: [] }).state).toBe('done')
    expect(entry(quest('A')).state).toBe('open')
  })
})

describe('buildSections', () => {
  const sections = buildSections(QUESTS.map((q) => entry(q)))

  it('orders the main story by wiki order, quests without an order last', () => {
    expect(sections[0]!.title).toBe('Hoofdverhaal')
    expect(ids(sections[0]!.groups[0]!.entries)).toEqual(['First Steps', 'Ratcatcher', 'Warding Off Danger'])
  })

  it('groups side quests by region in order of first appearance, region-less last', () => {
    const side = sections[1]!
    expect(side.title).toBe('Zijquests')
    expect(side.groups.map((g) => g.label)).toEqual(['Brynmoor', 'Ghornfell', 'Overige'])
    expect(ids(side.groups[1]!.entries)).toEqual(['Heartstrings', 'Dog Days'])
  })

  it('only adds Tertiair when there is a tertiary quest', () => {
    expect(sections.map((s) => s.kind)).toEqual(['primary', 'secondary'])
    const withTertiary = buildSections([...QUESTS, quest('Odd Job', { kind: 'tertiary' })].map((q) => entry(q)))
    expect(withTertiary.map((s) => s.title)).toEqual(['Hoofdverhaal', 'Zijquests', 'Tertiair'])
  })

  it('leaves out a kind when the filter removed all its quests', () => {
    const onlySide = buildSections([entry(QUESTS[0]!)])
    expect(onlySide.map((s) => s.kind)).toEqual(['secondary'])
  })

  it('gives the flat list order', () => {
    expect(ids(orderEntries(QUESTS.map((q) => entry(q))))).toEqual([
      'First Steps',
      'Ratcatcher',
      'Warding Off Danger',
      'Growing Pains',
      'Goblin Diplomacy',
      'Heartstrings',
      'Dog Days',
      'Lost Letter',
    ])
  })
})

describe('search and status filter', () => {
  const entries = QUESTS.map((q) =>
    q.id === 'Ratcatcher' ? entry(q, { ...ACTIVE, steps: ['Ratcatcher:s:1'] }) : q.id === 'First Steps' ? entry(q, { done: true, steps: [], items: [] }) : entry(q),
  )

  it('matches name, region and start location, every word, ignoring case and accents', () => {
    expect(matchesSearch(QUESTS[3]!, 'windmill')).toBe(true)
    expect(matchesSearch(QUESTS[3]!, 'TEMPLE ratc')).toBe(true)
    expect(matchesSearch(QUESTS[3]!, 'temple brynmoor')).toBe(false)
    expect(matchesSearch(QUESTS[0]!, 'ghornfell')).toBe(true)
    expect(matchesSearch(QUESTS[0]!, 'Stormtouched')).toBe(true)
    expect(matchesSearch(quest('Café'), 'cafe')).toBe(true)
    expect(matchesSearch(QUESTS[0]!, '   ')).toBe(true)
  })

  it('counts per status over the search results', () => {
    expect(countByStatus(entries)).toEqual({ all: 8, open: 6, active: 1, done: 1 })
    const vannaka = searchEntries(entries, 'vannaka')
    expect(ids(vannaka).sort()).toEqual(['Dog Days', 'Ratcatcher'])
    expect(countByStatus(vannaka)).toEqual({ all: 2, open: 1, active: 1, done: 0 })
  })

  it('combines search and status', () => {
    expect(ids(filterEntries(entries, { q: 'vannaka', status: 'active' }))).toEqual(['Ratcatcher'])
    expect(ids(filterEntries(entries, { q: '', status: 'done' }))).toEqual(['First Steps'])
    expect(filterEntries(entries, { q: '', status: 'all' })).toHaveLength(8)
  })

  it('counts done quests for the overall bar', () => {
    expect(countDone(entries)).toEqual({ done: 1, total: 8 })
  })
})

describe('pickDefaultQuestId', () => {
  it('prefers the first quest in progress, in list order', () => {
    const entries = QUESTS.map((q) =>
      q.id === 'Dog Days' || q.id === 'Growing Pains' ? entry(q, { ...ACTIVE, steps: [`${q.id}:s:1`] }) : entry(q),
    )
    expect(pickDefaultQuestId(entries)).toBe('Growing Pains')
  })

  it('falls back to the first open main story quest by order', () => {
    const entries = QUESTS.map((q) => (q.id === 'First Steps' ? entry(q, { done: true, steps: [], items: [] }) : entry(q)))
    expect(pickDefaultQuestId(entries)).toBe('Ratcatcher')
  })

  it('falls back to the first quest when the main story is done', () => {
    const entries = QUESTS.map((q) => (q.kind === 'primary' ? entry(q, { done: true, steps: [], items: [] }) : entry(q)))
    expect(pickDefaultQuestId(entries)).toBe('First Steps')
  })

  it('returns undefined without quests', () => {
    expect(pickDefaultQuestId([])).toBeUndefined()
  })
})
