// Quests domain against stored API responses in __fixtures__/quests. Never hits the live wiki.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapPointId, questItemId, questStepId, wikiUrl } from '../../../src/lib/ids'
import type { MapCategory, MapData, MapPoint, Quest, SyncMeta } from '../../../src/lib/types'
import { fixtureJson, fixturePage, fixturePages } from '../__fixtures__/load'
import type { SyncContext } from '../context'
import type { RawPage } from '../wiki'
import { fetchQuestSources, parseQuests, questResolver, questTitles, type QuestSources } from './quests'
import {
  droppedTemplates,
  parseItemLine,
  parseItems,
  parseRewards,
  plain,
  quickGuideSteps,
  walkthroughNeeds,
  walkthroughSteps,
  withStepIds,
} from './quests-content'
import { findStartPoint, MapIndex, questMapNames } from './quests-start'

// ---------------------------------------------------------------------------
// Helpers

function point(categoryId: string, x: number, y: number, extra: Partial<MapPoint> = {}): MapPoint {
  return { id: mapPointId(categoryId, x, y), categoryId, x, y, ...extra }
}

function mapOf(points: MapPoint[], labels: Record<string, string> = {}): MapData {
  const ids = [...new Set(points.map((p) => p.categoryId))]
  const categories: MapCategory[] = ids.map((id) => ({
    id,
    label: labels[id] ?? id,
    group: 'other',
    sources: [`Module:Map/${labels[id] ?? id}.json`],
    count: points.filter((p) => p.categoryId === id).length,
  }))
  return { categories, points }
}

const RATCATCHER_POINT = point('ratcatcher', 15182.611, 178853.42)
const VANNAKA_POINT = point('vannaka', 44247.65625, 92573.547363, { name: 'Vannaka' })
const WISE_OLD_MAN_POINTS = [point('wise-old-man', 6133.2593, 187356.61), point('wise-old-man', 48499.72, 177604)]

/** Small hand-made map: one Ratcatcher pin, one Vannaka, two Wise Old Men. */
const MAP = mapOf([RATCATCHER_POINT, VANNAKA_POINT, ...WISE_OLD_MAN_POINTS], {
  ratcatcher: 'Ratcatcher',
  vannaka: 'Vannaka',
  'wise-old-man': 'Wise Old Man',
})

function sources(): QuestSources {
  const quickGuides: Record<string, RawPage> = {}
  for (const guide of fixturePages('quests/quickguides.json')) quickGuides[guide.title.replace(/\/Quick guide$/, '')] = guide
  return { overview: fixturePage('quests/overview.json'), quests: fixturePages('quests/pages.json'), quickGuides }
}

function run(map: MapData = MAP, src: QuestSources = sources()) {
  const warnings: { message: string; page?: string }[] = []
  const quests = parseQuests(src, map, (message, page) => warnings.push({ message, page }))
  const byId = new Map(quests.map((q) => [q.id, q]))
  const get = (id: string): Quest => {
    const q = byId.get(id)
    if (!q) throw new Error(`quest ${id} not parsed`)
    return q
  }
  return { quests, warnings, get }
}

function pageContent(title: string): string {
  const page = fixturePages('quests/pages.json').find((p) => p.title === title)
  if (!page) throw new Error(`no fixture page ${title}`)
  return page.content
}

// ---------------------------------------------------------------------------
// parseQuests on the full fixtures

