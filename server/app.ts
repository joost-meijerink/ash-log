// App server: the built app on a fixed port (APP_PORT, default 5199), started by the macOS
// app or `npm run app` / `npm run app:serve`. Serves dist/, the same /api as the dev
// middleware, /wiki-img/* live from public/wiki-img and /icons/* from public/icons.
//
// Only this computer can reach it until live mode is switched on (from this computer). Then
// phones on the same Wi-Fi can, but only after pairing with a one-time code; until then they
// get a small pairing page and nothing else.
//
// One port, two protocols (live.ts): this computer keeps using plain http://localhost:<port>;
// phones use https with a certificate from Ash Log's own local CA (tls.ts), which they install
// once from the plain-http certificate page (certificate-page.ts). Plain http from the network
// serves only that page, the profile and a page that points to https. https is what gives the
// phone a service worker (/sw.js), so it can show its own 'niet bereikbaar' screen while the
// computer is away.
//
// The address in the QR codes (phoneHost): a Mac with an iPhone uses <name>.local, which
// Bonjour makes reliable. Anything else uses the LAN address: Android only resolves .local
// names from Android 12 on, and Windows and Linux may not answer for their .local name.
// LIVE_ADDRESS=name or ip in .env picks one for every phone (net.ts liveAddressSetting).
//
//   GET  /api/health                     { ok: true, mode: 'app' } (for the launcher)
//   GET  /api/server                     ServerStatus (devices only for this computer)
//   GET  /api/server/certificate-qr      ?phone=iphone|android -> { url, qrSvg } for the certificate page
//                                        (this computer, 409 when not live)
//   POST /api/server/live                { on } -> ServerStatus, answered before the sockets switch
//   POST /api/server/pairing             { phone? } -> PairingCode with the https url (409 when not live)
//   POST /api/server/devices/revoke      { id } -> ServerStatus
//   POST /api/server/stop                {} -> 202, then the server shuts down
//   GET  /koppel?code=                   pair via the QR code; sets the device cookie, redirects to /
//   POST /api/pair                       { code } -> { ok: true } with the device cookie
//   GET  /manifest.webmanifest           start_url '/?device=<token>' for a paired device
//   GET  /sw.js                          the service worker (no-cache), also before pairing
//   GET  /certificaat[/...]              certificate page and profile, over plain http too

import { readFileSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http'
import { hostname as osHostname } from 'node:os'
import { extname } from 'node:path'
import { finished } from 'node:stream/promises'
import QRCode from 'qrcode'
import type { Socket } from 'node:net'
import { isEntryPoint } from '../scripts/sync/node-command.ts'
import { computerNoun, parsePhoneKind, serverPlatform } from '../src/lib/platform.ts'
import type { PairingCode, PhoneKind, ServerStatus } from '../src/lib/types.ts'
import { StayAwake } from './awake.ts'
import { handleCertificate, isCertificatePath, sendSecureConnectionPage } from './certificate-page.ts'
import { APP_ICONS_DIR, DIST_DIR, LOCAL_DIR, PID_FILE, PUBLIC_DIR, SERVER_STATE_FILE, TLS_DIR, loadEnv, parsePort } from './config.ts'
import { checkWriteRequest, HttpError, isRecord, readBody, resolveInside, send, sendEmpty, sendError, serveFile } from './http.ts'
import { Listeners, PortInUseError } from './live.ts'
import { MANIFEST_PATH, handleManifest, startUrlFor } from './manifest.ts'
import { handleApi, handleWikiImage, stopSync, syncRunning, whenIdle } from './middleware.ts'
import {
  allowedHosts,
  createLanHostname,
  hostAllowed,
  isLoopback,
  lanAddresses,
  liveAddressSetting,
  liveUrls,
  normalizeAddress,
  phoneHosts,
  type PhoneAddressMode,
} from './net.ts'
import { DEVICE_COOKIE, Pairing, deviceCookie, readCookie } from './pairing.ts'
import { sendPairingPage } from './pairing-page.ts'
import { LocalTls, certNames } from './tls.ts'

const IMMUTABLE = 'public, max-age=31536000, immutable'
/** After a failed certificate attempt, status polls try again at most this often. */
const TLS_RETRY_MS = 5 * 60 * 1000
/**
 * Marks a response as the app itself (index.html), never the pairing, certificate or an error
 * page. The service worker only keeps responses with this header as its offline copy.
 */
export const APP_HEADER = 'X-Ash-Log-App'
export const SERVICE_WORKER_PATH = '/sw.js'
/**
 * index.html: never in a frame (the live switch must not be clickjacked), no referrer out,
 * marked as the app for the service worker.
 */
const INDEX_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'same-origin',
  Vary: 'Cookie',
  [APP_HEADER]: '1',
}

