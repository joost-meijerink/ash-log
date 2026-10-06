// Vaults domain: 'Dragonkin Vault' page tables + 'Template:Dragonkin Vaults' navbox -> Vault[].
//
// - "Standard Progression Order" table: order, vault (link or ''TBA''), power level, area.
// - Navbox: the region per vault (gtitle -> list) and the names of vaults without a page yet,
//   which the table only lists as ''TBA''.
// - "Recipes" table: nested lists per vault, where a bold item ending in ':' labels an armour set.

import { wikiUrl } from '../../../src/lib/ids'
import type { MapData, MapPoint, Vault, VaultRecipe } from '../../../src/lib/types'
import type { SyncContext, Warn } from '../context'
import type { RawPage } from '../wiki'
import { findTemplates, links, listItems, parseTables, stripMarkup } from '../wikitext'
import { compact, nameKey, readColumns, sameName, upperFirst } from './table-columns'

export const VAULT_PAGE = 'Dragonkin Vault'
export const VAULT_NAVBOX = 'Template:Dragonkin Vaults'
/** Map category of the vault entrances (Module:Map/Vaults.json). */
export const VAULT_MAP_CATEGORY = 'vaults'
const VAULT_MAP_PAGE = 'Module:Map/Vaults.json'

export interface VaultSources {
  /** The 'Dragonkin Vault' page (Standard Progression Order + Recipes tables). */
  page: RawPage
  /** 'Template:Dragonkin Vaults' navbox (region per vault, names of vaults without a page). */
  navbox: RawPage
}

export async function fetchVaultSources(ctx: SyncContext): Promise<VaultSources> {
  const { pages } = await ctx.pages([VAULT_PAGE, VAULT_NAVBOX])
  const page = pages.get(VAULT_PAGE)
  const navbox = pages.get(VAULT_NAVBOX)
  if (!page || !navbox) {
    const gone = [VAULT_PAGE, VAULT_NAVBOX].filter((title) => !pages.has(title))
    throw new Error(`Vaults: pagina ontbreekt op de wiki: ${gone.join(', ')}. Zonder deze pagina's valt er niets te lezen.`)
  }
  return { page, navbox }
}

const PROGRESSION_COLUMNS = {
  order: /^order$/i,
  vault: /^vaults?$/i,
  power: /^power( level)?$/i,
  area: /^(area|location|region)$/i,
}

const RECIPE_COLUMNS = { vault: /^vaults?$/i, recipe: /^recipes?$/i }
const RECIPE_OPTIONAL = { note: /misc|notes?|info/i }

/** Placeholder text for a vault that has no name (and no page) yet. */
const PLACEHOLDER = /^(tba|tbd|unknown|\?+)?$/i

interface ProgressionRow {
  order: number
  power: number
  area: string
  /** Undefined for a ''TBA'' row. */
  name?: string
  /** Page title when the vault cell is a link. */
  page?: string
}

interface NavEntry {
  name: string
  linked: boolean
}

interface NavGroup {
  title: string
  entries: NavEntry[]
}

/** `map` is used to link each vault to its point in the 'Vaults' map category. */
export function parseVaults(src: VaultSources, map: MapData, warn: Warn): Vault[] {
  const pageTitle = src.page.title
  const tables = parseTables(src.page.content)

  const progression = tables.map((rows) => readColumns(rows, PROGRESSION_COLUMNS)).find((t) => t !== undefined)
  if (!progression) {
    // Without this table there is no vault list at all; stop rather than write an empty file.
    throw new Error(`Vaults: tabel 'Standard Progression Order' (Order, Vault, Power level, Area) niet gevonden op ${pageTitle}`)
  }

  const rows = readProgression(progression, (m) => warn(m, pageTitle))
  const groups = vaultGroups(src.navbox, rows, warn)
  const tableKeys = new Set(rows.filter((r) => r.name).map((r) => nameKey(r.name!)))
  const used = new Set<string>()
  const vaults: Vault[] = []
  const noRegion: string[] = []

  for (const row of rows) {
    if (row.name) {
      const key = nameKey(row.name)
      if (used.has(key)) {
        warn(`Vault ${row.name} staat twee keer in de volgordetabel, tweede rij overgeslagen`, pageTitle)
        continue
      }
      used.add(key)
      const region = groups.find((g) => g.entries.some((e) => sameName(e.name, row.name)))?.title
      if (!region) noRegion.push(row.name)
      vaults.push(makeVault(row.name, row, region, row.page))
      continue
    }

    // ''TBA'' row: the navbox group of this area names the vaults that have no page yet.
    const areaName = row.area.replace(/\s*\([^()]*\)\s*$/, '')
    const group = groups.find((g) => sameName(g.title, row.area) || sameName(g.title, areaName))
    const entry = group?.entries.find((e) => !tableKeys.has(nameKey(e.name)) && !used.has(nameKey(e.name)))
    if (!group || !entry) {
      warn(`Vault zonder naam (TBA, volgorde ${row.order}, ${row.area || 'onbekend gebied'}) niet gevonden in de navbox, overgeslagen`, VAULT_NAVBOX)
      continue
    }
    used.add(nameKey(entry.name))
    vaults.push(makeVault(entry.name, row, group.title, entry.linked ? entry.name : undefined))
  }

  if (noRegion.length) warn(`Geen regio in de navbox voor: ${noRegion.join(', ')}`, VAULT_NAVBOX)
  const leftover = groups.flatMap((g) => g.entries).filter((e) => !used.has(nameKey(e.name)))
  if (leftover.length) {
    warn(`In de navbox maar niet in de volgordetabel, overgeslagen: ${leftover.map((e) => e.name).join(', ')}`, VAULT_NAVBOX)
  }

  addRecipes(tables, vaults, pageTitle, warn)
  addPoints(vaults, map, warn)

  return vaults
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'en'))
    .map((v) =>
      // Fixed key order keeps vaults.json diffs readable.
      compact<Vault>({
        id: v.id,
        name: v.name,
        order: v.order,
        power: v.power,
        area: v.area,
        region: v.region,
        recipes: v.recipes,
        note: v.note,
        pointId: v.pointId,
        wikiUrl: v.wikiUrl,
      }),
    )
}

