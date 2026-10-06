// Shared wikitext helpers for the sync parsers. Pure string functions, no I/O.
//
// Not a MediaWiki parser: just enough structure to read the Dragonwilds wiki
// reliably (templates, links, headings, lists, tables). Everything works on raw
// wikitext as returned by prop=revisions; templates are never expanded.
//
// Nesting model, shared by every helper: one left-to-right scan matches {{ }},
// {{{ }}}, [[ ]] and {| |} with a stack, the way the MediaWiki preprocessor does
// (brace runs like `}}}}` close two templates, `{|` and `|}` only count at the
// start of a line). HTML comments and the contents of <nowiki>, <pre>, <math>,
// <syntaxhighlight>, <source>, <gallery> and <templatedata> are opaque.
// Unmatched openers are plain text. A closing `}}` also closes a `[[` or `{|` left
// open inside its template, so one typo does not swallow the rest of the page.
// "Top level" below means: not inside any of these constructs.

// ---------------------------------------------------------------------------
// Scanner (internal)

type SpanKind = 'template' | 'param' | 'link' | 'table' | 'opaque'

interface Span {
  kind: SpanKind
  start: number
  /** Exclusive. */
  end: number
}

interface Opener {
  kind: 'brace' | 'link' | 'table'
  start: number
  /** Brace openers only: how many `{` are still unmatched. */
  count: number
}

const OPAQUE_TAG = /<(nowiki|pre|math|syntaxhighlight|source|gallery|templatedata)(\s[^>]*)?>/iy

function atLineStart(text: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--
  return j < 0 || text[j] === '\n'
}

/** All matched constructs in `text`, in closing order. Spans never partially overlap. */
function scan(text: string): Span[] {
  const spans: Span[] = []
  const stack: Opener[] = []
  const n = text.length
  let i = 0

  while (i < n) {
    const c = text[i]

    if (c === '<') {
      if (text.startsWith('<!--', i)) {
        const close = text.indexOf('-->', i + 4)
        const end = close < 0 ? n : close + 3
        spans.push({ kind: 'opaque', start: i, end })
        i = end
        continue
      }
      OPAQUE_TAG.lastIndex = i
      const open = OPAQUE_TAG.exec(text)
      if (open && !open[0].endsWith('/>')) {
        const closeRe = new RegExp(`</${open[1]}\\s*>`, 'ig')
        closeRe.lastIndex = i + open[0].length
        const close = closeRe.exec(text)
        if (close) {
          const end = close.index + close[0].length
          spans.push({ kind: 'opaque', start: i, end })
          i = end
          continue
        }
      }
      i++
      continue
    }

    if (c === '{') {
      let run = 1
      while (text[i + run] === '{') run++
      if (run >= 2) {
        stack.push({ kind: 'brace', start: i, count: run })
      } else if (text[i + 1] === '|' && atLineStart(text, i)) {
        stack.push({ kind: 'table', start: i, count: 0 })
        i += 2
        continue
      }
      i += run
      continue
    }

    if (c === '}') {
      let run = 1
      while (text[i + run] === '}') run++
      let pos = i
      let left = run
      while (left >= 2) {
        let k = stack.length - 1
        while (k >= 0 && stack[k].kind !== 'brace') k--
        if (k < 0) break
        stack.length = k + 1
        const open = stack[k]
        const matched = Math.min(open.count, left) >= 3 ? 3 : 2
        open.count -= matched
        spans.push({ kind: matched === 3 ? 'param' : 'template', start: open.start + open.count, end: pos + matched })
        pos += matched
        left -= matched
        if (open.count < 2) stack.pop()
      }
      i += run
      continue
    }

    if (c === '[' && text[i + 1] === '[') {
      stack.push({ kind: 'link', start: i, count: 0 })
      i += 2
      continue
    }

    if (c === ']' && text[i + 1] === ']') {
      const top = stack[stack.length - 1]
      if (top?.kind === 'link') {
        stack.pop()
        spans.push({ kind: 'link', start: top.start, end: i + 2 })
        i += 2
        continue
      }
      i++
      continue
    }

    if (c === '|' && text[i + 1] === '}' && atLineStart(text, i)) {
      // Closes the nearest table, skipping links left open in a cell, but never
      // crosses an open template (`|}}` on its own line ends a template call).
      let k = stack.length - 1
      while (k >= 0 && stack[k].kind === 'link') k--
      if (k >= 0 && stack[k].kind === 'table') {
        const open = stack[k]
        stack.length = k
        spans.push({ kind: 'table', start: open.start, end: i + 2 })
        i += 2
        continue
      }
    }

    i++
  }
  return spans
}

