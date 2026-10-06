// Ash Log service worker: lets the home-screen app on the iPhone open when the Mac is off,
// asleep or not live on wifi, and show its own 'can't be reached' screen instead of an error.
// Registered by src/sw-register.ts, only in a production build, only over https (a secure
// context) and only on a phone; the Mac itself never runs it. A plain classic script: the app
// server serves it from public/ as /sw.js with Cache-Control: no-cache.
//
// What goes where:
//   navigations               network first. A real app page (index.html, header X-Ash-Log-App: 1)
//                             is kept under '/' (without ?device= and the like). Without an
//                             answer the kept app opens (app routes only); with nothing kept, a
//                             small 'can't be reached' page. Pairing, certificate and error pages
//                             are never kept.
//   /assets/*                 cache first (hashed build files), filled as they are used; files
//                             not used for the longest time go first when there are too many
//   /icons/*, /wiki-img/*     cache first, filled as they are used (map tiles only once viewed)
//   GET /api/data             network first; the last good 200 is the fallback, handed out with
//   GET /api/progress         X-Ash-Log-Offline: <time it was kept>, so the app knows it is old
//   everything else           not touched (writes, /api/health, /api/sync, the manifest, ...)
//
// A 401 (this phone was unpaired on the Mac) forgets the kept app and data.
// New versions take over at once (skipWaiting + clients.claim): navigations are network first,
// so nobody is left on old files.

'use strict'

const VERSION = 1
const CACHE_PREFIX = 'ash-log-'
const SHELL_CACHE = `${CACHE_PREFIX}shell-v${VERSION}`
const STATIC_CACHE = `${CACHE_PREFIX}static-v${VERSION}`
const IMAGE_CACHE = `${CACHE_PREFIX}images-v${VERSION}`
const DATA_CACHE = `${CACHE_PREFIX}data-v${VERSION}`
const CURRENT_CACHES = [SHELL_CACHE, STATIC_CACHE, IMAGE_CACHE, DATA_CACHE]

/** Set by the app server on index.html only. */
const APP_HEADER = 'X-Ash-Log-App'
/** On an offline copy of /api/data or /api/progress; read by src/lib/api.ts. */
const OFFLINE_HEADER = 'X-Ash-Log-Offline'
/** When a copy was kept; stored with it. */
const CACHED_AT_HEADER = 'X-Ash-Log-Cached-At'

const SHELL_PATH = '/'
const DATA_PATHS = ['/api/data', '/api/progress']
/**
 * Paths the server answers itself: never the app, so never the kept app either. /koppel and
 * /certificaat are the Dutch paths of older QR codes and links; the server redirects them.
 */
const SERVER_PATHS = /^\/(?:api|pair|certificate|koppel|certificaat|assets|icons|wiki-img)(?:\/|$)/

/** With the app kept: how long a navigation waits for the Mac before opening the kept app. */
const NAVIGATION_TIMEOUT_MS = 4000
/** With nothing kept: how long before the 'can't be reached' page. */
const OFFLINE_PAGE_TIMEOUT_MS = 10000
/** How long /api/data and /api/progress wait for the Mac before the offline copy. */
const DATA_TIMEOUT_MS = 6000
/**
 * Right after a request found no Mac (a cold start that just opened the kept app), the data
 * GETs give up much sooner: the 'can't be reached' screen then follows in a second or two.
 */
const DATA_TIMEOUT_AFTER_FAILURE_MS = 1500
const RECENT_FAILURE_MS = 30000
/** A kept build file used again after this long gets a new stamp (see trimStatic). */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000

const MAX_STATIC_ENTRIES = 200
const MAX_IMAGE_ENTRIES = 3000
const MAX_WARM_URLS = 200

// Same texts as the app's own screen (src/components/offline/texts.ts); a test keeps them in step.
const OFFLINE_TITLE = "Ash Log can't be reached"
const OFFLINE_TEXT =
  'Your computer is off or asleep, or Live on Wi-Fi is off. Make sure your phone is on the same Wi-Fi.'
const RETRY_LABEL = 'Try again'

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

/**
 * What to do with a request: 'navigate', 'static', 'image', 'data', or null to leave it to
 * the browser.
 */
