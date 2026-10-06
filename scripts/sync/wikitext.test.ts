import { describe, expect, it } from 'vitest'
import { fixturePage, fixturePages } from './__fixtures__/load'
import {
  decodeEntities,
  expandGrid,
  findTemplates,
  lead,
  links,
  listItems,
  normalizeTitle,
  paragraphs,
  parseTables,
  section,
  sections,
  splitTopLevel,
  stripMarkup,
} from './wikitext'

const questPages = fixturePages('quests/pages.json')
const questPage = (title: string) => {
  const page = questPages.find((p) => p.title === title)
  if (!page) throw new Error(`fixture misses ${title}`)
  return page.content
}
const dataRows = <T extends { header: boolean }>(rows: T[][]) => rows.filter((r) => !r.every((c) => c.header))

describe('splitTopLevel', () => {
  it('splits on plain separators', () => {
    expect(splitTopLevel('a|b|c')).toEqual(['a', 'b', 'c'])
    expect(splitTopLevel('')).toEqual([''])
    expect(splitTopLevel('a|')).toEqual(['a', ''])
  })

  it('ignores separators inside templates, links, params, comments and nowiki', () => {
    expect(splitTopLevel('a|{{b|c}}|[[d|e]]|{{{f|g}}}')).toEqual(['a', '{{b|c}}', '[[d|e]]', '{{{f|g}}}'])
    expect(splitTopLevel('a<!-- | -->|b')).toEqual(['a<!-- | -->', 'b'])
    expect(splitTopLevel('a<nowiki>|</nowiki>|b')).toEqual(['a<nowiki>|</nowiki>', 'b'])
    expect(splitTopLevel('[[File:x.png|thumb|The [[Wise Old Man]]]]|y')).toEqual([
      '[[File:x.png|thumb|The [[Wise Old Man]]]]',
      'y',
    ])
  })

  it('handles brace runs like MediaWiki', () => {
    expect(splitTopLevel('{{UH|{{UL|x}}}}|z')).toEqual(['{{UH|{{UL|x}}}}', 'z'])
    expect(splitTopLevel('{{a|{{{1|d}}}}}|x')).toEqual(['{{a|{{{1|d}}}}}', 'x'])
    expect(splitTopLevel('{{a}}}|b')).toEqual(['{{a}}}', 'b'])
  })

  it('treats unmatched openers as text', () => {
    expect(splitTopLevel('a|{{b|c')).toEqual(['a', '{{b', 'c'])
    expect(splitTopLevel('a]]|b}}|c')).toEqual(['a]]', 'b}}', 'c'])
  })

  it('respects tables only at line start', () => {
    expect(splitTopLevel('x|\n{|\n|a||b\n|}\n|y')).toEqual(['x', '\n{|\n|a||b\n|}\n', 'y'])
    expect(splitTopLevel('a {|b|}')).toEqual(['a {', 'b', '}'])
  })

  it('supports multi-character separators', () => {
    expect(splitTopLevel('a||{{b||c}}||d', '||')).toEqual(['a', '{{b||c}}', 'd'])
    expect(splitTopLevel('x\n{{t|\ny}}\nz', '\n')).toEqual(['x', '{{t|\ny}}', 'z'])
  })
})

