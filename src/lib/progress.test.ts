import { describe, expect, it } from 'vitest'
import { emptyProgress } from './normalize'
import { isEmptyQuestProgress, isEmptyVaultProgress, mergeIds, mergeProgress, questFraction, questState } from './progress'
import type { Progress, Quest } from './types'

const quest: Quest = {
  id: 'Q',
  name: 'Q',
  kind: 'primary',
  location: 'Somewhere',
  steps: [
    { id: 'Q:s:a', text: 'A' },
    { id: 'Q:s:b', text: 'B' },
  ],
  stepsSource: 'quick-guide',
  items: [],
  rewards: [],
  requires: [],
  wikiUrl: 'https://dragonwilds.runescape.wiki/w/Q',
}

function progress(partial: Partial<Progress> = {}): Progress {
  return { ...emptyProgress(), ...partial }
}

describe('questState and questFraction', () => {
  it('count a step listed twice only once', () => {
    const qp = { steps: ['Q:s:a', 'Q:s:a'], items: [] }
    expect(questState(quest, qp)).toBe('active')
    expect(questFraction(quest, qp)).toBe(0.5)
  })

  it('still mark a quest done when every step is checked', () => {
    const qp = { steps: ['Q:s:b', 'Q:s:a', 'Q:s:gone'], items: [] }
    expect(questState(quest, qp)).toBe('done')
    expect(questFraction(quest, qp)).toBe(1)
  })
})

describe('empty entries', () => {
  it('knows when a quest or vault entry holds nothing', () => {
    expect(isEmptyQuestProgress({ steps: [], items: [] })).toBe(true)
    expect(isEmptyQuestProgress({ done: true, steps: [], items: [] })).toBe(false)
    expect(isEmptyQuestProgress({ steps: [], items: ['Q:i:rope'] })).toBe(false)
    expect(isEmptyVaultProgress({})).toBe(true)
    expect(isEmptyVaultProgress({ done: true })).toBe(false)
  })
})

describe('mergeIds', () => {
  it('keeps local additions and removals on top of the server list', () => {
    // base a,b; local removed a, added c; server added d.
    expect(mergeIds(['a', 'b'], ['b', 'c'], ['a', 'b', 'd'])).toEqual(['b', 'd', 'c'])
  })

  it('does not bring back what the server removed', () => {
    expect(mergeIds(['a', 'b'], ['a', 'b'], ['a'])).toEqual(['a'])
  })

  it('never duplicates an id both sides added', () => {
    expect(mergeIds([], ['x'], ['x'])).toEqual(['x'])
    expect(mergeIds([0], [0, 2], [2, 1])).toEqual([2, 1])
  })
})

describe('mergeProgress', () => {
  it('keeps checkmarks made in another tab and the ones made here', () => {
    const base = progress({ quests: { Ratcatcher: { steps: ['R:s:1'], items: [] } } })
    const local = progress({
      quests: { Ratcatcher: { steps: ['R:s:1'], items: [] } },
      points: { 'lore:1:2': { foundAt: 'local' } },
    })
    const server = progress({
      quests: { Ratcatcher: { steps: ['R:s:1', 'R:s:2'], items: [] } },
      rewards: { 'plan:torch': { at: 'server' } },
    })
    expect(mergeProgress(base, local, server)).toEqual({
      version: 1,
      quests: { Ratcatcher: { steps: ['R:s:1', 'R:s:2'], items: [] } },
      points: { 'lore:1:2': { foundAt: 'local' } },
      vaults: {},
      rewards: { 'plan:torch': { at: 'server' } },
    })
  })

  it('applies local removals, and drops entries that end up empty', () => {
    const base = progress({
      quests: { A: { done: true, steps: ['A:s:1'], items: ['A:i:rope'] }, B: { steps: ['B:s:1'], items: [] } },
      points: { p: { foundAt: 'x' } },
      vaults: { Kara: { done: true }, Other: { done: true } },
      rewards: { r: { at: 'x' } },
    })
    const local = progress({ quests: { A: { steps: ['A:s:1'], items: [] } }, vaults: { Other: { done: true } } })
    const server = structuredClone(base)
    expect(mergeProgress(base, local, server)).toEqual({
      version: 1,
      quests: { A: { steps: ['A:s:1'], items: [] } },
      points: {},
      vaults: { Other: { done: true } },
      rewards: {},
    })
  })

  it('takes flags and entries from the server where this tab changed nothing', () => {
    const base = progress({ vaults: {}, points: { gone: { foundAt: 'x' } } })
    const local = structuredClone(base)
    const server = progress({ quests: { New: { done: true, steps: [], items: [] } }, vaults: { Kara: { done: true } } })
    expect(mergeProgress(base, local, server)).toEqual({
      version: 1,
      quests: { New: { done: true, steps: [], items: [] } },
      points: {},
      vaults: { Kara: { done: true } },
      rewards: {},
    })
  })

  it('lets a local uncheck of "done" win over an unchanged server flag', () => {
    const base = progress({ quests: { A: { done: true, steps: ['A:s:1'], items: [] } } })
    const local = progress({ quests: { A: { steps: ['A:s:1'], items: [] } } })
    const server = progress({ quests: { A: { done: true, steps: ['A:s:1', 'A:s:2'], items: [] } } })
    expect(mergeProgress(base, local, server).quests.A).toEqual({ steps: ['A:s:1', 'A:s:2'], items: [] })
  })

  it('does not mutate its inputs', () => {
    const base = progress({ points: { p: { foundAt: 'x' } } })
    const local = progress({ points: { p: { foundAt: 'x' }, q: { foundAt: 'y' } } })
    const server = progress({ points: { p: { foundAt: 'x' } } })
    const snapshot = JSON.stringify([base, local, server])
    const merged = mergeProgress(base, local, server)
    merged.points.p!.foundAt = 'changed'
    expect(JSON.stringify([base, local, server])).toBe(snapshot)
  })
})
