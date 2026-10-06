import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { emptyProgress, normalizeProgress } from '@/lib/normalize'
import type { Progress } from '@/lib/types'
import { PROGRESS_RELOADED_MESSAGE, useProgressStore } from './progress'

// A fake middleware behind the real api client: progress.json with an ETag, If-Match and 409.

interface Put {
  ifMatch?: string
  body: Progress
  keepalive?: boolean
}

let disk: { progress: Progress; rev: number }
let gets: number
let puts: Put[]
/** Runs right before the server handles PUT number n (0-based): lets a test play "the other tab". */
let beforePut: ((n: number) => void) | undefined
/** Returns an error message to fail PUT number n with a 500. */
let failPut: ((n: number) => string | undefined) | undefined

const etag = () => `"r${disk.rev}"`

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  }
}

/** Another tab (or a hand edit) changes progress.json. */
function editOnDisk(fn: (p: Progress) => void) {
  fn(disk.progress)
  disk.rev++
}

const settle = () => vi.advanceTimersByTimeAsync(500)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  disk = { progress: emptyProgress(), rev: 1 }
  gets = 0
  puts = []
  beforePut = undefined
  failPut = undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      expect(url).toBe('/api/progress')
      const headers = (init.headers ?? {}) as Record<string, string>
      if ((init.method ?? 'GET') === 'GET') {
        gets++
        return reply(200, disk.progress, { ETag: etag() })
      }
      const n = puts.length
      beforePut?.(n)
      const body = JSON.parse(init.body as string) as Progress
      puts.push({ ifMatch: headers['If-Match'], body, keepalive: init.keepalive })
      const fail = failPut?.(n)
      if (fail) return reply(500, { error: fail })
      if (headers['If-Match'] && headers['If-Match'] !== etag()) {
        return reply(409, { error: 'Voortgang is elders gewijzigd', progress: disk.progress }, { ETag: etag() })
      }
      disk.progress = normalizeProgress(body)
      disk.rev++
      return reply(200, disk.progress, { ETag: etag() })
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function loadedStore(initial?: Progress) {
  if (initial) disk.progress = initial
  const store = useProgressStore()
  await store.load()
  await settle()
  return store
}

describe('saving', () => {
  it('does not write progress.json back after a plain load', async () => {
    disk.progress = { ...emptyProgress(), rewards: { 'pattern:cape': { at: 'x' } } }
    const store = await loadedStore()
    expect(store.loaded).toBe(true)
    expect(store.state.rewards).toEqual({ 'pattern:cape': { at: 'x' } })
    await store.flush()
    expect(puts).toEqual([])
  })

  it('saves a change once, with the ETag of the loaded copy', async () => {
    const store = await loadedStore()
    store.toggleStep('Ratcatcher', 'Ratcatcher:s:1')
    await settle()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.ifMatch).toBe('"r1"')
    expect(disk.progress.quests).toEqual({ Ratcatcher: { steps: ['Ratcatcher:s:1'], items: [] } })
  })

  it('still saves a cleanup that replaces the whole state', async () => {
    const store = await loadedStore({ ...emptyProgress(), rewards: { 'plan:gone': { at: 'x' } } })
    store.removeOrphans({ quests: [], steps: [], items: [], points: [], vaults: [], rewards: ['plan:gone'] })
    await settle()
    expect(puts).toHaveLength(1)
    expect(disk.progress.rewards).toEqual({})
  })

  it('reports a failed save and keeps the change for the next try', async () => {
    const store = await loadedStore()
    failPut = (n) => (n === 0 ? 'Schijf vol' : undefined)
    store.togglePoint('lore:1:2')
    await settle()
    expect(store.error).toBe('Opslaan mislukt: Schijf vol')
    expect(store.conflict).toBe(false)
    await store.flush()
    expect(store.error).toBeNull()
    expect(Object.keys(disk.progress.points)).toEqual(['lore:1:2'])
  })
})

describe('empty entries', () => {
  it('drops a quest entry once nothing is checked any more', async () => {
    const store = await loadedStore()
    store.toggleStep('Q', 'Q:s:1')
    store.toggleItem('Q', 'Q:i:rope')
    store.setQuestDone('Q', true)
    store.toggleStep('Q', 'Q:s:1')
    store.toggleItem('Q', 'Q:i:rope')
    expect(store.state.quests.Q).toEqual({ done: true, steps: [], items: [] })
    store.setQuestDone('Q', false)
    expect(store.state.quests).toEqual({})
    store.toggleStep('Other', 'Other:s:1', false)
    expect(store.state.quests).toEqual({})
  })

  it('drops a quest entry when keepItems leaves nothing', async () => {
    const store = await loadedStore({ ...emptyProgress(), quests: { Q: { steps: [], items: ['Q:i:old'] } } })
    store.keepItems('Q', new Set(['Q:i:new']))
    expect(store.state.quests).toEqual({})
  })

  it('drops a vault entry once it is no longer done', async () => {
    const store = await loadedStore()
    store.setVaultDone('Kara', true)
    expect(store.state.vaults.Kara).toEqual({ done: true })
    store.setVaultDone('Kara', false)
    expect(store.state.vaults).toEqual({})
  })
})