describe('findTemplates', () => {
  it('parses named, positional and multi-line parameters', () => {
    const text = 'Intro {{Quest details\n|desc = A test.\n|item_req =\n*4 [[raw rat meat]]\n*6 [[ash log]]s\n|qtype = primary\n}} end'
    const [t] = findTemplates(text, 'Quest details')
    expect(t.name).toBe('Quest details')
    expect(t.params).toEqual({ desc: 'A test.', item_req: '*4 [[raw rat meat]]\n*6 [[ash log]]s', qtype: 'primary' })
    expect(t.positional).toEqual([])
    expect(text.slice(t.start, t.end)).toBe(t.raw)
    expect(t.raw.startsWith('{{Quest details')).toBe(true)
    expect(t.raw.endsWith('}}')).toBe(true)
  })

  it('normalises names: first letter, underscores, spaces, Template: prefix', () => {
    const text = '{{ quest_details |a=1}}{{hastranscript|quest}}{{Template:Map|X}}'
    expect(findTemplates(text, 'Quest details')).toHaveLength(1)
    expect(findTemplates(text, 'quest details')).toHaveLength(1)
    expect(findTemplates(text, 'Hastranscript')[0].positional).toEqual(['quest'])
    expect(findTemplates(text, 'HasTranscript')).toHaveLength(0)
    expect(findTemplates(text, 'map')[0].name).toBe('Map')
    expect(findTemplates(text, /^has/i)).toHaveLength(1)
    expect(findTemplates(text).map((t) => t.name)).toEqual(['Quest details', 'Hastranscript', 'Map'])
  })

  it('keeps = and | inside links and nested templates out of the split', () => {
    const [t] = findTemplates('{{t|[[a|b=c]]|x={{y|z=1}}|w = 2 = 3}}')
    expect(t.positional).toEqual(['[[a|b=c]]'])
    expect(t.params).toEqual({ x: '{{y|z=1}}', w: '2 = 3' })
  })

  it('removes comments from names and values', () => {
    const [t] = findTemplates('{{Quest details<!-- note -->\n|qtype = primary <!-- or secondary -->\n}}')
    expect(t.name).toBe('Quest details')
    expect(t.params.qtype).toBe('primary')
  })

  it('returns only top-level templates unless nested is set', () => {
    const text = '{{UH|{{UL|type = update}}\n{{UL|type = patch}}}}{{plink|X}}'
    expect(findTemplates(text).map((t) => t.name)).toEqual(['UH', 'Plink'])
    expect(findTemplates(text, 'UL')).toHaveLength(0)
    expect(findTemplates(text, 'UL', { nested: true }).map((t) => t.params.type)).toEqual(['update', 'patch'])
    expect(findTemplates(text, undefined, { nested: true }).map((t) => t.name)).toEqual(['UH', 'UL', 'UL', 'Plink'])
  })

  it('skips templates in comments and nowiki, and {{{params}}}', () => {
    expect(findTemplates('<!-- {{Map|x}} --><nowiki>{{Map|y}}</nowiki>{{{1|{{Map|z}}}}}')).toHaveLength(0)
    expect(findTemplates('{{{1|{{Map|z}}}}}', 'Map', { nested: true })[0].positional).toEqual(['z'])
  })

  it('finds templates inside links as top level', () => {
    expect(findTemplates('[[File:x.png|thumb|{{plink|A}}]]', 'plink')).toHaveLength(1)
  })
})

describe('sections', () => {
  const text = [
    'Lead text.',
    '== Location ==',
    'Here.',
    '==Walkthrough==',
    'Intro.',
    '===Part I: Start===',
    'One.',
    '=== Part II ===',
    'Two.',
    '==Reward==',
    '* 1 [[stone dagger]]',
    '====[[The Cathedral]]====',
    'Deep.',
    '{{t|',
    '== Not a heading ==',
    '}}',
  ].join('\n')

  it('lists headings with level, plain title and body', () => {
    const all = sections(text)
    expect(all.map((s) => [s.level, s.title])).toEqual([
      [2, 'Location'],
      [2, 'Walkthrough'],
      [3, 'Part I: Start'],
      [3, 'Part II'],
      [2, 'Reward'],
      [4, 'The Cathedral'],
    ])
    expect(all[5].rawTitle).toBe('[[The Cathedral]]')
    expect(all[0].body).toBe('Here.\n')
    expect(text.slice(all[0].start).startsWith('== Location ==')).toBe(true)
    expect(text.slice(all[0].end).startsWith('==Walkthrough==')).toBe(true)
  })

  it('includes subsections and stops at the next heading of the same level', () => {
    const body = section(text, 'Walkthrough')!
    expect(body).toContain('===Part I: Start===')
    expect(body).toContain('Two.')
    expect(body).not.toContain('Reward')
    expect(section(text, 'part ii')).toBe('Two.\n')
    expect(section(text, /^rewards?$/i)).toContain('stone dagger')
    expect(section(text, 'Missing')).toBeUndefined()
    expect(section(text, 'Location', { level: 3 })).toBeUndefined()
  })

  it('ignores headings inside templates and returns the lead', () => {
    expect(section(text, 'Not a heading')).toBeUndefined()
    expect(lead(text)).toBe('Lead text.\n')
    expect(lead('No headings')).toBe('No headings')
  })

  it('handles unequal markers and trailing comments', () => {
    const [s] = sections('== Foo === <!-- c -->\nbody')
    expect(s.level).toBe(2)
    expect(s.title).toBe('Foo =')
  })
})