describe('parseQuests', () => {
  const { quests, warnings, get } = run()

  it('keeps the 37 real quests and warns about the two other pages and the removed quest', () => {
    const pages = fixturePages('quests/pages.json')
    expect(pages).toHaveLength(40)
    expect(quests).toHaveLength(37)
    const skipped = warnings.filter((w) => w.message === 'No Quest details/qtype, skipped').map((w) => w.page)
    expect(skipped.sort()).toEqual(['Consumable Recipes', 'Statues of Saradomin'])
    expect(quests.map((q) => q.id)).not.toContain('Consumable Recipes')
    expect(quests.map((q) => q.id)).not.toContain('Statues of Saradomin')
  })

  it('skips Warding Off Danger, removed from the game ({{Gone}}), with one warning', () => {
    expect(quests.map((q) => q.id)).not.toContain('Warding Off Danger')
    expect(warnings.filter((w) => w.page === 'Warding Off Danger')).toEqual([
      { message: 'Removed from the game ({{Gone}}), skipped', page: 'Warding Off Danger' },
    ])
  })

  it('sorts by kind, then order, then name', () => {
    const primary = quests.filter((q) => q.kind === 'primary').map((q) => q.name)
    expect(primary).toEqual([
      'First Steps',
      'Getting Started',
      'Ratcatcher',
      'Rune Mysteries',
      'Dragon Slayer',
      'Withering Heights',
      "Black Knight's Fortress",
      "Icthlarin's Little Helper",
      'Regicide',
    ])
    const kinds = quests.map((q) => q.kind)
    expect(kinds.indexOf('secondary')).toBe(9)
    expect(kinds.slice(9).every((k) => k === 'secondary')).toBe(true)
    const secondary = quests.filter((q) => q.kind === 'secondary')
    expect(secondary.map((q) => q.order)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1))
    expect(secondary[0].name).toBe('Growing Pains')
    expect(secondary[27].name).toBe('Mapping The Sands II')
  })

  it('parses Ratcatcher from its Quick guide', () => {
    const q = get('Ratcatcher')
    expect(q).toMatchObject({
      id: 'Ratcatcher',
      name: 'Ratcatcher',
      kind: 'primary',
      order: 3,
      region: 'Temple Woods',
      description: 'Vannaka wants to teach you the basics of hunting, fighting and cooking.',
      location: 'Speak to Vannaka south of the Windmill.',
      stepsSource: 'quick-guide',
      requires: ['Getting Started'],
      rewards: ['1 stone logging axe', '1 stone dagger'],
      wikiUrl: wikiUrl('Ratcatcher'),
    })
    expect(q.steps.map((s) => s.text)).toEqual([
      'Talk to Vannaka.',
      'Head to the windmill in the north of Temple Woods.',
      'Kill four giant rats and get four raw rat meats.',
      'Cook two rat roasts. You will need to make a campfire using 4 ash logs and 4 stones. You will also need ash logs to fuel the fire',
      'Return to Vannaka with the cooked rat roasts.',
    ])
    expect(q.steps[0].id).toBe(questStepId('Ratcatcher', 'Talk to Vannaka.'))
    expect(q.steps.every((s) => s.section === undefined)).toBe(true)
    expect(q.items).toEqual([
      { id: questItemId('Ratcatcher', 'Raw rat meat'), name: 'Raw rat meat', qty: 4 },
      { id: questItemId('Ratcatcher', 'Ash log'), name: 'Ash log', qty: 6 },
      { id: questItemId('Ratcatcher', 'Stone'), name: 'Stone', qty: 4 },
    ])
  })

  it('starts Ratcatcher at its own quest map pin', () => {
    const q = get('Ratcatcher')
    expect(q.startPointId).toBe(RATCATCHER_POINT.id)
    expect(q.startMatch).toBe('quest-map')
  })

  it('parses Rune Mysteries from its Quick guide, folding hints into their step', () => {
    const q = get('Rune Mysteries')
    expect(q.stepsSource).toBe('quick-guide')
    expect(q.steps).toHaveLength(7)
    expect(q.steps[1].text).toMatch(/^Obtain 50 ash logs\. You can obtain ash logs by picking up spawns/)
    expect(q.steps.map((s) => s.text)).not.toContain('Congratulations. Quest complete!')
    expect(q.requires).toEqual(['Ratcatcher'])
  })

  it('parses Dragon Slayer from its Walkthrough with sub-headings as sections', () => {
    const q = get('Dragon Slayer')
    expect(q).toMatchObject({ kind: 'primary', order: 5, region: 'Brynmoor/Ghornfell', stepsSource: 'walkthrough', requires: ['First Steps'] })
    expect(q.steps[0].section).toBe('Part I: To Slay Dragons!')
    expect(q.steps[0].text).toMatch(/^To start this quest, speak to the Wise Old Man in Bramblemead Village/)
    expect([...new Set(q.steps.map((s) => s.section))]).toEqual([
      'Part I: To Slay Dragons!',
      'Part II: A Lost Adventurer...',
      'Part III: The Beginnings of a Legend...',
      'Part IV: Fight for your life',
    ])
    // List items in the walkthrough are steps of their own.
    expect(q.steps.some((s) => s.text.startsWith('In the Highlands you have to travel past the skeleton'))).toBe(true)
    expect(q.steps.some((s) => /quest complete/i.test(s.text))).toBe(false)
    expect(q.steps.at(-1)?.text).toMatch(/give him the head to complete this quest\.$/)
  })

  it('reads Dragon Slayer items with notes and nested rewards', () => {
    const q = get('Dragon Slayer')
    expect(q.items.map((i) => [i.name, i.qty])).toEqual([
      ['Antlers', 1],
      ['Ash log', 23],
      ['Coarse animal fur', 1],
      ['Dragon tooth', 1],
      ['Bloodwood sap', 1],
      ['Bronze bar', 5],
    ])
    expect(q.items.find((i) => i.name === 'Dragon tooth')?.note).toBe('iron pickaxe needed to gather')
    expect(q.items.find((i) => i.name === 'Antlers')?.note).toBeUndefined()
    expect(q.rewards).toEqual([
      'Tome of Construction - Vol 1. (After being asked to get antlers)',
      'Dragon Slayer reward packs,',
      '  After following Cathan into Ghornfell - containing 3 clay, 3 redberries, and 3 harralander.',
      '  End of quest - containing a Tome of the Dragon Slayer, a noxious draconic visage, and an anti-dragon shield.',
    ])
  })

  it('leaves Dragon Slayer without a pin when the Wise Old Man is ambiguous', () => {
    expect(get('Dragon Slayer').startPointId).toBeUndefined()
    expect(get('Dragon Slayer').startMatch).toBeUndefined()
  })

  it("resolves the 'Black Knight's Fortress (Quest)' links", () => {
    expect(get("Black Knight's Fortress")).toMatchObject({ order: 7, region: 'Dowdun Reach' })
    // |req = Partial completion of [[Black Knight's Fortress (quest)]] for access to [[Dowdun Reach]]
    expect(get('Biohazard').requires).toEqual(["Black Knight's Fortress"])
  })

  it('finds every fixture quest on the overview', () => {
    expect(warnings.filter((w) => w.message.startsWith('Not on the page'))).toEqual([])
  })

  it('keeps only known quests in requires', () => {
    // |req = Partial completion of [[Withering Heights]], to gain access to [[Fellhollow]]
    expect(get('The Wild Hunt').requires).toEqual(['Withering Heights'])
    expect(get('Things That Go Boom In The Night').requires).toEqual(['Withering Heights', 'The Wild Hunt'])
    // |req = [[Farming]] skill unlocked and [[wheat]] gathered.
    expect(get("Cook's Assistant").requires).toEqual([])
    expect(get('First Steps').requires).toEqual([])
  })

  it('gives every quest steps with unique, stable ids and plain text', () => {
    const again = run().quests
    for (const q of quests) {
      expect(q.steps.length, q.id).toBeGreaterThan(0)
      const ids = q.steps.map((s) => s.id)
      expect(new Set(ids).size, q.id).toBe(ids.length)
      for (const s of q.steps) {
        // The text alone, or section and text for a repeated text (see withStepIds).
        expect([questStepId(q.id, s.text), questStepId(q.id, `${s.section}\n${s.text}`)]).toContain(s.id)
        expect(s.text).not.toMatch(/\[\[|\]\]|\{\{|\}\}|'''/)
        expect(s.text.trim()).toBe(s.text)
        expect(s.text).not.toBe('')
      }
    }
    expect(again.map((q) => q.steps.map((s) => s.id))).toEqual(quests.map((q) => q.steps.map((s) => s.id)))
    expect(warnings.filter((w) => w.message === 'No steps found')).toEqual([])
  })

  it('keeps a note repeated under several headings once per heading', () => {
    // "If you already own the item, you do not need to craft it..." appears under three headings.
    const q = get("Doric's Quest")
    expect(q.steps).toHaveLength(7)
    const same = q.steps.filter((s) => s.text.startsWith('If you already own the item'))
    expect(same.map((s) => s.section)).toEqual(["Undead Ranger's Bow", "Necromancer's Staff", 'Shadow Sword'])
    // The first keeps the id it always had; the others get one from section and text.
    expect(same[0].id).toBe("Doric's Quest:s:a2c3c591")
    expect(same[0].id).toBe(questStepId("Doric's Quest", same[0].text))
    expect(same[1].id).toBe(questStepId("Doric's Quest", `Necromancer's Staff\n${same[1].text}`))
    expect(warnings.filter((w) => w.page === "Doric's Quest")).toEqual([])
    expect(warnings.some((w) => /duplicate step/.test(w.message))).toBe(false)
  })

  it('keeps {{Needed}} blocks as needs per section, outside the steps', () => {
    expect(get('Even More Restless Ghosts').needs).toEqual([
      {
        section: 'Windswept ghost',
        needed: 'Building materials in order to build a small house.',
        recommended: '24 ash logs to build a square foundation, four walls, and 1 floor piece as roof.',
      },
      { section: 'Reminiscing ghost', needed: 'Clay Decoration (Fired)' },
      {
        section: 'Paint-spattered ghost',
        needed: 'Mining equipment of power level 4 or higher (i.e., iron pickaxe or runes for Rocksplosion).',
      },
    ])
    expect(get("Icthlarin's Little Helper").needs).toEqual([
      {
        section: 'Saga of the Adventurer',
        needed: '1 torch, good weapons, armour and food to better defend yourself against wandering enemies.',
      },
    ])
    expect(get('Letters for the Dead').needs).toEqual([
      { section: 'The Missing Postage', recommended: 'Lodestone access to Fellhollow; Food, drink, and gear' },
    ])
    expect(quests.filter((q) => q.needs).map((q) => q.id).sort()).toEqual([
      'Even More Restless Ghosts',
      "Icthlarin's Little Helper",
      'Letters for the Dead',
    ])
    // The Windswept 'Note:' still folds into the step it always did.
    expect(get('Even More Restless Ghosts').steps.map((s) => s.id)).toContain('Even More Restless Ghosts:s:9cb1744b')
  })

  it('warns about no dropped template on the fixtures', () => {
    expect(warnings.filter((w) => /left out of the steps/.test(w.message))).toEqual([])
  })

  it('does not glue text around a floated {{Map}}', () => {
    const step = get("Icthlarin's Little Helper").steps.find((s) => s.section === 'Scaling Difficulties')
    expect(step?.text).toMatch(/^Item\(s\) required: Good weapons, armour, and food\. Speak to Hedric/)
    expect(step?.id).toBe("Icthlarin's Little Helper:s:1ea2c356")
  })

  it('gives every item a unique id and plain text', () => {
    for (const q of quests) {
      const ids = q.items.map((i) => i.id)
      expect(new Set(ids).size, q.id).toBe(ids.length)
      for (const i of q.items) {
        expect(i.id).toBe(questItemId(q.id, i.name))
        expect(`${i.name} ${i.note ?? ''}`).not.toMatch(/\[\[|\{\{|'''/)
      }
    }
  })

  it('returns only the fields of the Quest contract', () => {
    const allowed = new Set(['id', 'name', 'kind', 'order', 'region', 'description', 'location', 'startPointId', 'startMatch', 'steps', 'stepsSource', 'items', 'rewards', 'requires', 'needs', 'wikiUrl'])
    for (const q of quests) {
      for (const key of Object.keys(q)) expect(allowed.has(key), key).toBe(true)
      for (const value of Object.values(q)) expect(value).not.toBeUndefined()
      expect(q.location).not.toBe('')
    }
  })
})