describe('conflicts', () => {
  it('merges its own change onto a copy another tab saved, and retries once', async () => {
    const store = await loadedStore({ ...emptyProgress(), quests: { Ratcatcher: { steps: ['R:s:1'], items: [] } } })
    editOnDisk((p) => {
      p.quests.Ratcatcher!.steps.push('R:s:2')
      p.rewards['plan:torch'] = { at: 'other tab' }
    })

    store.togglePoint('lore:1:2')
    store.toggleStep('Ratcatcher', 'R:s:1')
    await settle()

    expect(puts.map((p) => p.ifMatch)).toEqual(['"r1"', '"r2"'])
    expect(disk.progress).toEqual({
      version: 1,
      quests: { Ratcatcher: { steps: ['R:s:2'], items: [] } },
      points: { 'lore:1:2': { foundAt: expect.any(String) } },
      vaults: {},
      rewards: { 'plan:torch': { at: 'other tab' } },
    })
    expect(store.state).toEqual(disk.progress)
    expect(store.error).toBeNull()

    // The merged copy is the new base: the next save goes through at once.
    store.toggleReward('plan:torch')
    await settle()
    expect(puts).toHaveLength(3)
    expect(puts[2]!.ifMatch).toBe('"r3"')
    expect(disk.progress.rewards).toEqual({})
  })

  it('takes the copy on disk and says so when it changes again during the retry', async () => {
    const store = await loadedStore()
    editOnDisk((p) => (p.points['a:1:1'] = { foundAt: 'other tab' }))
    beforePut = (n) => {
      if (n === 1) editOnDisk((p) => (p.points['b:2:2'] = { foundAt: 'third write' }))
    }

    store.togglePoint('mine:3:3')
    await settle()

    expect(puts).toHaveLength(2)
    expect(store.state.points).toEqual({ 'a:1:1': { foundAt: 'other tab' }, 'b:2:2': { foundAt: 'third write' } })
    expect(store.error).toBe(PROGRESS_RELOADED_MESSAGE)
    expect(store.conflict).toBe(true)

    // Nothing is pending: no save of the reloaded copy, and a click dismisses the notice.
    await settle()
    expect(puts).toHaveLength(2)
    store.clearError()
    expect(store.error).toBeNull()
    expect(store.conflict).toBe(false)
  })

  it('keeps the merged state when the retry fails for another reason, and saves it later', async () => {
    const store = await loadedStore()
    editOnDisk((p) => (p.points['a:1:1'] = { foundAt: 'other tab' }))
    failPut = (n) => (n === 1 ? 'Schijf vol' : undefined)

    store.togglePoint('mine:3:3')
    await settle()
    expect(store.error).toBe('Opslaan mislukt: Schijf vol')
    expect(Object.keys(store.state.points).sort()).toEqual(['a:1:1', 'mine:3:3'])

    await store.flush()
    expect(puts[2]!.ifMatch).toBe('"r2"')
    expect(Object.keys(disk.progress.points).sort()).toEqual(['a:1:1', 'mine:3:3'])
    expect(store.error).toBeNull()
  })
})

describe('refresh', () => {
  it('picks up changes from another tab without writing them back', async () => {
    const store = await loadedStore()
    editOnDisk((p) => (p.quests.Q = { steps: ['Q:s:1'], items: [] }))
    await store.refresh()
    await settle()
    expect(store.state.quests).toEqual({ Q: { steps: ['Q:s:1'], items: [] } })
    expect(puts).toEqual([])

    // The refreshed copy is the base of the next save.
    store.toggleStep('Q', 'Q:s:2')
    await settle()
    expect(puts[0]!.ifMatch).toBe('"r2"')
  })

  it('waits while a change is not saved yet', async () => {
    const store = await loadedStore()
    store.togglePoint('mine:1:1')
    await vi.advanceTimersByTimeAsync(0)
    const before = gets
    await store.refresh()
    expect(gets).toBe(before)
    await settle()
    expect(puts).toHaveLength(1)
  })

  it('keeps a change made while the fresh copy was on its way', async () => {
    const store = await loadedStore()
    editOnDisk((p) => (p.rewards.r = { at: 'other tab' }))
    const pending = store.refresh()
    store.togglePoint('mine:1:1')
    await pending
    await settle()
    expect(Object.keys(store.state.points)).toEqual(['mine:1:1'])
    expect(store.state.rewards).toEqual({ r: { at: 'other tab' } })
    expect(disk.progress.points).toEqual(store.state.points)
    expect(disk.progress.rewards).toEqual({ r: { at: 'other tab' } })
  })

  it('does nothing before the first load', async () => {
    const store = useProgressStore()
    await store.refresh()
    expect(gets).toBe(0)
  })
})