/** depth[i] = number of spans containing position i (start <= i < end). */
function depthMap(spans: Span[], length: number): Int32Array {
  const depth = new Int32Array(length + 1)
  for (const s of spans) {
    depth[s.start]++
    depth[s.end]--
  }
  let acc = 0
  for (let i = 0; i <= length; i++) {
    acc += depth[i]
    depth[i] = acc
  }
  return depth
}

/** Spans not contained in another span of the list, sorted by start. */
function outermost(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Span[] = []
  let maxEnd = 0
  for (const s of sorted) {
    if (s.start >= maxEnd) {
      out.push(s)
      maxEnd = s.end
    }
  }
  return out
}

function topLevelIndexOf(text: string, sep: string): number {
  const depth = depthMap(scan(text), text.length)
  for (let i = 0; i <= text.length - sep.length; i++) {
    if (depth[i] === 0 && text.startsWith(sep, i)) return i
  }
  return -1
}

const stripComments = (text: string) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')

// ---------------------------------------------------------------------------
// Titles

/**
 * Normalises a page title the way MediaWiki does for the parts that matter here:
 * underscores become spaces, whitespace is collapsed, a leading `:` is dropped and
 * the first letter is upper case. `normalizeTitle('ash_log')` gives `'Ash log'`.
 */
export function normalizeTitle(title: string): string {
  const t = title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/^:\s*/, '')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function normalizeTemplateName(name: string): string {
  return normalizeTitle(stripComments(name).replace(/^\s*template\s*:/i, ''))
}

// ---------------------------------------------------------------------------
// Splitting

/**
 * Splits `text` on `sep` (any length, default `'|'`) only at nesting depth 0:
 * separators inside `{{ }}`, `{{{ }}}`, `[[ ]]`, `{| |}`, HTML comments and opaque
 * tags are ignored. Parts are returned untrimmed; there is always at least one.
 * `splitTopLevel('a|{{b|c}}|[[d|e]]')` gives `['a', '{{b|c}}', '[[d|e]]']`.
 */
export function splitTopLevel(text: string, sep = '|'): string[] {
  if (!sep) throw new Error('splitTopLevel: empty separator')
  const depth = depthMap(scan(text), text.length)
  const out: string[] = []
  let last = 0
  let i = 0
  while (i <= text.length - sep.length) {
    if (depth[i] === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(last, i))
      i += sep.length
      last = i
    } else {
      i++
    }
  }
  out.push(text.slice(last))
  return out
}

// ---------------------------------------------------------------------------
// Templates

/** One template call, e.g. `{{Quest details|qtype = primary}}`. */
export interface Template {
  /**
   * Normalised name: comments and a `Template:` prefix removed, underscores as
   * spaces, whitespace collapsed, first letter upper case (`{{quest_details}}` gives
   * `'Quest details'`). Parser functions keep their argument: `'#if:x'`.
   */
  name: string
  /** Named parameters (`|key = value`): key and value trimmed, HTML comments removed. Multi-line values stay intact. */
  params: Record<string, string>
  /** Unnamed parameters in order, trimmed, HTML comments removed. `{{plink|X}}` gives `['X']`. */
  positional: string[]
  /** The full call including the braces, exactly as in the source. */
  raw: string
  /** Offset of the opening `{{` in the searched text. */
  start: number
  /** Offset just after the closing `}}` (exclusive). */
  end: number
}