function makeVault(name: string, row: ProgressionRow, region: string | undefined, page: string | undefined): Vault {
  return compact<Vault>({
    id: name,
    name,
    order: row.order,
    power: row.power,
    area: row.area,
    region,
    recipes: [],
    wikiUrl: page ? wikiUrl(page) : undefined,
  })
}

function readProgression(table: Record<keyof typeof PROGRESSION_COLUMNS, string>[], warn: (m: string) => void): ProgressionRow[] {
  const out: ProgressionRow[] = []
  for (const cells of table) {
    const label = stripMarkup(cells.vault) || `rij ${out.length + 1}`
    const order = Number.parseInt(stripMarkup(cells.order), 10)
    const power = Number.parseInt(stripMarkup(cells.power), 10)
    if (!Number.isFinite(order) || !Number.isFinite(power)) {
      warn(`Vault ${label}: volgorde of power level is geen getal, rij overgeslagen`)
      continue
    }
    const area = stripMarkup(cells.area)
    if (!area) warn(`Vault ${label}: geen gebied in de volgordetabel`)

    const link = links(cells.vault)[0]
    const plain = stripMarkup(cells.vault)
    if (link) out.push({ order, power, area, name: link.target, page: link.target })
    else if (PLACEHOLDER.test(plain)) out.push({ order, power, area })
    else out.push({ order, power, area, name: plain })
  }
  return out
}

/**
 * Leaf groups of the navbox (gtitle -> list of entries) that hold vaults: a group
 * counts when one of its entries is a vault from the table or its title is the area
 * of a table row (the ''TBA'' rows). Monster, trap and resource groups drop out.
 */
function vaultGroups(navbox: RawPage, rows: ProgressionRow[], warn: Warn): NavGroup[] {
  const navboxes = findTemplates(navbox.content, 'Navbox', { nested: true })
  if (!navboxes.length) {
    warn('Navbox niet herkend (geen {{Navbox}}), vaults krijgen geen regio', navbox.title)
    return []
  }

  const all: NavGroup[] = []
  for (const template of navboxes) {
    for (const [key, value] of Object.entries(template.params)) {
      const m = /^group(\d+)$/.exec(key)
      if (!m || findTemplates(value, 'Navbox').length) continue
      const title = stripMarkup(template.params[`gtitle${m[1]}`] ?? '')
      const entries: NavEntry[] = []
      for (const item of listItems(value)) {
        const link = links(item.text)[0]
        const name = link ? link.target : stripMarkup(item.text)
        if (name) entries.push({ name, linked: !!link })
      }
      if (title && entries.length) all.push({ title, entries })
    }
  }

  const names = rows.filter((r) => r.name).map((r) => r.name!)
  const areas = rows.filter((r) => !r.name).flatMap((r) => [r.area, r.area.replace(/\s*\([^()]*\)\s*$/, '')])
  return all.filter(
    (g) => g.entries.some((e) => names.some((n) => sameName(n, e.name))) || areas.some((a) => sameName(a, g.title)),
  )
}

