// Map domain helpers: regions, power levels and point descriptions.
// Pure functions on plain text (run stripMarkup first). See docs/spikes.md for the formats.

/** Top-level regions of Ashenfall. Every MapPoint.region is one of these. */
export const REGIONS = ['Brynmoor', 'Ghornfell', 'Fellhollow', 'Dowdun Reach', 'Umbral Sands', 'Scorned Wilderness'] as const

/**
 * Sub-areas -> top-level region. Sources: the 'Quests' overview table, Template:Dragonkin Vaults
 * with the area column of 'Dragonkin Vault', and the vault descriptions in Module:Map/Vaults.json.
 */
export const SUB_AREAS: Record<string, string> = {
  'Temple Woods': 'Brynmoor',
  'Bramblemead Valley': 'Brynmoor',
  'Bramblemead Village': 'Brynmoor',
  'Whispering Swamp': 'Brynmoor',
  'Fractured Plains': 'Ghornfell',
  'Stormtouched Highlands': 'Ghornfell',
  'Bloodblight Swamp': 'Ghornfell',
  Emberwood: 'Fellhollow',
  'Lake of Lost Souls': 'Fellhollow',
  'Bleaksfield Valley': 'Fellhollow',
  'Coalridge Pass': 'Fellhollow',
  'Dunes of Uzzer': 'Umbral Sands',
  'Manafem Plains': 'Umbral Sands',
}

/** Misspellings and short forms seen in the data ('Brynmore', 'Zombie (Dowdun)', 'Tier4_World_Highlands'). */
const ALIASES: Record<string, string> = {
  Brynmore: 'Brynmoor',
  Felhollow: 'Fellhollow',
  Dowdun: 'Dowdun Reach',
  Highlands: 'Stormtouched Highlands',
}

export interface RegionMatch {
  /** Top-level region. */
  region: string
  /** Sub-area name when the text named one (e.g. 'Fractured Plains'). */
  area?: string
}

const key = (text: string) => text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()

const REGION_BY_KEY = new Map<string, RegionMatch>()
for (const r of REGIONS) REGION_BY_KEY.set(key(r), { region: r })
for (const [area, region] of Object.entries(SUB_AREAS)) REGION_BY_KEY.set(key(area), { region, area })
for (const [alias, target] of Object.entries(ALIASES)) REGION_BY_KEY.set(key(alias), { ...REGION_BY_KEY.get(key(target))! })

/** Text that is exactly a region, sub-area or known alias ('Brynmore', 'the Scorned Wilderness'). */
export function regionOf(text: string): RegionMatch | undefined {
  return REGION_BY_KEY.get(key(text).replace(/^the /, ''))
}

/** 'Umbral Sands Cape' -> Umbral Sands with rest 'Cape'. Only for text that starts with a region name. */
export function regionPrefix(text: string): (RegionMatch & { rest: string }) | undefined {
  const exact = regionOf(text)
  if (exact) return { ...exact, rest: '' }
  const k = key(text)
  let best: (RegionMatch & { rest: string; len: number }) | undefined
  for (const [name, match] of REGION_BY_KEY) {
    if (k.startsWith(name + ' ') && (!best || name.length > best.len)) {
      best = { ...match, rest: text.trim().slice(name.length).trim(), len: name.length }
    }
  }
  if (!best) return undefined
  const { len: _len, ...out } = best
  return out
}

