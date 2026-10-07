import { describe, expect, it } from 'vitest'
import {
  buildRewardList,
  collectionQuery,
  compareGroups,
  groupNote,
  isTrackedReward,
  kindLabel,
  kindTallies,
  mergeCollectionQuery,
  parseCollectionQuery,
  rewardHaystack,
  rewardNote,
  rewardRegion,
  rewardVia,
  REWARD_KINDS,
  rowNote,
  sameCollectionState,
  targetsUnlockList,
  trackedRewards,
  viaText,
  type RewardFilter,
} from './collections-rewards'
import { NO_REGION_LABEL } from './quests-list'
import type { Reward } from './types'

// Modelled on data/wiki/rewards.json.
const rewards: Reward[] = [
  { id: 'plan:blue-standing-torch', kind: 'plan', name: 'Blue Standing Torch', recipe: 'PLAN: Blue Standing Torch', group: 'Lighting', source: 'Dropped by monsters' },
  { id: 'plan:armadyl-flag-10', kind: 'plan', name: 'Armadyl Flag 10', recipe: 'PLAN: Armadyl Flag 10', group: 'Dowdun Reach', source: 'Dropped by monsters' },
  { id: 'plan:armadyl-flag-02', kind: 'plan', name: 'Armadyl Flag 2', recipe: 'PLAN: Armadyl Flag 2', group: 'Dowdun Reach', source: 'Dropped by monsters' },
  { id: 'plan:garou-rug', kind: 'plan', name: 'Garou Rug', recipe: 'PLAN: Garou Rug', group: 'Garou', source: 'Garou camps' },
  { id: 'plan:fell-lantern', kind: 'plan', name: 'Fell Lantern', recipe: 'PLAN: Fell Lantern', group: 'Fellhollow' },
  { id: 'vestige:wooden-training-sword', kind: 'vestige', name: 'Wooden Training Sword', recipe: 'An Educational Blade', group: 'Brynmoor', source: 'Located inside a chest on top of the Temple of Saradomin ledge' },
  { id: 'vestige:black-greataxe', kind: 'vestige', name: 'Black Greataxe', recipe: 'Bloodstained Hilt', group: 'Dowdun Reach', source: 'Sold in shops' },
  { id: 'vestige:ghorn-blade', kind: 'vestige', name: 'Ghorn Blade', recipe: 'A Chipped Blade', group: 'Ghornfell' },
  { id: 'quest:anti-dragon-shield', kind: 'quest', name: 'Anti-Dragon Shield', requirement: 'Vertentis Kara', questId: 'Dragon Slayer' },
  { id: 'effigy:paladins-helm', kind: 'effigy', name: "Paladin's Helm", group: 'Ghornfell', set: 'Paladin armour set', source: 'Dragonkin effigy in Takla Kara', vaultId: 'Takla Kara' },
  { id: 'recipe-book:meat-sandwich', kind: 'recipe-book', name: 'Meat Sandwich' },
  { id: 'fishing-trophy:pristine-herring-trophy', kind: 'fishing-trophy', name: 'Pristine Herring Trophy', recipe: 'Pristine Herring', source: 'Rod fishing spots in Ghornfell.' },
  { id: 'pattern:fellhollow-cape', kind: 'pattern', name: 'Fellhollow Cape', recipe: 'PATTERN: Fell Cape', source: "Located in Hope's Fall behind rocks" },
]

const owned = new Set(['plan:blue-standing-torch', 'plan:armadyl-flag-02', 'vestige:black-greataxe', 'orphan:gone'])
const filter = (f: Partial<RewardFilter>): RewardFilter => ({ kind: 'all', query: '', hideOwned: false, ...f })

describe('kind labels', () => {
  it('has a label for every kind and All', () => {
    // Gear first, then recipe books and trophies. Plans are not tracked.
    expect(REWARD_KINDS.map(kindLabel)).toEqual([
      'Patterns',
      'Vestiges',
      'Quest rewards',
      'Effigies',
      'Recipe books',
      'Fishing trophies',
    ])
    expect(kindLabel('all')).toBe('All')
  })
})

describe('kindTallies', () => {
  it('counts done and total per kind and overall, ignoring unknown ids', () => {
    const t = kindTallies(rewards, owned)
    expect(t.all).toEqual({ done: 3, total: rewards.length })
    expect(t.plan).toEqual({ done: 2, total: 5 })
    expect(t.vestige).toEqual({ done: 1, total: 3 })
    expect(t['fishing-trophy']).toEqual({ done: 0, total: 1 })
  })
})