describe('links', () => {
  it('reads targets, labels, trails and fragments', () => {
    expect(links('[[a|b]] [[ash log]]s [[Quests#Primary|primary quest]] [[Wise_Old_Man]]')).toEqual([
      { target: 'A', label: 'b' },
      { target: 'Ash log', label: 'ash logs' },
      { target: 'Quests', label: 'primary quest', fragment: 'Primary' },
      { target: 'Wise Old Man', label: 'Wise_Old_Man' },
    ])
  })

  it('strips markup from labels and applies the pipe trick', () => {
    expect(links("[[Black Knight's Fortress (Quest)|''Black Knight's Fortress'']] [[Goblin (race)|]]")).toEqual([
      { target: "Black Knight's Fortress (Quest)", label: "Black Knight's Fortress" },
      { target: 'Goblin (race)', label: 'Goblin' },
    ])
  })

  it('skips File, Image and Category links and the links in their captions', () => {
    const text = '[[File:Vannaka.png|thumb|The [[Wise Old Man]] here]][[Image:x.png]][[Category:Quests]] [[Vannaka]]'
    expect(links(text)).toEqual([{ target: 'Vannaka', label: 'Vannaka' }])
    expect(links('[[:Category:Quests|all quests]]')).toEqual([{ target: 'Category:Quests', label: 'all quests' }])
  })

  it('includes links inside template parameters but not in comments or nowiki', () => {
    const text = '{{Quest details|start=Speak to [[Vannaka]]}}<!-- [[Hidden]] --><nowiki>[[Nope]]</nowiki>'
    expect(links(text).map((l) => l.target)).toEqual(['Vannaka'])
  })

  it('does not attach a trail across nowiki', () => {
    expect(links('[[chicken]]<nowiki/>s')[0].label).toBe('chicken')
  })
})

