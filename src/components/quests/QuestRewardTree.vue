<script setup lang="ts">
import { cn } from '@/lib/utils'
import type { RewardNode } from '@/lib/quests-detail'

defineOptions({ name: 'QuestRewardTree' })

/** Reward lines as nested lists: a reward pack with what is inside it, indented. */
withDefaults(defineProps<{ nodes: RewardNode[]; depth?: number }>(), { depth: 0 })
</script>

<template>
  <ul
    role="list"
    :class="cn('flex flex-col', depth === 0 ? 'gap-1.5' : 'mt-1 ml-[3px] gap-1 border-l border-gold-ink/20 pl-3.5')"
  >
    <li v-for="(node, i) in nodes" :key="i" class="relative pl-4 leading-relaxed">
      <span
        aria-hidden="true"
        :class="
          cn(
            'absolute left-0',
            depth === 0 ? 'top-[0.6em] size-[7px] rotate-45 bg-gold-ink/75' : 'top-[0.8em] h-px w-2 bg-gold-ink/45',
          )
        "
      />
      <span lang="en" :class="cn(depth > 0 && 'text-text-parchment/85')">{{ node.text }}</span>
      <QuestRewardTree v-if="node.children.length" :nodes="node.children" :depth="depth + 1" />
    </li>
  </ul>
</template>