describe('compareGroups', () => {
  it('puts named groups first, then regions in play order, then no group', () => {
    const groups = ['Dowdun Reach', undefined, 'Lighting', 'Fellhollow', 'Ancient Dragonkin', 'Brynmoor']
    expect([...groups].sort(compareGroups)).toEqual([
      'Ancient Dragonkin',
      'Lighting',
      'Brynmoor',
      'Fellhollow',
      'Dowdun Reach',
      undefined,
    ])
  })
})

describe('buildRewardList', () => {
  it('shows the tracked kinds for All, gear first and without plans', () => {
    const view = buildRewardList(rewards, owned, filter({}))
    const tracked = rewards.filter((r) => r.kind !== 'plan')
    expect(view.blocks.map((b) => b.kind)).toEqual([
      'pattern',
      'vestige',
      'quest',
      'effigy',
      'recipe-book',
      'fishing-trophy',
    ])
    expect(view.visible).toBe(tracked.length)
    expect(view.total).toBe(tracked.length)
    expect(trackedRewards(rewards)).toEqual(tracked)
    expect(isTrackedReward({ kind: 'plan' })).toBe(false)
  })

  it('groups a kind by wiki sub-heading with done/total and natural name order', () => {
    const [plans] = buildRewardList(rewards, owned, filter({ kind: 'plan' })).blocks
    expect(plans!.tally).toEqual({ done: 2, total: 5 })
    expect(plans!.groups.map((g) => [g.label, g.tally.done, g.tally.total])).toEqual([
      ['Garou', 0, 1],
      ['Lighting', 1, 1],
      ['Fellhollow', 0, 1],
      ['Dowdun Reach', 1, 2],
    ])
    expect(plans!.groups[3]!.rewards.map((r) => r.name)).toEqual(['Armadyl Flag 2', 'Armadyl Flag 10'])
  })

  it('uses one unlabeled group for kinds without sub-headings', () => {
    const [quests] = buildRewardList(rewards, owned, filter({ kind: 'quest' })).blocks
    expect(quests!.groups).toHaveLength(1)
    expect(quests!.groups[0]!.label).toBeUndefined()
  })

  it('hides owned rewards but keeps the full counts', () => {
    const view = buildRewardList(rewards, owned, filter({ kind: 'plan', hideOwned: true }))
    const plans = view.blocks[0]!
    expect(plans.groups.map((g) => g.label)).toEqual(['Garou', 'Fellhollow', 'Dowdun Reach'])
    expect(plans.groups[2]!.tally).toEqual({ done: 1, total: 2 })
    expect(plans.visible).toBe(3)
    expect(view.total).toBe(5)
  })

  it('searches name, recipe, source and group, every word must match', () => {
    const names = (query: string) =>
      buildRewardList(rewards, owned, filter({ query }))
        .blocks.flatMap((b) => b.groups.flatMap((g) => g.rewards.map((r) => r.name)))
    // Plans are not tracked, so 'torch' and 'garou' find nothing under All.
    expect(names('torch')).toEqual([])
    expect(names('educational')).toEqual(['Wooden Training Sword'])
    expect(names('temple saradomin')).toEqual(['Wooden Training Sword'])
    expect(names('garou')).toEqual([])
    expect(names('ghornfell')).toEqual(['Ghorn Blade', "Paladin's Helm", 'Pristine Herring Trophy'])
    expect(names('PALADIN set')).toEqual(["Paladin's Helm"])
    expect(names('dragon slayer')).toEqual(['Anti-Dragon Shield'])
    expect(names('hope’s fall')).toEqual(['Fellhollow Cape'])
    expect(names('nothing like this')).toEqual([])
  })

  it('drops blocks without matches', () => {
    const view = buildRewardList(rewards, owned, filter({ query: 'sandwich' }))
    expect(view.blocks.map((b) => b.kind)).toEqual(['recipe-book'])
    expect(view.visible).toBe(1)
  })

  it('uses precomputed haystacks when given', () => {
    const haystacks = new Map(rewards.map((r) => [r.id, rewardHaystack(r)]))
    haystacks.set('recipe-book:meat-sandwich', rewardHaystack(rewards[10]!, ['secret alias']))
    const view = buildRewardList(rewards, owned, filter({ query: 'secret alias' }), haystacks)
    expect(view.visible).toBe(1)
  })
})