function toTemplate(text: string, span: Span): Template {
  const raw = text.slice(span.start, span.end)
  const parts = splitTopLevel(raw.slice(2, -2), '|')
  const params: Record<string, string> = {}
  const positional: string[] = []
  for (const part of parts.slice(1)) {
    // Like MediaWiki: the first top-level `=` makes it a named parameter.
    const eq = topLevelIndexOf(part, '=')
    if (eq < 0) positional.push(stripComments(part).trim())
    else params[stripComments(part.slice(0, eq)).trim()] = stripComments(part.slice(eq + 1)).trim()
  }
  return { name: normalizeTemplateName(parts[0]), params, positional, raw, start: span.start, end: span.end }
}

function nameMatches(name: string, want: string | RegExp): boolean {
  if (typeof want === 'string') return name === normalizeTemplateName(want)
  want.lastIndex = 0
  return want.test(name)
}

/**
 * Template calls in `text`, in source order, found with a balanced-brace scan
 * (`{{{param}}}` is not a template; templates in comments or `<nowiki>` are skipped).
 *
 * `name` filters by name: a string matches after normalisation (first letter case
 * and `_` versus space do not matter, the rest is case-sensitive like MediaWiki);
 * a RegExp is tested against the normalised `name` (add the `i` flag if needed).
 *
 * By default only templates that are not nested inside another template (or
 * `{{{param}}}`) are returned; `{ nested: true }` returns every template call.
 * Templates inside links or tables count as not nested.
 */
export function findTemplates(text: string, name?: string | RegExp, opts: { nested?: boolean } = {}): Template[] {
  const braces = scan(text).filter((s) => s.kind === 'template' || s.kind === 'param')
  const candidates = (opts.nested ? [...braces].sort((a, b) => a.start - b.start) : outermost(braces)).filter(
    (s) => s.kind === 'template',
  )
  const out: Template[] = []
  for (const span of candidates) {
    const template = toTemplate(text, span)
    if (name === undefined || nameMatches(template.name, name)) out.push(template)
  }
  return out
}

// ---------------------------------------------------------------------------
// Sections

/** A heading and everything below it. */
export interface Section {
  /** Number of `=` (2 for `== X ==`), 1 to 6. */
  level: number
  /** Plain-text title (via stripMarkup): `===[[The Cathedral]]===` gives `'The Cathedral'`. */
  title: string
  /** Title wikitext between the `=` markers, trimmed. */
  rawTitle: string
  /**
   * Text after the heading line up to the next heading of the same or a higher
   * level (so subsections are included). Not trimmed.
   */
  body: string
  /** Offset of the heading line. */
  start: number
  /** Offset where the body ends (exclusive). */
  end: number
}

const HEADING = /^(={1,6})(.+?)(={1,6})[ \t]*$/

function parseHeading(line: string): { level: number; rawTitle: string } | undefined {
  const m = HEADING.exec(stripComments(line))
  if (!m) return undefined
  const level = Math.min(m[1].length, m[3].length)
  const rawTitle = ('='.repeat(m[1].length - level) + m[2] + '='.repeat(m[3].length - level)).trim()
  return rawTitle ? { level, rawTitle } : undefined
}

function findHeadings(text: string) {
  const depth = depthMap(scan(text), text.length)
  const out: { level: number; rawTitle: string; start: number; lineEnd: number }[] = []
  let pos = 0
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos)
    const lineEnd = nl < 0 ? text.length : nl
    if (text[pos] === '=' && depth[pos] === 0) {
      const heading = parseHeading(text.slice(pos, lineEnd))
      if (heading) out.push({ ...heading, start: pos, lineEnd })
    }
    if (nl < 0) break
    pos = nl + 1
  }
  return out
}

/**
 * Every heading in `text` in source order, each with its body including subsections.
 * Both `== Location ==` and `==Walkthrough==` work; headings inside templates,
 * tables and comments are ignored.
 */
export function sections(text: string): Section[] {
  const heads = findHeadings(text)
  return heads.map((h, i) => {
    let end = text.length
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].start
        break
      }
    }
    const bodyStart = Math.min(h.lineEnd + 1, end)
    return {
      level: h.level,
      title: stripMarkup(h.rawTitle),
      rawTitle: h.rawTitle,
      body: text.slice(bodyStart, end),
      start: h.start,
      end,
    }
  })
}