describe('stripMarkup', () => {
  it('removes comments, refs and references', () => {
    expect(stripMarkup('a<!-- x -->b<ref>note [[x]]</ref> c<ref name="x" /> <references />')).toBe('ab c')
  })

  it('removes files with nested caption links, categories and magic words', () => {
    expect(stripMarkup('[[File:X.png|thumb|The [[Wise Old Man]] here]]Text')).toBe('Text')
    expect(stripMarkup('__NOTOC__ Hello [[Category:Quests]]')).toBe('Hello')
  })

  it('removes tables', () => {
    expect(stripMarkup('a\n{| class="wikitable"\n!H\n|-\n|b\n|}\nc')).toBe('a c')
  })

  it('renders plink and drops unknown templates', () => {
    expect(stripMarkup('{{plink|PLAN: Blue Standing Torch}}')).toBe('PLAN: Blue Standing Torch')
    expect(stripMarkup('{{plink|X|pic=X|txt=Y}}')).toBe('Y')
    expect(stripMarkup('x {{Map|Ratcatcher|center=178000,15000}}{{Clear}} y {{Quest details|desc=z}}')).toBe('x y')
    expect(stripMarkup('rememberance{{sic|misspelled remembrance}}.')).toBe('rememberance.')
    expect(stripMarkup("''{{RSL|RuneScape}}'' and {{OSL|Doric's Quest|same name}}")).toBe('RuneScape and same name')
    expect(stripMarkup('press {{Key press|F}} {{!}} {{{1|x}}}')).toBe('press F |')
  })

  it('accepts extra template renderers', () => {
    const opts = { templates: { coins: (t: { positional: string[] }) => `${t.positional[0]} coins` } }
    expect(stripMarkup('Costs {{Coins|100}}.', opts)).toBe('Costs 100 coins.')
  })

  it('turns links into their labels', () => {
    expect(stripMarkup('[[a|b]] [[c]] [[ash log]]s [[chicken]]<nowiki/>s [[Goblin (race)|]]')).toBe(
      'b c ash logs chickens Goblin',
    )
    expect(stripMarkup('[[Bramblemead Valley|Bramblemead {{plink|Village}}]]')).toBe('Bramblemead Village')
  })

  it('turns external links into their labels', () => {
    expect(stripMarkup('see [https://example.com the site] [https://example.com] https://x.org')).toBe(
      'see the site https://x.org',
    )
  })

  it('removes bold, italic, br and html tags', () => {
    expect(stripMarkup("'''Bold''' ''it'' '''''both''''' Black Knight's")).toBe("Bold it both Black Knight's")
    expect(stripMarkup('a<br />b<br>c<br/>d')).toBe('a b c d')
    expect(stripMarkup('<span style="color:red">red</span> <small>s</small> <div>d</div>')).toBe('red s d')
    expect(stripMarkup('a < b and c > d')).toBe('a < b and c > d')
  })

  it('decodes entities after removing tags', () => {
    expect(stripMarkup('a &amp; b&nbsp;c &#39;d&#39; &quot;e&quot; &lt;span&gt; &#x41;')).toBe(`a & b c 'd' "e" <span> A`)
  })

  it('keeps nowiki text literal', () => {
    expect(stripMarkup("<nowiki>[[not a link]] ''x''</nowiki>")).toBe("[[not a link]] ''x''")
  })

  it('removes heading and list markers and collapses whitespace', () => {
    expect(stripMarkup('== Title ==\n* item\n** sub\n#  num\n\n\n  end  ')).toBe('Title item sub num end')
  })
})

describe('decodeEntities and normalizeTitle', () => {
  it('decodes once and leaves unknown entities', () => {
    expect(decodeEntities('&amp;lt; &bogus; &#0;')).toBe('&lt; &bogus; &#0;')
  })

  it('normalises titles', () => {
    expect(normalizeTitle(' ash_log ')).toBe('Ash log')
    expect(normalizeTitle(':Category:Quests')).toBe('Category:Quests')
  })
})

describe('listItems', () => {
  it('reads depth, order and text', () => {
    expect(listItems('*4 [[raw rat meat]]\n* 6 [[ash log]]s\n** sub\n# one\n*# mixed\ntext\n*\n')).toEqual([
      { depth: 1, text: '4 [[raw rat meat]]', ordered: false },
      { depth: 1, text: '6 [[ash log]]s', ordered: false },
      { depth: 2, text: 'sub', ordered: false },
      { depth: 1, text: 'one', ordered: true },
      { depth: 2, text: 'mixed', ordered: true },
    ])
  })

  it('keeps multi-line templates in their item and allows indented markers', () => {
    expect(listItems('* a {{t|\n* not an item\n}}\n  * [[Crasorak Kara]]')).toEqual([
      { depth: 1, text: 'a {{t|\n* not an item\n}}', ordered: false },
      { depth: 1, text: '[[Crasorak Kara]]', ordered: false },
    ])
  })
})

