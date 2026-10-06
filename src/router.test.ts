// @vitest-environment jsdom
// The app's real router: the Dutch addresses of older bookmarks land on the English ones, with
// the rest of the query and the hash, in one history entry.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const stub = (name: string) => ({ default: { name, render: () => null } })
vi.mock('./views/QuestsView.vue', () => stub('QuestsView'))
vi.mock('./views/MapView.vue', () => stub('MapView'))
vi.mock('./views/CollectionsView.vue', () => stub('CollectionsView'))

const { router } = await import('./router')

const at = () => router.currentRoute.value

describe('old Dutch addresses', () => {
  beforeEach(async () => {
    await router.replace('/quests')
  })

  it('sends /kaart to /map with the query and the hash', async () => {
    await router.push('/kaart?c=vaults,quest-start&quest=Rune%20Mysteries#top')
    expect(at().name).toBe('map')
    expect(at().path).toBe('/map')
    expect(at().query).toEqual({ c: 'vaults,quest-start', quest: 'Rune Mysteries' })
    expect(at().hash).toBe('#top')
    expect(at().redirectedFrom?.path).toBe('/kaart')
    expect(window.location.pathname).toBe('/map')
  })

  it('sends /verzamelingen to /collections and renames ?soort= and ?verberg=', async () => {
    await router.push('/verzamelingen?soort=vestige&verberg=1&x=y#vault-takla-kara')
    expect(at().name).toBe('collections')
    expect(at().fullPath).toBe('/collections?kind=vestige&hide=1&x=y#vault-takla-kara')
    await router.push('/verzamelingen#unlocks')
    expect(at().fullPath).toBe('/collections#unlocks')
    await router.push('/collections?soort=quest')
    expect(at().fullPath).toBe('/collections?kind=quest')
  })

  it('translates the Dutch quest status in a quest address', async () => {
    await router.push("/quests/Black%20Knight's%20Fortress?q=k&status=bezig#walkthrough")
    expect(at().name).toBe('quests')
    expect(at().params.questId).toBe("Black Knight's Fortress")
    expect(at().query).toEqual({ q: 'k', status: 'active' })
    expect(at().hash).toBe('#walkthrough')
    await router.push('/quests?status=voltooid')
    expect(at().fullPath).toBe('/quests?status=done')
  })

  it('adds one history entry for an old address, not two', async () => {
    const before = window.history.length
    await router.push('/verzamelingen?soort=vestige')
    expect(window.history.length).toBe(before + 1)
    expect(at().fullPath).toBe('/collections?kind=vestige')
  })

  it('leaves current addresses alone', async () => {
    await router.push('/collections?kind=all&hide=1#unlocks')
    expect(at().fullPath).toBe('/collections?kind=all&hide=1#unlocks')
    expect(at().redirectedFrom).toBeUndefined()
    await router.push('/map?q=kaart')
    expect(at().fullPath).toBe('/map?q=kaart')
  })
})