describe('via labels', () => {
  it('keeps known values in a fixed order without duplicates', () => {
    expect(rewardVia({})).toEqual([])
    expect(rewardVia({ via: ['shops', 'drops', 'shops'] })).toEqual(['drops', 'shops'])
    expect(rewardVia({ via: ['bogus' as never, 'shops'] })).toEqual(['shops'])
  })

  it('writes the labels as one phrase', () => {
    expect(viaText([])).toBe('')
    expect(viaText(['drops'])).toBe('Dropped by monsters')
    expect(viaText(['shops'])).toBe('Sold in shops')
    expect(viaText(['shops', 'drops'])).toBe('Dropped by monsters, sold in shops')
  })

  it('makes the labels searchable', () => {
    const r: Reward = { id: 'vestige:black-sword', kind: 'vestige', name: 'Black Sword', via: ['shops'], source: 'Also found in chests.' }
    const view = (query: string) => buildRewardList([r], new Set(), filter({ query })).visible
    expect(view('sold shops')).toBe(1)
    expect(view('also found')).toBe(1)
    expect(view('monsters')).toBe(0)
  })
})

describe('reward notes', () => {
  const unlock = (name: string, extra: Partial<Reward> = {}): Reward => ({
    id: `vestige:${name.toLowerCase().replace(/\W+/g, '-')}`,
    kind: 'vestige',
    name,
    group: 'Fellhollow',
    ...extra,
  })
  const long = 'PLAN: headstone 01 and PLAN: grave 1 are available from 3 spectral platforming chests.'

  it('leaves out a source that only repeats the vault link', () => {
    const effigy = rewards[9]!
    expect(rewardNote(effigy)).toEqual({ via: [] })
    expect(rewardNote(effigy, 'Some Other Kara')).toEqual({ via: [], source: 'Dragonkin effigy in Takla Kara' })
    expect(rewardNote(unlock('A', { via: ['drops'], source: '  ' }))).toEqual({ via: ['drops'] })
  })

  it('has nothing to share for a single reward or all different notes', () => {
    expect(groupNote([unlock('A', { source: 'x' })])).toBeUndefined()
    expect(groupNote([unlock('A', { source: 'x' }), unlock('B', { source: 'y' }), unlock('C')])).toBeUndefined()
    expect(groupNote([unlock('A'), unlock('B')])).toBeUndefined()
  })

  it('shares a source that every reward has (old data: the phrase is in the source)', () => {
    const group = [unlock('A', { source: 'Dropped by monsters' }), unlock('B', { source: 'Dropped by monsters' })]
    const note = groupNote(group)
    expect(note).toEqual({ via: [], shared: { via: [], source: 'Dropped by monsters', count: 2 }, total: 2 })
    expect(rowNote(group[0]!, note)).toEqual({ via: [] })
  })

  it('shares via that every reward has and a source most rewards have', () => {
    const group = [
      unlock('Grave 01', { via: ['drops'], source: long }),
      unlock('Grave 02', { via: ['drops'], source: long }),
      unlock('Headstone 01', { via: ['drops'], source: long }),
      unlock('Spectral Book', { via: ['drops'], source: 'Reward from the activity X Marks the Spot.' }),
    ]
    const note = groupNote(group)!
    expect(note).toEqual({ via: ['drops'], shared: { via: [], source: long, count: 3 }, total: 4 })
    expect(rowNote(group[0]!, note)).toEqual({ via: [] })
    expect(rowNote(group[3]!, note)).toEqual({ via: [], source: 'Reward from the activity X Marks the Spot.' })
    // Without the group note a row shows everything.
    expect(rowNote(group[0]!)).toEqual({ via: ['drops'], source: long })
  })

  it('shares via on its own when the sources differ', () => {
    const group = [
      unlock('A', { via: ['drops'] }),
      unlock('B', { via: ['drops', 'shops'], source: 'Found in chests.' }),
      unlock('C', { via: ['drops'] }),
    ]
    const note = groupNote(group)!
    expect(note).toEqual({ via: ['drops'], total: 3 })
    expect(rowNote(group[0]!, note)).toEqual({ via: [] })
    expect(rowNote(group[1]!, note)).toEqual({ via: ['shops'], source: 'Found in chests.' })
  })

  it('shares a most-common note only when every other reward shows a note of its own', () => {
    const shops = (name: string) => unlock(name, { via: ['shops'] })
    const most = groupNote([shops('A'), shops('B'), shops('C'), unlock('D', { via: ['drops'] })])
    expect(most).toEqual({ via: [], shared: { via: ['shops'], count: 3 }, total: 4 })
    // D has no note at all, so a row without a note would be ambiguous: nothing is shared.
    expect(groupNote([shops('A'), shops('B'), shops('C'), unlock('D')])).toBeUndefined()
    // Half is not most.
    expect(groupNote([shops('A'), shops('B'), unlock('C', { via: ['drops'] }), unlock('D', { source: 'x' })])).toBeUndefined()
  })

  it('attaches the note to the group view, computed over the whole group', () => {
    const group = [
      unlock('Grave 01', { via: ['drops'], source: long }),
      unlock('Grave 02', { via: ['drops'], source: long }),
      unlock('Spectral Book', { via: ['drops'], source: 'Reward from X Marks the Spot.' }),
    ]
    const owned = new Set(['vestige:grave-01', 'vestige:grave-02'])
    const [block] = buildRewardList(group, owned, filter({ hideOwned: true })).blocks
    expect(block!.groups[0]!.rewards.map((r) => r.name)).toEqual(['Spectral Book'])
    expect(block!.groups[0]!.note).toEqual({ via: ['drops'], shared: { via: [], source: long, count: 2 }, total: 3 })
    expect(buildRewardList(rewards, owned, filter({ kind: 'quest' })).blocks[0]!.groups[0]!.note).toBeUndefined()
  })
})