/**
 * Body of the first section whose title matches, including its subsections, or
 * undefined. A string matches case-insensitively with whitespace collapsed
 * (`'required to complete'` matches `== Required to Complete ==`); a RegExp is
 * tested against the plain title (`/^rewards?$/i`). `opts.level` restricts the
 * heading level.
 */
export function section(text: string, title: string | RegExp, opts: { level?: number } = {}): string | undefined {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const matches =
    typeof title === 'string'
      ? (t: string) => norm(t) === norm(title)
      : (t: string) => {
          title.lastIndex = 0
          return title.test(t)
        }
  return sections(text).find((s) => (opts.level === undefined || s.level === opts.level) && matches(s.title))?.body
}

/** Text before the first heading (the intro of a page), not trimmed. */
export function lead(text: string): string {
  const [first] = findHeadings(text)
  return first ? text.slice(0, first.start) : text
}

// ---------------------------------------------------------------------------
// Links

/** An internal wiki link. */
export interface Link {
  /** Normalised page title without fragment (see normalizeTitle), e.g. `'Ash log'`. */
  target: string
  /** Plain display text including a link trail: `[[ash log]]s` gives `'ash logs'`. */
  label: string
  /** Section after `#`, if any: `[[Quests#Primary|x]]` gives `'Primary'`. */
  fragment?: string
}

const LINK_TRAIL = /^[a-z]+/
const MEDIA_LINK = /^\s*(?:file|image|category)\s*:/i

interface LinkParts {
  page: string
  fragment: string
  /** Display wikitext, before the trail. */
  display: string
}

function linkParts(inner: string): LinkParts {
  const pipe = topLevelIndexOf(inner, '|')
  const rawTarget = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
  const hash = rawTarget.indexOf('#')
  const page = hash < 0 ? rawTarget : rawTarget.slice(0, hash)
  const fragment = hash < 0 ? '' : rawTarget.slice(hash + 1).replace(/_/g, ' ').trim()
  let display = pipe < 0 ? rawTarget.replace(/^:/, '') : inner.slice(pipe + 1)
  // Pipe trick: [[Goblin (race)|]] shows 'Goblin'.
  if (pipe >= 0 && !display.trim()) display = page.replace(/^:/, '').replace(/\s*\([^()]*\)\s*$/, '')
  return { page, fragment, display }
}

/**
 * Internal links in `text` in source order: `[[target]]`, `[[target|label]]` and
 * link trails (`[[ash log]]s`). Links inside template parameters count, as long
 * as they are written in `text` (templates are not expanded). File:, Image: and
 * Category: links are left out, and so are the links in their captions. Links in
 * comments and `<nowiki>` are ignored. Interwiki links (`[[rsw:Elvarg]]`) are
 * returned as-is.
 */
export function links(text: string): Link[] {
  const spans = scan(text)
    .filter((s) => s.kind === 'link')
    .sort((a, b) => a.start - b.start)
  const out: Link[] = []
  let skipUntil = -1
  for (const s of spans) {
    if (s.start < skipUntil) continue
    const inner = text.slice(s.start + 2, s.end - 2)
    if (MEDIA_LINK.test(inner)) {
      skipUntil = s.end
      continue
    }
    const trail = LINK_TRAIL.exec(text.slice(s.end, s.end + 64))?.[0] ?? ''
    const { page, fragment, display } = linkParts(inner)
    const link: Link = { target: normalizeTitle(page), label: stripMarkup(display + trail) }
    if (fragment) link.fragment = fragment
    out.push(link)
  }
  return out
}

// ---------------------------------------------------------------------------
// Plain text

/** Renders a template to wikitext for stripMarkup. Return `''` to drop it. */
export type TemplateRenderer = (template: Template) => string

/** Options for stripMarkup. */
export interface StripOptions {
  /**
   * Extra or replacement renderers keyed by template name (normalised like
   * findTemplates, so `'plink'` and `'Plink'` are the same). The returned wikitext
   * is stripped in turn.
   */
  templates?: Record<string, TemplateRenderer>
}

const otherWikiLink: TemplateRenderer = (t) => t.positional[1] || t.positional[0] || ''

