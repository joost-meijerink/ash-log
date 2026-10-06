<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronDown, CircleCheck, CircleX, LoaderCircle, Minus, Plus, RefreshCw } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import EmptyState from '@/components/common/EmptyState.vue'
import OrphanCleanupDialog from '@/components/common/OrphanCleanupDialog.vue'
import ParchmentPanel from '@/components/common/ParchmentPanel.vue'
import SectionHeading from '@/components/common/SectionHeading.vue'
import SourceCredit from '@/components/SourceCredit.vue'
import { ORPHAN_KIND_LABEL, useOrphans, type OrphanKind } from '@/composables/useOrphans'
import { formatDateTime, formatDuration } from '@/composables/useRelativeTime'
import { cn } from '@/lib/utils'
import type { ListDiff, SyncDomain, SyncWarning } from '@/lib/types'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'
import { useSyncStore } from '@/stores/sync'

// Same prefix as PARTIAL_WRITE_PREFIX in scripts/sync/files.ts (not importable in the browser bundle).
const PARTIAL_WRITE_PREFIX = 'Deels weggeschreven'

const data = useDataStore()
const sync = useSyncStore()
const connection = useConnectionStore()
const { orphans, count: orphanTotal, label: orphanLabel } = useOrphans()

const DOMAIN_LABEL: Record<SyncDomain, string> = {
  map: 'Kaart',
  quests: 'Quests',
  vaults: 'Vaults',
  rewards: 'Beloningen',
}

const SOURCE_LABEL: Record<SyncWarning['source'], string> = {
  ...DOMAIN_LABEL,
  assets: 'Afbeeldingen',
  sync: 'Sync',
}

const report = computed(() => sync.report ?? data.lastReport ?? null)

const description = computed(() => {
  if (sync.running) return 'De sync loopt. Dat kan een paar minuten duren, je kunt gewoon verder.'
  const r = report.value
  if (!r) return 'Hier zie je na een sync wat er op de wiki veranderd is.'
  const domains = r.domains.map((d) => DOMAIN_LABEL[d]).join(', ')
  return `${formatDateTime(r.syncedAt)}, ${domains}`
})

/** Meta of the same run, for totals and duration. */
const meta = computed(() => {
  const m = data.meta
  return m && report.value && m.syncedAt === report.value.syncedAt ? m : null
})

/* ---------------- Changes per domain ---------------- */

interface Counts {
  added: number
  removed: number
  changed: number
}

interface ChangeRow {
  key: string
  label: string
  counts: Counts
  /** Named changes, English wiki names. */
  lists?: { title: string; items: string[] }[]
  /** Per-category counts (map points). */
  categories?: { id: string; label: string; counts: Counts }[]
}

const COUNT_KEYS = ['added', 'removed', 'changed'] as const

const countsOf = (d: ListDiff): Counts => ({ added: d.added.length, removed: d.removed.length, changed: d.changed.length })
const total = (c: Counts) => c.added + c.removed + c.changed
/** Dutch thousands separator: 16.012. */
const fmt = (n: number) => n.toLocaleString('nl-NL')

function listsOf(d: ListDiff, name: (id: string) => string): ChangeRow['lists'] {
  return [
    { title: 'Nieuw', items: d.added.map(name) },
    { title: 'Weg', items: d.removed.map(name) },
    { title: 'Gewijzigd', items: d.changed.map(name) },
  ].filter((l) => l.items.length > 0)
}

const categoryLabel = (id: string) => data.categoryById.get(id)?.label ?? id
const rewardLabel = (id: string) => data.rewardById.get(id)?.name ?? id
const questLabel = (id: string) => data.questById.get(id)?.name ?? id

