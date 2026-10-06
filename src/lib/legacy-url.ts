// Addresses from before Ash Log was in English: Dutch paths, query keys and query values. A
// bookmark, a home-screen icon or a link in an old note still opens the right place. The router
// rewrites them (src/router.ts) and keeps everything else: the rest of the query and the hash.
//
//   /kaart                        -> /map
//   /verzamelingen                -> /collections
//   /collections?soort=<kind>     -> ?kind=<kind>
//   /collections?verberg=1        -> ?hide=1 (verberg=ja too)
//   /quests?status=bezig          -> ?status=active
//   /quests?status=voltooid       -> ?status=done
//
// The server pages moved too (/koppel -> /pair, /certificaat -> /certificate); the app server
// redirects those itself, see LEGACY_SERVER_PATHS in server/app.ts.
// Pure, no vue-router: the query type below is vue-router's LocationQuery.

type QueryValue = string | null | (string | null)[]
export type LegacyQuery = Record<string, QueryValue | undefined>

/** Old view paths and where they live now. */
export const LEGACY_VIEW_PATHS: Readonly<Record<string, string>> = {
  '/kaart': '/map',
  '/verzamelingen': '/collections',
}

const COLLECTION_KEYS: Readonly<Record<string, string>> = { soort: 'kind', verberg: 'hide' }
const QUEST_STATUS: Readonly<Record<string, string>> = { bezig: 'active', voltooid: 'done' }

function mapValue(value: QueryValue | undefined, change: (v: string) => string): QueryValue | undefined {
  if (Array.isArray(value)) return value.map((v) => (v === null ? v : change(v)))
  return typeof value === 'string' ? change(value) : value
}

function collectionsQuery(query: LegacyQuery): LegacyQuery | null {
  if (!Object.keys(query).some((k) => k in COLLECTION_KEYS)) return null
  const out: LegacyQuery = {}
  for (const [key, value] of Object.entries(query)) {
    const modern = COLLECTION_KEYS[key]
    if (!modern) out[key] = value
    // A link that names both: the English key wins.
    else if (!(modern in query)) out[modern] = modern === 'hide' ? mapValue(value, (v) => (v === 'ja' ? '1' : v)) : value
  }
  return out
}

function questsQuery(query: LegacyQuery): LegacyQuery | null {
  const old = (v: string) => QUEST_STATUS[v.toLowerCase()]
  const status = query.status
  const named = Array.isArray(status) ? status.some((v) => v !== null && old(v)) : typeof status === 'string' && !!old(status)
  if (!named) return null
  return { ...query, status: mapValue(status, (v) => old(v) ?? v) }
}

/**
 * The query of a view with its Dutch keys and values in English, or null when there is nothing
 * to rewrite. `view` is the route name (see src/router.ts).
 */
export function modernQuery(view: unknown, query: LegacyQuery): LegacyQuery | null {
  if (view === 'collections') return collectionsQuery(query)
  if (view === 'quests') return questsQuery(query)
  return null
}

/** Where a navigation should go instead, or undefined when its address is already current. */
export function legacyRedirect<T extends { name?: unknown; path: string; query: LegacyQuery; hash: string }>(
  to: T,
): { path: string; query: LegacyQuery; hash: string } | undefined {
  const query = modernQuery(to.name, to.query)
  return query ? { path: to.path, query, hash: to.hash } : undefined
}