const TEMPLATE_RENDERERS: Record<string, TemplateRenderer> = {
  Plink: (t) => t.params.txt || t.positional[0] || '',
  RSL: otherWikiLink,
  OSL: otherWikiLink,
  RSCL: otherWikiLink,
  'Key press': (t) => t.positional[0] ?? '',
  Nowrap: (t) => t.positional[0] ?? '',
  '!': () => '|',
  '=': () => '=',
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  ndash: '\u2013',
  mdash: '\u2014',
  minus: '\u2212',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  times: '\u00d7',
  divide: '\u00f7',
  middot: '\u00b7',
  bull: '\u2022',
  deg: '\u00b0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
}

/**
 * Decodes HTML entities: the common named ones (`&amp; &nbsp; &quot; &lt; &gt;`,
 * dashes, quotes, arrows) and numeric ones (`&#39;`, `&#x41;`). Unknown entities
 * stay as they are. Decodes once: `&amp;lt;` gives `&lt;`.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name] ?? m
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16)
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
  })
}

const LITERAL_OPEN = '\ue000'
const LITERAL_CLOSE = '\ue001'
const EXTERNAL_LINK = /\[(?:https?:)?\/\/[^\s\]]+(?:[ \t]+([^\]\n]*))?\]/gi
const HTML_TAG =
  /<\/?(?:span|div|small|big|sup|sub|strike|strong|s|u|b|i|em|code|center|font|p|abbr|del|ins|blockquote|tt|kbd|samp|var|q|cite|dfn|mark|time|data|ruby|rt|rp|bdi|bdo|wbr|hr|section|poem|tabber|noinclude|onlyinclude|includeonly|nowiki|ref|references|gallery|table|tr|td|th|caption|ul|ol|li|dl|dt|dd|h[1-6])\b[^>]*>/gi

/** Removes blocks that never show up as text and shields literal blocks behind placeholders. */
function removeBlocks(text: string, literals: string[]): string {
  return stripComments(text)
    .replace(/<(?:nowiki|ref|references|pre|gallery)\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '')
    .replace(/<(references|gallery|includeonly|templatedata|imagemap)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(nowiki|pre|math|syntaxhighlight|source)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _tag, inner: string) => {
      literals.push(inner)
      return `${LITERAL_OPEN}${literals.length - 1}${LITERAL_CLOSE}`
    })
}

