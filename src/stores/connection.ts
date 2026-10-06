// Can this page reach the Mac? On a phone the answer decides between the app, the full-screen
// 'can't be reached' state and read-only browsing of the last known data. On the Mac itself
// (localhost) nothing changes: the native app has its own alert when the server is gone.
//
// Signals: every /api request (via lib/connection.ts), the offline copies the service worker
// hands out, navigator.onLine, and a GET /api/health poll while unreachable (5 s, doubling up
// to 30 s). Coming back to the page (visibilitychange, focus, online) checks at once.
// When the server answers again, the stores that registered with onReconnect reload and send
// what was waiting.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { earlier, isRemoteHost, onConnectionEvent, parseTime, pollDelay, type ConnectionEvent } from '@/lib/connection'

/** A health check that takes longer than this counts as no answer. */
export const HEALTH_TIMEOUT_MS = 4000
/** Focus and visibilitychange often fire together; one check is enough. */
const EVENT_THROTTLE_MS = 1000
/**
 * After a blip (a request failed, the health check did not) the stores reload at most this
 * often, so a request that keeps failing can never start a reload loop.
 */
export const BLIP_RELOAD_MS = 10_000

export type ConnectionState = 'online' | 'checking' | 'offline'

type ReconnectHandler = () => unknown

/** globalThis, not window: tests and the type-check may run without a DOM. */
function pageHostname(): string | undefined {
  return (globalThis as { location?: { hostname?: string } }).location?.hostname
}

function browserOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator
  return nav?.onLine !== false
}