export interface AppOptions {
  port: number
  distDir?: string
  publicDir?: string
  iconsDir?: string
  /** Paired devices (.local/server.json). */
  stateFile?: string
  /** The local CA and server certificate (.local/tls). */
  tlsDir?: string
  /** Replaces the certificate store (tests share one CA between servers). */
  tls?: LocalTls
  hostname?: () => string
  lanAddresses?: () => string[]
  hosts?: { loopback?: string[]; live?: string[] }
  log?: (line: string) => void
  now?: () => number
  /** POST /api/server/stop was answered; the caller stops the process. */
  onStop?: () => void
  /** Not even loopback could be bound again after a switch: the server is unreachable. */
  onFatal?: (err: Error) => void
  /** Keeps the computer awake while live (default: awake.ts for this platform). */
  stayAwake?: { start(): void; stop(): void }
  /** process.platform of this computer (tests pretend to be Windows). */
  platform?: NodeJS.Platform
  /** LIVE_ADDRESS: the host every phone gets ('name' or 'ip'); null picks per computer and phone. Default: from .env. */
  liveAddress?: PhoneAddressMode | null
}

export interface AppServer {
  readonly listeners: Listeners
  readonly pairing: Pairing
  readonly tls: LocalTls
  /** Makes sure the server certificate holds this computer's current names and addresses. Never throws. */
  refreshTls(): Promise<void>
  /** The request handler all listeners share. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  status(local: boolean): ServerStatus
  /** Loads paired devices and listens on loopback. Throws PortInUseError. */
  start(): Promise<void>
  /** Stops listening, lets open requests and writes finish, saves device state. */
  close(): Promise<void>
}

const isRead = (req: IncomingMessage) => req.method === 'GET' || req.method === 'HEAD'
/** The request came in over TLS (the https side of the port). */
const isEncrypted = (socket: Socket) => (socket as Socket & { encrypted?: boolean }).encrypted === true

async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    color: { dark: '#15120e', light: '#efe4cc' },
  })
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end()
}

