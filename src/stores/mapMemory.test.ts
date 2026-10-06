import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { emptyFilters } from '@/lib/map-url'
import { useMapMemoryStore } from './mapMemory'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('map memory', () => {
  it('starts empty and keeps a copy of the filters', () => {
    const memory = useMapMemoryStore()
    expect(memory.lastFilters).toBeNull()
    const filters = { ...emptyFilters(), categories: ['treasure-chest'], powers: [3], strictPower: true }
    memory.remember(filters)
    filters.categories.push('vaults')
    filters.powers.length = 0
    expect(memory.lastFilters).toEqual({ ...emptyFilters(), categories: ['treasure-chest'], powers: [3], strictPower: true })
  })

  it('forgets', () => {
    const memory = useMapMemoryStore()
    memory.remember(emptyFilters())
    memory.forget()
    expect(memory.lastFilters).toBeNull()
  })
})
