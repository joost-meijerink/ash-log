import { describe, expect, it } from 'vitest'
import { normalizeProgress } from './normalize'

describe('normalizeProgress', () => {
  it('dedupes steps and items of a hand-merged file', () => {
    const p = normalizeProgress({
      version: 1,
      quests: { Q: { steps: ['Q:s:a', 'Q:s:a', 'Q:s:b', 3], items: ['Q:i:rope', 'Q:i:rope'] } },
    })
    expect(p.quests.Q).toEqual({ steps: ['Q:s:a', 'Q:s:b'], items: ['Q:i:rope'] })
  })

  it('still drops entries that are not in the expected shape', () => {
    const p = normalizeProgress({
      quests: { Q: 'nope' },
      points: { a: { foundAt: 'x' }, b: true },
      // 'cores' comes from older files: vault cores respawn and are no longer kept.
      vaults: { K: { cores: [2, 2, 0, 5] }, D: { done: true, cores: [1] } },
      rewards: { r: true, s: { at: 'y' } },
    })
    expect(p).toEqual({
      version: 1,
      quests: {},
      points: { a: { foundAt: 'x' } },
      vaults: { D: { done: true } },
      rewards: { s: { at: 'y' } },
    })
  })
})