// ---------------------------------------------------------------------------
// Ids against the last sync on disk (read-only): parser fixes must not move other ids

describe('ids against data/wiki/quests.json', () => {
  const DATA = join(import.meta.dirname, '../../../data/wiki')
  const onDisk = existsSync(join(DATA, 'quests.json')) && existsSync(join(DATA, 'meta.json'))
  const disk: Quest[] = onDisk ? JSON.parse(readFileSync(join(DATA, 'quests.json'), 'utf8')) : []
  const meta: SyncMeta | undefined = onDisk ? JSON.parse(readFileSync(join(DATA, 'meta.json'), 'utf8')) : undefined
  const revids = new Map([...fixturePages('quests/pages.json'), ...fixturePages('quests/quickguides.json')].map((p) => [p.title, p.revid]))
  const sameRevision = (title: string) => !revids.has(title) || meta?.revisions[title] === revids.get(title)
  // Only quests synced from the same wiki revisions as the fixtures can be compared.
  const comparable = disk.filter((q) => revids.has(q.id) && sameRevision(q.id) && sameRevision(`${q.id}/Quick guide`))
  const { quests } = run()
  const parsed = new Map(quests.map((q) => [q.id, q]))
  const stepIds = (q: Quest | undefined) => q?.steps.map((s) => s.id) ?? []
  const itemIds = (q: Quest | undefined) => q?.items.map((i) => i.id) ?? []

  /** Changed on purpose: the {{Map}} space in one step, the repeated Doric note, late-link item lines. */
  const STEPS_CHANGED = ["Icthlarin's Little Helper", "Doric's Quest"]
  const ITEMS_CHANGED = ['Granite Mauled', 'Even More Restless Ghosts']
  const REMOVED = ['Warding Off Danger']

  it.skipIf(!comparable.length)('keeps every step and item id of every other quest', () => {
    for (const old of comparable) {
      if (REMOVED.includes(old.id)) continue
      const q = parsed.get(old.id)
      expect(q, old.id).toBeDefined()
      if (!STEPS_CHANGED.includes(old.id)) expect(stepIds(q), old.id).toEqual(stepIds(old))
      if (!ITEMS_CHANGED.includes(old.id)) expect(itemIds(q), old.id).toEqual(itemIds(old))
    }
  })

  it.skipIf(!comparable.length)('changes only the expected ids in the quests that were fixed', () => {
    const ilh = parsed.get("Icthlarin's Little Helper")
    const ilhOld = stepIds(comparable.find((q) => q.id === "Icthlarin's Little Helper"))
    expect(stepIds(ilh)).toHaveLength(51)
    // Nothing to compare when data/wiki holds another revision of this quest than the fixture.
    if (ilhOld.length) {
      expect(stepIds(ilh).filter((id) => !ilhOld.includes(id))).toEqual(
        ilhOld.includes("Icthlarin's Little Helper:s:1ea2c356") ? [] : ["Icthlarin's Little Helper:s:1ea2c356"],
      )
    }
    expect(ilhOld.filter((id) => !stepIds(ilh).includes(id)).every((id) => id === "Icthlarin's Little Helper:s:2260589e")).toBe(true)

    // Doric's Quest only gains the two repeated notes.
    const doricOld = stepIds(comparable.find((q) => q.id === "Doric's Quest"))
    expect(doricOld.every((id) => stepIds(parsed.get("Doric's Quest")).includes(id))).toBe(true)

    expect(itemIds(parsed.get('Granite Mauled'))).toEqual(['Granite Mauled:i:one-slot-space-in-their-quest-inventory', 'Granite Mauled:i:air-rune'])
    expect(itemIds(parsed.get('Even More Restless Ghosts'))).toEqual([
      'Even More Restless Ghosts:i:clay-decoration',
      'Even More Restless Ghosts:i:mining-equipment-of-power-level-4-or-higher-i-e-iron-pickaxe-or-runes-for-rocksplosion',
      'Even More Restless Ghosts:i:building-materals-for-a-square-foundation-four-walls-and-a-roof-e-g-36-ash-logs',
    ])
    expect(parsed.has('Warding Off Danger')).toBe(false)
  })
})

