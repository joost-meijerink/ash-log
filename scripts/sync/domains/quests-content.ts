// Quest page content: plain text, item candidates, steps and reward lines.
// Pure functions on wikitext, used by quests.ts.

import { questItemId, questStepId } from '../../../src/lib/ids'
import type { QuestItem, QuestNeed, QuestStep } from '../../../src/lib/types'
import type { Warn } from '../context'
import {
  expandGrid,
  findTemplates,
  links,
  listItems,
  paragraphs,
  parseTables,
  sections,
  splitTopLevel,
  stripMarkup,
  type Template,
  type TemplateRenderer,
} from '../wikitext'

// ---------------------------------------------------------------------------
// Plain text

/**
 * Templates that carry visible text on quest pages. Every other template is dropped.
 * Block templates ({{Map}}, {{Clear}}) render as a space, so the text around a map floated
 * into a sentence does not glue together ('food.{{Map|...}}Speak' gives 'food. Speak').
 */
const RENDERERS: Record<string, TemplateRenderer> = {
  'Pic link': (t) => t.params.txt || t.positional[0] || '',
  Map: () => ' ',
  Clear: () => ' ',
}

export function plain(wikitext: string): string {
  return stripMarkup(wikitext, { templates: RENDERERS })
}

export const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Joins sentence fragments, adding a full stop where a fragment has no closing punctuation. */
export function joinSentences(parts: string[]): string {
  let out = ''
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    out = out ? `${/[.!?:;,]$/.test(out) ? out : `${out}.`} ${part}` : part
  }
  return out
}

type Expander = (template: Template, before: string) => string

/** Replaces top-level templates by wikitext (so e.g. a checklist becomes a real list). */
function expandTemplates(text: string, expanders: Record<string, Expander>): string {
  let out = text
  const found = findTemplates(text).filter((t) => expanders[t.name])
  for (const t of found.reverse()) {
    out = out.slice(0, t.start) + expanders[t.name](t, text.slice(0, t.start)) + out.slice(t.end)
  }
  return out
}

/** {{Checklist|* a|* b}}: the list inside. */
const checklist: Expander = (t) => t.positional.join('\n') || Object.values(t.params).join('\n')