describe('URL state', () => {
  it('parses kind and hide with safe fallbacks', () => {
    expect(parseCollectionQuery({})).toEqual({ kind: 'all', hideOwned: false })
    expect(parseCollectionQuery({ kind: 'vestige', hide: '1' })).toEqual({ kind: 'vestige', hideOwned: true })
    expect(parseCollectionQuery({ kind: ['effigy', 'plan'] })).toEqual({ kind: 'effigy', hideOwned: false })
    expect(parseCollectionQuery({ kind: 'bogus', hide: '0' })).toEqual({ kind: 'all', hideOwned: false })
  })

  it('writes only non-default values and keeps other keys', () => {
    expect(collectionQuery({ kind: 'all', hideOwned: false }, { kind: 'plan', x: 'y' })).toEqual({ x: 'y' })
    expect(collectionQuery({ kind: 'recipe-book', hideOwned: true })).toEqual({ kind: 'recipe-book', hide: '1' })
  })

  it('round-trips', () => {
    const state = { kind: 'fishing-trophy' as const, hideOwned: true }
    expect(parseCollectionQuery(collectionQuery(state))).toEqual(state)
  })

  it('keeps what a link from another screen does not name', () => {
    const kept = { kind: 'vestige' as const, hideOwned: true }
    // '/collections#vault-x': nothing named.
    expect(mergeCollectionQuery({}, kept)).toEqual(kept)
    expect(mergeCollectionQuery({ focus: 'x' }, kept)).toEqual(kept)
    // Only the kind, or only the switch.
    expect(mergeCollectionQuery({ kind: 'quest' }, kept)).toEqual({ kind: 'quest', hideOwned: true })
    expect(mergeCollectionQuery({ hide: '0' }, kept)).toEqual({ kind: 'vestige', hideOwned: false })
    expect(mergeCollectionQuery({ hide: '1' }, { kind: 'all', hideOwned: false })).toEqual({ kind: 'all', hideOwned: true })
    // Named, but not a kind: 'All'. An empty param counts as named too.
    expect(mergeCollectionQuery({ kind: 'all' }, kept)).toEqual({ kind: 'all', hideOwned: true })
    expect(mergeCollectionQuery({ kind: null, hide: '' }, kept)).toEqual({ kind: 'all', hideOwned: false })
    // Both named: the link says it all.
    expect(mergeCollectionQuery({ kind: 'effigy', hide: 'yes' }, { kind: 'all', hideOwned: false })).toEqual({ kind: 'effigy', hideOwned: true })
  })

  it('lets a link to the unlock list show what it points at: the hide switch goes off unless it is asked for', () => {
    const kept = { kind: 'vestige' as const, hideOwned: true }
    expect(mergeCollectionQuery({ kind: 'quest' }, kept, true)).toEqual({ kind: 'quest', hideOwned: false })
    expect(mergeCollectionQuery({ kind: 'all' }, kept, true)).toEqual({ kind: 'all', hideOwned: false })
    expect(mergeCollectionQuery({ kind: 'quest', hide: '1' }, kept, true)).toEqual({ kind: 'quest', hideOwned: true })
    // '#unlocks' alone names no kind: that one stays.
    expect(mergeCollectionQuery({}, kept, true)).toEqual({ kind: 'vestige', hideOwned: false })
  })

  it('knows which links point at the unlock list', () => {
    expect(targetsUnlockList({ kind: 'quest' }, '#unlocks')).toBe(true)
    expect(targetsUnlockList({ kind: 'all' }, '')).toBe(true)
    expect(targetsUnlockList({}, '#unlocks')).toBe(true)
    expect(targetsUnlockList({}, '#unlocks-vestige')).toBe(true)
    expect(targetsUnlockList({}, '#vault-takla-kara')).toBe(false)
    expect(targetsUnlockList({ hide: '0' }, '')).toBe(false)
    expect(targetsUnlockList({}, undefined)).toBe(false)
    expect(targetsUnlockList({}, '#unlockski')).toBe(false)
  })

  it('compares states by value', () => {
    expect(sameCollectionState({ kind: 'all', hideOwned: false }, { kind: 'all', hideOwned: false })).toBe(true)
    expect(sameCollectionState({ kind: 'all', hideOwned: false }, { kind: 'quest', hideOwned: false })).toBe(false)
    expect(sameCollectionState({ kind: 'quest', hideOwned: true }, { kind: 'quest', hideOwned: false })).toBe(false)
  })
})

