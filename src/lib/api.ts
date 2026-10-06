// Thin client for the dev middleware (server/middleware.ts) and the app server, which share /api.

import { OFFLINE_HEADER, OfflineCopyError, reportConnection } from './connection'
import type { AppData, Overrides, PairingCode, PhoneKind, Progress, ServerStatus, SyncDomain, SyncStatus } from './types'

/** For the two GETs the service worker may answer from its cache (see public/sw.js). */
export interface ReadOptions {
  /**
   * Take the service worker's offline copy when the server cannot be reached. Only when there
   * is nothing on screen yet: an older copy must never replace newer data. Without it an
   * offline copy throws OfflineCopyError.
   */
  acceptOffline?: boolean
}

/**
 * GET /api/server/certificate-qr: the page where a phone installs the Ash Log certificate once
 * (ServerStatus.certificateUrl), as a QR code rendered by the server like the pairing code.
 */
export interface CertificateQr {
  /**
   * Plain-http certificate page on the address for that phone: the .local name for an iPhone
   * and a Mac (http://MacBook-Pro-van-Joost.local:5199/certificaat), the LAN address otherwise.
   */
  url: string
  /** The QR code as an SVG string. */
  qrSvg: string
}

/**
 * PUT /api/progress was refused with 409: progress.json changed since this tab last read or
 * wrote it (another tab, or a hand edit). Carries the copy that is on disk now.
 */
export class ProgressConflictError extends Error {
  /** Current progress on disk, as the server sent it. */
  readonly progress: Progress

  constructor(message: string, progress: Progress) {
    super(message)
    this.name = 'ProgressConflictError'
    this.progress = progress
  }
}

/**
 * ETag of progress.json as this tab last saw it (GET, successful PUT or 409). Sent as If-Match,
 * so a tab with a stale copy gets a 409 instead of overwriting newer progress.
 */
let progressEtag: string | null = null

/** Revision of overrides.json from the last GET /api/data; sent as If-Match on PUT /api/overrides. */
let overridesEtag: string | null = null

/** A 401 already sent this page back to the server's pairing page. */
let reloadingForPairing = false

async function call(method: string, path: string, body?: unknown, init: RequestInit = {}, read: ReadOptions = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  // The middleware refuses writes without a JSON content type (415).
  if (method !== 'GET') headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    // No answer at all: the Mac is off, asleep, or not live on wifi (or just a blip).
    reportConnection({ type: 'failed' })
    throw err
  }
  // headers?: test doubles of fetch do not always carry headers.
  const offlineAt = res.headers?.get(OFFLINE_HEADER) ?? null
  if (offlineAt !== null) {
    const used = !!read.acceptOffline
    reportConnection({ type: 'offline-copy', at: offlineAt, used })
    if (!used) throw new OfflineCopyError(offlineAt)
  } else {
    reportConnection({ type: 'reached' })
  }
  // Only a phone that was unpaired on the Mac gets 401 (this Mac and the dev server never do).
  // Reload once: the app server then shows its pairing page instead of the app. A home-screen
  // app on the iPhone has no reload button, so it would otherwise stay stuck on the error.
  // globalThis, not window: src/lib is also type-checked without the DOM (tsconfig.node.json).
  const page = (globalThis as { location?: { reload(): void } }).location
  if (res.status === 401 && !reloadingForPairing && page) {
    reloadingForPairing = true
    page.reload()
  }
  const text = await res.text()
  let data: any
  try {
    data = text ? JSON.parse(text) : undefined
  } catch (err) {
    if (res.ok) throw err
  }
  return { res, data }
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const { res, data } = await call(method, path, body, init)
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data as T
}

async function getProgress(read: ReadOptions = {}): Promise<Progress> {
  const { res, data } = await call('GET', '/api/progress', undefined, {}, read)
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  progressEtag = res.headers.get('ETag')
  return data as Progress
}

async function putProgress(progress: Progress, init: RequestInit = {}): Promise<Progress> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  if (progressEtag) headers['If-Match'] = progressEtag
  const { res, data } = await call('PUT', '/api/progress', progress, { ...init, headers })
  if (res.status === 409 && data?.progress) {
    // The copy in the error is the new base: a retry after merging must name its revision.
    progressEtag = res.headers.get('ETag')
    throw new ProgressConflictError(data.error ?? 'Voortgang is elders gewijzigd', data.progress as Progress)
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  progressEtag = res.headers.get('ETag')
  return data as Progress
}

async function getData(read: ReadOptions = {}): Promise<AppData> {
  const { res, data } = await call('GET', '/api/data', undefined, {}, read)
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  overridesEtag = res.headers.get('X-Overrides-ETag')
  return data as AppData
}

async function putOverrides(overrides: Overrides): Promise<Overrides> {
  const headers: Record<string, string> = overridesEtag ? { 'If-Match': overridesEtag } : {}
  const { res, data } = await call('PUT', '/api/overrides', overrides, { headers })
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  overridesEtag = res.headers.get('ETag')
  return data as Overrides
}

export const api = {
  data: getData,
  progress: getProgress,
  saveProgress: putProgress,
  saveOverrides: putOverrides,
  startSync: (opts: { only?: SyncDomain[]; full?: boolean } = {}) => request<SyncStatus>('POST', '/api/sync', opts),
  syncStatus: () => request<SyncStatus>('GET', '/api/sync/status'),
  /** Mode, live state and addresses; paired devices only for requests from the computer itself. */
  serverStatus: () => request<ServerStatus>('GET', '/api/server'),
  /** Turns 'Live op wifi' on or off (app server only, from the computer itself). */
  setLive: (on: boolean) => request<ServerStatus>('POST', '/api/server/live', { on }),
  /** A one-time code plus QR code to pair a phone (the address in it suits that phone). Only while live. */
  createPairing: (phone?: PhoneKind) => request<PairingCode>('POST', '/api/server/pairing', phone ? { phone } : {}),
  /** QR code for the certificate page, with the address for that phone. Only while live, from the computer itself. */
  certificateQr: (phone?: PhoneKind) =>
    request<CertificateQr>('GET', `/api/server/certificate-qr${phone ? `?phone=${encodeURIComponent(phone)}` : ''}`),
  /** Forgets a paired device; its cookie stops working. */
  revokeDevice: (id: string) => request<ServerStatus>('POST', '/api/server/devices/revoke', { id }),
  /** Stops the app server (it answers first, then shuts down). */
  stopServer: () => request<{ ok: true }>('POST', '/api/server/stop', {}),
}
