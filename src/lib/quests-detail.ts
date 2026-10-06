// Detail logic for one quest: kind label, step sections, reward line nesting and the quests
// that depend on it. Pure functions only.

import { compareQuests } from './quests-list'
import type { Quest, QuestNeed, QuestStep, RewardKind } from './types'

/** 'Main story · 3', 'Main story' (no order on the wiki), 'Side quest' or 'Tertiary'. */
export function questKindLabel(quest: Pick<Quest, 'kind' | 'order'>): string {
  if (quest.kind === 'primary') return quest.order ? `Main story · ${quest.order}` : 'Main story'
  if (quest.kind === 'secondary') return 'Side quest'
  return 'Tertiary'
}

export function stepsSourceLabel(source: Quest['stepsSource']): string {
  return source === 'quick-guide' ? 'From the Quick guide' : 'From the walkthrough on the wiki'
}

export interface StepGroup {
  key: string
  /** Walkthrough sub-heading. Undefined for steps before the first heading. */
  section?: string
  /** 1 for a top heading, 2 for a heading nested under a 'Part ...' heading. */
  level: 1 | 2
  steps: QuestStep[]
}

const PART_HEADING = /^part\s+([ivxlcdm]+|\d+)\b/i

/**
 * Groups consecutive steps under their section heading, keeping the walkthrough order.
 * When the walkthrough uses 'Part I: ...' headings, headings that follow a Part are treated
 * as its sub-headings (level 2), like 'The Cathedral' under 'Part III: Shard Hunting'.
 */
export function groupSteps(steps: QuestStep[]): StepGroup[] {
  const groups: StepGroup[] = []
  let insidePart = false
  for (const step of steps) {
    const section = step.section?.trim() || undefined
    const last = groups[groups.length - 1]
    if (last && last.section === section) {
      last.steps.push(step)
      continue
    }
    let level: 1 | 2 = 1
    if (section && PART_HEADING.test(section)) insidePart = true
    else if (section && insidePart) level = 2
    groups.push({ key: `${groups.length}:${section ?? ''}`, section, level, steps: [step] })
  }
  return groups
}

export interface PlacedNeeds {
  /** Needs without a section, or whose section has no steps: shown above the steps. */
  before: QuestNeed[]
  /** Needs per StepGroup.key: shown under that group's heading (the first group with the section). */
  byGroup: Map<string, QuestNeed[]>
}

/**
 * Places the {{Needed}} blocks of a walkthrough next to the steps: under the first group
 * with the same section heading, or above all steps when no group matches. Blocks without
 * any text are dropped.
 */
export function placeNeeds(groups: readonly StepGroup[], needs: readonly QuestNeed[] | undefined): PlacedNeeds {
  const out: PlacedNeeds = { before: [], byGroup: new Map() }
  const keyBySection = new Map<string, string>()
  for (const g of groups) if (g.section && !keyBySection.has(g.section)) keyBySection.set(g.section, g.key)
  for (const need of needs ?? []) {
    const needed = need.needed?.trim()
    const recommended = need.recommended?.trim()
    if (!needed && !recommended) continue
    const clean: QuestNeed = {
      ...(need.section?.trim() ? { section: need.section.trim() } : {}),
      ...(needed ? { needed } : {}),
      ...(recommended ? { recommended } : {}),
    }
    const key = clean.section ? keyBySection.get(clean.section) : undefined
    if (key === undefined) out.before.push(clean)
    else out.byGroup.set(key, [...(out.byGroup.get(key) ?? []), clean])
  }
  return out
}

export interface RewardLine {
  text: string
  /** Nesting level: every two leading spaces is one level deeper. */
  depth: number
}

/**
 * Reads the indentation of reward lines ('  Tome of the Titan' is one level under the line
 * before it). Blank lines are dropped. A line never nests more than one level deeper than the
 * line above it, so a stray indent cannot leave a gap.
 */
export function parseRewardLines(lines: string[]): RewardLine[] {
  const out: RewardLine[] = []
  for (const raw of lines) {
    const text = raw.trim()
    if (!text) continue
    const spaces = /^ */.exec(raw)?.[0].length ?? 0
    const wanted = Math.floor(spaces / 2)
    const max = out.length ? out[out.length - 1]!.depth + 1 : 0
    out.push({ text, depth: Math.min(wanted, max) })
  }
  return out
}

export interface RewardNode {
  text: string
  children: RewardNode[]
}

/** Reward lines as a tree, for nested lists. */
export function rewardTree(lines: string[]): RewardNode[] {
  const root: RewardNode[] = []
  const stack: RewardNode[][] = [root]
  for (const line of parseRewardLines(lines)) {
    const node: RewardNode = { text: line.text, children: [] }
    stack.length = line.depth + 1
    stack[line.depth]!.push(node)
    stack[line.depth + 1] = node.children
  }
  return root
}

/** Quests that list `questId` in their requirements, in list order. */
export function dependentsOf<Q extends Quest>(questId: string, quests: Q[]): Q[] {
  return quests.filter((q) => q.id !== questId && q.requires.includes(questId)).sort(compareQuests)
}

/** Short label per reward kind, for the unlocks on a quest. */
export const REWARD_KIND_LABEL: Record<RewardKind, string> = {
  plan: 'Plan',
  pattern: 'Pattern',
  vestige: 'Vestige',
  quest: 'Quest reward',
  effigy: 'Effigy',
  'recipe-book': 'Recipe book',
  'fishing-trophy': 'Fishing trophy',
}
