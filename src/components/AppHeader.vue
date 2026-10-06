<script setup lang="ts">
import { computed, onMounted, type Component } from 'vue'
import { useRoute } from 'vue-router'
import { useEventListener } from '@vueuse/core'
import {
  CloudAlert,
  CloudCheck,
  CloudOff,
  FileClock,
  Gem,
  LoaderCircle,
  Map as MapIcon,
  RefreshCw,
  ScrollText,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import IconButton from '@/components/common/IconButton.vue'
import ashLogs from '@/assets/ash-logs.png'
import RelativeTime from '@/components/common/RelativeTime.vue'
import LiveControl from '@/components/live/LiveControl.vue'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/composables/useRelativeTime'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import { useServerStore } from '@/stores/server'
import { useSyncStore } from '@/stores/sync'
import { useViewMemoryStore, VIEW_PATHS, type ViewName } from '@/stores/viewMemory'

const data = useDataStore()
const progress = useProgressStore()
const server = useServerStore()
const sync = useSyncStore()
const connection = useConnectionStore()
const memory = useViewMemoryStore()
const route = useRoute()

// Which server is behind /api decides whether the live control shows (Mac, app server only).
onMounted(() => void server.load())
// Back in this window: live may have been switched in another one.
useEventListener(window, 'focus', () => {
  if (server.canManage) void server.load()
})

interface NavItem {
  view: ViewName
  /** The base path of the view. */
  to: string
  label: string
  icon: Component
}

const nav: NavItem[] = [
  { view: 'quests', to: VIEW_PATHS.quests, label: 'Quests', icon: ScrollText },
  { view: 'map', to: VIEW_PATHS.map, label: 'Kaart', icon: MapIcon },
  { view: 'collections', to: VIEW_PATHS.collections, label: 'Verzamelingen', icon: Gem },
]

const isActive = (to: string) => route.path === to || route.path.startsWith(`${to}/`)

/**
 * The tab of another view goes back to where that view was left (its filters, selection and
 * anchor are in its address); the tab of the view you are on goes to its base path.
 */
const target = (view: ViewName) => memory.linkTo(view)

/**
 * A click on a tab (or the brand). The links are drawn by hand (RouterLink `custom`), so this
 * decides first and then lets the router navigate.
 *
 * A plain click that becomes a navigation is announced as a return, so the view restores itself
 * instead of handling its address as a new target. A click with a modifier key opens a new tab or
 * window and is left to the browser (navigate() does nothing for it).
 *
 * The second click of a double click, or an impatient second tap, lands when the first one has
 * already brought the view back: the tab then links to the base path and would throw away exactly
 * what just came back. That click does nothing. A later click on the tab of the view you are on
 * goes to the base path as always.
 */
function onTabClick(event: MouseEvent, view: ViewName, navigate: (event?: MouseEvent) => unknown) {
  const plain = event.button === 0 && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
  if (plain) {
    if (memory.active === view && (event.detail > 1 || memory.cameByTab(view))) {
      event.preventDefault()
      return
    }
    memory.announceReturn(view)
  }
  void navigate(event)
}

/** The report the panel shows: the one from this session, else the last one on disk. */
const report = computed(() => sync.report ?? data.lastReport ?? null)
const reportNeedsAttention = computed(() => !!report.value && (!report.value.ok || report.value.warnings.length > 0))

const lastLine = computed(() => {
  for (let i = sync.log.length - 1; i >= 0; i--) {
    const line = sync.log[i]?.trim()
    if (line) return line
  }
  return 'Sync gestart'
})

function openReport() {
  if (report.value) sync.openReport(report.value)
  else sync.panelOpen = true
}

function openLive() {
  sync.panelOpen = true
}

function startSync() {
  // Offline on a phone: the button is disabled, and the Mac could not start it anyway.
  if (connection.readOnly) return
  void sync.start()
}

/**
 * Saving failed: try again. Loading failed: load again (checks are not saved until then).
 * Reloaded after a conflict: nothing to retry, the click dismisses the notice.
 */
async function retryProgress() {
  if (progress.conflict) return progress.clearError()
  if (progress.loaded) return progress.flush()
  await progress.load()
}

const progressLabel = computed(() =>
  progress.conflict ? 'Opnieuw geladen' : progress.loaded ? 'Niet opgeslagen' : 'Voortgang niet geladen',
)
const progressHint = computed(() =>
  progress.conflict
    ? 'Klik om dit te sluiten.'
    : progress.loaded
      ? 'Klik om opnieuw op te slaan.'
      : 'Vinkjes worden pas bewaard als dit lukt. Klik om opnieuw te laden.',
)
</script>

<template>
  <header class="relative z-20 shrink-0 bg-leather pt-[env(safe-area-inset-top)] text-text-light">
    <!-- pt: on the iPhone home screen the status bar lies over the page (black-translucent) -->
    <div class="flex h-14 items-center gap-2 px-3 sm:gap-4 sm:px-5">
      <!-- Brand -->
      <RouterLink v-slot="{ href, navigate }" :to="target('quests')" custom>
        <a
          :href="href"
          class="group -ml-1 flex min-h-11 shrink-0 items-center gap-2.5 rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-gold"
          aria-label="Ash Log, naar Quests"
          @click="onTabClick($event, 'quests', navigate)"
        >
          <img
            :src="ashLogs"
            alt=""
            width="36"
            height="36"
            class="size-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.6)] transition-transform duration-300 group-hover:-rotate-6 motion-reduce:transition-none"
          />
          <span class="font-display text-[1.15rem] leading-none font-bold tracking-[0.12em] text-text-light">ASH LOG</span>
        </a>
      </RouterLink>

      <!-- Navigation, wide screens -->
      <nav aria-label="Hoofdmenu" class="ml-2 hidden h-full items-stretch md:flex lg:ml-6">
        <RouterLink v-for="item in nav" :key="item.to" v-slot="{ href, navigate }" :to="target(item.view)" custom>
          <a
            :href="href"
            :aria-current="isActive(item.to) ? 'page' : undefined"
            :class="
              cn(
                'relative flex min-w-tap items-center gap-2 px-3.5 font-display text-[0.78rem] font-semibold tracking-[0.14em] uppercase transition-colors outline-none lg:px-4',
                'focus-visible:bg-line-dark/50 focus-visible:text-text-light',
                `after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors after:content-['']`,
                isActive(item.to)
                  ? 'text-gold after:bg-gold'
                  : 'text-muted-light after:bg-transparent hover:text-text-light hover:after:bg-line-dark',
              )
            "
            @click="onTabClick($event, item.view, navigate)"
          >
            <component :is="item.icon" class="size-4" :stroke-width="1.75" aria-hidden="true" />
            {{ item.label }}
          </a>
        </RouterLink>
      </nav>

      <!-- Status and sync -->
      <div class="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        <!-- Live on wifi: only on the Mac itself, under the app server -->
        <LiveControl v-if="server.canManage && !connection.readOnly" />

        <!-- Progress save state -->
        <Tooltip v-if="progress.error">
          <TooltipTrigger as-child>
            <Button variant="ghost" size="sm" class="text-[#e08a6c] hover:text-[#f0a488]" @click="retryProgress">
              <CloudAlert v-if="progress.conflict" aria-hidden="true" />
              <CloudOff v-else aria-hidden="true" />
              <span class="hidden sm:inline">{{ progressLabel }}</span>
              <span class="sr-only sm:hidden">
                {{ progress.conflict ? 'Voortgang opnieuw geladen, sluiten' : `${progress.loaded ? 'Voortgang niet opgeslagen' : 'Voortgang niet geladen'}, opnieuw proberen` }}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ progress.error }}. {{ progressHint }}</TooltipContent>
        </Tooltip>
        <!-- Offline on a phone: what is on screen is the last known copy -->
        <span
          v-else-if="connection.readOnly"
          role="status"
          data-slot="progress-offline"
          class="grid size-9 shrink-0 place-content-center text-muted-light/80"
          title="Offline: alleen lezen"
        >
          <CloudOff class="size-4" :stroke-width="1.75" aria-hidden="true" />
          <span class="sr-only">Offline, alleen lezen</span>
        </span>
        <span
          v-else-if="progress.loaded"
          role="status"
          class="grid size-9 shrink-0 place-content-center text-muted-light/80"
          :title="progress.saving ? 'Opslaan...' : 'Voortgang staat veilig in data/progress.json'"
        >
          <LoaderCircle v-if="progress.saving" class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <CloudCheck v-else class="size-4" :stroke-width="1.75" aria-hidden="true" />
          <span class="sr-only">{{ progress.saving ? 'Voortgang wordt opgeslagen' : 'Voortgang opgeslagen' }}</span>
        </span>

        <!-- Last sync time: one line on wide screens, a compact two-line stack below xl.
             The stack is the only part of the row that may shrink, so it truncates before anything overflows. -->
        <p class="hidden shrink-0 text-sm whitespace-nowrap text-muted-light xl:block">
          <template v-if="data.meta">Gesynct <RelativeTime :value="data.meta.syncedAt" /></template>
          <template v-else-if="data.data">Nog niet gesynct</template>
        </p>
        <p
          v-if="data.meta"
          data-slot="sync-time-compact"
          class="flex min-w-0 flex-col px-1 text-right text-[0.68rem] leading-tight whitespace-nowrap text-muted-light xl:hidden"
        >
          <span class="truncate">Gesynct</span>
          <RelativeTime short :value="data.meta.syncedAt" class="truncate text-text-light/85" />
        </p>

        <!-- Last report -->
        <IconButton v-if="report" label="Laatste syncrapport" size="icon-sm" side="bottom" class="relative" @click="openReport">
          <FileClock :stroke-width="1.75" />
          <span
            v-if="reportNeedsAttention"
            aria-hidden="true"
            class="absolute top-1.5 right-1.5 size-2 rounded-full bg-ember ring-2 ring-leather"
          />
        </IconButton>

        <!-- Resync -->
        <Button
          variant="outline"
          size="sm"
          :disabled="sync.running || connection.readOnly"
          :aria-label="sync.running ? 'Sync loopt' : 'Wiki bijwerken'"
          :title="data.meta ? `Laatste sync: ${formatDateTime(data.meta.syncedAt)}` : undefined"
          @click="startSync"
        >
          <RefreshCw :class="cn(sync.running && 'animate-spin motion-reduce:animate-none')" aria-hidden="true" />
          <span class="hidden sm:inline">{{ sync.running ? 'Bezig' : 'Wiki bijwerken' }}</span>
        </Button>
      </div>
    </div>

    <!-- Navigation, narrow screens -->
    <nav aria-label="Hoofdmenu" class="grid grid-cols-3 border-t border-line-dark/70 md:hidden">
      <RouterLink v-for="item in nav" :key="item.to" v-slot="{ href, navigate }" :to="target(item.view)" custom>
        <a
          :href="href"
          :aria-current="isActive(item.to) ? 'page' : undefined"
          :class="
            cn(
              'relative flex min-h-11 items-center justify-center gap-1.5 px-1 font-display text-[0.7rem] font-semibold tracking-[0.06em] uppercase transition-colors outline-none min-[420px]:tracking-[0.1em]',
              'focus-visible:bg-line-dark/50',
              `after:absolute after:inset-x-4 after:bottom-0 after:h-0.5 after:rounded-full after:content-['']`,
              isActive(item.to) ? 'text-gold after:bg-gold' : 'text-muted-light after:bg-transparent',
            )
          "
          @click="onTabClick($event, item.view, navigate)"
        >
          <component :is="item.icon" class="hidden size-4 shrink-0 min-[420px]:block" :stroke-width="1.75" aria-hidden="true" />
          <span class="truncate">{{ item.label }}</span>
        </a>
      </RouterLink>
    </nav>

    <!-- Live sync strip -->
    <div
      v-if="sync.running || sync.error"
      class="flex min-h-9 items-center gap-2 border-t border-line-dark/70 bg-ink/40 px-3 text-sm sm:px-5"
      role="status"
      aria-live="polite"
    >
      <template v-if="sync.running">
        <LoaderCircle class="size-3.5 shrink-0 animate-spin text-gold motion-reduce:animate-none" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate text-muted-light" :title="lastLine">{{ lastLine }}</span>
        <Button variant="link" size="xs" class="shrink-0" @click="openLive">Bekijk log</Button>
      </template>
      <template v-else>
        <span class="min-w-0 flex-1 truncate text-[#e08a6c]">Sync starten lukt niet: {{ sync.error }}</span>
        <Button variant="link" size="xs" class="shrink-0" :disabled="connection.readOnly" @click="startSync">Opnieuw</Button>
      </template>
    </div>

    <!-- Tooled double rule, like the edge of a leather binding -->
    <div aria-hidden="true" class="h-[3px] border-t border-b border-t-gold/35 border-b-gold/10" />
  </header>
</template>