/** {{Flexbox|a|b|c}}: a list, one level below the list line before it. */
const flexboxAsList: Expander = (t, before) => {
  const lastLine = before.trimEnd().split('\n').pop() ?? ''
  const depth = (/^\s*([*#]+)/.exec(lastLine)?.[1].length ?? 0) + 1
  return '\n' + t.positional.map((arg) => `${'*'.repeat(depth)} ${arg}`).join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Items (Quest details |item_req)

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
}
const QTY_DIGITS = /^(\d+)\s*(?:x\b)?\s*(?=\S)/i
const QTY_WORDS = new RegExp(`^(${Object.keys(NUMBER_WORDS).join('|')})\\b\\s*(?:x\\b)?\\s*(?=\\S)`, 'i')
const NO_ITEMS = /^(none|n\/a|nothing|-)\.?$/i

interface ItemCandidate {
  name: string
  qty?: number
  note?: string
}

/** Strips leading punctuation and wrapping parentheses: '(iron pickaxe needed)' gives 'iron pickaxe needed'. */
function cleanNote(text: string): string | undefined {
  let note = text.trim().replace(/^[,;:\-–]+\s*/, '')
  const wrapped = /^\(([^()]*)\)[.,;]?$/.exec(note)
  if (wrapped) note = wrapped[1].trim()
  return note || undefined
}

/** A link counts as the item only when at most this many words stand before it ('5 or more [[air rune]]s'). */
const MAX_WORDS_BEFORE_ITEM = 3

/**
 * One |item_req line as item candidates. '*4 [[raw rat meat]]' gives 4x 'Raw rat meat';
 * '1 [[dragon tooth]] ([[iron pickaxe]] needed to gather)' adds a note; '3x of each: [[a]], [[b]]'
 * gives one candidate per link. The name is the first link target, or the plain text. A line
 * where the first link comes late ('One slot space in their quest [[inventory]]') is a
 * free-text requirement: the whole line as name, without quantity.
 */
export function parseItemLine(line: string): ItemCandidate[] {
  const text = plain(line)
  if (!text || NO_ITEMS.test(text)) return []

  let qty: number | undefined
  let rest = text
  const digits = QTY_DIGITS.exec(text)
  const words = digits ? null : QTY_WORDS.exec(text)
  if (digits) qty = Number(digits[1])
  else if (words) qty = NUMBER_WORDS[words[1].toLowerCase()]
  if (digits || words) rest = text.slice((digits ?? words)![0].length)

  const targets = links(line).filter((l) => l.target)
  if (/^of each\b/i.test(rest) && targets.length) {
    return targets.map((l) => ({ name: upperFirst(l.target), ...(qty !== undefined ? { qty } : {}) }))
  }

  let name: string
  let note: string | undefined
  if (targets.length) {
    const [first] = targets
    const at = rest.toLowerCase().indexOf(first.label.toLowerCase())
    const wordsBefore = at < 0 ? Infinity : rest.slice(0, at).trim().split(/\s+/).filter(Boolean).length
    if (wordsBefore > MAX_WORDS_BEFORE_ITEM) {
      const free = upperFirst(text.replace(/[.,;:]+$/, '').trim())
      return free ? [{ name: free }] : []
    }
    name = upperFirst(first.target)
    // '[qty] [[link]] (remark)' keeps the remark as note; anything irregular keeps the whole line.
    note = rest.toLowerCase().startsWith(first.label.toLowerCase()) ? cleanNote(rest.slice(first.label.length)) : text
  } else {
    const paren = /^(.+?)\s*\(([^()]+)\)\s*[.,;]?$/.exec(rest)
    name = paren ? paren[1] : rest
    note = paren ? paren[2].trim() : undefined
  }
  name = upperFirst(name.replace(/[.,;:]+$/, '').trim())
  if (!name) return []
  return [{ name, ...(qty !== undefined ? { qty } : {}), ...(note && note !== name ? { note } : {}) }]
}

interface ItemPart {
  qty?: number
  note?: string
}

/**
 * Note of an item listed on several lines. Lines that agree keep their note once; otherwise each
 * line keeps its own note next to its quantity ('2x for the coarse net; 1x'), so a remark about
 * one line is never read as a remark about the sum.
 */
function mergedNote(parts: ItemPart[]): string | undefined {
  if (parts.every((p) => p.note === parts[0].note)) return parts[0].note
  const perLine = parts.map((p) =>
    [p.qty !== undefined ? `${p.qty}x` : '', p.note?.replace(/[.,;]+$/, '') ?? ''].filter(Boolean).join(' '),
  )
  return perLine.filter(Boolean).join('; ') || undefined
}

/**
 * Item candidates from Quest details |item_req. Duplicate names are merged: quantities summed,
 * notes kept per line when they differ (see mergedNote).
 */
export function parseItems(questId: string, itemReq: string | undefined): QuestItem[] {
  const raw = itemReq?.trim()
  if (!raw) return []

  // List lines, with deeper levels folded into their parent as extra notes. Without a list, every line counts.
  const lines: { text: string; sub: string[] }[] = []
  const list = listItems(raw)
  if (list.length) {
    for (const li of list) {
      const last = lines[lines.length - 1]
      if (li.depth > 1 && last) last.sub.push(plain(li.text))
      else lines.push({ text: li.text, sub: [] })
    }
  } else {
    for (const line of splitTopLevel(raw.replace(/<br\s*\/?>/gi, '\n'), '\n')) {
      if (line.trim()) lines.push({ text: line.trim(), sub: [] })
    }
  }

  const byId = new Map<string, { name: string; parts: ItemPart[] }>()
  for (const line of lines) {
    for (const candidate of parseItemLine(line.text)) {
      const id = questItemId(questId, candidate.name)
      if (id.endsWith(':i:')) continue
      const note = joinSentences([candidate.note ?? '', ...line.sub]) || undefined
      const part: ItemPart = { ...(candidate.qty !== undefined ? { qty: candidate.qty } : {}), ...(note ? { note } : {}) }
      const existing = byId.get(id)
      if (existing) existing.parts.push(part)
      else byId.set(id, { name: candidate.name, parts: [part] })
    }
  }
  return [...byId].map(([id, { name, parts }]) => {
    const counted = parts.filter((p) => p.qty !== undefined)
    const qty = counted.length ? counted.reduce((sum, p) => sum + p.qty!, 0) : undefined
    const note = mergedNote(parts)
    return { id, name, ...(qty !== undefined ? { qty } : {}), ...(note ? { note } : {}) }
  })
}

// ---------------------------------------------------------------------------
// Steps

export interface RawStep {
  text: string
  section?: string
}

/** 'Congratulations. Quest complete!', 'Quest Completed!' and friends close a walkthrough. */
const QUEST_COMPLETE = /^(?:congratulations?[\s.,!:]*)?quest (?:is )?completed?[.!]*$/i
/** Remarks that belong to the step before them. */
const NOTE = /^(?:note|tip|hint|reward)s?\s*:/i
/** Sections that are never steps (in a Quick guide). */
const NOT_STEPS = /^(?:quest )?(?:rewards?|transcript|required to (?:complete|start)|update(?: history)?|trivia|references|gallery|see also)$/i
/** Lists after 'the following:' with items up to this length are folded into that sentence. */
const SHORT_ITEM = 120
/** A lone 'Some label:' line up to this length (a caption for an image) is dropped. */
const SHORT_LABEL = 60
/** A short line without closing punctuation right above an image is its caption. */
const SHORT_CAPTION = 80
const MEDIA_LINE = /^\[\[\s*(?:file|image)\s*:/i

interface Chunk {
  /** Nearest heading, undefined for the text before the first heading. */
  section?: string
  /** Outermost heading the chunk sits under. */
  top?: string
  text: string
}

/** Splits text at every heading: each chunk is the text between a heading and the next one. */
function chunks(text: string): Chunk[] {
  const secs = sections(text)
  const out: Chunk[] = [{ text: text.slice(0, secs[0]?.start ?? text.length) }]
  const stack: { level: number; title: string }[] = []
  secs.forEach((s, i) => {
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop()
    stack.push(s)
    const bodyStart = s.end - s.body.length
    const end = i + 1 < secs.length ? secs[i + 1].start : text.length
    out.push({ section: s.title || undefined, top: stack[0].title, text: text.slice(bodyStart, end) })
  })
  return out
}

interface Block {
  kind: 'prose' | 'item' | 'row'
  text: string
  /** Nested list lines, folded into this block. */
  children: string[]
}

/**
 * Raw wikitext pieces in source order: paragraph blocks (see paragraphs()) and whole tables,
 * which paragraphs() would drop. Image captions are left out.
 */
function pieces(text: string): { table: boolean; text: string }[] {
  const out: { table: boolean; text: string }[] = []
  let run: string[] = []
  const flush = () => {
    for (const block of paragraphs(run.join('\n'))) out.push({ table: false, text: block })
    run = []
  }
  const lines = splitTopLevel(text, '\n')
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('{|')) {
      flush()
      out.push({ table: true, text: t })
    } else if (!isCaption(t, lines[i + 1]?.trim() ?? '')) {
      run.push(line)
    }
  })
  flush()
  return out
}

function isCaption(line: string, next: string): boolean {
  return (
    MEDIA_LINE.test(next) &&
    !!line &&
    line.length <= SHORT_CAPTION &&
    !/^[*#:;{|=[]/.test(line) &&
    !/[.!?:;]$/.test(line)
  )
}

/** Typed blocks; nested list lines join the item above them. Tables give one block per row. */
function toBlocks(text: string, withTables: boolean): Block[] {
  const out: Block[] = []
  let lastItem: Block | undefined
  for (const piece of pieces(expandTemplates(text, { Checklist: checklist }))) {
    if (piece.table) {
      lastItem = undefined
      if (withTables) for (const row of tableRows(piece.text)) out.push({ kind: 'row', text: row, children: [] })
      continue
    }
    const block = piece.text
    const li = /^[*#]/.test(block) ? listItems(block)[0] : undefined
    const text = plain(li ? li.text : block)
    if (!text) continue
    if (li && li.depth > 1 && lastItem) {
      lastItem.children.push(text)
      continue
    }
    const b: Block = { kind: li ? 'item' : 'prose', text, children: [] }
    lastItem = li ? b : undefined
    out.push(b)
  }
  return out
}

/**
 * Blocks to step texts. Folds short lists into a sentence ending with ':', notes into the step before
 * them, and drops image captions ('Cave entrance:') and the closing 'Congratulations. Quest complete!'.
 */
function blockTexts(blocks: Block[]): string[] {
  const out: string[] = []
  const texts = blocks.map((b) => ({ kind: b.kind, text: joinSentences([b.text, ...b.children]) }))
  for (let i = 0; i < texts.length; i++) {
    const { kind, text } = texts[i]
    if (QUEST_COMPLETE.test(text)) continue
    if (kind === 'prose' && /[:;]$/.test(text)) {
      let j = i + 1
      while (j < texts.length && texts[j].kind === 'item') j++
      const run = texts.slice(i + 1, j).map((t) => t.text.replace(/[.;,]$/, ''))
      if (run.length && run.every((t) => t.length <= SHORT_ITEM)) {
        out.push(`${text.replace(/;$/, ':')} ${run.join('; ')}`)
        i = j - 1
        continue
      }
      if (!run.length && text.length <= SHORT_LABEL) continue
    }
    if (kind === 'prose' && NOTE.test(text) && out.length) {
      out[out.length - 1] = joinSentences([out[out.length - 1], text])
      continue
    }
    out.push(text)
  }
  return out
}

/** One text per data row: 'South-West: Cut down vines... You can acquire...'. */
function tableRows(table: string): string[] {
  const [rows] = parseTables(table)
  if (!rows) return []
  const grid = expandGrid(rows)
  const out: string[] = []
  rows.forEach((row, i) => {
    if (row.every((c) => c.header)) return
    const cells = grid[i].map((cell) => joinSentences(blockTexts(toBlocks(cell, false)))).filter(Boolean)
    if (!cells.length) return
    out.push(cells.length === 1 ? cells[0] : `${cells[0].replace(/[.:]$/, '')}: ${joinSentences(cells.slice(1))}`)
  })
  return out
}

/**
 * Steps from a '<quest>/Quick guide' page: its list items (outside Reward and similar sections).
 * Nested items are hints for the item above them and become part of that step. Names of
 * templates whose text the steps leave out go into `dropped` (see droppedTemplates).
 */
export function quickGuideSteps(content: string, dropped?: Set<string>): RawStep[] {
  const out: RawStep[] = []
  for (const chunk of chunks(content)) {
    if (chunk.top && NOT_STEPS.test(chunk.top)) continue
    for (const name of droppedTemplates(chunk.text, QUICK_GUIDE_TEMPLATES)) dropped?.add(name)
    const items = toBlocks(chunk.text, false).filter((b) => b.kind === 'item')
    for (const text of blockTexts(items)) out.push({ text, ...(chunk.section ? { section: chunk.section } : {}) })
  }
  return out
}

/** Body of the Walkthrough section (the outermost one), or undefined. */
function walkthroughBody(content: string): string | undefined {
  return sections(content)
    .filter((s) => /^walkthrough$/i.test(s.title))
    .sort((a, b) => a.level - b.level)[0]?.body
}

/**
 * Steps from the Walkthrough section: one per paragraph, list item or table row, with the nearest
 * sub-heading as section. Undefined when the page has no Walkthrough section. Names of templates
 * whose text the steps leave out go into `dropped` (see droppedTemplates).
 */
export function walkthroughSteps(content: string, dropped?: Set<string>): RawStep[] | undefined {
  const body = walkthroughBody(content)
  if (body === undefined) return undefined
  const out: RawStep[] = []
  for (const chunk of chunks(body)) {
    for (const name of droppedTemplates(chunk.text, WALKTHROUGH_TEMPLATES)) dropped?.add(name)
    for (const text of blockTexts(toBlocks(chunk.text, true))) {
      out.push({ text, ...(chunk.section ? { section: chunk.section } : {}) })
    }
  }
  return out
}

/**
 * {{Needed|what you need|recommended=...}} blocks of the Walkthrough, with the sub-heading they sit
 * under. They stay out of the steps: a new step there would fold the 'Note:' after it and change
 * existing step ids.
 */
export function walkthroughNeeds(content: string): QuestNeed[] {
  const body = walkthroughBody(content)
  if (body === undefined) return []
  const out: QuestNeed[] = []
  for (const chunk of chunks(body)) {
    for (const t of findTemplates(chunk.text, 'Needed')) {
      const needed = plain(t.positional[0] ?? '')
      const recommended = plain(t.params.recommended ?? '')
      if (!needed && !recommended) continue
      out.push({
        ...(chunk.section ? { section: chunk.section } : {}),
        ...(needed ? { needed } : {}),
        ...(recommended ? { recommended } : {}),
      })
    }
  }
  return out
}

/** Templates that show nothing worth keeping in a step: maps, layout, [sic], the quest navbox. */
const SILENT_TEMPLATES = ['Map', 'Clear', 'Sic', 'Quests']
/** Templates whose text ends up in the steps (renderers and expanders). */
const RENDERED_TEMPLATES = ['Pic link', 'Plink', 'RSL', 'OSL', 'RSCL', 'Key press', 'Nowrap', '!', '=', 'Checklist']
const QUICK_GUIDE_TEMPLATES = new Set([...SILENT_TEMPLATES, ...RENDERED_TEMPLATES])
/** The walkthrough also keeps {{Needed}}, as Quest.needs. */
const WALKTHROUGH_TEMPLATES = new Set([...QUICK_GUIDE_TEMPLATES, 'Needed'])

/**
 * Names of templates in `text` that carry text but have no place in the output: not in `known`,
 * not a parser function, with at least one argument that is not empty. Templates inside a silent
 * one ({{Map|...}}) do not count. Used to warn instead of losing wiki text without a word.
 */
export function droppedTemplates(text: string, known: ReadonlySet<string> = WALKTHROUGH_TEMPLATES): string[] {
  const all = findTemplates(text, undefined, { nested: true })
  const silent = all.filter((t) => SILENT_TEMPLATES.includes(t.name))
  const out = new Set<string>()
  for (const t of all) {
    if (known.has(t.name) || t.name.startsWith('#')) continue
    if (silent.some((s) => s.start < t.start && t.end <= s.end)) continue
    if ([...t.positional, ...Object.values(t.params)].some((arg) => stripMarkup(arg) !== '')) out.add(t.name)
  }
  return [...out]
}

/**
 * Adds stable ids. The same text twice in one quest gets a second id from section and text, as long
 * as the sections differ (the first keeps its plain id). A real duplicate is skipped, with one
 * warning per quest.
 */
export function withStepIds(questId: string, raw: RawStep[], warn: Warn): QuestStep[] {
  const seen = new Set<string>()
  const out: QuestStep[] = []
  let duplicates = 0
  for (const step of raw) {
    let id = questStepId(questId, step.text)
    if (seen.has(id) && step.section) id = questStepId(questId, `${step.section}\n${step.text}`)
    if (seen.has(id)) {
      duplicates++
      continue
    }
    seen.add(id)
    out.push({ id, text: step.text, ...(step.section ? { section: step.section } : {}) })
  }
  if (duplicates) warn(`${duplicates} dubbele stap(pen) overgeslagen`, questId)
  return out
}

// ---------------------------------------------------------------------------
// Rewards

/**
 * Plain-text lines of the Reward(s) section, in order: list items and the text between them.
 * Nested list items are indented with two spaces per level ('  1x Tome of Cooking - Vol 1.').
 */
export function parseRewards(content: string): string[] {
  const rewards = sections(content)
    .filter((s) => /^(?:quest )?rewards?$/i.test(s.title))
    .sort((a, b) => a.level - b.level)[0]
  if (!rewards) return []
  const out: string[] = []
  for (const piece of pieces(expandTemplates(rewards.body, { Flexbox: flexboxAsList }))) {
    if (piece.table) {
      out.push(...tableRows(piece.text))
      continue
    }
    const block = piece.text
    const li = /^[*#]/.test(block) ? listItems(block)[0] : undefined
    const text = plain(li ? li.text : block)
    if (text) out.push('  '.repeat(Math.max(0, (li?.depth ?? 1) - 1)) + text)
  }
  return out
}
