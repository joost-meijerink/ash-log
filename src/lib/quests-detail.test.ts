import { describe, expect, it } from 'vitest'
import {
  dependentsOf,
  groupSteps,
  parseRewardLines,
  placeNeeds,
  questKindLabel,
  rewardTree,
  stepsSourceLabel,
} from './quests-detail'
import type { Quest, QuestNeed, QuestStep } from './types'

const step = (n: number, section?: string): QuestStep => ({ id: `Q:s:${n}`, text: `Step ${n}`, ...(section ? { section } : {}) })

describe('questKindLabel', () => {
  it('shows the order for the main story', () => {
    expect(questKindLabel({ kind: 'primary', order: 3 })).toBe('Main story · 3')
    expect(questKindLabel({ kind: 'primary' })).toBe('Main story')
    expect(questKindLabel({ kind: 'secondary', order: 4 })).toBe('Side quest')
    expect(questKindLabel({ kind: 'tertiary' })).toBe('Tertiary')
  })

  it('names the step source', () => {
    expect(stepsSourceLabel('quick-guide')).toBe('From the Quick guide')
    expect(stepsSourceLabel('walkthrough')).toBe('From the walkthrough on the wiki')
  })
})

describe('groupSteps', () => {
  it('keeps steps without a section in a heading-less first group', () => {
    const groups = groupSteps([step(1), step(2, 'Building a plot'), step(3, 'Building a plot')])
    expect(groups.map((g) => [g.section, g.level, g.steps.length])).toEqual([
      [undefined, 1, 1],
      ['Building a plot', 1, 2],
    ])
  })

  it('nests headings under a Part heading', () => {
    const groups = groupSteps([
      step(1, 'A Mysterious Mirror...'),
      step(2, 'Part I: The Dark Fortress...'),
      step(3, 'Part III: Shard Hunting'),
      step(4, 'The Cathedral'),
      step(5, 'The Garrison'),
      step(6, 'Part IV: Remember the Titans'),
    ])
    expect(groups.map((g) => g.level)).toEqual([1, 1, 1, 2, 2, 1])
  })

  it('does not merge a heading that comes back later', () => {
    const groups = groupSteps([step(1, 'A'), step(2, 'B'), step(3, 'A')])
    expect(groups.map((g) => g.section)).toEqual(['A', 'B', 'A'])
    expect(new Set(groups.map((g) => g.key)).size).toBe(3)
  })

  it('returns nothing for no steps', () => {
    expect(groupSteps([])).toEqual([])
  })
})

describe('placeNeeds', () => {
  // Modelled on 'Even More Restless Ghosts': {{Needed}} blocks per walkthrough section.
  const groups = groupSteps([step(1), step(2, 'Windswept ghost'), step(3, 'Windswept ghost'), step(4, 'Grave ghost'), step(5, 'Windswept ghost')])
  const windswept: QuestNeed = {
    section: 'Windswept ghost',
    needed: 'Building materials in order to build a small house.',
    recommended: '24 ash logs to build a square foundation, four walls, and 1 floor piece as roof.',
  }

  it('puts a block under the first group with the same section', () => {
    const placed = placeNeeds(groups, [windswept, { section: 'Grave ghost', needed: 'Clay Decoration (Fired)' }])
    expect(placed.before).toEqual([])
    expect([...placed.byGroup.keys()]).toEqual([groups[1]!.key, groups[2]!.key])
    expect(placed.byGroup.get(groups[1]!.key)).toEqual([windswept])
    expect(placed.byGroup.get(groups[2]!.key)).toEqual([{ section: 'Grave ghost', needed: 'Clay Decoration (Fired)' }])
  })

  it('puts blocks without a matching section above the steps and drops empty ones', () => {
    const placed = placeNeeds(groups, [
      { recommended: 'Lodestone access to Fellhollow; Food, drink, and gear' },
      { section: 'Tomb ghost', needed: 'Mining equipment of power level 4 or higher.' },
      { section: 'Windswept ghost', needed: '  ', recommended: '' },
      { section: '  Grave ghost ', needed: ' 1 torch ' },
    ])
    expect(placed.before).toEqual([
      { recommended: 'Lodestone access to Fellhollow; Food, drink, and gear' },
      { section: 'Tomb ghost', needed: 'Mining equipment of power level 4 or higher.' },
    ])
    expect(placed.byGroup.get(groups[2]!.key)).toEqual([{ section: 'Grave ghost', needed: '1 torch' }])
    expect(placed.byGroup.has(groups[1]!.key)).toBe(false)
  })

  it('handles quests without needs or without steps', () => {
    expect(placeNeeds(groups, undefined)).toEqual({ before: [], byGroup: new Map() })
    expect(placeNeeds([], [windswept]).before).toEqual([windswept])
  })
})

describe('reward lines', () => {
  // Black Knight's Fortress on the wiki.
  const LINES = [
    "1x Black Knight's Fortress reward pack",
    '  1x Tome of the Titan',
    '    +750 XP to Magic, Ranged, and Attack',
    "  1x Titan's wrath",
    "Recipe to creating the Titan's wrath 2h sword",
  ]

  it('reads two spaces as one level', () => {
    expect(parseRewardLines(LINES).map((l) => l.depth)).toEqual([0, 1, 2, 1, 0])
    expect(parseRewardLines(LINES)[2]!.text).toBe('+750 XP to Magic, Ranged, and Attack')
  })

  it('drops blank lines and never skips a level', () => {
    expect(parseRewardLines(['    Orphan', '', 'Top', '      Deep'])).toEqual([
      { text: 'Orphan', depth: 0 },
      { text: 'Top', depth: 0 },
      { text: 'Deep', depth: 1 },
    ])
  })

  it('builds a tree for nested lists', () => {
    const tree = rewardTree(LINES)
    expect(tree.map((n) => n.text)).toEqual(["1x Black Knight's Fortress reward pack", "Recipe to creating the Titan's wrath 2h sword"])
    expect(tree[0]!.children.map((n) => n.text)).toEqual(['1x Tome of the Titan', "1x Titan's wrath"])
    expect(tree[0]!.children[0]!.children[0]!.text).toBe('+750 XP to Magic, Ranged, and Attack')
    expect(tree[1]!.children).toEqual([])
  })

  it('handles flat and empty lists', () => {
    expect(rewardTree(['Crystal bow', 'Recipe for crystal bow'])).toHaveLength(2)
    expect(rewardTree([])).toEqual([])
  })
})

describe('dependentsOf', () => {
  const q = (id: string, requires: string[], partial: Partial<Quest> = {}): Quest => ({
    id,
    name: id,
    kind: 'secondary',
    location: '',
    steps: [],
    stepsSource: 'walkthrough',
    items: [],
    rewards: [],
    requires,
    wikiUrl: '',
    ...partial,
  })

  it('lists quests that require this one, in list order', () => {
    const quests = [
      q('Letters for the Dead', ['Withering Heights'], { order: 19 }),
      q('Black Knight', ['Withering Heights'], { kind: 'primary', order: 7 }),
      q('The Wild Hunt', ['Withering Heights'], { order: 15 }),
      q('Withering Heights', ['Dragon Slayer'], { kind: 'primary', order: 6 }),
    ]
    expect(dependentsOf('Withering Heights', quests).map((x) => x.id)).toEqual(['Black Knight', 'The Wild Hunt', 'Letters for the Dead'])
    expect(dependentsOf('Nobody', quests)).toEqual([])
  })
})
