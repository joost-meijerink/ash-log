// Shared data model for the sync script (Node), the dev middleware and the Vue app.
// Three layers, three files: wiki data (/data/wiki), overrides (/data/overrides.json)
// and progress (/data/progress.json). Keep this file free of runtime imports.

/* ------------------------------------------------------------------ */
/* Wiki layer: /data/wiki/*.json, written only by the sync script      */
/* ------------------------------------------------------------------ */

/**
 * How a map category behaves in the UI.
 * - resource: gatherable nodes and plants (respawn)
 * - chest: loot containers (respawn, carry a power level)
 * - unique: one-time unlocks placed on the map (recipe books, vestige spots, patterns)
 * - lore: lore scraps, journals, tomes (one-time reads)
 * - quest: quest start or quest objective pins
 * - vault: Dragonkin vault entrances
 * - npc: friendly characters, merchants
 * - monster: enemies and bosses
 * - location: named places, landmarks, activities
 * - other: anything the classifier could not place (reported as a warning)
 */
export type MapGroup =
  | 'resource'
  | 'chest'
  | 'unique'
  | 'lore'
  | 'quest'
  | 'vault'
  | 'npc'
  | 'monster'
  | 'location'
  | 'other'

export interface MapCategory {
  /** Slug of the base name, e.g. 'gold-ore-node', 'treasure-chest'. Used in URLs (?c=). */
  id: string
  /** English label (wiki text is never translated). */
  label: string
  group: MapGroup
  /** Local icon file name inside /wiki-img/icons/, if any. */
  icon?: string
  /** Main-namespace wiki page for this category, if it exists. */
  wikiPage?: string
  /** Module:Map/*.json titles merged into this category. */
  sources: string[]
  /** Number of points after dedupe. */
  count: number
}

export interface MapPoint {
  /** `${categoryId}:${Math.round(x)}:${Math.round(y)}`, see ids.ts. */
  id: string
  categoryId: string
  /** Game coordinates as stored on the wiki. Leaflet LatLng is [y, x]. */
  x: number
  y: number
  /** Plain text (wikilinks stripped). */
  name?: string
  /** Wiki page the name linked to, if the name was a wikilink. */
  link?: string
  /** Plain text. Coordinate-only descriptions ("12.3, 45.6") are dropped. */
  description?: string
  /** Local icon file name inside /wiki-img/icons/ (per-point icon wins over category icon). */
  icon?: string
  /** Power level, parsed from 'Tier 3', 'Tier3_World', 'Power Level 3'. */
  power?: number
  /** Region name, e.g. 'Brynmoor'. */
  region?: string
  /** True when the region was inferred from nearby points instead of stated by the wiki. */
  regionGuessed?: boolean
  /**
   * Ids of twin points that the sync merged into this one (the same one-time spot listed
   * in another category of the same group). Progress on an alias counts for this point.
   */
  aliases?: string[]
}

export interface MapData {
  categories: MapCategory[]
  points: MapPoint[]
}

export interface QuestStep {
  /** `${questId}:s:${hash(text)}`, see ids.ts. */
  id: string
  /** Plain text of the step. */
  text: string
  /** Sub-heading the step sits under in the walkthrough ('Part I: To Slay Dragons!'), if any. */
  section?: string
}

export interface QuestItem {
  /** `${questId}:i:${slug(name)}`, see ids.ts. */
  id: string
  name: string
  qty?: number
  note?: string
}

export type QuestKind = 'primary' | 'secondary' | 'tertiary'

export interface Quest {
  /** Wiki page title, e.g. 'Ratcatcher'. */
  id: string
  name: string
  kind: QuestKind
  /** Position within its kind on the 'Quests' page tables (1-based). */
  order?: number
  /** Region from the 'Quests' page table, e.g. 'Brynmoor'. */
  region?: string
  /** Short description (Quest details |desc). */
  description?: string
  /** Where to start, plain text (Quest details |start, or the Quests page table). */
  location: string
  /** Map point of the quest start, when the sync could match one. */
  startPointId?: string
  /** How startPointId was found: the quest's own Module:Map page, or an NPC name match. */
  startMatch?: 'quest-map' | 'npc-name'
  steps: QuestStep[]
  stepsSource: 'quick-guide' | 'walkthrough'
  /** Candidates from Quest details |item_req. Overridable. */
  items: QuestItem[]
  /** Plain-text reward lines. */
  rewards: string[]
  /** Quest ids required before this one (Quest details |req). */
  requires: string[]
  /** {{Needed}} blocks from the walkthrough, per section. Kept outside the steps so step ids stay stable. */
  needs?: QuestNeed[]
  wikiUrl: string
}