describe('parseTables and expandGrid', () => {
  it('parses headers, attributes, inline cells, captions and multi-line cells', () => {
    const text = [
      'before',
      '{| class="wikitable"',
      '|+ Caption',
      'caption continues',
      '! colspan="2" style="x" | Title',
      '|-',
      '!A!!B',
      '|-',
      '| rowspan="2" |one||[[Link|two]]',
      '|-',
      '|style="text-align:center;" | three',
      '*listed',
      '',
      'after blank',
      '|-',
      '|Speak to X | not attributes',
      '|{{plink|Y}}',
      '|-',
      '|-',
      '|}',
    ].join('\n')
    const [rows] = parseTables(text)
    expect(rows.map((r) => r.map((c) => c.text))).toEqual([
      ['Title'],
      ['A', 'B'],
      ['one', '[[Link|two]]'],
      ['three\n*listed\n\nafter blank'],
      ['Speak to X | not attributes', '{{plink|Y}}'],
    ])
    expect(rows[0][0]).toMatchObject({ header: true, colspan: 2, rowspan: 1 })
    expect(rows[2][0]).toMatchObject({ header: false, rowspan: 2, colspan: 1 })
    expect(expandGrid(rows)).toEqual([
      ['Title', 'Title'],
      ['A', 'B'],
      ['one', '[[Link|two]]'],
      ['one', 'three\n*listed\n\nafter blank'],
      ['Speak to X | not attributes', '{{plink|Y}}'],
    ])
  })

  it('keeps nested tables in the cell and ignores tables inside templates', () => {
    const text = '{|\n|outer\n{|\n|inner||x\n|}\n|last\n|}\n{{t|\n{|\n|hidden\n|}\n}}'
    const tables = parseTables(text)
    expect(tables).toHaveLength(1)
    expect(tables[0][0].map((c) => c.text)).toEqual(['outer\n{|\n|inner||x\n|}', 'last'])
  })

  it('pads ragged rows and clips rowspans at the end', () => {
    const cell = (text: string, rowspan = 1) => ({ text, header: false, rowspan, colspan: 1 })
    expect(expandGrid([[cell('a', 5), cell('b')], [cell('c'), cell('d')]])).toEqual([
      ['a', 'b', ''],
      ['a', 'c', 'd'],
    ])
    expect(expandGrid([])).toEqual([])
  })
})

describe('paragraphs', () => {
  it('splits on blank lines, lists and headings and drops noise', () => {
    const text = [
      '{{Map|Dragon Slayer|float=right}}',
      '===Part I===',
      '[[File:Vannaka.png|thumb|Vannaka at his tent.]]',
      'Go and talk to [[Vannaka]].',
      'Same paragraph.',
      '',
      'Second {{Key press|F}}.',
      '* Item one',
      '** Sub item',
      'After list.',
      '{{Needed|x}}',
      '<div>',
      '{{Clear}}',
      '</div>',
      '{|',
      '|cell',
      '|}',
      "''Congratulations. Quest complete!''",
    ].join('\n')
    expect(paragraphs(text)).toEqual([
      'Go and talk to [[Vannaka]].\nSame paragraph.',
      'Second {{Key press|F}}.',
      '* Item one',
      '** Sub item',
      'After list.',
      "''Congratulations. Quest complete!''",
    ])
  })
})