const changeRows = computed<ChangeRow[]>(() => {
  const r = report.value
  if (!r || !r.ok) return []
  const rows: ChangeRow[] = []
  if (r.map) {
    rows.push({
      key: 'map-categories',
      label: 'Kaartcategorieën',
      counts: countsOf(r.map.categories),
      lists: listsOf(r.map.categories, categoryLabel),
    })
    const categories = Object.entries(r.map.points)
      .map(([id, d]) => ({ id, label: categoryLabel(id), counts: countsOf(d) }))
      .filter((c) => total(c.counts) > 0)
      .sort((a, b) => total(b.counts) - total(a.counts) || a.label.localeCompare(b.label))
    const sum = categories.reduce<Counts>(
      (acc, c) => ({
        added: acc.added + c.counts.added,
        removed: acc.removed + c.counts.removed,
        changed: acc.changed + c.counts.changed,
      }),
      { added: 0, removed: 0, changed: 0 },
    )
    rows.push({ key: 'map-points', label: 'Kaartpunten', counts: sum, categories })
  }
  if (r.quests) {
    rows.push({ key: 'quests', label: 'Quests', counts: countsOf(r.quests.quests), lists: listsOf(r.quests.quests, questLabel) })
  }
  if (r.vaults) {
    rows.push({ key: 'vaults', label: 'Vaults', counts: countsOf(r.vaults.vaults), lists: listsOf(r.vaults.vaults, (id) => id) })
  }
  if (r.rewards) {
    rows.push({
      key: 'rewards',
      label: 'Beloningen',
      counts: countsOf(r.rewards.rewards),
      lists: listsOf(r.rewards.rewards, rewardLabel),
    })
  }
  return rows
})

const hasDetails = (row: ChangeRow) => (row.lists?.length ?? 0) > 0 || (row.categories?.length ?? 0) > 0

const stepChanges = computed(() => {
  const r = report.value
  if (!r?.ok || !r.quests) return []
  return r.quests.steps
    .filter((s) => s.added.length || s.removed.length)
    .map((s) => ({ ...s, name: questLabel(s.questId) }))
})

/* ---------------- Orphans (live) ---------------- */

const orphanKinds = computed(() =>
  (Object.keys(ORPHAN_KIND_LABEL) as OrphanKind[])
    .map((kind) => ({
      kind,
      label: ORPHAN_KIND_LABEL[kind],
      entries: orphans.value[kind].map((id) => ({ id, text: orphanLabel(kind, id) })),
    }))
    .filter((k) => k.entries.length > 0),
)

const cleaned = ref<number | null>(null)
const confirmOpen = ref(false)
function onCleaned(n: number) {
  cleaned.value = n
}
watch(
  () => sync.panelOpen,
  (open) => {
    if (open) cleaned.value = null
  },
)

/* ---------------- Warnings ---------------- */

const warningGroups = computed(() => {
  const r = report.value
  if (!r) return []
  const groups = new Map<SyncWarning['source'], SyncWarning[]>()
  for (const w of r.warnings) {
    const list = groups.get(w.source)
    if (list) list.push(w)
    else groups.set(w.source, [w])
  }
  return [...groups.entries()].map(([source, items]) => ({ source, label: SOURCE_LABEL[source] ?? source, items }))
})

/* ---------------- Live log ---------------- */

const logBox = ref<HTMLElement | null>(null)
watch(
  () => sync.log.length,
  async () => {
    await nextTick()
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  },
)

function startSync() {
  // Offline on a phone: the buttons are disabled, and the Mac could not start it anyway.
  if (connection.readOnly) return
  void sync.start()
}

const summaryClass =
  'flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-2 outline-none select-none hover:bg-parchment-deep/70 focus-visible:ring-2 focus-visible:ring-gold-ink/50 [&::-webkit-details-marker]:hidden'
</script>

