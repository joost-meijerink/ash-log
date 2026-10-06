<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Pencil } from 'lucide-vue-next'
import CheckRow from '@/components/common/CheckRow.vue'
import IconButton from '@/components/common/IconButton.vue'
import SectionHeading from '@/components/common/SectionHeading.vue'
import { Badge } from '@/components/ui/badge'
import type { AppQuest } from '@/lib/types'
import { useConnectionStore } from '@/stores/connection'
import { useProgressStore } from '@/stores/progress'
import QuestItemsEditor from './QuestItemsEditor.vue'

/** What to bring ('Items needed') as a checklist, with an edit mode that writes overrides. */
const props = defineProps<{ quest: AppQuest }>()

const progress = useProgressStore()
const connection = useConnectionStore()
const items = computed(() => props.quest.items)
const checked = computed(() => new Set(progress.state.quests[props.quest.id]?.items ?? []))
const checkedCount = computed(() => items.value.filter((i) => checked.value.has(i.id)).length)
/** Wiki items are English; your own list can be in any language, so it keeps the page language. */
const textLang = computed(() => (props.quest.itemsOverridden ? undefined : 'en'))

const editing = ref(false)
const root = ref<HTMLElement | null>(null)

function startEdit() {
  editing.value = true
}

function stopEdit() {
  editing.value = false
  // Back to the pencil, so keyboard users keep their place.
  void nextTick(() => root.value?.querySelector<HTMLElement>('[data-edit-items]')?.focus())
}
</script>

<template>
  <section ref="root" aria-labelledby="quest-items-heading" class="@container">
    <SectionHeading
      id="quest-items-heading"
      title="Items needed"
      :count="!editing && items.length ? `${checkedCount} / ${items.length}` : null"
    >
      <template #right>
        <Badge v-if="quest.itemsOverridden" variant="outline">Edited</Badge>
        <IconButton
          v-if="!editing"
          data-edit-items
          :label="connection.readOnly ? 'You can edit the list again once your computer is back' : 'Edit list'"
          :disabled="connection.readOnly"
          size="icon-sm"
          @click="startEdit"
        >
          <Pencil aria-hidden="true" />
        </IconButton>
      </template>
    </SectionHeading>

    <QuestItemsEditor v-if="editing" :quest="quest" class="mt-3" @close="stopEdit" />

    <template v-else>
      <ul v-if="items.length" class="mt-2 flex flex-col gap-0.5" role="list">
        <li v-for="item in items" :key="item.id">
          <CheckRow
            :checked="checked.has(item.id)"
            :disabled="!progress.canEdit"
            @update:checked="progress.toggleItem(quest.id, item.id, $event)"
          >
            <span :lang="textLang">{{ item.name }}</span>
            <template v-if="item.qty" #meta>{{ item.qty }}x</template>
            <template v-if="item.note" #note><span :lang="textLang">{{ item.note }}</span></template>
          </CheckRow>
        </li>
      </ul>
      <p v-else class="mt-2 text-text-parchment/70">
        {{ quest.itemsOverridden ? 'You emptied the list: nothing to bring.' : 'No items known.' }}
      </p>
      <p class="mt-2 text-sm leading-snug text-text-parchment/60">
        {{
          quest.itemsOverridden
            ? 'This is your own list. A resync leaves it alone.'
            : 'Best guess from the wiki. Something off? Edit the list.'
        }}
      </p>
    </template>
  </section>
</template>