describe('rewardRegion', () => {
  const lookup = {
    quest: (id: string) => ({ 'Dragon Slayer': 'Brynmoor/Ghornfell', Ratcatcher: 'Temple Woods' })[id],
    vault: (id: string) => ({ 'Takla Kara': 'Ghornfell', 'Hidden Vault': 'Fellhollow' })[id],
    point: (id: string) => ({ a: 'Fellhollow', b: 'Ghornfell', c: 'Ghornfell', d: 'Dowdun Reach' })[id],
  }
  const reward = (r: Partial<Reward>): Reward => ({ id: 'pattern:x', kind: 'pattern', name: 'X', ...r })

  it('takes the wiki sub-heading first when it is a region', () => {
    const r = reward({ group: 'dowdun reach', vaultId: 'Takla Kara', questId: 'Dragon Slayer', pointIds: ['a'], source: 'In Brynmoor' })
    expect(rewardRegion(r, lookup)).toBe('Dowdun Reach')
  })

  it('then the vault, the quest, most of the map points and the source text', () => {
    expect(rewardRegion(reward({ vaultId: 'Takla Kara', questId: 'Dragon Slayer' }), lookup)).toBe('Ghornfell')
    expect(rewardRegion(reward({ group: 'Garou', questId: 'Dragon Slayer', pointIds: ['d'] }), lookup)).toBe('Brynmoor')
    expect(rewardRegion(reward({ questId: 'Ratcatcher', pointIds: ['a', 'b', 'c'] }), lookup)).toBe('Ghornfell')
    expect(rewardRegion(reward({ pointIds: ['d', 'a'] }), lookup)).toBe('Dowdun Reach')
    expect(rewardRegion(reward({ pointIds: ['gone'], source: 'Rod fishing spots in Ghornfell.' }), lookup)).toBe('Ghornfell')
  })

  it('gives undefined without any region, and without lookups only uses the reward itself', () => {
    expect(rewardRegion(reward({ questId: 'Ratcatcher', source: 'Located inside a chest' }), lookup)).toBeUndefined()
    expect(rewardRegion(reward({ kind: 'plan', group: 'Garou' }), lookup)).toBeUndefined()
    expect(rewardRegion(reward({ vaultId: 'Takla Kara', source: 'Net fishing spots in Fellhollow.' }))).toBe('Fellhollow')
  })
})