function sendText(res: ServerResponse, code: number, text: string) {
  res.statusCode = code
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

export function createAppServer(opts: AppOptions): AppServer {
  const distDir = opts.distDir ?? DIST_DIR
  const publicDir = opts.publicDir ?? PUBLIC_DIR
  const iconsDir = opts.iconsDir ?? APP_ICONS_DIR
  const nodePlatform = opts.platform ?? process.platform
  const platform = serverPlatform(nodePlatform)
  /** 'Mac', 'pc' or 'computer': how texts name this computer. */
  const computer = computerNoun(platform)
  // On a Mac the Bonjour name (MacBook-Pro-van-Joost.local), which phones resolve; see createLanHostname.
  const hostname = opts.hostname ?? createLanHostname({ platform: nodePlatform })
  const lan = opts.lanAddresses ?? lanAddresses
  const log = opts.log ?? (() => {})
  const pairing = new Pairing({ file: opts.stateFile ?? SERVER_STATE_FILE, now: opts.now, log, platform: nodePlatform })
  const awake = opts.stayAwake ?? new StayAwake({ log })
  const listeners = new Listeners((req, res) => void handle(req, res), {
    port: opts.port,
    log,
    loopbackHosts: opts.hosts?.loopback,
    liveHosts: opts.hosts?.live,
    platform: nodePlatform,
  })
  const tls = opts.tls ?? new LocalTls({ dir: opts.tlsDir ?? TLS_DIR, now: opts.now, log })
  const now = opts.now ?? Date.now
  const liveAddress = opts.liveAddress === undefined ? liveAddressSetting() : opts.liveAddress
  /** The server certificate the https side uses now. */
  let appliedCert: string | null = null
  let tlsFailedAt = Number.NEGATIVE_INFINITY

  const tlsNames = () => certNames(hostname(), lan())

  /**
   * Which host a phone of this kind gets: LIVE_ADDRESS when set; otherwise the .local name for
   * an iPhone and a Mac (Bonjour on both sides) and the private LAN address for anything else.
   */
  function addressMode(phone: PhoneKind = 'iphone'): PhoneAddressMode {
    if (liveAddress) return liveAddress
    return platform === 'mac' && phone === 'iphone' ? 'name' : 'ip'
  }
  /**
   * Host and port a phone of this kind reaches this computer by, for the QR codes. phoneHosts
   * falls back to the .local name without a LAN address, and to the address when the name
   * cannot be resolved. The server certificate holds both.
   */
  const phoneHost = (phone?: PhoneKind) => phoneHosts(listeners.port, hostname(), lan(), addressMode(phone))[0]!
  const certificateUrlFor = (phone?: PhoneKind) => `http://${phoneHost(phone)}/certificaat`
  /** The https addresses for the live dialog, the one an iPhone gets first. */
  const phoneUrls = () => liveUrls(listeners.port, hostname(), lan(), addressMode())

  /**
   * Makes sure the server certificate holds this computer's current names and addresses (on
   * start, when live goes on, and when a status shows they changed) and hands it to the https
   * side. When no certificate can be made, everything still works on this computer; https then
   * refuses connections.
   */
  async function refreshTls(): Promise<void> {
    try {
      const material = await tls.ensure(tlsNames())
      if (material.cert !== appliedCert) {
        listeners.setTls({ key: material.key, cert: material.cert })
        appliedCert = material.cert
      }
    } catch (err) {
      tlsFailedAt = now()
      log(`Certificaat maken mislukt: ${(err as Error).message}. Je telefoon kan er nu niet bij; op deze ${computer} werkt alles gewoon.`)
    }
  }

  function status(local: boolean, live = listeners.live): ServerStatus {
    return {
      mode: 'app',
      platform,
      local,
      live,
      port: listeners.port,
      urls: live ? phoneUrls() : [],
      ...(live ? { certificateUrl: certificateUrlFor() } : {}),
      ...(local ? { devices: pairing.devices() } : {}),
    }
  }

  /**
   * The https address for the host a request named: the same name or address when the server
   * certificate holds it, the host an iPhone gets otherwise (such as for a DHCP name the Host
   * check allows).
   */
  function httpsBaseFor(host: string | undefined): string {
    const fallback = `https://${phoneHost()}`
    if (!host) return fallback
    let name: string
    try {
      name = new URL(`http://${host}`).hostname.toLowerCase()
    } catch {
      return fallback
    }
    const names = tls.current?.names ?? tlsNames()
    const covered = names.dns.some((d) => d.toLowerCase() === name) || names.ips.includes(name)
    return covered ? `https://${host}` : fallback
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res)
    } catch (err) {
      if (!res.headersSent) sendError(res, err)
      else res.destroy()
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const { pathname } = url
    const api = pathname.startsWith('/api/')

    // DNS rebinding: a foreign domain pointed at this computer still names itself in Host.
    // os.hostname() too: on some networks it is a DHCP name (mbp-van-joost.home) that resolves as well.
    if (!hostAllowed(req.headers.host, allowedHosts(listeners.port, hostname(), lan(), [osHostname()]))) {
      if (api) send(res, 403, { error: 'Onbekende host' })
      else sendText(res, 403, 'Onbekende host')
      return
    }
    const local = isLoopback(req.socket.remoteAddress)
    const secure = isEncrypted(req.socket)
    // A connection from the network that outlived live mode.
    if (!local && !listeners.live) {
      res.destroy()
      return
    }

    // The certificate page and profile: over every transport, without pairing.
    if (isCertificatePath(pathname)) {
      handleCertificate(req, res, pathname, { material: tls.current, httpsUrl: httpsBaseFor(req.headers.host) + '/', computer })
      return
    }
    // Plain http from the network: nothing else, only a pointer to https.
    if (!local && !secure) return plainFromNetwork(req, res, url, api)

    // The home-screen app logs itself in with its start_url (see manifest.ts).
    if (isRead(req) && url.searchParams.has('device')) {
      const token = url.searchParams.get('device') ?? ''
      if (pairing.authenticate(token)) {
        url.searchParams.delete('device')
        // '/.//x' normalizes to '//x': never let that become a protocol-relative redirect.
        const location = '/' + url.pathname.replace(/^\/+/, '') + url.search
        redirect(res, location, { 'Set-Cookie': deviceCookie(token, secure) })
        return
      }
    }
    const token = readCookie(req.headers.cookie, DEVICE_COOKIE)
    const device = local ? undefined : pairing.authenticate(token)
    const authorized = local || !!device

    // Reachable without pairing.
    if (pathname === MANIFEST_PATH) {
      await handleManifest(req, res, { startUrl: device ? startUrlFor(token) : '/', iconsDir })
      return
    }
    if (pathname.startsWith('/icons/')) return serveFrom(req, res, iconsDir, pathname, '/icons/', 'no-cache')
    // Static code without data. Also before pairing, so an installed worker can always update itself.
    if (pathname === SERVICE_WORKER_PATH) return serveServiceWorker(req, res)
    if (pathname === '/koppel') return koppel(req, res, url, authorized, secure)
    if (pathname === '/api/pair') return apiPair(req, res, secure)

    if (!authorized) {
      if (api) send(res, 401, { error: 'Koppel dit apparaat eerst' })
      else if (isRead(req) && !extname(pathname)) sendPairingPage(req, res, 401, undefined, {}, nodePlatform)
      else sendEmpty(res, 401)
      return
    }

    if (pathname === '/api/health') {
      if (isRead(req)) send(res, 200, { ok: true, mode: 'app' })
      else send(res, 405, { error: 'Alleen GET' }, { Allow: 'GET, HEAD' })
      return
    }
    if (pathname === '/api/server' || pathname.startsWith('/api/server/')) return serverApi(req, res, pathname, local)
    if (await handleWikiImage(req, res)) return
    if (await handleApi(req, res)) return
    await serveApp(req, res, pathname)
  }

  /**
   * Plain http from a phone on the Wi-Fi (an old home-screen icon, a typed address): a page
   * that says Ash Log uses https now, with links to the certificate page and the https
   * address. No redirect: without the certificate the https page would just fail. The link
   * keeps the path and query, but never a device token.
   */
  function plainFromNetwork(req: IncomingMessage, res: ServerResponse, url: URL, api: boolean) {
    const base = httpsBaseFor(req.headers.host)
    if (api) {
      send(res, 403, { error: `Ash Log gebruikt nu een beveiligde verbinding: ${base}` })
      return
    }
    if (!isRead(req) || extname(url.pathname)) {
      sendEmpty(res, 403)
      return
    }
    url.searchParams.delete('device')
    // '/.//x' normalizes to '//x', which would name another host.
    const target = new URL('/' + url.pathname.replace(/^\/+/, '') + url.search, base)
    sendSecureConnectionPage(req, res, target.href, computer)
  }

  /* ---------------------------------------------------------------- */
  /* Pairing                                                           */
  /* ---------------------------------------------------------------- */

  async function koppel(req: IncomingMessage, res: ServerResponse, url: URL, paired: boolean, secure: boolean) {
    if (!isRead(req)) return sendEmpty(res, 405, { Allow: 'GET, HEAD' })
    // Already paired (or this computer): nothing to do, and the code stays usable.
    if (paired) return redirect(res, '/')
    const code = url.searchParams.get('code')
    // HEAD (a link preview) never uses up a code.
    if (code === null || req.method === 'HEAD') return sendPairingPage(req, res, 200, undefined, {}, nodePlatform)
    const result = await pairing.redeem(code, normalizeAddress(req.socket.remoteAddress), req.headers['user-agent'])
    if (result.ok) return redirect(res, '/', { 'Set-Cookie': deviceCookie(result.token, secure) })
    sendPairingPage(req, res, result.status, result.error, result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {}, nodePlatform)
  }

  async function apiPair(req: IncomingMessage, res: ServerResponse, secure: boolean) {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Alleen POST', undefined, { Allow: 'POST' })
      checkWriteRequest(req)
      const body = await readBody(req)
      const result = await pairing.redeem(isRecord(body) ? body.code : undefined, normalizeAddress(req.socket.remoteAddress), req.headers['user-agent'])
      if (result.ok) send(res, 200, { ok: true }, { 'Set-Cookie': deviceCookie(result.token, secure) })
      else send(res, result.status, { error: result.error }, result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {})
    } catch (err) {
      sendError(res, err)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Server management                                                 */
  /* ---------------------------------------------------------------- */

  async function serverApi(req: IncomingMessage, res: ServerResponse, pathname: string, local: boolean) {
    try {
      if (pathname === '/api/server') {
        if (!isRead(req)) throw new HttpError(405, 'Alleen GET', undefined, { Allow: 'GET, HEAD' })
        // The live dialog polls this: when the computer's name or Wi-Fi address changed, issue a
        // new certificate in the background (it is in use for new connections right after).
        if (local && listeners.live && tls.isStale(tlsNames()) && now() - tlsFailedAt >= TLS_RETRY_MS) void refreshTls()
        send(res, 200, status(local))
        return
      }
      if (!local) throw new HttpError(403, `Dit kan alleen op de ${computer} zelf`)
      if (pathname === '/api/server/certificate-qr') {
        if (!isRead(req)) throw new HttpError(405, 'Alleen GET', undefined, { Allow: 'GET, HEAD' })
        if (!listeners.live) throw new HttpError(409, 'Zet eerst Live op wifi aan')
        const url = certificateUrlFor(phoneParam(new URL(req.url ?? '/', 'http://localhost').searchParams.get('phone')))
        send(res, 200, { url, qrSvg: await qrSvg(url) })
        return
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Alleen POST', undefined, { Allow: 'POST' })
      checkWriteRequest(req)
      const raw = await readBody(req)
      const body = isRecord(raw) ? raw : {}
      switch (pathname) {
        case '/api/server/live':
          return await toggleLive(res, body.on)
        case '/api/server/pairing':
          return await createPairing(res, phoneParam(body.phone))
        case '/api/server/devices/revoke': {
          if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'Verwacht { id }')
          if (!(await pairing.revoke(body.id))) throw new HttpError(404, 'Apparaat niet gevonden')
          send(res, 200, status(true))
          return
        }
        case '/api/server/stop':
          send(res, 202, { ok: true })
          await finished(res).catch(() => {})
          log('Stoppen gevraagd vanuit de app')
          opts.onStop?.()
          return
      }
      throw new HttpError(404, `Onbekend endpoint: ${req.method} ${pathname}`)
    } catch (err) {
      sendError(res, err)
    }
  }

  /** Answers first, then switches the sockets (the answer travels over one of them). */
  async function toggleLive(res: ServerResponse, on: unknown) {
    if (typeof on !== 'boolean') throw new HttpError(400, 'Verwacht { on: true } of { on: false }')
    if (on === listeners.live) {
      send(res, 200, status(true))
      return
    }
    if (!on) pairing.clearCode()
    send(res, 200, status(true, on))
    await finished(res).catch(() => {})
    try {
      // The certificate first, so the first phone that connects gets one for the current address.
      if (on) await refreshTls()
      const result = await listeners.setLive(on)
      if (listeners.live) {
        awake.start()
      } else {
        awake.stop()
        // A code made while the switch was on its way must not outlive live mode either.
        pairing.clearCode()
      }
      if (!result.ok) return
      if (on) {
        log(`Live op wifi: ${phoneUrls().join(' en ')}. Deze ${computer} blijft wakker.`)
        log(`Certificaat voor je telefoon: ${certificateUrlFor()}`)
      }
      else log(`Live uit: alleen deze ${computer} kan erbij`)
    } catch (err) {
      awake.stop()
      log(`Luisteren mislukt: ${(err as Error).message}`)
      opts.onFatal?.(err as Error)
    }
  }

  /** A phone kind from a request; nothing means the default, an iPhone. */
  function phoneParam(value: unknown): PhoneKind | undefined {
    if (value === undefined || value === null) return undefined
    const phone = parsePhoneKind(value)
    if (!phone) throw new HttpError(400, 'Verwacht phone: iphone of android')
    return phone
  }

  async function createPairing(res: ServerResponse, phone?: PhoneKind) {
    if (!listeners.live) throw new HttpError(409, 'Zet eerst Live op wifi aan')
    const { code, expiresAt } = pairing.createCode()
    const url = `https://${phoneHost(phone)}/koppel?code=${code}`
    const body: PairingCode = { code, url, qrSvg: await qrSvg(url), expiresAt: new Date(expiresAt).toISOString() }
    send(res, 200, body)
  }

  /* ---------------------------------------------------------------- */
  /* Files                                                             */
  /* ---------------------------------------------------------------- */

  async function serveFrom(req: IncomingMessage, res: ServerResponse, root: string, pathname: string, prefix: string, cacheControl: string) {
    if (!isRead(req)) return sendEmpty(res, 405, { Allow: 'GET, HEAD' })
    const resolved = resolveInside(root, pathname, prefix)
    if (!resolved.ok) return sendEmpty(res, resolved.status)
    if (!(await serveFile(req, res, resolved.file, { cacheControl }))) sendEmpty(res, 404)
  }

  async function serveIndex(req: IncomingMessage, res: ServerResponse) {
    const resolved = resolveInside(distDir, '/index.html')
    if (resolved.ok && (await serveFile(req, res, resolved.file, { cacheControl: 'no-cache', headers: INDEX_HEADERS }))) return
    sendText(res, 503, 'Het Logboek is nog niet gebouwd. Start het met npm run app.')
  }

  /** /sw.js from dist/ or public/, always checked for a new version. */
  async function serveServiceWorker(req: IncomingMessage, res: ServerResponse) {
    if (!isRead(req)) return sendEmpty(res, 405, { Allow: 'GET, HEAD' })
    for (const root of [distDir, publicDir]) {
      const resolved = resolveInside(root, SERVICE_WORKER_PATH)
      if (resolved.ok && (await serveFile(req, res, resolved.file, { cacheControl: 'no-cache' }))) return
    }
    sendEmpty(res, 404)
  }

  /** dist/ first, then public/ (Vite no longer copies it), then the SPA fallback for app routes. */
  async function serveApp(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!isRead(req)) return sendEmpty(res, 405, { Allow: 'GET, HEAD' })
    if (pathname === '/' || pathname === '/index.html') return serveIndex(req, res)
    const inDist = resolveInside(distDir, pathname)
    if (!inDist.ok) return sendEmpty(res, inDist.status)
    const cacheControl = pathname.startsWith('/assets/') ? IMMUTABLE : 'no-cache'
    if (await serveFile(req, res, inDist.file, { cacheControl })) return
    const inPublic = resolveInside(publicDir, pathname)
    if (inPublic.ok && (await serveFile(req, res, inPublic.file, { cacheControl: 'no-cache' }))) return
    if (!extname(pathname)) return serveIndex(req, res)
    sendEmpty(res, 404)
  }

  return {
    listeners,
    pairing,
    tls,
    refreshTls,
    handle,
    status,
    async start() {
      await pairing.load()
      await refreshTls()
      await listeners.start()
    },
    async close() {
      awake.stop()
      // The launcher gives a stop request about ten seconds before it sends SIGTERM.
      await listeners.close(4000)
      if (syncRunning()) log('Er loopt een sync, even wachten...')
      if (!(await whenIdle(4000)) && syncRunning()) {
        log('Sync afgebroken; start hem later opnieuw')
        stopSync()
        await whenIdle(1500)
      }
      await pairing.flush().catch((err: Error) => log(`Apparaten opslaan mislukt: ${err.message}`))
    },
  }
}