function routeRequest(request, origin) {
  if (request.method !== 'GET') return null
  let url
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  if (request.mode === 'navigate') return 'navigate'
  if (url.pathname.startsWith('/assets/')) return 'static'
  if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/wiki-img/')) return 'image'
  if (DATA_PATHS.includes(url.pathname)) return 'data'
  return null
}

/** A route of the app itself (the SPA), as opposed to a server page or a file. */
function isAppRoute(pathname) {
  if (pathname === '/index.html') return true
  if (SERVER_PATHS.test(pathname)) return false
  // Same rule as the server's SPA fallback: a last segment with an extension is a file.
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return last.lastIndexOf('.') <= 0
}

/** index.html as the app server marks it: never the pairing page, the certificate page or an error. */
function isAppResponse(response) {
  return !!response && response.status === 200 && !response.redirected && response.headers.get(APP_HEADER) === '1'
}

/** A plain same-origin 200. */
function isCacheable(response) {
  return !!response && response.status === 200 && (response.type === 'basic' || response.type === 'default')
}

/** The cache key of a data request: the path without its query string. */
function dataKey(requestUrl) {
  const url = new URL(requestUrl)
  return url.origin + url.pathname
}

function shellKey(origin) {
  return new URL(SHELL_PATH, origin).href
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** When a request last found no Mac (0: the last one got an answer). Lost when the worker stops, which is fine. */
let unreachableAt = 0

function markReached() {
  unreachableAt = 0
}

function markUnreachable() {
  unreachableAt = Date.now()
}

function recentlyUnreachable() {
  return unreachableAt > 0 && Date.now() - unreachableAt < RECENT_FAILURE_MS
}

/**
 * Writes to the file caches run one at a time, so trimming never races a file that is being
 * kept or touched (it could otherwise delete a file of the current build right after use).
 */
let cacheQueue = Promise.resolve()
function serial(task) {
  const run = cacheQueue.then(task, task)
  cacheQueue = run.catch(() => undefined)
  return run
}

/** When a kept copy was stored or last touched, as epoch ms (0 when unknown). */
function keptAt(response) {
  const at = Date.parse((response && response.headers.get(CACHED_AT_HEADER)) || '')
  return Number.isNaN(at) ? 0 : at
}

/** Resolves like `promise`, or rejects when it takes longer than `ms`. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** A copy to keep: same status and headers, plus the time it was kept. */
async function stamped(response, now = new Date()) {
  const headers = new Headers(response.headers)
  headers.set(CACHED_AT_HEADER, now.toISOString())
  // The body is kept decoded; the length follows from it.
  headers.delete('Content-Encoding')
  headers.delete('Content-Length')
  const body = await response.arrayBuffer()
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/** A fresh response from a kept copy, with extra headers. */
function fromKept(kept, extra = {}) {
  const headers = new Headers(kept.headers)
  headers.delete(CACHED_AT_HEADER)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return new Response(kept.body, { status: 200, statusText: 'OK', headers })
}

/** Map tiles and icons: roughly the oldest go first (the order cache.keys() gives). Any loss is harmless. */
async function trimImages() {
  const cache = await caches.open(IMAGE_CACHE)
  const keys = await cache.keys()
  for (const request of keys.slice(0, Math.max(0, keys.length - MAX_IMAGE_ENTRIES))) await cache.delete(request)
}

/**
 * Build files: the ones not used for the longest time go first, by their stamp. Not by the
 * order of cache.keys(): Safari keeps a replaced entry in its old place, so a file of the
 * current build that has not changed for many builds would look oldest and could go, and the
 * app would then miss it without the Mac. Every file in use gets a fresh stamp at least daily.
 */
async function trimStatic() {
  const cache = await caches.open(STATIC_CACHE)
  const keys = await cache.keys()
  if (keys.length <= MAX_STATIC_ENTRIES) return
  const entries = []
  for (const request of keys) entries.push({ request, at: keptAt(await cache.match(request)) })
  entries.sort((a, b) => a.at - b.at)
  for (const { request } of entries.slice(0, entries.length - MAX_STATIC_ENTRIES)) await cache.delete(request)
}

function trimFiles() {
  return serial(() => trimStatic()).then(() => serial(() => trimImages()))
}

/** Keeps a file (a clone the page does not read) with the time it was kept. */
function keepFile(cacheName, request, response) {
  return serial(async () => {
    const cache = await caches.open(cacheName)
    await cache.put(request, await stamped(response))
  })
}

/** This phone was unpaired on the Mac: it keeps nothing of the logbook. */
async function forget(origin) {
  const shell = await caches.open(SHELL_CACHE)
  await shell.delete(shellKey(origin))
  await caches.delete(DATA_CACHE)
}

/* ------------------------------------------------------------------ */
/* Navigations                                                         */
/* ------------------------------------------------------------------ */

async function keepShell(response, origin) {
  const cache = await caches.open(SHELL_CACHE)
  await cache.put(shellKey(origin), await stamped(response))
  // A good moment to keep the other caches in bounds.
  await trimFiles()
}

async function keptShell(origin) {
  const cache = await caches.open(SHELL_CACHE)
  return cache.match(shellKey(origin), { ignoreSearch: true, ignoreVary: true })
}

async function handleNavigation(event, origin) {
  const request = event.request
  const network = fetch(request)
  event.waitUntil(
    network
      .then((response) => {
        markReached()
        if (isAppResponse(response)) return keepShell(response.clone(), origin)
        if (response.status === 401) return forget(origin)
        return undefined
      }, markUnreachable)
      .catch(() => undefined),
  )
  const kept = isAppRoute(new URL(request.url).pathname) ? await keptShell(origin).catch(() => undefined) : undefined
  try {
    // Whatever the Mac answers goes through as is: redirects, the pairing page, errors.
    return await withTimeout(network, kept ? NAVIGATION_TIMEOUT_MS : OFFLINE_PAGE_TIMEOUT_MS)
  } catch {
    markUnreachable()
    return kept ? fromKept(kept) : offlinePage()
  }
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function keepData(key, response, origin) {
  if (response.status === 401) return forget(origin)
  if (!isCacheable(response)) return undefined
  const cache = await caches.open(DATA_CACHE)
  await cache.put(key, await stamped(response))
  return undefined
}

async function handleData(event, origin) {
  const request = event.request
  const key = dataKey(request.url)
  const network = fetch(request)
  event.waitUntil(
    network
      .then((response) => {
        markReached()
        // Clone at once: the page reads the body of the original.
        const copy = response.status === 200 ? response.clone() : response
        return keepData(key, copy, origin)
      }, markUnreachable)
      .catch(() => undefined),
  )
  const kept = await caches
    .open(DATA_CACHE)
    .then((cache) => cache.match(key, { ignoreSearch: true, ignoreVary: true }))
    .catch(() => undefined)
  // Nothing to fall back on: the page sees exactly what the network does.
  if (!kept) return network
  try {
    return await withTimeout(network, recentlyUnreachable() ? DATA_TIMEOUT_AFTER_FAILURE_MS : DATA_TIMEOUT_MS)
  } catch {
    markUnreachable()
    return fromKept(kept, { [OFFLINE_HEADER]: kept.headers.get(CACHED_AT_HEADER) || '' })
  }
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

/** waitUntil after an await: an older engine may refuse it; the work then simply runs on. */
function lateWaitUntil(event, promise) {
  const quiet = promise.catch(() => undefined)
  try {
    event.waitUntil(quiet)
  } catch {
    // Runs on without it.
  }
}

async function cacheFirst(event, cacheName) {
  const request = event.request
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request, { ignoreVary: true })
  if (hit) {
    // A build file in use keeps a fresh stamp, so trimStatic never takes it.
    if (cacheName === STATIC_CACHE && Date.now() - keptAt(hit) > TOUCH_AFTER_MS) {
      lateWaitUntil(event, keepFile(cacheName, request, hit.clone()))
    }
    return hit
  }
  const response = await fetch(request)
  if (isCacheable(response)) lateWaitUntil(event, keepFile(cacheName, request, response.clone()))
  return response
}

/** Keeps the given same-origin files (build files, icons) that are not kept yet, one at a time. */
async function warm(urls, origin) {
  for (const raw of urls.slice(0, MAX_WARM_URLS)) {
    let url
    try {
      url = new URL(String(raw), origin)
    } catch {
      continue
    }
    const kind = routeRequest({ method: 'GET', mode: 'no-cors', url: url.href }, origin)
    const name = kind === 'static' ? STATIC_CACHE : kind === 'image' ? IMAGE_CACHE : null
    if (!name) continue
    const cache = await caches.open(name)
    if (await cache.match(url.href, { ignoreVary: true })) continue
    try {
      const response = await fetch(url.href, { credentials: 'same-origin' })
      if (isCacheable(response)) await keepFile(name, url.href, response)
    } catch {
      // No network right now; the next launch fills it in.
    }
  }
}

/** The /assets/ files index.html links to (entry script, styles, preloads). */
function assetUrlsIn(html, origin) {
  const out = new Set()
  for (const match of String(html).matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], origin)
      if (url.origin === origin && url.pathname.startsWith('/assets/')) out.add(url.href)
    } catch {
      // Not a URL.
    }
  }
  return [...out]
}