export interface QuestNeed {
  /** Walkthrough sub-heading the block sits under. */
  section?: string
  /** Plain text of what you need. */
  needed?: string
  /** Plain text of |recommended=. */
  recommended?: string
}

export interface VaultRecipe {
  name: string
  /** Armour set label, e.g. 'Paladin armour set'. */
  set?: string
  note?: string
}

export interface Vault {
  /** Vault name, e.g. 'Crasorak Kara'. Stable across resyncs. */
  id: string
  name: string
  /** Standard progression order (1-based). */
  order: number
  power: number
  /** Sub-area, e.g. 'Temple Woods', 'Lake of Lost Souls (east)'. */
  area: string
  /** Top-level region from Template:Dragonkin Vaults, e.g. 'Brynmoor'. */
  region?: string
  recipes: VaultRecipe[]
  /** 'Misc Information' column of the recipes table. */
  note?: string
  /** Matching point in the 'Vaults' map category. */
  pointId?: string
  /** Undefined when the vault has no wiki page yet. */
  wikiUrl?: string
}

/** Sections of the 'Consumable Recipes' wiki page. */
export type RewardKind =
  | 'plan'
  | 'pattern'
  | 'vestige'
  | 'quest'
  | 'effigy'
  | 'recipe-book'
  | 'fishing-trophy'

/** A one-time unlock worth ticking off (a recipe, pattern, vestige, trophy...). */
export interface Reward {
  /** `${kind}:${slug(name)}`, see ids.ts. */
  id: string
  kind: RewardKind
  /** What you unlock, e.g. 'Paladin's Helm'. */
  name: string
  /** The consumable that teaches it, e.g. 'PLAN: Blue Standing Torch' or 'An Educational Blade'. */
  recipe?: string
  /** Sub-heading on the wiki page: 'Lighting', 'Brynmoor', 'Ghornfell'... */
  group?: string
  /** Armour set label when known, e.g. 'Paladin armour set'. */
  set?: string
  /** Plain-text source from the wiki (only the wiki's own words). */
  source?: string
  /** Source hints from wiki templates ({{Drop sources list}}, {{Store locations list}}); the UI labels them. */
  via?: RewardVia[]
  /** Plain-text requirement (quest rewards table). */
  requirement?: string
  questId?: string
  vaultId?: string
  /** Map points (group 'unique') where this reward can be picked up. */
  pointIds?: string[]
}

export type RewardVia = 'drops' | 'shops'

export interface SyncMeta {
  syncedAt: string
  durationMs: number
  /** Domains refreshed by this sync ('map', 'quests', 'vaults', 'rewards'). */
  domains: SyncDomain[]
  counts: {
    categories: number
    points: number
    quests: number
    vaults: number
    rewards: number
  }
  /** Wiki revision id per page title that fed the data. */
  revisions: Record<string, number>
}

export type SyncDomain = 'map' | 'quests' | 'vaults' | 'rewards'

export interface SyncWarning {
  source: SyncDomain | 'assets' | 'sync'
  page?: string
  message: string
}

export interface ListDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

export interface DiffReport {
  syncedAt: string
  ok: boolean
  /** Fatal error message when ok is false. Nothing was written in that case. */
  error?: string
  domains: SyncDomain[]
  map?: {
    categories: ListDiff
    /** Point ids per category id. */
    points: Record<string, ListDiff>
  }
  quests?: {
    quests: ListDiff
    /** Quests whose step list changed: added/removed step ids with their text. */
    steps: { questId: string; added: { id: string; text: string }[]; removed: { id: string; text: string }[] }[]
  }
  vaults?: { vaults: ListDiff }
  rewards?: { rewards: ListDiff }
  /** Progress entries that no longer point at anything (never deleted by sync). */
  orphans: Orphans
  warnings: SyncWarning[]
}

export interface Orphans {
  quests: string[]
  steps: string[]
  items: string[]
  points: string[]
  vaults: string[]
  rewards: string[]
}

/* ------------------------------------------------------------------ */
/* Overrides layer: /data/overrides.json, never touched by sync        */
/* ------------------------------------------------------------------ */