/* ------------------------------------------------------------------ */
/* Command line: npm run app / npm run app:serve                       */
/* ------------------------------------------------------------------ */

/** Local time as 2026-09-28 16:05:12, the same stamp the desktop launcher writes into .local/server.log. */
function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * A reason the server cannot run, on stderr without a timestamp: the launcher shows the
 * last such line in its dialog.
 */
function fatal(message: string): never {
  console.error(message)
  process.exit(1)
}

/** True when an app server already answers on this port. */
export function isRunning(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/api/health', headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(res.statusCode === 200 && body?.ok === true && body?.mode === 'app')
        } catch {
          resolve(false)
        }
      })
      res.on('error', () => resolve(false))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

async function readPid(): Promise<number | null> {
  const text = await readFile(PID_FILE, 'utf8').catch(() => '')
  const pid = Number(text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function removePidSync() {
  try {
    if (Number(readFileSync(PID_FILE, 'utf8').trim()) === process.pid) unlinkSync(PID_FILE)
  } catch {
    // Already gone.
  }
}

export async function main(): Promise<void> {
  const log = (line: string) => console.log(`[${timestamp()}] ${line}`)
  let port: number
  try {
    loadEnv()
    port = parsePort(process.env.APP_PORT)
  } catch (err) {
    fatal((err as Error).message)
  }

  if (await isRunning(port)) {
    const pid = await readPid()
    log(`Het Logboek draait al op http://localhost:${port}${pid ? ` (pid ${pid})` : ''}`)
    return
  }

  let stopping: Promise<void> | null = null
  const shutdown = (code: number): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      log('Het Logboek stopt...')
      await app.close().catch((err: Error) => log(`Fout bij stoppen: ${err.message}`))
      removePidSync()
      log('Gestopt')
      process.exit(code)
    })()
    return stopping
  }

  const app = createAppServer({
    port,
    log,
    onStop: () => void shutdown(0),
    onFatal: () => void shutdown(1),
  })
  try {
    await app.start()
  } catch (err) {
    if (err instanceof PortInUseError) {
      fatal(`Poort ${port} is bezet door een ander programma. Sluit dat af of kies een andere poort met APP_PORT in .env.`)
    }
    throw err
  }

  await mkdir(LOCAL_DIR, { recursive: true })
  await writeFile(PID_FILE, `${process.pid}\n`)
  process.on('exit', removePidSync)
  // SIGBREAK: Ctrl+Break in a Windows console. Windows never sends SIGTERM; the launchers stop
  // the server with POST /api/server/stop instead.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      // A second Ctrl-C stops at once.
      if (stopping) process.exit(1)
      void shutdown(0)
    })
  }
  // Node resets an inherited 'ignore' for SIGHUP at startup, so nohup alone does not protect
  // the server the launcher starts. Without a terminal (launcher: stdin is /dev/null) a
  // hangup is ignored; in a terminal that closes, the server stops cleanly.
  process.on('SIGHUP', () => {
    if (process.stdin.isTTY) void shutdown(0)
    else log('SIGHUP genegeerd: de server draait los van een terminal')
  })
  log(`Het Logboek draait op http://localhost:${port}`)
  log(`Live op wifi staat uit: alleen deze ${computerNoun(serverPlatform(process.platform))} kan erbij`)
}

// Real paths on both sides, case-insensitive on Windows (8.3 short names, a lower-case drive letter).
if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((err: Error) => {
    console.error(err.stack ?? err.message)
    fatal(`Het Logboek kon niet starten: ${err.message}`)
  })
}