describe('parseQuests: page recognition', () => {
  const page = (title: string, content: string): RawPage => ({ title, revid: 1, content })

  it('warns about pages without Quest details and unknown qtypes', () => {
    const src: QuestSources = {
      overview: fixturePage('quests/overview.json'),
      quests: [
        page('Plain page', 'Just text.'),
        page('No qtype', '{{Quest details|desc = x}}'),
        page('Mini', '{{Quest details|qtype = miniquest}}'),
        page('Side Task', '{{Quest details|qtype = Tertiary|start = Talk to [[Vannaka]]}}\n==Walkthrough==\nDo the thing.'),
      ],
      quickGuides: {},
    }
    const { quests, warnings } = run(MAP, src)
    expect(quests.map((q) => [q.id, q.kind])).toEqual([['Side Task', 'tertiary']])
    expect(quests[0].steps.map((s) => s.text)).toEqual(['Do the thing.'])
    expect(quests[0].startPointId).toBe(VANNAKA_POINT.id)
    expect(quests[0].startMatch).toBe('npc-name')
    const pageWarnings = warnings.filter((w) => w.page !== 'Quests')
    expect(pageWarnings).toEqual([
      { message: 'No Quest details/qtype, skipped', page: 'Plain page' },
      { message: 'No Quest details/qtype, skipped', page: 'No qtype' },
      { message: "Unknown qtype 'miniquest', skipped", page: 'Mini' },
    ])
  })

  it('skips pages marked as removed at the top, with one warning each', () => {
    const src: QuestSources = {
      overview: fixturePage('quests/overview.json'),
      quests: [
        page('Old One', '{{Gone}}\n{{Quest details|qtype = primary}}\n==Walkthrough==\nDo it.'),
        page('Old Two', '{{removed}}\n{{Quest details|qtype = secondary}}\n==Walkthrough==\nDo it.'),
        page('Still Here', '{{Quest details|qtype = tertiary}}\n==Walkthrough==\nDo it.\n==Rewards==\n* {{Gone}} hat'),
      ],
      quickGuides: {},
    }
    const { quests, warnings } = run(MAP, src)
    expect(quests.map((q) => q.id)).toEqual(['Still Here'])
    expect(warnings.filter((w) => w.page !== 'Quests')).toEqual([
      { message: 'Removed from the game ({{Gone}}), skipped', page: 'Old One' },
      { message: 'Removed from the game ({{Removed}}), skipped', page: 'Old Two' },
    ])
  })

  it('warns once per quest about templates whose text the steps leave out', () => {
    const src: QuestSources = {
      overview: fixturePage('quests/overview.json'),
      quests: [
        page(
          'Templated',
          '{{Quest details|qtype = tertiary|start = Somewhere}}\n==Walkthrough==\n{{Map|Somewhere|float=right}}\n{{Clear}}\nGo there.\n\n{{Mystery box|Take the red key.}}\n\n{{Mystery box|Again.}} {{Empty}}\n\n{{Needed|A key}}',
        ),
      ],
      quickGuides: {},
    }
    const { quests, warnings } = run(MAP, src)
    expect(quests[0].steps.map((s) => s.text)).toEqual(['Go there.'])
    expect(quests[0].needs).toEqual([{ needed: 'A key' }])
    expect(warnings.filter((w) => w.page === 'Templated')).toEqual([
      { message: 'Template {{Mystery box}} left out of the steps', page: 'Templated' },
    ])
  })

  it('warns when a quest has neither Quick guide steps nor a Walkthrough', () => {
    const src: QuestSources = {
      overview: fixturePage('quests/overview.json'),
      quests: [page('Lonely', '{{Quest details|qtype = secondary|start = Somewhere}}\n==Rewards==\n* Nothing')],
      quickGuides: { Lonely: page('Lonely/Quick guide', 'No list here.') },
    }
    const { quests, warnings } = run(MAP, src)
    expect(quests[0]).toMatchObject({ steps: [], stepsSource: 'walkthrough', rewards: ['Nothing'], location: 'Somewhere' })
    expect(warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        'Quick guide without steps, using the Walkthrough',
        'No Walkthrough section found',
        'No steps found',
      ]),
    )
  })
})