const MENTION_PATTERNS = [...REGION_BY_KEY].map(([name, match]) => ({
  re: new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`),
  region: match.region,
}))

/** Distinct top-level regions a sentence mentions ('The location of a Sanguine Urn in Dowdun Reach.'). */
export function regionsMentioned(text: string): string[] {
  const k = key(text)
  const found = new Set<string>()
  for (const { re, region } of MENTION_PATTERNS) if (re.test(k)) found.add(region)
  return [...found]
}

/* ------------------------------------------------------------------ */
/* Descriptions and power levels                                       */
/* ------------------------------------------------------------------ */

export interface ParsedText {
  power?: number
  region?: string
  /** Text left to show; undefined when the text was fully consumed as power/region or was noise. */
  text?: string
  /** True when `text` is a readable version of an internal code ('Vestige: Training Sword'). */
  hint?: boolean
  /** The text seems to state a power level the parser cannot read (see extractPower); report it. */
  powerIssue?: string
}

/**
 * Text that seems to talk about a power level: 'Power Level', 'Tier', 'PL 7', 'Level 7'.
 * Only for Module:Map names and descriptions; quest text says 'level' in other senses.
 */
export function looksLikePower(text: string): boolean {
  return /power\s*level|\btier\b|\btier\s*\d|\bPL\s*\d|\blevel\s*\d/i.test(text)
}

export interface PowerMatch {
  power?: number
  /** The text without the power part; the input itself when nothing was taken. */
  rest: string
  /** Looks like power text, but not in a known format, or with two different levels. No power then. */
  unrecognised?: boolean
}

/**
 * 'Power Level N' (anywhere, optionally in brackets) or 'Tier N' / 'Tier N+' as words. The level must
 * stand alone: '5-6', '5 to 6', 'Power Level 5+' and '5.5' are not read. Tier codes ('Tier3_World') are
 * parseTierCode's job.
 */
const POWER_RE = /(\(\s*)?\b(power\s*level\s*:?|tier)\s*(\d+)(\+?)(?![\w+]|[.,]\d)(\s*\))?/gi
const RANGE_AFTER = /^\s*(?:[-\u2013/&]|to\b|or\b|and\b)\s*\d/i

/**
 * Takes the power level out of a name or description: 'Zombie (Fellhollow) - Power Level 5',
 * 'Black Dragon (Power Level 9)', 'Skeletal Archer - Power Level 6 (Dowdun)', 'Bramblemead Cape Tier 2'.
 * Text that looks like power (looksLikePower) but is not read here comes back as `unrecognised`.
 */
export function extractPower(input: string): PowerMatch {
  const text = input.replace(/\s+/g, ' ').trim()
  const hits: { power: number; start: number; end: number }[] = []
  for (const m of text.matchAll(POWER_RE)) {
    const [whole, open = '', kind, digits, plus, close = ''] = m
    const end = m.index + whole.length
    if ((plus && !/^tier$/i.test(kind!)) || RANGE_AFTER.test(text.slice(end))) return { rest: text, unrecognised: true }
    // Brackets only go along when both are there.
    const both = !!open && !!close
    hits.push({ power: Number(digits), start: both ? m.index : m.index + open.length, end: both ? end : end - close.length })
  }
  if (!hits.length) return looksLikePower(text) ? { rest: text, unrecognised: true } : { rest: text }
  if (new Set(hits.map((h) => h.power)).size > 1) return { rest: text, unrecognised: true }

  let rest = text
  for (const h of [...hits].reverse()) {
    const before = rest.slice(0, h.start).replace(/[\s,;:\u2013\u2014-]+$/, '')
    const after = rest.slice(h.end).replace(/^[\s.,;:\u2013\u2014-]+/, '')
    rest = [before, after].filter(Boolean).join(before.endsWith('(') ? '' : ' ')
  }
  if (looksLikePower(rest)) return { rest: text, unrecognised: true }
  return { power: hits[0]!.power, rest }
}

/** Only coordinates, like '12.3, 45.6' (sometimes with a z value or brackets). */
export function isCoordinateText(text: string): boolean {
  return /^\s*[([]?\s*-?\d+(?:\.\d+)?\s*[,;]\s*-?\d+(?:\.\d+)?(?:\s*[,;]\s*-?\d+(?:\.\d+)?)?\s*[)\]]?\s*$/.test(text)
}

/** 'TrainingSword' -> 'Training Sword', 'jewellery_box' -> 'jewellery box'. */
export function humanize(code: string): string {
  return code
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Same text for display purposes: case, spacing, underscores and curly quotes ignored. */
export function sameText(a: string, b: string): boolean {
  return key(a.replace(/_/g, ' ')) === key(b.replace(/_/g, ' '))
}

/**
 * Internal chest codes from chests.json and a few item pages:
 * 'Tier3_World', 'Tier2+_World', 'Tier4_World_Highlands', 'Tier4_World_Highlands_Cape',
 * 'Tier2_World_Vestige_TrainingSword'. The tier is the power level.
 */
export function parseTierCode(text: string): ParsedText | undefined {
  const m = text.trim().match(/^Tier\s*(\d+)\+?(?:_(\S*))?$/i)
  if (!m) return undefined
  const out: ParsedText = { power: Number(m[1]) }
  const tokens = (m[2] ?? '').split('_').filter((t) => t && !/^world$/i.test(t))
  const parts: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (/^vestige$/i.test(t)) {
      const next = tokens[i + 1]
      parts.push(next ? `Vestige: ${humanize(next)}` : 'Vestige')
      if (next) i++
    } else if (/^cape$/i.test(t)) {
      parts.push('Cape vestige')
    } else {
      const region = regionOf(humanize(t)) ?? regionOf(t)
      if (region && !out.region) out.region = region.region
      else parts.push(humanize(t))
    }
  }
  if (parts.length) {
    out.text = parts.join(', ')
    out.hint = true
  }
  return out
}

/**
 * A point description (or a name) as plain text -> power, region and the text worth showing.
 * `labels` are names the text is redundant with (category label, page name): equal text is dropped.
 */
export function parseDescription(input: string, labels: string[] = []): ParsedText {
  let text = input.replace(/\s+/g, ' ').trim()
  if (!text || isCoordinateText(text)) return {}

  const tier = parseTierCode(text)
  if (tier) return tier

  const out: ParsedText = {}
  // 'Zombie (Fellhollow) - Power Level 5', 'Black Dragon (Power Level 9)', 'Bramblemead Cape Tier 2'
  const level = extractPower(text)
  if (level.unrecognised) out.powerIssue = text
  else if (level.power !== undefined) {
    out.power = level.power
    text = level.rest
  }

  // Trailing '(Region)': 'Zombie (Dowdun)'.
  const paren = text.match(/^(.*\S)\s*\(([^()]+)\)$/)
  if (paren) {
    const r = regionOf(paren[2]!)
    if (r && (out.power !== undefined || labels.some((l) => sameText(l, paren[1]!)))) {
      out.region = r.region
      text = paren[1]!
    }
  }

  if (!text || labels.some((l) => sameText(l, text))) return out

  const exact = regionOf(text)
  if (exact) {
    out.region = exact.region
    // A sub-area says more than its region: keep it as text.
    if (exact.area) out.text = text
    return out
  }

  // 'Fractured Plains (Inside Cave)'
  const qualified = text.match(/^(.*\S)\s*\(([^()]+)\)$/)
  const inner = qualified ? regionOf(qualified[1]!) : undefined
  if (inner) out.region ??= inner.region
  else if (!out.region) {
    const mentioned = regionsMentioned(text)
    if (mentioned.length === 1) out.region = mentioned[0]
  }
  out.text = text
  return out
}
