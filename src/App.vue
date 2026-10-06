<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useEventListener } from '@vueuse/core'
import { CloudOff, FileExclamationPoint, LoaderCircle, RefreshCw } from 'lucide-vue-next'
import AppHeader from '@/components/AppHeader.vue'
import OrphanNotice from '@/components/OrphanNotice.vue'
import SyncReportPanel from '@/components/SyncReportPanel.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ashLogs from '@/assets/ash-logs.png'
import ParchmentPanel from '@/components/common/ParchmentPanel.vue'
import { unreachableHint } from '@/components/live/format'
import OfflineBanner from '@/components/offline/OfflineBanner.vue'
import OfflineScreen from '@/components/offline/OfflineScreen.vue'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import { useServerStore } from '@/stores/server'
import { useSyncStore } from '@/stores/sync'
import { useViewMemoryStore } from '@/stores/viewMemory'

const data = useDataStore()
const progress = useProgressStore()
const server = useServerStore()
const sync = useSyncStore()
const connection = useConnectionStore()
const memory = useViewMemoryStore()
// main.ts does this before the first navigation; here for a shell that is mounted on its own.
memory.attach(useRouter())

onMounted(() => {
  // Before the first request, so a Mac that cannot be reached shows up at once (phones only).
  connection.start()
  void data.load()
  void progress.load()
  void sync.resume()
})
onBeforeUnmount(() => connection.stop())

// Back in this tab: pick up what another tab or a hand edit changed in the meantime, so the
// next checkmark or pin starts from the files on disk. The stores skip it while they have
// unsaved changes. Focus and visibilitychange often fire together, hence the short throttle.
const REFRESH_THROTTLE_MS = 1000
let lastRefresh = 0
function refreshFromDisk() {
  if (document.visibilityState !== 'visible') return
  // The Mac cannot be reached: the connection store checks on its own and reloads when it is back.
  if (connection.state !== 'online') return
  const now = Date.now()
  if (now - lastRefresh < REFRESH_THROTTLE_MS) return
  lastRefresh = now
  void progress.refresh()
  // A running sync reloads the data itself when it finishes.
  if (!sync.running) void data.refresh()
}
useEventListener(document, 'visibilitychange', refreshFromDisk)
useEventListener(window, 'focus', refreshFromDisk)

/** overrides.json could not be read (a typo after a hand edit): corrections are off and read-only. */
const overridesError = computed(() => data.data?.overridesError ?? null)

/**
 * A phone that cannot reach the Mac: the 'niet bereikbaar' screen over everything, unless you
 * chose to look at the last known data (read-only, with a banner).
 */
const offlineScreen = computed(() => connection.offline && (!connection.browsing || !data.data))
// A dialog (the sync report) must not stay open over it.
watch(offlineScreen, (on) => {
  if (on) sync.panelOpen = false
})

/** No data at all yet: still loading, or the middleware is unreachable. */
const view = computed<'loading' | 'error' | 'first-run' | 'app'>(() => {
  if (!data.data) {
    if (!data.error) return 'loading'
    // On a phone a failed request is double-checked first; the offline screen may follow.
    return connection.remote && connection.state === 'checking' ? 'loading' : 'error'
  }
  return data.ready ? 'app' : 'first-run'
})

/** Report of a failed earlier attempt, shown on the first-run screen. */
const failedReport = computed(() => {
  const r = sync.report ?? data.lastReport
  return r && !r.ok ? r : null
})

const lastLine = computed(() => [...sync.log].reverse().find((l) => l.trim()) ?? 'Sync gestart')

/** Where to look when the server does not answer: npm run dev, the app on the Mac, or the laptop from the phone. */
const unreachableText = computed(() => unreachableHint({ mode: server.status?.mode, hostname: window.location.hostname }))

// main is the scroll container the views share. The views stay alive (KeepAlive below), so each
// one gets its own scroll position back: the view memory saves it in the navigation that leaves a
// view, while that view is still in the page. After the switch, in the same flush as the render
// (nothing jumps), main goes back there on a return and to the top on a fresh navigation. Not on
// param or query changes inside a view. A view can overrule this with scrollMain (useViewRoute).
// The browser's own scroll anchoring is off on main (overflow-anchor): it moves the page when a
// view swaps what is in it (the quest for the list on a phone), and the positions are kept here.
const mainEl = ref<HTMLElement | null>(null)
onMounted(() => memory.setMain(mainEl.value))
onBeforeUnmount(() => memory.setMain(null))
watch(
  () => memory.arrival,
  () => memory.settleMain(),
  { flush: 'post' },
)

function firstSync() {
  if (connection.readOnly) return
  void sync.start()
}
</script>

