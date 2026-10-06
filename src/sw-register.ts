// Registers the service worker (public/sw.js) that lets the home-screen app on the iPhone open
// when the Mac cannot be reached. Only in a production build (never under the Vite dev
// server), only in a secure context (a service worker needs https) and only on a phone: on the
// Mac itself (localhost) the native app keeps its own behaviour, so a worker left behind there
// is removed.

import type { Router } from 'vue-router'
import { isRemoteHost } from '@/lib/connection'

export const SERVICE_WORKER_URL = '/sw.js'

export interface SwEnvironment {
  /** import.meta.env.PROD */
  prod: boolean
  /** window.isSecureContext */
  secure: boolean
  hostname: string
  container: ServiceWorkerContainer | undefined
}

export type SwDecision = 'register' | 'unregister' | 'skip'

export function swDecision(env: SwEnvironment): SwDecision {
  if (!env.container) return 'skip'
  if (!isRemoteHost(env.hostname)) return 'unregister'
  if (!env.prod || !env.secure) return 'skip'
  return 'register'
}

function currentEnvironment(): SwEnvironment {
  return {
    prod: import.meta.env.PROD,
    secure: typeof window !== 'undefined' && window.isSecureContext === true,
    hostname: typeof location !== 'undefined' ? location.hostname : '',
    container: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  }
}

/**
 * Hashed build files this page already loaded before the worker controlled it (the first
 * launch): the worker caches them too, so the next launch without the Mac has everything.
 */
export function loadedAssetUrls(entries: readonly { name: string }[], origin: string): string[] {
  const out = new Set<string>()
  for (const { name } of entries) {
    try {
      const url = new URL(name, origin)
      if (url.origin === origin && url.pathname.startsWith('/assets/')) out.add(url.href)
    } catch {
      // Not a URL.
    }
  }
  return [...out]
}

/** Loads every lazy view once, through the worker, so each view also opens without the Mac. */
async function warmRoutes(router: Router | undefined): Promise<void> {
  if (!router) return
  for (const record of router.getRoutes()) {
    for (const component of Object.values(record.components ?? {})) {
      if (typeof component === 'function') {
        await (component as () => Promise<unknown>)().catch(() => undefined)
      }
    }
  }
}

function whenControlled(container: ServiceWorkerContainer): Promise<ServiceWorker> {
  if (container.controller) return Promise.resolve(container.controller)
  return new Promise((resolve) => {
    container.addEventListener(
      'controllerchange',
      () => {
        if (container.controller) resolve(container.controller)
      },
      { once: true },
    )
  })
}

/**
 * The home-screen app starts at '/?device=<token>' (manifest.ts). Online the server logs it in
 * and redirects, so the app never sees the token; offline the worker opens the kept app at
 * that address. Drop the token from the address then, so it does not linger in the history or
 * in the query the views keep.
 */
export async function stripDeviceToken(router: Router): Promise<void> {
  await router.isReady()
  const current = router.currentRoute.value
  if (!('device' in current.query)) return
  const { device: _device, ...query } = current.query
  await router.replace({ path: current.path, query, hash: current.hash })
}

export interface RegisterOptions {
  /** For tests; defaults to the real browser. */
  env?: Partial<SwEnvironment>
  /** Its lazy views are loaded once the worker controls the page. */
  router?: Router
}

/**
 * Registers /sw.js when the conditions hold; on the Mac itself removes a worker left behind.
 * Never throws: without a worker the app works as before, just not offline.
 */
export async function registerServiceWorker(opts: RegisterOptions = {}): Promise<ServiceWorkerRegistration | null> {
  const env = { ...currentEnvironment(), ...opts.env }
  const decision = swDecision(env)
  const container = env.container
  if (!container || decision === 'skip') return null
  try {
    if (decision === 'unregister') {
      for (const registration of await container.getRegistrations()) await registration.unregister()
      return null
    }
    const registration = await container.register(SERVICE_WORKER_URL, { scope: '/', updateViaCache: 'none' })
    void whenControlled(container)
      .then(async (worker) => {
        const entries = typeof performance !== 'undefined' ? performance.getEntriesByType('resource') : []
        const origin = typeof location !== 'undefined' ? location.origin : ''
        const urls = origin ? loadedAssetUrls(entries, origin) : []
        if (urls.length) worker.postMessage({ type: 'cache', urls })
        await warmRoutes(opts.router)
      })
      .catch(() => undefined)
    return registration
  } catch {
    return null
  }
}
