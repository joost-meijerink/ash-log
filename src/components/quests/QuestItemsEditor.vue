<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { LoaderCircle, Plus, Trash2, Undo2 } from 'lucide-vue-next'
import IconButton from '@/components/common/IconButton.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  draftsFromItems,
  emptyDraft,
  overridesWithItems,
  overridesWithoutItems,
  validateDrafts,
  type ItemDraft,
} from '@/lib/quests-items'
import type { AppQuest } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import QuestConfirmDialog from './QuestConfirmDialog.vue'

/**
 * Edit mode for a quest's item list. Saving writes overrides.questItems[questId], which
 * replaces the wiki list until you go back to it. Ids come from the item name, so an item
 * that keeps its name keeps its checkmark. Checkmarks of items that are no longer in the
 * list are dropped after a save or revert, so your own edit never leaves orphans behind.
 */
const props = defineProps<{ quest: AppQuest }>()
const emit = defineEmits<{ close: [] }>()

const data = useDataStore()
const progress = useProgressStore()

const drafts = ref<ItemDraft[]>(props.quest.items.length ? draftsFromItems(props.quest.items) : [emptyDraft()])
const attempted = ref(false)
const saving = ref(false)
const saveError = ref<string | null>(null)
const confirmRevert = ref(false)
const form = ref<HTMLFormElement | null>(null)

const validation = computed(() => validateDrafts(props.quest.id, drafts.value))
const errorsFor = (key: string) => (attempted.value ? validation.value.errors[key] : undefined)

function focusField(key: string, field: 'name' | 'qty') {
  form.value?.querySelector<HTMLInputElement>(`[data-draft="${key}"][data-field="${field}"]`)?.focus()
}

onMounted(() => {
  const first = drafts.value[0]
  if (first) focusField(first.key, 'name')
})

function addRow() {
  const draft = emptyDraft()
  drafts.value.push(draft)
  void nextTick(() => focusField(draft.key, 'name'))
}

function removeRow(index: number) {
  drafts.value.splice(index, 1)
  const next = drafts.value[Math.min(index, drafts.value.length - 1)]
  void nextTick(() => (next ? focusField(next.key, 'name') : form.value?.querySelector<HTMLElement>('[data-add-row]')?.focus()))
}

/** Writes the overrides. True when the write succeeded (the reload after it may still fail). */
async function write(next: Parameters<typeof data.saveOverrides>[0]): Promise<boolean> {
  saving.value = true
  saveError.value = null
  try {
    await data.saveOverrides(next)
    return true
  } catch (err) {
    saveError.value = `Couldn't save: ${(err as Error).message}`
    return false
  } finally {
    saving.value = false
  }
}

/** Drops checked items of this quest that are not in `ids`. Only with progress loaded, so nothing is lost. */
function keepChecked(ids: Iterable<string>) {
  if (progress.loaded) progress.keepItems(props.quest.id, new Set(ids))
}

async function save() {
  attempted.value = true
  const result = validation.value
  if (!result.valid) {
    const bad = drafts.value.find((d) => result.errors[d.key])
    const errs = bad && result.errors[bad.key]
    if (bad && errs) focusField(bad.key, errs.name ? 'name' : 'qty')
    return
  }
  if (!(await write((ov) => overridesWithItems(ov, props.quest.id, result.items)))) return
  // The saved list itself, not the reloaded data: that reload can fail without an error.
  keepChecked(result.items.map((i) => i.id))
  emit('close')
}

async function revert() {
  if (!(await write((ov) => overridesWithoutItems(ov, props.quest.id)))) return
  // The wiki list only comes back with the reload; without it, leave the checkmarks alone.
  const wiki = data.error || data.data?.overridesError ? undefined : data.questById.get(props.quest.id)
  if (wiki && !wiki.itemsOverridden) keepChecked(wiki.items.map((i) => i.id))
  emit('close')
}

const errorCount = computed(() => (attempted.value ? Object.keys(validation.value.errors).length : 0))
</script>