describe('fixture: Quests overview', () => {
  const page = fixturePage('quests/overview.json')
  const tables = parseTables(page.content)

  it('finds the primary and secondary tables', () => {
    expect(tables).toHaveLength(2)
    expect(expandGrid(tables[0])[0]).toEqual(['Quest Type', 'Quests', 'Region', 'Where to Start'])
  })

  it('expands rowspans in the primary table', () => {
    const grid = expandGrid(dataRows(tables[0]))
    expect(grid.map((r) => stripMarkup(r[1]))).toEqual([
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
    expect(grid.map((r) => stripMarkup(r[2]))).toEqual([
      'Temple Woods',
      'Temple Woods',
      'Temple Woods',
      'Temple Woods',
      'Brynmoor/Ghornfell',
      'Fellhollow',
      'Dowdun Reach',
      'Umbral Sands',
      'Scorned Wilderness',
    ])
    expect(grid.map((r) => stripMarkup(r[0]))).toEqual([...Array(4).fill('Primary/Tutorial'), ...Array(5).fill('Primary')])
    expect(stripMarkup(grid[0][3])).toBe('Automatically started with new character.')
    expect(stripMarkup(grid[2][3])).toBe('Speak to Vannaka near the old windmill.')
    expect(links(grid[6][1])).toEqual([{ target: "Black Knight's Fortress (Quest)", label: "Black Knight's Fortress" }])
    expect(links(grid[4][2]).map((l) => l.target)).toEqual(['Brynmoor', 'Ghornfell'])
  })

  it('expands rowspans in the secondary table', () => {
    const grid = expandGrid(dataRows(tables[1]))
    const byQuest = new Map(grid.map((r) => [stripMarkup(r[1]), r.map((c) => stripMarkup(c))]))
    expect(grid).toHaveLength(29)
    expect(byQuest.get('Shrimp Catcher')).toEqual([
      'Secondary/Tutorial',
      'Shrimp Catcher',
      'Brynmoor',
      'Speak to the Wise Old Man in Bramblemead Village.',
    ])
    expect(byQuest.get('Things That Go Boom In The Night')?.slice(2)).toEqual([
      'Fellhollow',
      'Speak to Vannaka in Bleaksfield Valley.',
    ])
    expect(byQuest.get('Mapping The Sands II')?.slice(0, 3)).toEqual(['Secondary', 'Mapping The Sands II', 'Umbral Sands'])
    expect(byQuest.get('Contact!')?.[3]).toBe('Speak to Avisk Crystal in Dunes of Uzzer.')
    expect(grid[28]).toEqual(['', 'Saga of the Adventurer', '', ''])
  })

  it('keeps nested update templates out of the top level', () => {
    expect(findTemplates(page.content, 'UL')).toHaveLength(0)
    expect(findTemplates(page.content, 'UL', { nested: true })).toHaveLength(11)
    expect(findTemplates(page.content, 'UH')[0].positional[0]).toMatch(/^\{\{UL/)
  })
})

describe('fixture: quest pages', () => {
  it('reads Ratcatcher', () => {
    const text = questPage('Ratcatcher')
    const details = findTemplates(text, 'Quest details')
    expect(details).toHaveLength(1)
    const { params } = details[0]
    expect(params.qtype).toBe('primary')
    expect(params.start).toBe('Speak to [[Vannaka]] south of the Windmill.')
    expect(params.req).toBe('[[Getting Started]]')
    expect(params.item_req).toBe('*4 [[raw rat meat]]\n*6 [[ash log]]s\n*4 [[stone]]s')
    expect(listItems(params.item_req).map((i) => i.text)).toEqual(['4 [[raw rat meat]]', '6 [[ash log]]s', '4 [[stone]]s'])
    expect(links(params.item_req).map((l) => l.label)).toEqual(['raw rat meat', 'ash logs', 'stones'])

    const walkthrough = section(text, 'Walkthrough')!
    expect(walkthrough).toContain('Go and talk to [[Vannaka]]')
    expect(walkthrough).not.toContain('==Reward==')
    const steps = paragraphs(walkthrough)
    expect(steps).toHaveLength(4)
    expect(steps[0]).toMatch(/^Go and talk to \[\[Vannaka\]\]/)
    expect(stripMarkup(steps[1])).toContain('kill 4 giant rats to get 4 raw rat meats')
    expect(steps[3]).toBe("''Congratulations. Quest complete!''")

    expect(listItems(section(text, /^rewards?$/i)!).map((i) => i.text)).toEqual(['1 [[stone logging axe]]', '1 [[stone dagger]]'])
    expect(section(text, 'Location')).toContain('{{Map|Ratcatcher')
    expect(findTemplates(section(text, 'Location')!, 'Map')[0].params.center).toBe('178000,15000')
    expect(links(section(text, 'Required to complete')!).map((l) => l.target)).toEqual(['Rune Mysteries'])
  })

  it('reads Dragon Slayer', () => {
    const text = questPage('Dragon Slayer')
    const [details] = findTemplates(text, 'Quest details')
    expect(details.params.qtype).toBe('primary')
    const items = listItems(details.params.item_req)
    expect(items).toHaveLength(6)
    expect(items[3].text).toBe('1 [[dragon tooth]] ([[iron pickaxe]] needed to gather)')
    expect(details.params.item_req).toContain('*1 [[dragon tooth]] ([[iron pickaxe]] needed to gather)\n*1 [[bloodwood sap]]')
    expect(listItems(details.params.rec)).toHaveLength(4)
    expect(links(details.params.start).map((l) => [l.target, l.label])).toEqual([
      ['Wise Old Man', 'Wise Old Man'],
      ['Bramblemead Valley', 'Bramblemead Village'],
    ])

    const walkthrough = section(text, 'Walkthrough')!
    expect(sections(walkthrough).map((s) => s.title)).toEqual([
      'Part I: To Slay Dragons!',
      'Part II: A Lost Adventurer...',
      'Part III: The Beginnings of a Legend...',
      'Part IV: Fight for your life',
    ])
    expect(walkthrough).toContain("'''Congratulations! Quest complete!'''")
    expect(walkthrough).not.toContain('==Rewards==')
    const steps = paragraphs(walkthrough)
    expect(steps[0]).toMatch(/^To start this quest/)
    expect(steps).toContain('* In the Highlands you have to travel past the skeleton which the [[Garou (race)|Garou]] use as home on the western part and you can find a dragon skull. You can mine it\'s [[Dragon\'s Tooth|teeth]] with an [[iron pickaxe]] to get the [[dragon tooth]].')
    expect(steps.some((s) => s.includes('{{Map'))).toBe(false)

    const rewards = listItems(section(text, /^rewards?$/i)!)
    expect(rewards.map((r) => r.depth)).toEqual([1, 1, 2, 2])
  })

  it('reads Quest details written on one line (Black Knight\'s Fortress)', () => {
    const text = questPage("Black Knight's Fortress")
    const [details] = findTemplates(text, 'Quest details')
    expect(details.params.qtype).toBe('primary')
    expect(listItems(details.params.item_req).map((i) => i.text)).toEqual([
      'Steel or Undead Spade',
      'Steel or Mithril Pickaxe',
      'Mithril Logging Axe',
      'Fishing Rod (Any, preferably highest available)',
    ])
    expect(section(text, 'Quest overview')).toContain('{{Quest details')
    // Templates in table cells are not nested in another template, so they count as top level.
    expect(findTemplates(section(text, 'Walkthrough')!, 'Checklist')).toHaveLength(1)
    const tables = parseTables(section(text, 'The Grand Hall')!)
    expect(tables).toHaveLength(2)
    expect(findTemplates(tables[1][1][0].text, 'Checklist')).toHaveLength(1)
  })
})

describe('fixture: Dragonkin Vault', () => {
  const text = fixturePage('vaults/dragonkin-vault.json').content

  it('finds every top-level table', () => {
    expect(parseTables(text)).toHaveLength(4)
  })

  it('reads the progression table', () => {
    const [rows] = parseTables(section(text, 'Vault Locations')!)
    expect(rows[0][0]).toMatchObject({ header: true, colspan: 4, text: 'Standard Progression Order' })
    const data = dataRows(rows)
    expect(data).toHaveLength(12)
    const grid = expandGrid(data).map((r) => r.map((c) => stripMarkup(c)))
    expect(grid[0]).toEqual(['1', 'Crasorak Kara', '2', 'Temple Woods'])
    expect(grid[8]).toEqual(['9', 'Skekven Kara', '5', 'Lake of Lost Souls (east)'])
    expect(grid[11]).toEqual(['11', 'TBA', '7', 'Umbral Sands'])
  })

  it('keeps nested lists in the recipes table', () => {
    const [rows] = parseTables(section(text, 'Recipes')!)
    const data = dataRows(rows)
    expect(data).toHaveLength(10)
    const takla = data.find((r) => stripMarkup(r[0].text) === 'Takla Kara')!
    expect(takla).toHaveLength(3)
    expect(takla[1].text).toContain("* '''Paladin armour set:'''\n**[[Paladin's helm]]")
    const items = listItems(takla[1].text)
    expect(items.map((i) => i.depth)).toEqual([1, 2, 2, 2, 1])
    expect(stripMarkup(items[0].text)).toBe('Paladin armour set:')
    expect(takla[2].text).toBe('')

    const vek = data.find((r) => stripMarkup(r[0].text) === 'Vekchenven Kara')!
    expect(listItems(vek[1].text).map((i) => links(i.text)[0].target)).toEqual(["Necromancer's staff", "Fallen hoplite's helm"])
    const skeklac = data.find((r) => stripMarkup(r[0].text) === 'Skeklac Kara')!
    expect(stripMarkup(skeklac[2].text)).toBe('This recipe is not fully unlocked until completion of the quest Granite Mauled.')
  })

  it('reads the navbox regions', () => {
    const navbox = fixturePage('vaults/navbox.json').content
    const [outer] = findTemplates(navbox, 'Navbox')
    const [locations] = findTemplates(outer.params.group1, 'Navbox')
    expect(stripMarkup(locations.params.gtitle4)).toBe('Umbral Sands')
    expect(listItems(locations.params.group4).map((i) => i.text)).toEqual(['Uzzer Kara', 'Manafem Kara'])
    expect(links(locations.params.group1).map((l) => l.target)).toEqual(['Crasorak Kara', 'Thishepen Kara', 'Vertentis Kara'])
  })
})

describe('fixture: Consumable Recipes', () => {
  const text = fixturePage('rewards/consumable-recipes.json').content

  it('keeps a cell with plinks on separate lines as one cell', () => {
    const tables = parseTables(section(text, 'Lighting')!)
    expect(tables).toHaveLength(1)
    const data = dataRows(tables[0])
    expect(data).toHaveLength(1)
    expect(data[0]).toHaveLength(3)
    const plans = findTemplates(data[0][0].text, 'plink').map((t) => stripMarkup(t.raw))
    expect(plans).toEqual([
      'PLAN: Blue Wall-Mounted Torch',
      'PLAN: Blue Standing Torch',
      'PLAN: Green Wall-Mounted Torch',
      'PLAN: Green Standing Torch',
      'PLAN: Red Wall-Mounted Torch',
      'PLAN: Red Standing Torch',
      'PLAN: Purple Wall-Mounted Torch',
      'PLAN: Purple Standing Torch',
    ])
    expect(findTemplates(data[0][1].text, 'plink')).toHaveLength(8)
    expect(findTemplates(data[0][2].text, 'Drop sources list')[0].positional).toEqual(['PLAN: Blue Wall-mounted Torch'])
  })

  it('keeps text after blank lines in the source cell', () => {
    const [table] = parseTables(section(text, 'Fellhollow')!)
    const data = dataRows(table)
    expect(data).toHaveLength(2)
    expect(data[0][2].text).toContain('[[PLAN: headstone 01]] and [[PLAN: grave 1]] are available')
    expect(data[0][2].text).toContain('from 3 Moving spectral platforming')
    expect(stripMarkup(data[1][2].text)).toBe('Reward from the activity X Marks the Spot.')
  })

  it('reads plink variants and other sections', () => {
    expect(stripMarkup('{{plink|PLAN: Blue Standing Torch}}')).toBe('PLAN: Blue Standing Torch')
    const patterns = dataRows(parseTables(section(text, 'Patterns')!)[0])
    expect(patterns.map((r) => stripMarkup(r[1].text))).toContain('Umbral Sands Cape')
    const quests = dataRows(parseTables(section(text, 'Quests')!)[0])
    const animal = quests.find((r) => stripMarkup(r[2].text) === 'Animal Magnetism')!
    expect(findTemplates(animal[1].text, 'plink').map((t) => t.positional[0])).toEqual([
      'Undead Chicken',
      'Bundle of Undead Twigs',
      'Magnet',
    ])
    const books = listItems(section(text, 'Recipe Books')!)
    expect(books.map((b) => findTemplates(b.text, 'plink')[0].positional[0])).toHaveLength(6)
    expect(section(text, 'Plans')).toContain('===Dowdun Reach===')
    expect(section(text, 'Plans')).not.toContain('==Patterns==')
  })
})
