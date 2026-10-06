import { describe, expect, it } from 'vitest'
import { emptyOverrides } from './normalize'
import {
  draftsFromItems,
  emptyDraft,
  overridesWithItems,
  overridesWithoutItems,
  parseQty,
  validateDrafts,
  type ItemDraft,
} from './quests-items'
import type { QuestItem } from './types'

const draft = (name: string, qty = '', note = ''): ItemDraft => ({ ...emptyDraft(), name, qty, note })

describe('parseQty', () => {
  it('accepts whole numbers of 1 or more, with an optional x', () => {
    expect(parseQty('4')).toBe(4)
    expect(parseQty(' 12 ')).toBe(12)
    expect(parseQty('4x')).toBe(4)
    expect(parseQty('x4')).toBe(4)
    expect(parseQty('3 ×')).toBe(3)
  })

  it('treats an empty field as no quantity', () => {
    expect(parseQty('')).toBeUndefined()
    expect(parseQty('   ')).toBeUndefined()
  })

  it('rejects anything else', () => {
    for (const bad of ['0', '-2', '1.5', 'four', '4 logs', '99999999999999999999']) expect(parseQty(bad)).toBeNull()
  })
})

describe('draftsFromItems', () => {
  it('turns items into editable text rows with unique keys', () => {
    const items: QuestItem[] = [
      { id: 'Q:i:ash-log', name: 'Ash log', qty: 10 },
      { id: 'Q:i:torch', name: 'Torch', note: 'or the spell Fire Spirit' },
    ]
    const drafts = draftsFromItems(items)
    expect(drafts.map(({ name, qty, note }) => ({ name, qty, note }))).toEqual([
      { name: 'Ash log', qty: '10', note: '' },
      { name: 'Torch', qty: '', note: 'or the spell Fire Spirit' },
    ])
    expect(new Set(drafts.map((d) => d.key)).size).toBe(2)
  })
})

describe('validateDrafts', () => {
  it('builds items with ids from the name and leaves empty fields out', () => {
    const result = validateDrafts("Doric's Quest", [draft('  Shadow   sword ', '1', ''), draft("Undead ranger's bow", '', ' any ')])
    expect(result.valid).toBe(true)
    expect(result.items).toEqual([
      { id: "Doric's Quest:i:shadow-sword", name: 'Shadow sword', qty: 1 },
      { id: "Doric's Quest:i:undead-rangers-bow", name: "Undead ranger's bow", note: 'any' },
    ])
    expect('qty' in result.items[1]!).toBe(false)
  })

  it('keeps the id of an unchanged wiki item, so its checkmark survives', () => {
    const result = validateDrafts('Ratcatcher', [draft('Raw rat meat', '4')])
    expect(result.items[0]!.id).toBe('Ratcatcher:i:raw-rat-meat')
  })

  it('ignores rows that are completely empty', () => {
    const result = validateDrafts('Q', [draft(''), draft('Stone', '8'), draft('  ', ' ', ' ')])
    expect(result.valid).toBe(true)
    expect(result.items.map((i) => i.name)).toEqual(['Stone'])
  })

  it('requires a name when a quantity or note is filled in', () => {
    const d = draft('', '3', 'for the net')
    const result = validateDrafts('Q', [d])
    expect(result.valid).toBe(false)
    expect(result.errors[d.key]).toEqual({ name: 'Vul een naam in' })
    expect(result.items).toEqual([])
  })

  it('flags a bad quantity', () => {
    const d = draft('Stone', 'lots')
    expect(validateDrafts('Q', [d]).errors[d.key]).toEqual({ qty: 'Een heel getal vanaf 1' })
  })

  it('flags names that would give the same id', () => {
    const a = draft('Ash log', 'nope')
    const b = draft('ash-log')
    const c = draft('!!!')
    const result = validateDrafts('Q', [a, b, c])
    expect(result.errors[a.key]).toEqual({ qty: 'Een heel getal vanaf 1' })
    expect(result.errors[b.key]).toEqual({ name: 'Dit item staat er al' })
    expect(result.errors[c.key]).toEqual({ name: 'Gebruik letters of cijfers' })
  })

  it('allows an empty list (the quest needs nothing)', () => {
    expect(validateDrafts('Q', [])).toEqual({ items: [], errors: {}, valid: true })
  })
})

describe('overrides', () => {
  const items: QuestItem[] = [{ id: 'Q:i:stone', name: 'Stone', qty: 8 }]

  it('replaces only this quest and keeps the rest', () => {
    const base = { ...emptyOverrides(), questStart: { Q: { x: 1, y: 2 } }, questItems: { Other: [] } }
    const next = overridesWithItems(base, 'Q', items)
    expect(next.questItems).toEqual({ Other: [], Q: items })
    expect(next.questStart).toBe(base.questStart)
    expect(base.questItems).toEqual({ Other: [] })
  })

  it('removes the override without touching the input', () => {
    const base = overridesWithItems(emptyOverrides(), 'Q', items)
    const next = overridesWithoutItems(base, 'Q')
    expect(next.questItems).toEqual({})
    expect(base.questItems.Q).toBe(items)
  })
})