// ---------------------------------------------------------------------------
// Start points

describe('start points', () => {
  it('matches the start NPC by name (npc-name) and through a quest map named after them (quest-map)', () => {
    const { get } = run()
    // No {{Map}} on the page, |start = Speak to [[Vannaka]]
    expect(get('Things That Go Boom In The Night')).toMatchObject({ startPointId: VANNAKA_POINT.id, startMatch: 'npc-name' })
    // {{Map|...|Vannaka}} in the walkthrough lead
    expect(get('The Wild Hunt')).toMatchObject({ startPointId: VANNAKA_POINT.id, startMatch: 'quest-map' })
  })

  it('narrows several points down by the quest region', () => {
    const map = mapOf(
      [
        point('wise-old-man', 6133.2593, 187356.61, { region: 'Brynmoor' }),
        point('wise-old-man', 222410, 32940, { region: 'Dowdun Reach' }),
      ],
      { 'wise-old-man': 'Wise Old Man' },
    )
    const { get } = run(map)
    // Region 'Brynmoor/Ghornfell' picks the Brynmoor Wise Old Man.
    expect(get('Dragon Slayer')).toMatchObject({ startPointId: mapPointId('wise-old-man', 6133.2593, 187356.61), startMatch: 'npc-name' })
    // Withering Heights is in Fellhollow: no Wise Old Man there, so no pin.
    expect(get('Withering Heights').startPointId).toBeUndefined()
  })

  it('picks the point named in the start text from a quest map', () => {
    const map = mapOf(
      [
        point('manktongue', 43672.965, 120898.97, { name: 'Manktongue' }),
        point('slopfinger', 43067.16, 120848.66, { name: 'Slopfinger' }),
        point('cow-cooks-assistant', 45078.074, 121306.4, { name: "Cow (Cook's Assistant)" }),
        point('granite-mauled', 142219.22, 92602.2, { name: 'Doric (starting point)' }),
        point('granite-mauled', 131958.61, 83849.35, { name: 'Dragonkin Effigy' }),
        point('highlighting-the-problem', 18919, 149100, { name: 'Pedestal', description: 'Pedestal 1' }),
        point('highlighting-the-problem', 19234, 147056, { name: 'Saradomin Statue', description: 'Start and end of quest' }),
      ],
      { manktongue: 'Manktongue', slopfinger: 'Slopfinger', 'cow-cooks-assistant': "Cow (Cook's Assistant)" },
    )
    const { get } = run(map)
    // {{Map|Manktongue,Slopfinger,Cow (Cook's Assistant)}}, |start = Speak to [[Slopfinger]] ...
    expect(get("Cook's Assistant")).toMatchObject({ startPointId: mapPointId('slopfinger', 43067.16, 120848.66), startMatch: 'quest-map' })
    // 'Doric (starting point)' matches 'Speak to [[Doric]] ...'
    expect(get('Granite Mauled')).toMatchObject({ startPointId: mapPointId('granite-mauled', 142219.22, 92602.2), startMatch: 'quest-map' })
    // 'Start and end of quest' marks the start.
    expect(get('Highlighting the Problem')).toMatchObject({ startPointId: mapPointId('highlighting-the-problem', 19234, 147056), startMatch: 'quest-map' })
    // No map here for Animal Magnetism's own page, but [[Manktongue]] has one point.
    expect(get('Animal Magnetism')).toMatchObject({ startPointId: mapPointId('manktongue', 43672.965, 120898.97), startMatch: 'npc-name' })
  })

  it('ignores maps inside walkthrough sub-sections and splits comma lists', () => {
    expect(questMapNames(pageContent("Icthlarin's Little Helper"))).toEqual([])
    expect(questMapNames(pageContent("Black Knight's Fortress"))).toEqual([])
    expect(questMapNames(pageContent("Cook's Assistant"))).toEqual(['Manktongue', 'Slopfinger', "Cow (Cook's Assistant)"])
    expect(questMapNames(pageContent('Ratcatcher'))).toEqual(['Ratcatcher'])
  })

  it('narrows down by the top-level region of a sub-area', () => {
    // Rune Mysteries: region 'Temple Woods' (Brynmoor), |start = Speak to [[Zanik]] east of [[Vannaka]].
    const map = mapOf(
      [
        VANNAKA_POINT,
        point('zanik', 74419, 157729, { region: 'Brynmoor' }),
        point('zanik', 153366, -21181, { region: 'Fellhollow' }),
        point('zanik', 220451, 28213, { region: 'Dowdun Reach' }),
      ],
      { zanik: 'Zanik', vannaka: 'Vannaka' },
    )
    const { get } = run(map)
    expect(get('Rune Mysteries').region).toBe('Temple Woods')
    expect(get('Rune Mysteries')).toMatchObject({ startPointId: 'zanik:74419:157729', startMatch: 'npc-name' })
  })

  it('matches the last word of a quest-map point name when it is the only one', () => {
    // Mirror, Mirror: 'Speak to the mirror west of the Emberwood Village' and a point 'Magic Mirror'.
    const points = [
      point('mirror-mirror', 27850, -40978, { name: 'Magic Mirror', region: 'Fellhollow' }),
      point('mirror-mirror', 110924, 152929, { name: 'Candle', region: 'Brynmoor' }),
      point('mirror-mirror', 47528, -61014, { name: 'Bedraggled Spellbook', region: 'Fellhollow' }),
    ]
    const labels = { 'mirror-mirror': 'Mirror Mirror' }
    expect(run(mapOf(points, labels)).get('Mirror, Mirror')).toMatchObject({
      startPointId: 'mirror-mirror:27850:-40978',
      startMatch: 'quest-map',
    })
    // Two points end in 'Mirror': no guess.
    const twice = [...points, point('mirror-mirror', 1, 2, { name: 'Broken Mirror', region: 'Fellhollow' })]
    expect(run(mapOf(twice, labels)).get('Mirror, Mirror').startPointId).toBeUndefined()
  })

  it('finds a category through its Module:Map source when the id differs', () => {
    const map: MapData = {
      categories: [{ id: 'quest-pins', label: 'Quest pins', group: 'quest', sources: ['Module:Map/Ratcatcher.json'], count: 1 }],
      points: [point('quest-pins', 1, 2)],
    }
    const match = findStartPoint({ content: pageContent('Ratcatcher'), start: 'Speak to [[Nobody]]', location: 'Speak to Nobody.' }, new MapIndex(map))
    expect(match).toEqual({ pointId: 'quest-pins:1:2', match: 'quest-map' })
  })
})

