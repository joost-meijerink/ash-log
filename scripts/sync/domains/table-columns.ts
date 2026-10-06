// Small helpers shared by the vaults and rewards parsers: read wiki tables by
// their header names instead of by position, and compare names loosely.

import { expandGrid, stripMarkup, type TableCell } from '../wikitext'

/**
 * Data rows of a table as records keyed by column, or undefined when the table has
 * no header row with every required column. Header texts are compared as plain text,
 * so `! Power level` matches /^power level$/i. Optional columns that are missing
 * give ''. Header rows (every cell a `!` cell) are left out of the result.
 */
export function readColumns<R extends string, O extends string = never>(
  rows: TableCell[][],
  required: Record<R, RegExp>,
  optional?: Record<O, RegExp>,
): Record<R | O, string>[] | undefined {
  const grid = expandGrid(rows)
  const isHeader = (i: number) => rows[i].length > 0 && rows[i].every((c) => c.header)

  for (let h = 0; h < rows.length; h++) {
    if (!isHeader(h)) continue
    const headers = grid[h].map((text) => stripMarkup(text))
    const find = (re: RegExp) => headers.findIndex((text) => re.test(text))

    const index: Partial<Record<R | O, number>> = {}
    let complete = true
    for (const [key, re] of Object.entries(required) as [R, RegExp][]) {
      const i = find(re)
      if (i < 0) complete = false
      index[key] = i
    }
    if (!complete) continue
    for (const [key, re] of Object.entries(optional ?? {}) as [O, RegExp][]) index[key] = find(re)

    const out: Record<R | O, string>[] = []
    for (let r = h + 1; r < rows.length; r++) {
      if (isHeader(r)) continue
      const record = {} as Record<R | O, string>
      for (const [key, i] of Object.entries(index) as [R | O, number][]) record[key] = i >= 0 ? (grid[r][i] ?? '') : ''
      out.push(record)
    }
    return out
  }
  return undefined
}

/** Name key for loose comparisons: case, underscores and extra whitespace do not matter. */
export function nameKey(name: string): string {
  return name.replace(/[_\s]+/g, ' ').trim().toLowerCase()
}

export function sameName(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && nameKey(a) === nameKey(b)
}

export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Copy of `obj` without undefined values, so the JSON on disk stays tidy and stable. */
export function compact<T extends object>(obj: T): T {
  const out = {} as T
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}
