// Stable ids. Progress points at these, so they must survive a resync.
// Pure functions only: this file runs in Node (sync, middleware) and in the browser.

import type { RewardKind } from './types'

/** Lowercase ASCII slug: 'Treasure Chest (Brynmoor)' -> 'treasure-chest-brynmoor'. */
export function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Collapses whitespace so cosmetic edits on the wiki do not change a hash. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** FNV-1a 32-bit, as 8 hex chars. Deterministic in every JS runtime. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function mapCategoryId(baseName: string): string {
  return slug(baseName)
}

/** `<category>:<x rounded>:<y rounded>`. Never the array index. */
export function mapPointId(categoryId: string, x: number, y: number): string {
  return `${categoryId}:${Math.round(x)}:${Math.round(y)}`
}

/** `<page title>:s:<hash of the step text>`. An edited step loses its checkmark, on purpose. */
export function questStepId(questId: string, text: string): string {
  return `${questId}:s:${hash(normalizeText(text))}`
}

export function questItemId(questId: string, name: string): string {
  return `${questId}:i:${slug(name)}`
}

export function rewardId(kind: RewardKind, name: string): string {
  return `${kind}:${slug(name)}`
}

export function wikiUrl(title: string): string {
  return `https://dragonwilds.runescape.wiki/w/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`
}

/**
 * Local file name for a wiki image ('Gold Ore.png' or 'File:Gold_Ore.png' -> 'Gold_Ore.png').
 * Icons live in /public/wiki-img/icons/<this name>.
 */
export function iconFileName(wikiFile: string): string {
  const name = wikiFile.replace(/^(File|Image):/i, '').trim().replace(/ /g, '_')
  return name.charAt(0).toUpperCase() + name.slice(1)
}
