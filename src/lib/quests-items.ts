// Editing the item list of a quest. The result replaces the wiki list via overrides.questItems.
// Pure functions only.

import { questItemId, slug } from './ids'
import type { Overrides, QuestItem } from './types'

/** One editable row. Every field is the raw text of its input. */
export interface ItemDraft {
  /** Stable key for v-for while editing. Not saved. */
  key: string
  name: string
  qty: string
  note: string
}

export interface ItemDraftErrors {
  name?: string
  qty?: string
}

export interface ItemsValidation {
  /** The list to save: blank rows dropped, ids from questItemId(). */
  items: QuestItem[]
  /** Errors per draft key. */
  errors: Record<string, ItemDraftErrors>
  valid: boolean
}

let nextKey = 0
const newKey = () => `draft-${++nextKey}`

export function emptyDraft(): ItemDraft {
  return { key: newKey(), name: '', qty: '', note: '' }
}

export function draftsFromItems(items: QuestItem[]): ItemDraft[] {
  return items.map((item) => ({
    key: newKey(),
    name: item.name,
    qty: item.qty !== undefined ? String(item.qty) : '',
    note: item.note ?? '',
  }))
}

/**
 * Parses a quantity field. '' is no quantity (undefined), '4', '4x' and 'x4' are 4.
 * Anything else, zero included, is invalid (null).
 */
export function parseQty(input: string): number | undefined | null {
  const text = input.trim()
  if (!text) return undefined
  const match = /^[x×]?\s*(\d+)\s*[x×]?$/i.exec(text)
  if (!match) return null
  const n = Number(match[1])
  return Number.isSafeInteger(n) && n >= 1 ? n : null
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Checks the rows and builds the list to save. Rows that are completely empty are ignored.
 * A name is required, the quantity is an optional whole number of 1 or more, and two rows may
 * not end up with the same id (the id comes from the name, so 'Ash log' and 'ash log' clash).
 */
export function validateDrafts(questId: string, drafts: ItemDraft[]): ItemsValidation {
  const items: QuestItem[] = []
  const errors: Record<string, ItemDraftErrors> = {}
  const seen = new Set<string>()

  for (const draft of drafts) {
    const name = clean(draft.name)
    const note = clean(draft.note)
    if (!name && !draft.qty.trim() && !note) continue

    const rowErrors: ItemDraftErrors = {}
    const key = slug(name)
    if (!name) rowErrors.name = 'Vul een naam in'
    else if (!key) rowErrors.name = 'Gebruik letters of cijfers'
    else if (seen.has(key)) rowErrors.name = 'Dit item staat er al'
    if (key) seen.add(key)

    const qty = parseQty(draft.qty)
    if (qty === null) rowErrors.qty = 'Een heel getal vanaf 1'

    if (rowErrors.name || rowErrors.qty) {
      errors[draft.key] = rowErrors
      continue
    }
    items.push({
      id: questItemId(questId, name),
      name,
      ...(qty !== undefined && qty !== null ? { qty } : {}),
      ...(note ? { note } : {}),
    })
  }

  return { items, errors, valid: Object.keys(errors).length === 0 }
}

/** Overrides with this quest's item list replaced. */
export function overridesWithItems(overrides: Overrides, questId: string, items: QuestItem[]): Overrides {
  return { ...overrides, questItems: { ...overrides.questItems, [questId]: items } }
}

/** Overrides without this quest's item list, so the wiki list applies again. */
export function overridesWithoutItems(overrides: Overrides, questId: string): Overrides {
  const questItems = { ...overrides.questItems }
  delete questItems[questId]
  return { ...overrides, questItems }
}