<template>
  <Dialog v-model:open="sync.panelOpen">
    <DialogContent layout="sheet" class="gap-0 p-0">
      <div class="shrink-0 border-b border-line-dark px-5 pt-5 pb-4">
        <DialogHeader>
          <DialogTitle>Syncrapport</DialogTitle>
          <DialogDescription>{{ description }}</DialogDescription>
        </DialogHeader>
      </div>

      <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-5">
        <!-- Live log while running -->
        <section v-if="sync.running" aria-label="Sync loopt">
          <div class="mb-2 flex items-center gap-2 text-sm text-gold">
            <LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Bezig met syncen
          </div>
          <div
            ref="logBox"
            role="log"
            class="max-h-[50dvh] overflow-y-auto rounded-md border border-line-dark bg-ink px-3 py-2.5 font-mono text-xs leading-relaxed text-muted-light"
          >
            <p v-if="!sync.log.length">Wachten op de eerste regel...</p>
            <p v-for="(line, i) in sync.log" :key="i" class="break-words whitespace-pre-wrap">{{ line }}</p>
          </div>
        </section>

        <!-- Could not start -->
        <div
          v-if="sync.error && !sync.running"
          class="rounded-md border border-ember/50 bg-ember/10 px-4 py-3 text-[0.95rem]"
          role="alert"
        >
          <p class="font-medium text-[#e9a58c]">Sync starten lukt niet</p>
          <p class="mt-1 text-text-light/90">{{ sync.error }}</p>
        </div>

        <template v-if="report && !sync.running">
          <!-- Outcome -->
          <div
            v-if="report.ok"
            class="flex items-start gap-3 rounded-md border border-gold/30 bg-gold/[0.07] px-4 py-3"
            role="status"
          >
            <CircleCheck class="mt-0.5 size-5 shrink-0 text-gold" :stroke-width="1.75" aria-hidden="true" />
            <div class="min-w-0 text-[0.95rem]">
              <p class="font-medium text-text-light">Sync gelukt</p>
              <p v-if="meta" class="mt-0.5 text-muted-light">
                {{ fmt(meta.counts.points) }} kaartpunten, {{ fmt(meta.counts.quests) }} quests,
                {{ fmt(meta.counts.vaults) }} vaults, {{ fmt(meta.counts.rewards) }} beloningen<template v-if="meta.durationMs">, in {{ formatDuration(meta.durationMs) }}</template>.
              </p>
            </div>
          </div>
          <div v-else class="rounded-md border border-ember/50 bg-ember/10 px-4 py-3" role="alert">
            <div class="flex items-start gap-3">
              <CircleX class="mt-0.5 size-5 shrink-0 text-[#e08a6c]" :stroke-width="1.75" aria-hidden="true" />
              <div class="min-w-0 text-[0.95rem]">
                <p class="font-medium text-[#e9a58c]">Sync mislukt</p>
                <p v-if="report.error" class="mt-1 font-mono text-[0.8rem] break-words text-text-light/90">{{ report.error }}</p>
                <p v-if="report.error?.startsWith(PARTIAL_WRITE_PREFIX)" class="mt-2 text-muted-light">Een deel van de wiki-data is al vervangen. Draai de sync opnieuw. Je voortgang is niet veranderd.</p>
                <p v-else class="mt-2 text-muted-light">Er is niets weggeschreven. Je data en voortgang zijn niet veranderd.</p>
              </div>
            </div>
            <div class="mt-3 flex justify-end">
              <Button variant="outline" size="sm" :disabled="connection.readOnly" @click="startSync">
                <RefreshCw aria-hidden="true" />
                Opnieuw proberen
              </Button>
            </div>
          </div>

          <!-- Changes -->
          <ParchmentPanel v-if="changeRows.length" :padded="false" class="px-3 py-4 sm:px-4">
            <SectionHeading title="Wijzigingen" class="px-2" />
            <div class="mt-2">
              <div
                class="grid grid-cols-[1fr_repeat(3,4.5rem)] items-end gap-x-1 px-2 pb-1 text-right text-xs font-medium tracking-wide text-text-parchment/55 uppercase"
                aria-hidden="true"
              >
                <span />
                <span>Nieuw</span>
                <span>Weg</span>
                <span>Gewijzigd</span>
              </div>
              <ul class="divide-y divide-gold-ink/10">
                <li v-for="row in changeRows" :key="row.key">
                  <details v-if="hasDetails(row)" class="group/row">
                    <summary :class="cn(summaryClass, 'grid grid-cols-[1fr_repeat(3,4.5rem)] gap-x-1')">
                      <span class="flex min-w-0 items-center gap-1.5 font-medium">
                        <ChevronDown
                          class="size-4 shrink-0 -rotate-90 text-gold-ink/70 transition-transform group-open/row:rotate-0 motion-reduce:transition-none"
                          aria-hidden="true"
                        />
                        <span class="truncate">{{ row.label }}</span>
                      </span>
                      <span v-for="k in COUNT_KEYS" :key="k" :class="cn('text-right tabular-nums', row.counts[k] ? 'text-text-parchment' : 'text-text-parchment/35')">
                        {{ fmt(row.counts[k]) }}
                      </span>
                    </summary>
                    <div class="pb-3 pl-8 pr-2 text-sm">
                      <table v-if="row.categories?.length" class="w-full">
                        <caption class="sr-only">Kaartpunten per categorie</caption>
                        <tbody>
                          <tr v-for="c in row.categories" :key="c.id" class="align-baseline">
                            <th scope="row" lang="en" class="py-0.5 pr-2 text-left font-normal">{{ c.label }}</th>
                            <td class="w-[4.5rem] text-right tabular-nums text-text-parchment/80">{{ c.counts.added ? `+${fmt(c.counts.added)}` : '' }}</td>
                            <td class="w-[4.5rem] text-right tabular-nums text-text-parchment/80">{{ c.counts.removed ? `-${fmt(c.counts.removed)}` : '' }}</td>
                            <td class="w-[4.5rem] text-right tabular-nums text-text-parchment/80">{{ c.counts.changed ? fmt(c.counts.changed) : '' }}</td>
                          </tr>
                        </tbody>
                      </table>
                      <div v-for="list in row.lists" :key="list.title" class="mt-1.5 first:mt-0">
                        <p class="font-display text-[0.68rem] font-semibold tracking-[0.12em] text-gold-ink uppercase">
                          {{ list.title }}
                        </p>
                        <ul lang="en" class="mt-0.5 space-y-0.5">
                          <li v-for="item in list.items" :key="item" class="break-words">{{ item }}</li>
                        </ul>
                      </div>
                    </div>
                  </details>
                  <div v-else class="grid min-h-11 grid-cols-[1fr_repeat(3,4.5rem)] items-center gap-x-1 px-2">
                    <span class="truncate pl-[1.375rem] font-medium">{{ row.label }}</span>
                    <span v-for="k in COUNT_KEYS" :key="k" class="text-right tabular-nums text-text-parchment/35">
                      {{ fmt(row.counts[k]) }}
                    </span>
                  </div>
                </li>
              </ul>
            </div>
          </ParchmentPanel>

          <!-- Changed quest steps -->
          <ParchmentPanel v-if="stepChanges.length" :padded="false" class="px-3 py-4 sm:px-4">
            <SectionHeading title="Stappen veranderd" :count="stepChanges.length" class="px-2" />
            <p class="mt-1 px-2 text-sm text-text-parchment/70">
              Een aangepaste stap is voor de app een nieuwe stap. Het vinkje van de oude stap blijft als verweesd staan.
            </p>
            <ul class="mt-2 divide-y divide-gold-ink/10">
              <li v-for="q in stepChanges" :key="q.questId">
                <details class="group/q" :open="stepChanges.length <= 3">
                  <summary :class="summaryClass">
                    <ChevronDown
                      class="size-4 shrink-0 -rotate-90 text-gold-ink/70 transition-transform group-open/q:rotate-0 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                    <span lang="en" class="min-w-0 flex-1 truncate font-medium">{{ q.name }}</span>
                    <span class="shrink-0 text-sm tabular-nums text-text-parchment/60">+{{ q.added.length }} / -{{ q.removed.length }}</span>
                  </summary>
                  <ul class="space-y-1.5 pr-2 pb-3 pl-8 text-sm">
                    <li v-for="s in q.added" :key="`a-${s.id}`" class="flex gap-2">
                      <Plus class="mt-0.5 size-3.5 shrink-0 text-gold-ink" :stroke-width="2.5" aria-hidden="true" />
                      <span class="sr-only">Nieuw:</span>
                      <span lang="en">{{ s.text }}</span>
                    </li>
                    <li v-for="s in q.removed" :key="`r-${s.id}`" class="flex gap-2 text-text-parchment/60">
                      <Minus class="mt-0.5 size-3.5 shrink-0 text-ember" :stroke-width="2.5" aria-hidden="true" />
                      <span class="sr-only">Weg:</span>
                      <span lang="en" class="line-through decoration-ember/40">{{ s.text }}</span>
                    </li>
                  </ul>
                </details>
              </li>
            </ul>
          </ParchmentPanel>
        </template>

        <!-- Orphans: always the live state, not the snapshot in the report -->
        <ParchmentPanel
          v-if="!sync.running && (report || orphanTotal > 0 || cleaned)"
          :padded="false"
          class="px-3 py-4 sm:px-4"
        >
          <SectionHeading title="Verweesde vinkjes" :count="orphanTotal" class="px-2">
            <template #right>
              <Button v-if="orphanTotal > 0" variant="outline" size="sm" :disabled="connection.readOnly" @click="confirmOpen = true">Opruimen</Button>
            </template>
          </SectionHeading>
          <p class="mt-1 px-2 text-sm text-text-parchment/70">
            Sync verwijdert nooit voortgang. Vinkjes die nergens meer naar wijzen blijven staan tot jij ze opruimt.
          </p>
          <p v-if="cleaned" class="mt-3 px-2 text-[0.95rem]" role="status">
            {{ cleaned === 1 ? '1 vinkje opgeruimd.' : `${cleaned} vinkjes opgeruimd.` }}
          </p>
          <p v-else-if="orphanTotal === 0" class="mt-3 px-2 text-[0.95rem]">Alles wijst ergens naar. Niets op te ruimen.</p>
          <ul v-if="orphanKinds.length" class="mt-2 divide-y divide-gold-ink/10">
            <li v-for="k in orphanKinds" :key="k.kind">
              <details class="group/o">
                <summary :class="summaryClass">
                  <ChevronDown
                    class="size-4 shrink-0 -rotate-90 text-gold-ink/70 transition-transform group-open/o:rotate-0 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 font-medium">{{ k.label }}</span>
                  <span class="shrink-0 tabular-nums">{{ k.entries.length }}</span>
                </summary>
                <ul lang="en" class="space-y-0.5 pr-2 pb-3 pl-8 text-sm break-words text-text-parchment/80">
                  <li v-for="e in k.entries" :key="e.id" :title="e.id">{{ e.text }}</li>
                </ul>
              </details>
            </li>
          </ul>
        </ParchmentPanel>

        <!-- Warnings -->
        <section v-if="report && !sync.running && warningGroups.length" aria-labelledby="sync-warnings">
          <SectionHeading :count="report.warnings.length" class="mb-1">
            <span id="sync-warnings">Waarschuwingen</span>
          </SectionHeading>
          <p class="mb-2 text-sm text-muted-light">
            Pagina's die de parser niet herkende. Die zijn overgeslagen, de rest is wel bijgewerkt.
          </p>
          <div class="divide-y divide-line-dark rounded-md border border-line-dark">
            <details v-for="g in warningGroups" :key="g.source" class="group/w">
              <summary
                class="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 outline-none select-none hover:bg-line-dark/40 focus-visible:ring-2 focus-visible:ring-gold/60 focus-visible:ring-inset [&::-webkit-details-marker]:hidden"
              >
                <ChevronDown
                  class="size-4 shrink-0 -rotate-90 text-muted-light transition-transform group-open/w:rotate-0 motion-reduce:transition-none"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1 font-medium">{{ g.label }}</span>
                <span class="shrink-0 text-sm tabular-nums text-muted-light">{{ g.items.length }}</span>
              </summary>
              <ul class="space-y-2 px-3 pt-1 pb-3 pl-9 text-sm">
                <li v-for="(w, i) in g.items" :key="i">
                  <p v-if="w.page" lang="en" class="font-medium text-text-light">{{ w.page }}</p>
                  <p class="break-words text-muted-light">{{ w.message }}</p>
                </li>
              </ul>
            </details>
          </div>
        </section>

        <!-- Log of the last run -->
        <details v-if="!sync.running && sync.log.length" class="group/log text-sm">
          <summary
            class="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-light outline-none select-none hover:text-text-light focus-visible:ring-2 focus-visible:ring-gold/60 [&::-webkit-details-marker]:hidden"
          >
            <ChevronDown
              class="size-4 shrink-0 -rotate-90 transition-transform group-open/log:rotate-0 motion-reduce:transition-none"
              aria-hidden="true"
            />
            Log van deze sync
          </summary>
          <div class="max-h-80 overflow-y-auto rounded-md border border-line-dark bg-ink px-3 py-2.5 font-mono text-xs leading-relaxed text-muted-light">
            <p v-for="(line, i) in sync.log" :key="i" class="break-words whitespace-pre-wrap">{{ line }}</p>
          </div>
        </details>

        <!-- Nothing yet -->
        <EmptyState
          v-if="!report && !sync.running && !sync.error && orphanTotal === 0 && !cleaned"
          compact
          title="Nog geen syncrapport"
          text="Na een sync zie je hier wat er op de wiki veranderd is."
        >
          <template #action>
            <Button :disabled="connection.readOnly" @click="startSync">
              <RefreshCw aria-hidden="true" />
              Wiki bijwerken
            </Button>
          </template>
        </EmptyState>
      </div>

      <div class="flex shrink-0 items-center gap-3 border-t border-line-dark py-1 pr-5 pl-5">
        <SourceCredit class="flex-1" />
        <DialogClose as-child>
          <Button variant="outline">Sluiten</Button>
        </DialogClose>
      </div>
    </DialogContent>
  </Dialog>
  <OrphanCleanupDialog v-model:open="confirmOpen" @cleaned="onCleaned" />
</template>