// ---------------------------------------------------------------------------
// Content helpers

describe('parseItemLine', () => {
  it.each([
    ['4 [[raw rat meat]]', [{ name: 'Raw rat meat', qty: 4 }]],
    ['23 [[ash log]]s', [{ name: 'Ash log', qty: 23 }]],
    ['1x [[clean water]]', [{ name: 'Clean water', qty: 1 }]],
    ['Three [[primordial heart]]s', [{ name: 'Primordial heart', qty: 3 }]],
    ['1 [[dragon tooth]] ([[iron pickaxe]] needed to gather)', [{ name: 'Dragon tooth', qty: 1, note: 'iron pickaxe needed to gather' }]],
    ['7 [[wheat]]s (One is for the cow)', [{ name: 'Wheat', qty: 7, note: 'One is for the cow' }]],
    ['[[Unholy water]] (collected during the quest)', [{ name: 'Unholy water', note: 'collected during the quest' }]],
    ['Fishing Rod (Any, preferably highest available)', [{ name: 'Fishing Rod', note: 'Any, preferably highest available' }]],
    ['1 Shovel ', [{ name: 'Shovel', qty: 1 }]],
    ['Bronze or better Spade.', [{ name: 'Bronze or better Spade' }]],
    [
      '5 or more [[air rune]]s to cast [[Windstep]] or [[ash logs]] to cross the bridge',
      [{ name: 'Air rune', qty: 5, note: '5 or more air runes to cast Windstep or ash logs to cross the bridge' }],
    ],
    [
      '3x of each: [[Raw farm meat]], [[kalphite shell fragments]], and [[cactus steak]]s',
      [
        { name: 'Raw farm meat', qty: 3 },
        { name: 'Kalphite shell fragments', qty: 3 },
        { name: 'Cactus steak', qty: 3 },
      ],
    ],
    ['One slot space in their quest [[inventory]]', [{ name: 'One slot space in their quest inventory' }]],
    [
      'Mining equipment of power level 4 or higher (i.e., [[iron pickaxe]] or runes for [[Rocksplosion]])',
      [{ name: 'Mining equipment of power level 4 or higher (i.e., iron pickaxe or runes for Rocksplosion)' }],
    ],
    ['None', []],
    ['N/A', []],
    ['', []],
  ])('%s', (line, expected) => {
    expect(parseItemLine(line)).toEqual(expected)
  })
})