export const useConnectionStore = defineStore('connection', () => {
  /** The page came over the network (a phone), not from the Mac itself. Only then is there an offline mode. */
  const remote = ref(isRemoteHost(pageHostname()))
  const state = ref<ConnectionState>('online')
  /** A health request is under way. */
  const checking = ref(false)
  /** The user chose to look at the last known data instead of the 'can't be reached' screen. */
  const browsing = ref(false)
  /** Epoch ms of the next automatic check while offline; null while none is planned. */
  const nextCheckAt = ref<number | null>(null)
  /** When the offline copy the app took from the service worker was cached. */
  const offlineCopyAt = ref<string | null>(null)
  /** Last time any request got an answer from the server. */
  const lastReachedAt = ref<string | null>(null)

  /** The server cannot be reached from this phone. */
  const offline = computed(() => remote.value && state.value === 'offline')
  /** Every change waits: checkmarks, pins, item lists, sync, live mode. */
  const readOnly = offline
  /** How old the data on screen is: the offline copy, or the last answer from the server. */
  const knownAt = computed(() => offlineCopyAt.value ?? lastReachedAt.value)

  let started = false
  let unsubscribe: (() => void) | null = null
  let removeListeners: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Failed polls since the server went away; sets the backoff. */
  let attempts = 0
  /** Bumped on every state change, so a check that started earlier cannot undo a newer answer. */
  let generation = 0
  let lastEventCheck = 0
  let lastReload = Number.NEGATIVE_INFINITY
  const reconnectHandlers = new Set<ReconnectHandler>()

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = undefined
    nextCheckAt.value = null
  }

  /** Any answer from /api/health counts, even a 401: the Mac is there. */
  async function ping(): Promise<boolean> {
    if (!browserOnline()) return false
    const controller = new AbortController()
    const abort = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    try {
      await fetch('/api/health', { cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } })
      return true
    } catch {
      return false
    } finally {
      clearTimeout(abort)
    }
  }

  function schedule() {
    if (!started || timer || state.value !== 'offline') return
    const delay = pollDelay(attempts)
    nextCheckAt.value = Date.now() + delay
    timer = setTimeout(() => {
      timer = undefined
      nextCheckAt.value = null
      void check(true)
    }, delay)
  }

  function goOffline() {
    generation++
    if (state.value !== 'offline') {
      state.value = 'offline'
      attempts = 0
    }
    schedule()
  }

  /**
   * Asks /api/health now. Online again: reconnect. Still nothing: plan the next try, a step
   * further in the backoff when this was a planned poll.
   */
  async function check(poll = false): Promise<boolean> {
    if (checking.value) return false
    clearTimer()
    const gen = ++generation
    const before = state.value
    if (before === 'online') state.value = 'checking'
    checking.value = true
    let ok = false
    try {
      ok = await ping()
    } finally {
      checking.value = false
    }
    // Something newer (a request that got through, or an offline copy) decided meanwhile.
    if (gen !== generation) return ok
    if (ok) {
      await reconnect()
    } else {
      if (poll) attempts++
      goOffline()
    }
    return ok
  }

  /** The server answers again: back to normal, reload what is on screen and send what was waiting. */
  async function reconnect() {
    generation++
    clearTimer()
    attempts = 0
    const was = state.value
    state.value = 'online'
    browsing.value = false
    offlineCopyAt.value = null
    if (was === 'online') return
    const now = Date.now()
    if (was === 'checking' && now - lastReload < BLIP_RELOAD_MS) return
    lastReload = now
    // Side by side: waiting checkmarks need not wait for the (large) data reload. A handler
    // that fails reports it itself; the others still run.
    await Promise.allSettled([...reconnectHandlers].map(async (handler) => handler()))
  }

  function onEvent(event: ConnectionEvent) {
    if (!started) return
    switch (event.type) {
      case 'reached':
        lastReachedAt.value = new Date().toISOString()
        if (state.value !== 'online') void reconnect()
        break
      case 'failed':
        // A single failed request may be a blip: confirm before showing anything.
        if (state.value === 'online') void check()
        break
      case 'offline-copy':
        // The service worker already tried the network and gave up: no need to confirm.
        if (event.used) offlineCopyAt.value = earlier(offlineCopyAt.value, parseTime(event.at))
        goOffline()
        break
    }
  }

  /** Check now, with the backoff back at the start (the user is looking). */
  function retry(): Promise<boolean> {
    attempts = 0
    return check()
  }

  function onVisible() {
    const doc = (globalThis as { document?: Document }).document
    if (doc && doc.visibilityState !== 'visible') return
    if (state.value !== 'offline') return
    const now = Date.now()
    if (now - lastEventCheck < EVENT_THROTTLE_MS) return
    lastEventCheck = now
    void retry()
  }

  function addListeners(): () => void {
    const win = (globalThis as { window?: Window }).window
    const doc = (globalThis as { document?: Document }).document
    if (!win || !doc) return () => {}
    const onOnline = () => {
      lastEventCheck = 0
      onVisible()
    }
    // The phone itself lost its network: no point in waiting for a check.
    const onOffline = () => goOffline()
    doc.addEventListener('visibilitychange', onVisible)
    win.addEventListener('focus', onVisible)
    win.addEventListener('online', onOnline)
    win.addEventListener('offline', onOffline)
    return () => {
      doc.removeEventListener('visibilitychange', onVisible)
      win.removeEventListener('focus', onVisible)
      win.removeEventListener('online', onOnline)
      win.removeEventListener('offline', onOffline)
    }
  }

  /** Starts listening (App.vue, before the first request). Does nothing on the Mac itself. */
  function start() {
    if (started || !remote.value) return
    started = true
    unsubscribe = onConnectionEvent(onEvent)
    removeListeners = addListeners()
    if (!browserOnline()) goOffline()
  }

  function stop() {
    started = false
    unsubscribe?.()
    unsubscribe = null
    removeListeners?.()
    removeListeners = null
    clearTimer()
  }

  /** Runs `handler` every time the server answers again after being unreachable. Returns the unsubscribe. */
  function onReconnect(handler: ReconnectHandler): () => void {
    reconnectHandlers.add(handler)
    return () => reconnectHandlers.delete(handler)
  }

  return {
    remote,
    state,
    checking,
    browsing,
    nextCheckAt,
    offlineCopyAt,
    lastReachedAt,
    offline,
    readOnly,
    knownAt,
    start,
    stop,
    retry,
    onReconnect,
    /** Leave the 'can't be reached' screen for the last known data, read-only. */
    browse: () => {
      if (offline.value) browsing.value = true
    },
  }
})