/** Inline markup that is not nested structure. Idempotent on its own output. */
function inlineText(text: string): string {
  return text
    .replace(EXTERNAL_LINK, (_m, label?: string) => label ?? '')
    .replace(/'''''|'''|''/g, '')
    .replace(/<br\s*\/?>|<\/br\s*>/gi, ' ')
    .replace(HTML_TAG, '')
    .replace(/__[A-Z]+__/g, '')
    .replace(/^=+[ \t]*(.*?)[ \t]*=+[ \t]*$/gm, '$1')
    .replace(/^[ \t]*[*#:;]+[ \t]*/gm, '')
    .replace(/^-{4,}/gm, '')
}

function inline(text: string, renderers: Record<string, TemplateRenderer>): string {
  let out = ''
  let pos = 0
  for (const span of outermost(scan(text))) {
    if (span.start < pos) continue
    out += text.slice(pos, span.start)
    pos = span.end
    if (span.kind === 'template') {
      const template = toTemplate(text, span)
      const render = renderers[template.name]
      if (render) out += inline(render(template), renderers)
    } else if (span.kind === 'link') {
      const inner = text.slice(span.start + 2, span.end - 2)
      if (MEDIA_LINK.test(inner)) continue
      const trail = LINK_TRAIL.exec(text.slice(pos, pos + 64))?.[0] ?? ''
      pos += trail.length
      out += inline(linkParts(inner).display + trail, renderers)
    } else if (span.kind === 'table') {
      out += '\n'
    }
    // `{{{param}}}` and opaque blocks are dropped.
  }
  out += text.slice(pos)
  return inlineText(out)
}

/**
 * Wikitext to one line of plain text. Removes: HTML comments, `<ref>` notes,
 * `<references/>`, galleries, File:/Image: links (with the links in their
 * captions), Category: links, magic words like `__NOTOC__`, tables, `{{{params}}}`
 * and every template without a renderer (`{{Map}}`, `{{Clear}}`, `{{sic}}`, ...).
 * Renders `{{plink|X}}` as X (or its `txt=`), `{{RSL|X|label}}`/`{{OSL}}`/`{{RSCL}}`
 * as the label, `{{Key press|F}}` as F, `{{!}}` as `|`. Links become their label
 * (`[[a|b]]` b, `[[a]]s` as), external links `[http://x label]` their label; `'''`
 * and `''` go, `<br>` becomes a space, other HTML tags go but keep their text,
 * heading and list markers go, `<nowiki>` text stays literal. Then entities are
 * decoded, whitespace is collapsed and the result trimmed.
 */
export function stripMarkup(text: string, opts: StripOptions = {}): string {
  const renderers = { ...TEMPLATE_RENDERERS }
  for (const [name, render] of Object.entries(opts.templates ?? {})) renderers[normalizeTemplateName(name)] = render
  const literals: string[] = []
  const plain = inline(removeBlocks(text, literals), renderers).replace(
    new RegExp(`${LITERAL_OPEN}(\\d+)${LITERAL_CLOSE}`, 'g'),
    (_m, i: string) => literals[Number(i)] ?? '',
  )
  return decodeEntities(plain).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Lists

/** One line of a `*` or `#` list. */
export interface ListItem {
  /** Number of markers: `*` is 1, `**` is 2, `*#` is 2. */
  depth: number
  /** Raw wikitext after the markers, trimmed. */
  text: string
  /** True when the last marker is `#`. */
  ordered: boolean
}

/**
 * List items in `text`: lines starting with `*` or `#` (leading spaces allowed,
 * no space needed after the markers: `*4 [[x]]` works). Lines are split only at
 * top level, so a template spanning several lines stays in its item and list
 * lines inside a template or table in `text` are not items. Empty items are
 * skipped.
 */
export function listItems(text: string): ListItem[] {
  const out: ListItem[] = []
  for (const line of splitTopLevel(text, '\n')) {
    const m = /^[ \t]*([*#]+)([\s\S]*)$/.exec(line)
    if (!m) continue
    const body = m[2].trim()
    if (body) out.push({ depth: m[1].length, text: body, ordered: m[1].endsWith('#') })
  }
  return out
}

// ---------------------------------------------------------------------------
// Tables

/** One table cell. */
export interface TableCell {
  /** Raw wikitext content without the attribute prefix, trimmed. May span several lines. */
  text: string
  /** True for `!` cells. */
  header: boolean
  /** From `rowspan="n"`, at least 1. */
  rowspan: number
  /** From `colspan="n"`, at least 1. */
  colspan: number
}

const CELL_ATTRIBUTES = /^\s*(?:[a-zA-Z][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`|]+)\s*)*$/

function spanAttribute(attrs: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']?\\s*(\\d+)`, 'i').exec(attrs)
  const n = m ? parseInt(m[1], 10) : 1
  return n >= 1 ? n : 1
}

function makeCell(part: string, header: boolean): TableCell {
  // `rowspan="4" |content`: the part before a single top-level `|` holds the
  // attributes, but only when it really looks like attributes.
  const pieces = splitTopLevel(part, '|')
  let attrs = ''
  let text = part
  if (pieces.length > 1 && CELL_ATTRIBUTES.test(pieces[0])) {
    attrs = pieces[0]
    text = pieces.slice(1).join('|')
  }
  return { text, header, rowspan: spanAttribute(attrs, 'rowspan'), colspan: spanAttribute(attrs, 'colspan') }
}

function parseTable(src: string): TableCell[][] {
  const firstBreak = src.indexOf('\n')
  if (firstBreak < 0) return []
  const body = src.slice(firstBreak + 1, src.length - 2)
  const rows: TableCell[][] = []
  let row: TableCell[] = []
  let cell: TableCell | undefined
  let inCaption = false

  for (const line of splitTopLevel(body, '\n')) {
    const t = line.replace(/^[ \t]+/, '')
    if (t.startsWith('|-')) {
      if (row.length) rows.push(row)
      row = []
      cell = undefined
      inCaption = false
    } else if (t.startsWith('|+')) {
      cell = undefined
      inCaption = true
    } else if (t.startsWith('|') || t.startsWith('!')) {
      inCaption = false
      const header = t[0] === '!'
      let parts = splitTopLevel(t.slice(1), '||')
      if (header) parts = parts.flatMap((p) => splitTopLevel(p, '!!'))
      for (const part of parts) {
        cell = makeCell(part, header)
        row.push(cell)
      }
    } else if (cell && !inCaption) {
      // Continuation of the previous cell: text, blank lines, lists, nested tables.
      cell.text += '\n' + line
    }
  }
  if (row.length) rows.push(row)
  for (const r of rows) for (const c of r) c.text = c.text.trim()
  return rows
}

/**
 * Every top-level `{| ... |}` table in `text`, in source order, as rows of cells.
 * Handles the attributes line, `|+` captions (ignored), `|-` row separators (with
 * attributes), `!` and `!!` header cells, `|` and `||` data cells, attribute
 * prefixes (`rowspan="4" |x`, `style="..." | x`), cells spanning several lines
 * (including blank lines and lists) and rows before the first `|-`. Empty rows
 * are dropped, like MediaWiki does. Nested tables stay in their cell's text.
 */
export function parseTables(text: string): TableCell[][][] {
  return outermost(scan(text))
    .filter((s) => s.kind === 'table')
    .map((s) => parseTable(text.slice(s.start, s.end)))
}

/**
 * Expands rowspan and colspan into a rectangular grid of cell texts: a spanning
 * cell repeats its text in every slot it covers. Grid row i belongs to `rows[i]`
 * (a rowspan never adds rows); short rows are padded with `''`.
 */
export function expandGrid(rows: TableCell[][]): string[][] {
  const grid: (string | undefined)[][] = rows.map(() => [])
  rows.forEach((row, r) => {
    let c = 0
    for (const cell of row) {
      while (grid[r][c] !== undefined) c++
      for (let dr = 0; dr < cell.rowspan && r + dr < rows.length; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) grid[r + dr][c + dc] = cell.text
      }
      c += cell.colspan
    }
  })
  const width = grid.reduce((max, g) => Math.max(max, g.length), 0)
  return grid.map((g) => Array.from({ length: width }, (_, i) => g[i] ?? ''))
}

// ---------------------------------------------------------------------------
// Paragraphs

/** True when a block holds nothing but templates, File/Category links, comments and whitespace. */
function isNoise(block: string): boolean {
  let rest = ''
  let pos = 0
  for (const s of outermost(scan(block))) {
    rest += block.slice(pos, s.start)
    pos = s.end
    const content = s.kind === 'table' || (s.kind === 'link' && !MEDIA_LINK.test(block.slice(s.start + 2, s.end - 2)))
    if (content) rest += block.slice(s.start, s.end)
  }
  rest += block.slice(pos)
  return !rest.replace(/__[A-Z]+__|<br\s*\/?>/gi, '').trim()
}

/**
 * Splits `text` into blocks of raw wikitext, trimmed, in source order. Blocks are
 * separated by blank lines; every list line (`*`, `#`, `:`, `;`) and every table
 * is a block of its own, and headings end a block. Dropped: headings, lines or
 * blocks that are only templates or File links (`{{Map|...}}`, `[[File:x|thumb]]`),
 * and blocks that are empty after stripMarkup. Multi-line templates never split.
 */
export function paragraphs(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'))
    current = []
  }
  for (const line of splitTopLevel(text, '\n')) {
    if (!line.trim() || parseHeading(line)) {
      flush()
    } else if (/^[ \t]*(?:[*#:;]|\{\|)/.test(line) || isNoise(line)) {
      flush()
      blocks.push(line)
    } else {
      current.push(line)
    }
  }
  flush()
  return blocks.map((b) => b.trim()).filter((b) => !isNoise(b) && stripMarkup(b) !== '')
}