describe('parseItems', () => {
  it('merges duplicate names, sums their quantities and keeps each line note with its quantity', () => {
    const items = parseItems('Shrimp Catcher', '* 2 [[coarse thread]] for the [[coarse net]].\n* 1 [[ash logs]]\n* 1 [[coarse thread]]\n* 1 [[raw sardine]]')
    expect(items).toEqual([
      { id: 'Shrimp Catcher:i:coarse-thread', name: 'Coarse thread', qty: 3, note: '2x for the coarse net; 1x' },
      { id: 'Shrimp Catcher:i:ash-logs', name: 'Ash logs', qty: 1 },
      { id: 'Shrimp Catcher:i:raw-sardine', name: 'Raw sardine', qty: 1 },
    ])
  })

  it('keeps one note when merged lines agree', () => {
    expect(parseItems('Q', '* 2 [[stone]]s\n* 3 [[stone]]s')).toEqual([{ id: 'Q:i:stone', name: 'Stone', qty: 5 }])
    expect(parseItems('Q', '* 2 [[stone]]s (for the wall)\n* 3 [[stone]]s (for the wall)')).toEqual([
      { id: 'Q:i:stone', name: 'Stone', qty: 5, note: 'for the wall' },
    ])
    expect(parseItems('Q', '* [[rope]] (short)\n* [[rope]] (long)')).toEqual([{ id: 'Q:i:rope', name: 'Rope', note: 'short; long' }])
  })

  it('keeps a line whose link comes late as a free-text requirement', () => {
    // Granite Mauled: 'One' is no quantity of 'inventory'.
    expect(parseItems('Granite Mauled', '* One slot space in their quest [[inventory]]')).toEqual([
      { id: 'Granite Mauled:i:one-slot-space-in-their-quest-inventory', name: 'One slot space in their quest inventory' },
    ])
  })

  it('reads a value without list markers as one line', () => {
    expect(parseItems('The Wild Hunt', 'Three [[primordial heart]]s')).toEqual([{ id: 'The Wild Hunt:i:primordial-heart', name: 'Primordial heart', qty: 3 }])
    expect(parseItems('Withering Heights', 'None')).toEqual([])
    expect(parseItems('Regicide', '')).toEqual([])
    expect(parseItems('First Steps', undefined)).toEqual([])
  })

  it('folds nested lines into the note of their item', () => {
    expect(parseItems('Q', '* 2 [[stone]]s\n** or 2 [[ash log]]s')).toEqual([{ id: 'Q:i:stone', name: 'Stone', qty: 2, note: 'or 2 ash logs' }])
  })
})

describe('walkthroughSteps', () => {
  it('turns walkthrough tables into one step per row', () => {
    const steps = walkthroughSteps(pageContent("Black Knight's Fortress")) ?? []
    const garrison = steps.filter((s) => s.section === 'The Garrison')
    expect(garrison.map((s) => s.text)).toEqual([
      expect.stringMatching(/^East: Defeat Sergeant Blister\. He is located underground in The Garrison region/),
      expect.stringMatching(/^West: Standard interact\. Navigate past the elite Black Knight/),
    ])
    const shards = steps.filter((s) => /^(The Cathedral|The Garrison|The Grand Hall|The Library|The Menagerie|The Pastures|The Crypt|The Demon Gate|The Lake)/.test(s.section ?? ''))
    // 13 shards plus the Grand Hall checklist.
    expect(shards).toHaveLength(14)
    expect(steps.find((s) => s.section === 'The Library')?.text).toContain('the following books: The Empty Throne; The Eye of Oculus; Taking the Crown; Zamorak\'s Rebellion.')
  })

  it('drops image captions and closing lines, and folds notes into the step before', () => {
    const steps = walkthroughSteps(pageContent("Icthlarin's Little Helper")) ?? []
    const texts = steps.map((s) => s.text)
    expect(texts.some((t) => t.startsWith('Top moonstone'))).toBe(false)
    expect(texts.some((t) => t.startsWith('Middle moonstone short video'))).toBe(false)
    const rogue = steps.filter((s) => s.section === 'Rogue Trader').map((s) => s.text)
    expect(rogue).toHaveLength(2)
    expect(rogue[1]).toMatch(/Note: By completing reputation quests/)
    const restless = walkthroughSteps(pageContent('Restless Ghosts')) ?? []
    expect(restless.map((s) => s.text)).not.toContain('Quest completed.')
  })

  it('folds a short list into the sentence that announces it', () => {
    const steps = walkthroughSteps(pageContent('A Room With A Garou')) ?? []
    expect(steps[1].text).toMatch(/where players can create: 4 walls; 1 45° roof$/)
    const boom = walkthroughSteps(pageContent('Things That Go Boom In The Night')) ?? []
    expect(boom[1].text).toBe("Best location to find them near Vannaka is: South Emberwood's druid circle; Witchwillow Range's willow tree grove")
  })

  it('returns undefined without a Walkthrough section', () => {
    expect(walkthroughSteps('==Overview==\nText')).toBeUndefined()
  })
})