<template>
  <TooltipProvider>
    <!-- Phone without its Mac: 'niet bereikbaar' over everything; the app underneath keeps its place -->
    <OfflineScreen v-if="offlineScreen" class="fixed inset-0 z-[60]" />

    <!-- Side insets keep content clear of the notch in landscape on the iPhone home screen -->
    <div
      :inert="offlineScreen || undefined"
      :aria-hidden="offlineScreen || undefined"
      class="flex h-dvh flex-col overflow-hidden bg-ink pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] font-sans text-text-light"
    >
      <a
        href="#main"
        class="sr-only z-50 rounded-md bg-gold px-4 py-3 text-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Naar de inhoud
      </a>
      <AppHeader />
      <!-- Looking at the last known data while the Mac cannot be reached -->
      <OfflineBanner v-if="connection.readOnly" />
      <OrphanNotice v-if="view === 'app'" />

      <!-- Data could not be refreshed, but older data is still on screen -->
      <div
        v-if="data.error && data.data && connection.state === 'online'"
        role="alert"
        class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-ember/40 bg-[#2a1a13] px-3 py-1 text-sm sm:px-5"
      >
        <CloudOff class="size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
        <p class="min-w-0 flex-1">
          Verversen lukt niet: {{ data.error }}.
          <span class="text-muted-light">Je ziet de laatst geladen data.</span>
        </p>
        <Button variant="ghost" size="sm" @click="data.load()">Opnieuw proberen</Button>
      </div>

      <!-- overrides.json is broken: its corrections are off and editing waits until it is fixed -->
      <div
        v-if="overridesError"
        role="alert"
        class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-ember/40 bg-[#2a1a13] px-3 py-1 text-sm sm:px-5"
      >
        <FileExclamationPoint class="size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
        <p class="min-w-0 flex-1">
          <span class="font-mono text-[0.8rem]">data/overrides.json</span> is niet te lezen.
          <span class="text-muted-light">Je eigen correcties staan uit en aanpassen kan pas weer als je het bestand herstelt.</span>
          <span class="block font-mono text-xs break-words text-[#e08a6c]">{{ overridesError }}</span>
        </p>
        <Button variant="ghost" size="sm" :disabled="data.loading" @click="data.load()">Opnieuw laden</Button>
      </div>

      <main id="main" ref="mainEl" tabindex="-1" class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-[env(safe-area-inset-bottom)] outline-none [overflow-anchor:none]">
        <!-- Loading -->
        <div v-if="view === 'loading'" class="grid flex-1 place-content-center" role="status">
          <p class="flex items-center gap-2 text-muted-light">
            <LoaderCircle class="size-4 animate-spin text-gold motion-reduce:animate-none" aria-hidden="true" />
            Logboek openen...
          </p>
        </div>

        <!-- Middleware unreachable -->
        <div v-else-if="view === 'error'" class="grid flex-1 place-content-center px-4">
          <EmptyState
            :icon="CloudOff"
            title="Het logboek is niet bereikbaar"
            :text="unreachableText"
          >
            <p class="font-mono text-sm text-[#e08a6c]">{{ data.error }}</p>
            <template #action>
              <Button :disabled="data.loading" @click="data.load()">
                <RefreshCw :class="data.loading && 'animate-spin motion-reduce:animate-none'" aria-hidden="true" />
                Opnieuw proberen
              </Button>
            </template>
          </EmptyState>
        </div>

        <!-- First run: no wiki data yet -->
        <div v-else-if="view === 'first-run'" class="grid flex-1 place-items-center px-4 py-10">
          <ParchmentPanel class="w-full max-w-lg px-6 py-10 text-center sm:px-10">
            <img :src="ashLogs" alt="" width="64" height="64" class="mx-auto size-16" />
            <h1 class="mt-4 font-display text-xl font-semibold tracking-[0.08em] uppercase">Het logboek is nog leeg</h1>
            <p class="mx-auto mt-3 max-w-sm leading-relaxed text-text-parchment/75">
              Alle spelinhoud komt van de wiki. De eerste sync haalt kaartpunten, quests, vaults en beloningen op en
              downloadt de kaarttegels één keer. Dat duurt een paar minuten.
            </p>

            <div v-if="sync.running" class="mt-7 flex flex-col items-center gap-2" role="status" aria-live="polite">
              <p class="flex items-center gap-2 font-medium">
                <LoaderCircle class="size-4 animate-spin text-gold-ink motion-reduce:animate-none" aria-hidden="true" />
                Bezig met de eerste sync
              </p>
              <p class="max-w-full truncate font-mono text-xs text-text-parchment/60" :title="lastLine">{{ lastLine }}</p>
              <Button variant="link" size="xs" @click="sync.panelOpen = true">Bekijk log</Button>
            </div>
            <div v-else class="mt-7 flex flex-col items-center gap-3">
              <Button size="lg" :disabled="connection.readOnly" @click="firstSync">
                <RefreshCw aria-hidden="true" />
                {{ failedReport ? 'Opnieuw proberen' : 'Eerste sync starten' }}
              </Button>
              <p v-if="failedReport" class="text-sm text-ember">
                De vorige poging mislukte{{ failedReport.error ? `: ${failedReport.error}` : '.' }}
              </p>
              <p v-if="sync.error" class="text-sm text-ember">Sync starten lukt niet: {{ sync.error }}</p>
            </div>
          </ParchmentPanel>
        </div>

        <!-- The three views. Each view root gets flex-1 so it can fill the height (the map does).
             They stay alive while another one is on screen, so filters, open cards and the map
             itself are still there when you come back (see src/stores/viewMemory.ts). -->
        <RouterView v-else v-slot="{ Component }">
          <KeepAlive>
            <component :is="Component" class="min-w-0 flex-1" />
          </KeepAlive>
        </RouterView>
      </main>

      <SyncReportPanel />
    </div>
  </TooltipProvider>
</template>
