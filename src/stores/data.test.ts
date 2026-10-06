import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '@/lib/api'
import { reportConnection } from '@/lib/connection'
import { emptyOverrides } from '@/lib/normalize'
import type { AppData } from '@/lib/types'
import { useConnectionStore } from './connection'
import { READ_ONLY_MESSAGE, useDataStore } from './data'

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

function appData(partial: Partial<AppData> = {}): AppData {
  return {
    ready: true,
    meta: { syncedAt: '2026-09-01T10:00:00Z', durationMs: 1, domains: [], counts: { categories: 0, points: 0, quests: 0, vaults: 0, rewards: 0 }, revisions: {} },
    map: { categories: [], points: [] },
    quests: [],
    vaults: [],
    rewards: [],
    overrides: emptyOverrides(),
    ...partial,
  }
}

describe('data store refresh', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.data).mockReset()
  })

  it('keeps the same data object when nothing changed', async () => {
    const store = useDataStore()
    vi.mocked(api.data).mockResolvedValue(appData())
    await store.load()
    const before = store.data
    await store.refresh()
    expect(api.data).toHaveBeenCalledTimes(2)
    expect(store.data).toBe(before)
  })

  it('swaps in new data when overrides or the sync changed', async () => {
    const store = useDataStore()
    vi.mocked(api.data).mockResolvedValueOnce(appData())
    await store.load()

    const pinned = { ...emptyOverrides(), questStart: { Ratcatcher: { x: 1, y: 2 } } }
    vi.mocked(api.data).mockResolvedValueOnce(appData({ overrides: pinned }))
    await store.refresh()
    expect(store.overrides.questStart).toEqual({ Ratcatcher: { x: 1, y: 2 } })

    vi.mocked(api.data).mockResolvedValueOnce(appData({ overrides: pinned, overridesError: 'overrides.json is not valid JSON' }))
    await store.refresh()
    expect(store.data?.overridesError).toBe('overrides.json is not valid JSON')
  })

  it('does nothing before the first load, and reports a failed refresh', async () => {
    const store = useDataStore()
    await store.refresh()
    expect(api.data).not.toHaveBeenCalled()

    vi.mocked(api.data).mockResolvedValueOnce(appData())
    await store.load()
    vi.mocked(api.data).mockRejectedValueOnce(new Error('Failed to fetch'))
    await store.refresh()
    expect(store.error).toBe('Failed to fetch')
    expect(store.data).not.toBeNull()
  })

  it('drops a slow refresh when newer data was loaded meanwhile', async () => {
    const store = useDataStore()
    vi.mocked(api.data).mockResolvedValueOnce(appData())
    await store.load()

    let answer!: (d: AppData) => void
    vi.mocked(api.data).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const refreshing = store.refresh()
    const pinned = { ...emptyOverrides(), questStart: { Ratcatcher: { x: 1, y: 2 } } }
    vi.mocked(api.data).mockResolvedValueOnce(appData({ overrides: pinned }))
    await store.load()
    answer(appData())
    await refreshing
    expect(store.overrides.questStart).toEqual({ Ratcatcher: { x: 1, y: 2 } })
  })

  it('does not refresh in the middle of saving overrides', async () => {
    const store = useDataStore()
    vi.mocked(api.data).mockResolvedValue(appData())
    await store.load()
    vi.mocked(api.data).mockClear()

    let release!: () => void
    vi.mocked(api.saveOverrides).mockImplementationOnce(
      (o) =>
        new Promise((resolve) => {
          release = () => resolve(o)
        }),
    )
    const saving = store.saveOverrides((current) => current)
    await vi.waitFor(() => expect(api.saveOverrides).toHaveBeenCalled())
    await store.refresh()
    expect(api.data).toHaveBeenCalledTimes(1)
    release()
    await saving
    expect(api.data).toHaveBeenCalledTimes(2)
  })
})

describe('data store without the Mac', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.data).mockReset()
    vi.mocked(api.saveOverrides).mockClear()
  })

  function offline() {
    const connection = useConnectionStore()
    connection.remote = true
    connection.state = 'offline'
    return connection
  }

  it("takes the service worker's offline copy only while nothing is on screen", async () => {
    const store = useDataStore()
    vi.mocked(api.data).mockResolvedValue(appData())
    await store.load()
    expect(vi.mocked(api.data).mock.calls[0]).toEqual([{ acceptOffline: true }])
    await store.load()
    expect(vi.mocked(api.data).mock.calls[1]).toEqual([{ acceptOffline: false }])
    await store.refresh()
    expect(vi.mocked(api.data).mock.calls[2]).toEqual([])
  })

  it('refuses to change overrides while read-only', async () => {
    const store = useDataStore()
    store.data = appData()
    offline()
    await expect(store.saveOverrides((ov) => ov)).rejects.toThrow(READ_ONLY_MESSAGE)
    expect(api.data).not.toHaveBeenCalled()
    expect(api.saveOverrides).not.toHaveBeenCalled()
  })

  it('reloads quietly when the Mac is back', async () => {
    const store = useDataStore()
    vi.mocked(api.data).mockResolvedValue(appData())
    await store.load()
    const before = store.data
    const connection = offline()
    connection.start()
    reportConnection({ type: 'reached' })
    await vi.waitFor(() => expect(api.data).toHaveBeenCalledTimes(2))
    // Nothing changed on the Mac: the same object, so the views do not rebuild.
    expect(store.data).toBe(before)
    connection.stop()
  })
})