describe('buildRewardList by region', () => {
  const quest = (name: string, questId: string): Reward => ({ id: `quest:${name.toLowerCase()}`, kind: 'quest', name, questId })
  const trophy = (name: string, source: string): Reward => ({ id: `fishing-trophy:${name.toLowerCase()}`, kind: 'fishing-trophy', name, source })
  const list: Reward[] = [
    quest('Zombie Axe', "Doric's Quest"),
    quest('Anti-Dragon Shield', 'Dragon Slayer'),
    quest('Mount', 'The Wild Hunt'),
    quest('Granite Maul', 'Granite Mauled'),
    quest('Mystery Hat', 'Unknown'),
    trophy('Herring Trophy', 'Rod fishing spots in Ghornfell.'),
    trophy('Salmon Trophy', 'Rod fishing spots in Ghornfell.'),
    trophy('Lobster Trophy', 'Net fishing spots in Fellhollow.'),
    { id: 'recipe-book:meat-sandwich', kind: 'recipe-book', name: 'Meat Sandwich' },
  ]
  const questRegion: Record<string, string> = { "Doric's Quest": 'Fellhollow', 'Dragon Slayer': 'Brynmoor/Ghornfell', 'The Wild Hunt': 'Fellhollow', 'Granite Mauled': 'Ghornfell' }
  const regions = new Map<string, string>()
  for (const r of list) {
    const region = rewardRegion(r, { quest: (id) => questRegion[id] })
    if (region) regions.set(r.id, region)
  }
  const mine = new Set(['quest:mount', 'quest:zombie axe'])
  const build = (f: Partial<RewardFilter>) => buildRewardList(list, mine, filter(f), undefined, regions)
  const groups = (f: Partial<RewardFilter>, kind = f.kind) =>
    build(f).blocks.find((b) => b.kind === kind)?.groups.map((g) => [g.label, g.rewards.map((r) => r.name), `${g.tally.done}/${g.tally.total}`])

  it('groups a kind by region in play order, the rest last as Other', () => {
    expect(groups({ kind: 'quest' })).toEqual([
      ['Brynmoor', ['Anti-Dragon Shield'], '0/1'],
      ['Ghornfell', ['Granite Maul'], '0/1'],
      ['Fellhollow', ['Mount', 'Zombie Axe'], '2/2'],
      [NO_REGION_LABEL, ['Mystery Hat'], '0/1'],
    ])
    const [block] = build({ kind: 'quest' }).blocks
    expect(block!.groups.map((g) => g.key)).toEqual(['quest:Brynmoor', 'quest:Ghornfell', 'quest:Fellhollow', 'quest:'])
    expect(block!.groups.map((g) => !!g.fallback)).toEqual([false, false, false, true])
    expect(block!.tally).toEqual({ done: 2, total: 5 })
  })

  it('gives a kind without any region one unlabeled group', () => {
    const [block] = build({ kind: 'recipe-book' }).blocks
    expect(block!.groups).toHaveLength(1)
    expect(block!.groups[0]!.label).toBeUndefined()
    expect(block!.groups[0]!.fallback).toBe(true)
  })

  it('shows the same groups under All as under the single kind', () => {
    for (const kind of ['quest', 'fishing-trophy', 'recipe-book'] as const) expect(groups({}, kind)).toEqual(groups({ kind }))
  })

  it('drops region groups that hide owned empties, but keeps their counts', () => {
    expect(groups({ kind: 'quest', hideOwned: true })).toEqual([
      ['Brynmoor', ['Anti-Dragon Shield'], '0/1'],
      ['Ghornfell', ['Granite Maul'], '0/1'],
      [NO_REGION_LABEL, ['Mystery Hat'], '0/1'],
    ])
  })

  it('finds rewards by region, also without precomputed haystacks', () => {
    expect(groups({ kind: 'quest', query: 'fellhollow' })).toEqual([['Fellhollow', ['Mount', 'Zombie Axe'], '2/2']])
    expect(groups({ kind: 'quest', query: 'brynmoor shield' })).toEqual([['Brynmoor', ['Anti-Dragon Shield'], '0/1']])
    // Search never renames the group without a region.
    expect(groups({ kind: 'quest', query: 'mystery' })).toEqual([[NO_REGION_LABEL, ['Mystery Hat'], '0/1']])
  })

  it('shares a source per region group', () => {
    const [block] = build({ kind: 'fishing-trophy' }).blocks
    expect(block!.groups.map((g) => g.label)).toEqual(['Ghornfell', 'Fellhollow'])
    expect(block!.groups[0]!.note?.shared).toEqual({ via: [], source: 'Rod fishing spots in Ghornfell.', count: 2 })
    expect(block!.groups[1]!.note).toBeUndefined()
  })
})
