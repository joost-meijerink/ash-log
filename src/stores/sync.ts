// Resync: POST /api/sync, then poll /api/sync/status until the report is in.
// On a phone that cannot reach the Mac (read-only) a sync never starts; when the Mac answers
// again, a sync that kept running there is picked up.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { DiffReport, SyncDomain } from '@/lib/types'
import { useConnectionStore } from './connection'
import { useDataStore } from './data'

const POLL_MS = 1000

export const useSyncStore = defineStore('sync', () => {
  const connection = useConnectionStore()
  const running = ref(false)
  const log = ref<string[]>([])
  const report = ref<DiffReport | null>(null)
  const error = ref<string | null>(null)
  /** The diff report panel is open. */
  const panelOpen = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function poll() {
    try {
      const status = await api.syncStatus()
      log.value = status.log
      running.value = status.running
      if (status.running) {
        timer = setTimeout(poll, POLL_MS)
        return
      }
      if (status.report) {
        report.value = status.report
        panelOpen.value = true
      }
      await useDataStore().load()
    } catch (err) {
      error.value = (err as Error).message
      running.value = false
    }
  }

  async function start(opts: { only?: SyncDomain[]; full?: boolean } = {}) {
    if (running.value || connection.readOnly) return
    error.value = null
    try {
      await api.startSync(opts)
    } catch (err) {
      // 409: a sync is already running (another tab); just follow it.
      if (!/al een sync/i.test((err as Error).message)) {
        error.value = (err as Error).message
        return
      }
    }
    running.value = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(poll, POLL_MS / 2)
  }

  /** Picks up a sync that is still running after a page reload. */
  async function resume() {
    if (running.value) return
    try {
      const status = await api.syncStatus()
      if (status.running && !running.value) {
        error.value = null
        running.value = true
        log.value = status.log
        timer = setTimeout(poll, POLL_MS)
      }
    } catch {
      /* middleware not reachable; the data store shows the error */
    }
  }

  // A poll that failed while the Mac was away stopped following the sync; pick it up again.
  connection.onReconnect(() => resume())

  function openReport(r: DiffReport) {
    report.value = r
    panelOpen.value = true
  }

  return { running, log, report, error, panelOpen, start, resume, openReport }
})