function addRecipes(tables: ReturnType<typeof parseTables>, vaults: Vault[], pageTitle: string, warn: Warn): void {
  const table = tables.map((rows) => readColumns(rows, RECIPE_COLUMNS, RECIPE_OPTIONAL)).find((t) => t !== undefined)
  if (!table) {
    warn(`Tabel 'Recipes' (Vault, Recipe) niet gevonden, vaults zonder recepten`, pageTitle)
    return
  }

  const done = new Set<string>()
  const unknown: string[] = []
  for (const cells of table) {
    const ref = links(cells.vault)[0]?.target ?? stripMarkup(cells.vault)
    const vault = vaults.find((v) => sameName(v.id, ref))
    if (!vault) {
      if (ref) unknown.push(ref)
      continue
    }
    if (done.has(vault.id)) {
      warn(`Vault ${vault.name} staat twee keer in de receptentabel, tweede rij overgeslagen`, pageTitle)
      continue
    }
    done.add(vault.id)

    const recipes = parseRecipeList(cells.recipe)
    if (!recipes) warn(`Recepten van ${vault.name} niet herkend (geen lijst of links), overgeslagen`, pageTitle)
    else vault.recipes = recipes
    const note = stripMarkup(cells.note)
    if (note) vault.note = note
  }
  if (unknown.length) warn(`Recepten voor onbekende vaults overgeslagen: ${unknown.join(', ')}`, pageTitle)
}

/**
 * One recipe cell: list items, where `* '''Paladin armour set:'''` starts a set and its
 * deeper items belong to it. Undefined when the cell has text but nothing recognisable.
 */
export function parseRecipeList(cell: string): VaultRecipe[] | undefined {
  const items = listItems(cell)
  if (!items.length) {
    const found = links(cell)
    if (found.length) return found.map((l) => ({ name: upperFirst(l.label) }))
    return stripMarkup(cell) ? undefined : []
  }

  const out: VaultRecipe[] = []
  let set: { label: string; depth: number } | undefined
  for (const item of items) {
    if (set && item.depth <= set.depth) set = undefined
    const plain = stripMarkup(item.text)
    const link = links(item.text)[0]
    if (!link && /:\s*$/.test(plain)) {
      set = { label: plain.replace(/\s*:\s*$/, ''), depth: item.depth }
      continue
    }
    const name = upperFirst(link ? link.label : plain)
    if (!name) continue
    out.push(compact<VaultRecipe>({ name, set: set?.label, note: recipeNote(plain, name) }))
  }
  return out
}

/** Text around the recipe link, e.g. '[[Granite maul]] (after the quest)' gives 'after the quest'. */
function recipeNote(plain: string, name: string): string | undefined {
  if (nameKey(plain) === nameKey(name)) return undefined
  const rest = plain.toLowerCase().startsWith(name.toLowerCase()) ? plain.slice(name.length) : plain
  const note = rest
    .trim()
    .replace(/^[-,:;]\s*/, '')
    .replace(/^\((.*)\)$/, '$1')
    .trim()
  return note || undefined
}

/**
 * Links each vault to its entrance in the 'Vaults' map category: by name or link first, then by
 * the distinctive part of the vault name in a still unused point's name or description
 * ('Manafem Kara' and 'Vault (Kalphite)', described as 'south of Manafem Plains'). Only a single
 * candidate counts. Every vault left without a point gets a warning.
 */
function addPoints(vaults: Vault[], map: MapData, warn: Warn): void {
  const categories = new Set(map.categories.filter((c) => c.id === VAULT_MAP_CATEGORY || c.group === 'vault').map((c) => c.id))
  const points = map.points.filter((p) => p.categoryId === VAULT_MAP_CATEGORY || categories.has(p.categoryId))
  if (!points.length) {
    if (vaults.length) {
      warn(`Geen vault-ingangen op de kaart (categorie '${VAULT_MAP_CATEGORY}'), vaults zonder kaartpunt`, VAULT_MAP_PAGE)
    }
    return
  }

  const used = new Set<string>()
  const matches = (p: MapPoint, name: string) => sameName(p.name, name) || sameName(p.link, name)
  for (const vault of vaults) {
    const point = points.find((p) => !used.has(p.id) && matches(p, vault.name))
    if (point) {
      vault.pointId = point.id
      used.add(point.id)
    }
  }

  for (const vault of vaults) {
    if (vault.pointId) continue
    const word = distinctiveWord(vault.name)
    const re = word ? new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i') : undefined
    const candidates = re ? points.filter((p) => !used.has(p.id) && re.test(`${p.name ?? ''} ${p.description ?? ''}`)) : []
    if (candidates.length === 1) {
      vault.pointId = candidates[0].id
      used.add(candidates[0].id)
    } else if (candidates.length > 1) {
      warn(`Meerdere kaartpunten mogelijk voor vault ${vault.name}, geen gekozen`, vault.name)
    } else {
      warn(`Geen kaartpunt gevonden voor vault ${vault.name}`, vault.name)
    }
  }
}

/** 'Manafem Kara' gives 'Manafem': the vault name without the generic 'Kara'. Undefined when nothing is left. */
function distinctiveWord(name: string): string | undefined {
  const word = name.replace(/\s+kara$/i, '').trim()
  return word && !/^kara$/i.test(word) ? word : undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