<template>
  <form ref="form" novalidate aria-label="Edit items needed" @submit.prevent="save">
    <p class="text-sm leading-snug text-text-parchment/70">
      The wiki list is a best guess. Fix it here: your list replaces the wiki's, even after a resync.
    </p>

    <div
      class="mt-3 hidden gap-2 px-0.5 font-display text-[0.68rem] font-semibold tracking-[0.12em] text-text-parchment/60 uppercase @lg:grid @lg:grid-cols-[minmax(0,1.15fr)_4.75rem_minmax(0,1fr)_2.75rem]"
      aria-hidden="true"
    >
      <span>Name</span>
      <span>Qty</span>
      <span>Note</span>
    </div>

    <ul class="mt-2 flex flex-col gap-3 @lg:gap-2" role="list">
      <li
        v-for="(draft, i) in drafts"
        :key="draft.key"
        class="grid grid-cols-[4.75rem_minmax(0,1fr)_2.75rem] gap-2 rounded-md border border-gold-ink/15 bg-parchment-deep/40 p-2 @lg:grid-cols-[minmax(0,1.15fr)_4.75rem_minmax(0,1fr)_2.75rem] @lg:border-0 @lg:bg-transparent @lg:p-0.5"
      >
        <div class="col-span-2 row-start-1 @lg:col-span-1 @lg:col-start-1">
          <Input
            v-model="draft.name"
            :data-draft="draft.key"
            data-field="name"
            placeholder="Name"
            :aria-label="`Name, item ${i + 1}`"
            :aria-invalid="errorsFor(draft.key)?.name ? 'true' : undefined"
            :aria-describedby="errorsFor(draft.key)?.name ? `${draft.key}-name-error` : undefined"
            autocomplete="off"
          />
          <p v-if="errorsFor(draft.key)?.name" :id="`${draft.key}-name-error`" class="mt-1 text-sm text-ember">
            {{ errorsFor(draft.key)?.name }}
          </p>
        </div>

        <div class="col-start-1 row-start-2 @lg:col-start-2 @lg:row-start-1">
          <Input
            v-model="draft.qty"
            :data-draft="draft.key"
            data-field="qty"
            inputmode="numeric"
            placeholder="Qty"
            :aria-label="`Quantity, item ${i + 1}`"
            :aria-invalid="errorsFor(draft.key)?.qty ? 'true' : undefined"
            :aria-describedby="errorsFor(draft.key)?.qty ? `${draft.key}-qty-error` : undefined"
            class="tabular-nums"
            autocomplete="off"
          />
          <p v-if="errorsFor(draft.key)?.qty" :id="`${draft.key}-qty-error`" class="mt-1 text-sm leading-tight text-ember">
            {{ errorsFor(draft.key)?.qty }}
          </p>
        </div>

        <div class="col-span-2 col-start-2 row-start-2 @lg:col-span-1 @lg:col-start-3 @lg:row-start-1">
          <Input
            v-model="draft.note"
            placeholder="Note (optional)"
            :aria-label="`Note, item ${i + 1}`"
            autocomplete="off"
          />
        </div>

        <div class="col-start-3 row-start-1 @lg:col-start-4">
          <IconButton :label="`Remove ${draft.name.trim() || `item ${i + 1}`}`" type="button" @click="removeRow(i)">
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      </li>
    </ul>

    <Button data-add-row type="button" variant="ghost" size="sm" class="mt-2 -ml-1" @click="addRow">
      <Plus aria-hidden="true" />
      Add item
    </Button>

    <p v-if="!drafts.length" class="mt-1 text-sm text-text-parchment/65">Saving it empty means: nothing to bring.</p>

    <p v-if="errorCount" role="alert" class="mt-3 text-sm text-ember">
      {{ errorCount === 1 ? "One row isn't right yet." : `${errorCount} rows aren't right yet.` }}
    </p>
    <p v-if="saveError" role="alert" class="mt-3 text-sm text-ember">{{ saveError }}</p>

    <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-gold-ink/15 pt-4">
      <Button type="submit" :disabled="saving">
        <LoaderCircle v-if="saving" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Save
      </Button>
      <Button type="button" variant="ghost" :disabled="saving" @click="emit('close')">Cancel</Button>
      <Button
        v-if="quest.itemsOverridden"
        type="button"
        variant="link"
        size="sm"
        class="ml-auto"
        :disabled="saving"
        @click="confirmRevert = true"
      >
        <Undo2 aria-hidden="true" />
        Back to the wiki list
      </Button>
    </div>

    <QuestConfirmDialog
      v-model:open="confirmRevert"
      title="Back to the wiki list?"
      description="Your own list for this quest goes away and the wiki's list comes back. Ticks on items with the same name stay, the rest go."
      confirm-label="Use wiki list"
      @confirm="revert"
    />
  </form>
</template>