export interface Overrides {
  /** Manual quest start pin, in game coordinates. */
  questStart: Record<string, { x: number; y: number }>
  /** Replaces the parsed item list of a quest entirely. */
  questItems: Record<string, QuestItem[]>
  /** Fixes the automatic group of a map category. */
  categoryGroup: Record<string, MapGroup>
}

/* ------------------------------------------------------------------ */
/* Progress layer: /data/progress.json, never touched by sync          */
/* ------------------------------------------------------------------ */

export interface QuestProgress {
  done?: boolean
  /** Checked step ids. */
  steps: string[]
  /** Checked item ids. */
  items: string[]
}

/** Vault cores respawn in the game, so only 'done' is tracked. */
export interface VaultProgress {
  done?: boolean
}

export interface Progress {
  version: 1
  quests: Record<string, QuestProgress>
  /** Only used for one-time things on the map (lore, unique spots). Chests reset, so they are not tracked. */
  points: Record<string, { foundAt: string }>
  vaults: Record<string, VaultProgress>
  /** Unlocked rewards, keyed by Reward.id. */
  rewards: Record<string, { at: string }>
}

/* ------------------------------------------------------------------ */
/* API shapes served by the dev middleware                              */
/* ------------------------------------------------------------------ */

export interface QuestStart {
  x: number
  y: number
  pointId?: string
  source: 'wiki' | 'override'
}

/** A quest as the app sees it: wiki data with overrides applied. */
export interface AppQuest extends Quest {
  start?: QuestStart
  /** True when items come from overrides.json instead of the wiki. */
  itemsOverridden: boolean
}

/** GET /api/data */
export interface AppData {
  /** False until the first sync has run. */
  ready: boolean
  meta?: SyncMeta
  map: MapData
  quests: AppQuest[]
  vaults: Vault[]
  rewards: Reward[]
  overrides: Overrides
  /** Report of the most recent sync, if any. */
  lastReport?: DiffReport
  /** Set when overrides.json could not be read (e.g. invalid JSON after a hand edit). Overrides are then empty and read-only. */
  overridesError?: string
}

/** GET /api/sync/status */
export interface SyncStatus {
  running: boolean
  startedAt?: string
  /** Recent log lines of the running (or last) sync. */
  log: string[]
  /** Set once a sync has finished. */
  report?: DiffReport
}

/* ------------------------------------------------------------------ */
/* App server: live on Wi-Fi and device pairing                         */
/* ------------------------------------------------------------------ */

/** A phone or tablet that was paired once via the QR code. */
export interface ServerDevice {
  id: string
  /** Readable name from the user agent, e.g. 'iPhone (Safari)'. */
  name: string
  pairedAt: string
  lastSeenAt?: string
}

/** The computer the app server runs on (process.platform 'darwin', 'win32', 'linux', anything else). */
export type ServerPlatform = 'mac' | 'windows' | 'linux' | 'other'

/**
 * The kind of phone a QR code in the live dialog is meant for. It decides the steps on screen
 * and the address in the QR code (see ServerStatus.certificateUrl).
 */
export type PhoneKind = 'iphone' | 'android'

/** GET /api/server */
export interface ServerStatus {
  /** 'dev' under `npm run dev` (no live mode), 'app' under the app server. */
  mode: 'dev' | 'app'
  /** The computer the server runs on, so texts can say 'your Mac' or 'your PC'. Missing from older servers. */
  platform?: ServerPlatform
  /** The request came from this computer itself (loopback). Only then can live mode and pairing be managed. */
  local: boolean
  /** Reachable on the local network right now. Always off when the server starts. */
  live: boolean
  port: number
  /** Addresses on the local network while live: https, the mDNS name first (e.g. https://MacBook-Pro-van-Joost.local:5199). */
  urls: string[]
  /**
   * While live: the plain-http page where a phone installs the Ash Log certificate once, so it
   * trusts the https addresses above. On a Mac it uses the .local name; on Windows and Linux
   * the LAN address, as phones cannot count on resolving their .local name. The QR codes in
   * the live dialog ask for the address per phone (GET /api/server/certificate-qr?phone=).
   */
  certificateUrl?: string
  /** Paired devices; only sent to local requests. */
  devices?: ServerDevice[]
}

/** POST /api/server/pairing: a one-time code to pair a phone, valid for a few minutes. */
export interface PairingCode {
  /** Six digits, also typeable on the phone's pairing page. */
  code: string
  /** URL in the QR code: https://<address for the phone>:<port>/pair?code=<code>. */
  url: string
  /** The QR code as an SVG string. */
  qrSvg: string
  expiresAt: string
}