/** Right after install: keep the app and its entry files, so even the next launch works without the Mac. */
async function precache(origin) {
  const response = await fetch(shellKey(origin), { credentials: 'same-origin', cache: 'no-cache' })
  if (!isAppResponse(response)) return
  const html = await response.clone().text()
  await keepShell(response, origin)
  await warm(assetUrlsIn(html, origin), origin)
}

/* ------------------------------------------------------------------ */
/* 'Can't be reached' page, when not even the app is kept              */
/* ------------------------------------------------------------------ */

function offlinePageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#15120e">
<title>${OFFLINE_TITLE}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #15120e; }
body {
  min-height: 100vh; min-height: 100dvh;
  display: flex; align-items: center; justify-content: center; text-align: center;
  padding: max(40px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(40px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  color: #efe2c4; font: 17px/1.5 'Alegreya Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
main { width: 100%; max-width: 420px; }
svg { width: 56px; height: 56px; color: #c9a24a; }
h1 { margin: 20px 0 12px; font: 600 22px/1.2 Cinzel, 'Trajan Pro', Georgia, serif; letter-spacing: .08em; text-transform: uppercase; }
p { margin: 0; color: #a8977a; }
button {
  min-height: 44px; margin-top: 28px; padding: 0 20px;
  font-family: inherit; font-size: 16px; font-weight: 500;
  color: #efe2c4; background: transparent; border: 1px solid #3a2f22; border-radius: 6px; cursor: pointer;
}
button:focus-visible { outline: 2px solid #c9a24a; outline-offset: 2px; }
.hint { margin-top: 12px; font-size: 14px; opacity: .8; }
</style>
</head>
<body>
<main>
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/></svg>
<h1>${OFFLINE_TITLE}</h1>
<p>${OFFLINE_TEXT}</p>
<button type="button" id="retry">${RETRY_LABEL}</button>
<p class="hint">Ash Log will try again on its own.</p>
</main>
<script>
(function () {
  var delay = 5000, timer = 0, busy = false;
  function reload() { location.reload(); }
  function check() {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    fetch('/api/health', { cache: 'no-store' }).then(reload, function () {
      busy = false;
      timer = setTimeout(check, delay);
      delay = Math.min(delay * 2, 30000);
    });
  }
  function soon() { delay = 5000; check(); }
  document.getElementById('retry').addEventListener('click', reload);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') soon(); });
  window.addEventListener('online', soon);
  timer = setTimeout(check, delay);
})();
</script>
</body>
</html>
`
}

function offlinePage() {
  return new Response(offlinePageHtml(), {
    status: 503,
    statusText: 'Service Unavailable',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function activate() {
  const names = await caches.keys()
  // Caches of older versions of this worker; anything else on the origin is not ours.
  await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.includes(n)).map((n) => caches.delete(n)))
  await trimFiles()
  await self.clients.claim()
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(precache(self.location.origin).catch(() => undefined))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(activate())
})

self.addEventListener('fetch', (event) => {
  const origin = self.location.origin
  switch (routeRequest(event.request, origin)) {
    case 'navigate':
      return event.respondWith(handleNavigation(event, origin))
    case 'static':
      return event.respondWith(cacheFirst(event, STATIC_CACHE))
    case 'image':
      return event.respondWith(cacheFirst(event, IMAGE_CACHE))
    case 'data':
      return event.respondWith(handleData(event, origin))
    default:
      return undefined
  }
})

// The page lists the build files it loaded before this worker controlled it (sw-register.ts).
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'cache' || !Array.isArray(data.urls)) return
  event.waitUntil(warm(data.urls, self.location.origin).catch(() => undefined))
})