describe('walkthroughNeeds', () => {
  it('reads {{Needed}} per section and leaves the steps and their ids alone', () => {
    const content = "==Walkthrough==\n===X===\n{{Needed|[[Clay Decoration|Clay Decoration (Fired)]]|recommended=2 [[stone]]s}}\nIn [[Hope's Fall]], go.\n===Y===\n{{Needed|}}\nWait."
    expect(walkthroughNeeds(content)).toEqual([{ section: 'X', needed: 'Clay Decoration (Fired)', recommended: '2 stones' }])
    const without = content.replace(/\{\{Needed\|\[\[Clay[^\n]*\n/, '')
    expect(walkthroughSteps(content)).toEqual(walkthroughSteps(without))
    expect(walkthroughSteps(content)?.map((s) => s.text)).toEqual(["In Hope's Fall, go.", 'Wait.'])
  })

  it('gives nothing without a Walkthrough section', () => {
    expect(walkthroughNeeds('{{Needed|x}}\n==Overview==\nText')).toEqual([])
  })
})

describe('droppedTemplates', () => {
  it('names templates with text that no renderer shows', () => {
    expect(droppedTemplates('{{Map|A|float=right}} {{Clear}} {{Sic}} {{plink|B}} {{Needed|C}} {{Foo|text}} {{Bar}} {{Baz| }} {{#if:x|y}}')).toEqual(['Foo'])
    // Inside a map nothing counts.
    expect(droppedTemplates('{{Map|{{Foo|text}}}}')).toEqual([])
    expect(droppedTemplates('{{Pic link|{{Foo|text}}}}')).toEqual(['Foo'])
  })
})

describe('withStepIds', () => {
  it('rehashes a repeated text with its section, and skips a real duplicate with one warning', () => {
    const warnings: string[] = []
    const steps = withStepIds(
      'Q',
      [
        { text: 'Same.', section: 'A' },
        { text: 'Same.', section: 'B' },
        { text: 'Same.', section: 'B' },
        { text: 'Same.' },
      ],
      (message) => warnings.push(message),
    )
    expect(steps.map((s) => s.id)).toEqual([questStepId('Q', 'Same.'), questStepId('Q', 'B\nSame.')])
    expect(warnings).toEqual(['2 duplicate steps skipped'])
  })
})

describe('plain', () => {
  it('renders a block template between two sentences as a space', () => {
    expect(plain('a.{{Map|X|float=right}}B')).toBe('a. B')
    expect(plain('a.{{Clear}}B')).toBe('a. B')
    expect(plain('{{Map|X}}')).toBe('')
    expect(plain('Go {{Map|X}} there.')).toBe('Go there.')
  })
})

describe('quickGuideSteps', () => {
  it('reads list items only, outside the Reward section', () => {
    const guide = fixturePages('quests/quickguides.json').find((p) => p.title === 'Rune Mysteries/Quick guide')!
    const steps = quickGuideSteps(guide.content)
    expect(steps.map((s) => s.text)).toEqual([
      'Talk to Zanik',
      expect.stringMatching(/^Obtain 50 ash logs\. You can obtain ash logs by picking up spawns from the ground or uprooting Ash Saplings\. You can also create/),
      'Return to Zanik',
      expect.stringMatching(/^Mine rune essence using the stone pickaxe/),
      'Build a rune altar. This requires 12 stone and 4 rune essence.',
      'Craft some air runes and astral runes.',
      'Return to Zanik.',
    ])
  })
})

describe('parseRewards', () => {
  it('indents nested items and renders known templates', () => {
    expect(parseRewards(pageContent('A Room With A Garou'))).toEqual(['Unlocked building decorations:', '  Hanging Tools', '  Pots on a Bench', '  Sawhorse'])
    expect(parseRewards(pageContent('Mapping The Sands II'))).toEqual(['Bow of Elidinis recipe unlocked'])
    expect(parseRewards(pageContent("Black Knight's Fortress"))).toEqual([
      "1x Black Knight's Fortress reward pack",
      '  1x Tome of the Titan',
      '    +750 XP to Magic, Ranged, and Attack',
      "  1x Titan's wrath",
      "Recipe to creating the Titan's wrath 2h sword",
    ])
  })

  it('keeps the text between lists and drops references', () => {
    expect(parseRewards(pageContent('Granite Mauled'))).toContain('You will need to craft these for the granite maul:')
    expect(parseRewards(pageContent('Heartstrings'))).toEqual(['Crystal bow', 'Recipe for crystal bow'])
  })
})

describe('questResolver', () => {
  it("matches case-insensitively and strips a ' (quest)' suffix", () => {
    const resolve = questResolver(["Black Knight's Fortress", 'Ratcatcher'])
    expect(resolve("Black Knight's Fortress (Quest)")).toBe("Black Knight's Fortress")
    expect(resolve("black_knight's fortress (quest)")).toBe("Black Knight's Fortress")
    expect(resolve('ratcatcher')).toBe('Ratcatcher')
    expect(resolve('Fellhollow')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// fetchQuestSources with a fake context

describe('fetchQuestSources', () => {
  it('lists Category:Quests, fetches the pages and only existing Quick guides', async () => {
    const all = new Map<string, RawPage>()
    for (const p of [...fixturePages('quests/pages.json'), ...fixturePages('quests/quickguides.json'), fixturePage('quests/overview.json')]) all.set(p.title, p)
    const queries: Record<string, unknown>[] = []
    const requested: string[][] = []
    const ctx = {
      wiki: {
        async queryAll(params: Record<string, unknown>, pick: (d: unknown) => unknown[]) {
          queries.push(params)
          return pick(fixtureJson('quests/category.json'))
        },
      },
      log: () => {},
      full: false,
      revisions: new Map(),
      async pages(titles: string[]) {
        requested.push(titles)
        const pages = new Map<string, RawPage>()
        const missing: string[] = []
        for (const t of titles) {
          const page = all.get(t)
          if (page) pages.set(t, page)
          else missing.push(t)
        }
        return { pages, missing }
      },
    } as unknown as SyncContext

    const src = await fetchQuestSources(ctx)
    expect(queries).toEqual([{ list: 'categorymembers', cmtitle: 'Category:Quests', cmnamespace: 0, cmlimit: 'max' }])
    expect(src.overview.title).toBe('Quests')
    expect(src.quests).toHaveLength(40)
    expect(src.quests.map((q) => q.title)).not.toContain('Ratcatcher/Quick guide')
    expect(src.quests.map((q) => q.title)).not.toContain("Category:Cook's Assistant")
    expect(Object.keys(src.quickGuides).sort()).toEqual(['Ratcatcher', 'Rune Mysteries'])
    expect(src.quickGuides.Ratcatcher.title).toBe('Ratcatcher/Quick guide')
    expect(requested).toHaveLength(2)
    expect(requested[0]).toContain('Quests')
    expect(requested[1]).toContain('Dragon Slayer/Quick guide')
    expect(requested[1]).toHaveLength(40)
  })

  it('filters the overview page and subpages from the members', () => {
    expect(questTitles(['Quests', 'Ratcatcher', 'Ratcatcher/Quick guide', 'Ratcatcher'])).toEqual(['Ratcatcher'])
  })
})
