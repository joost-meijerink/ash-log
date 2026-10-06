// Pairing phones with the app server: one-time codes, paired devices and their cookie.
//
// A device holds a random 32-byte token in an HttpOnly cookie; only its sha256 is stored
// (in .local/server.json), so the file alone cannot log anyone in. Codes live in memory:
// six digits, valid ten minutes, single use, at most one at a time.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { computerNoun, serverPlatform } from '../src/lib/platform.ts'
import type { ServerDevice } from '../src/lib/types.ts'
import { parseJson, readBytes, writeJsonAtomic } from '../scripts/sync/files.ts'
import { isRecord } from './http.ts'

export const DEVICE_COOKIE = 'logboek_device'
/** About ten years: a paired phone stays paired until it is unpaired on the computer. */
export const COOKIE_MAX_AGE = 10 * 365 * 24 * 60 * 60
export const CODE_TTL_MS = 10 * 60 * 1000
/** Wrong codes per address per window before further tries get 429. */
export const RATE_LIMIT_MAX = 10
export const RATE_LIMIT_WINDOW_MS = 60 * 1000
/** Wrong codes in total (all addresses) after which the active code is burned. */
export const MAX_FAILURES_PER_CODE = 30
/** Above this many addresses with wrong codes, addresses without recent tries are forgotten. */
export const MAX_TRACKED_ADDRESSES = 1000
/** lastSeenAt is written to disk at most this often per device. */
const LAST_SEEN_PERSIST_MS = 5 * 60 * 1000

/** Error texts for a phone that pairs; they name the computer ('je Mac', 'je pc'). */
export function pairErrors(platform: string = process.platform) {
  return {
    format: 'Typ de zes cijfers van de koppelcode',
    wrong: 'Deze code klopt niet',
    expired: `Deze code is niet meer geldig. Maak op je ${computerNoun(serverPlatform(platform))} een nieuwe.`,
    rateLimited: 'Te veel pogingen. Wacht een minuut en probeer het opnieuw.',
  } as const
}

/** The error texts on this computer. */
export const PAIR_ERRORS = pairErrors()

interface StoredDevice extends ServerDevice {
  tokenHash: string
}

interface ServerFile {
  version: 1
  devices: StoredDevice[]
}

interface ActiveCode {
  code: string
  expiresAt: number
  used: boolean
  failures: number
}

export type PairResult =
  | { ok: true; token: string; device: ServerDevice }
  | { ok: false; status: 400 | 410 | 429; error: string; retryAfter?: number }

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Set-Cookie value for a device token. Secure on https responses (phones on the Wi-Fi);
 * without it on plain http, which only this computer uses (http://localhost).
 */
export function deviceCookie(token: string, secure = false): string {
  return `${DEVICE_COOKIE}=${token}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

/** One cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined
  }
  return undefined
}

/** A readable name such as 'iPhone (Safari)' from a user agent. */
export function deviceNameFromUserAgent(ua: string | undefined): string {
  const text = ua ?? ''
  const device = /iPhone/.test(text)
    ? 'iPhone'
    : /iPad/.test(text)
      ? 'iPad'
      : /Android/.test(text)
        ? /Mobile/.test(text)
          ? 'Android-telefoon'
          : 'Android-tablet'
        : /Macintosh|Mac OS X/.test(text)
          ? 'Mac'
          : /Windows/.test(text)
            ? 'Windows-pc'
            : /Linux/.test(text)
              ? 'Linux-pc'
              : ''
  const browser = /EdgiOS|EdgA?\//.test(text)
    ? 'Edge'
    : /FxiOS|Firefox\//.test(text)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(text)
        ? 'Chrome'
        : /Version\/[\d.]+.*Safari\//.test(text)
          ? 'Safari'
          : /(iPhone|iPad).*AppleWebKit/.test(text) && !/Safari\//.test(text)
            ? 'web-app'
            : ''
  if (!device) return browser ? `Onbekend apparaat (${browser})` : 'Onbekend apparaat'
  return browser ? `${device} (${browser})` : device
}

/** A device as the API shows it: without its token hash. */
function publicDevice(d: StoredDevice): ServerDevice {
  return { id: d.id, name: d.name, pairedAt: d.pairedAt, ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}) }
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function normalizeDevice(raw: unknown): StoredDevice | null {
  if (!isRecord(raw)) return null
  const { id, name, pairedAt, lastSeenAt, tokenHash } = raw
  if (typeof id !== 'string' || !id || typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) return null
  return {
    id,
    name: typeof name === 'string' && name ? name : 'Onbekend apparaat',
    pairedAt: typeof pairedAt === 'string' ? pairedAt : new Date(0).toISOString(),
    ...(typeof lastSeenAt === 'string' ? { lastSeenAt } : {}),
    tokenHash,
  }
}

export interface PairingOptions {
  /** .local/server.json */
  file: string
  now?: () => number
  log?: (line: string) => void
  /** process.platform, for the texts that name the computer (tests pretend to be Windows). */
  platform?: string
}

export class Pairing {
  private readonly file: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private devicesByHash = new Map<string, StoredDevice>()
  private persistedSeen = new Map<string, number>()
  private dirty = false
  private active: ActiveCode | null = null
  private failures = new Map<string, number[]>()
  private writes: Promise<void> = Promise.resolve()
  private readonly errors: ReturnType<typeof pairErrors>

  constructor(opts: PairingOptions) {
    this.file = opts.file
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
    this.errors = opts.platform === undefined ? PAIR_ERRORS : pairErrors(opts.platform)
  }

  /** Reads the paired devices. An unreadable file is moved aside (and logged), never silently dropped. */
  async load(): Promise<void> {
    const bytes = await readBytes(this.file)
    this.devicesByHash.clear()
    if (bytes === null) return
    let raw: unknown
    try {
      raw = parseJson<unknown>(bytes.toString('utf8'), this.file)
    } catch (err) {
      const aside = `${this.file}.ongeldig-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`
      await rename(this.file, aside).catch(() => {})
      this.log(`Let op: ${(err as Error).message}. Bewaard als ${aside}; gekoppelde apparaten moeten opnieuw koppelen.`)
      return
    }
    const list = isRecord(raw) && Array.isArray(raw.devices) ? raw.devices : []
    for (const entry of list) {
      const device = normalizeDevice(entry)
      if (!device) continue
      this.devicesByHash.set(device.tokenHash, device)
      this.persistedSeen.set(device.id, Date.parse(device.lastSeenAt ?? '') || 0)
    }
  }

  /** Paired devices, oldest first, without their token hashes. */
  devices(): ServerDevice[] {
    return [...this.devicesByHash.values()]
      .sort((a, b) => a.pairedAt.localeCompare(b.pairedAt))
      .map(publicDevice)
  }

  /** A new code; it replaces any earlier one. */
  createCode(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.active = { code, expiresAt: this.now() + CODE_TTL_MS, used: false, failures: 0 }
    return { code, expiresAt: this.active.expiresAt }
  }

  /** Invalidates the active code (live mode went off). */
  clearCode(): void {
    if (this.active) this.active.used = true
  }

  /** The device for a token, or undefined. Updates lastSeenAt (written to disk now and then). */
  authenticate(token: string | undefined): ServerDevice | undefined {
    if (!token || token.length > 200) return undefined
    const device = this.devicesByHash.get(hashToken(token))
    if (!device) return undefined
    const now = this.now()
    device.lastSeenAt = new Date(now).toISOString()
    this.dirty = true
    if (now - (this.persistedSeen.get(device.id) ?? 0) >= LAST_SEEN_PERSIST_MS) {
      this.persistedSeen.set(device.id, now)
      void this.persist().catch((err: Error) => this.log(`Apparaten opslaan mislukt: ${err.message}`))
    }
    return publicDevice(device)
  }

  /** Checks a code from a phone and pairs it. Wrong codes count towards the per-address rate limit. */
  async redeem(input: unknown, address: string, userAgent: string | undefined): Promise<PairResult> {
    const now = this.now()
    this.forgetOldFailures(now)
    const recent = (this.failures.get(address) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
    if (recent.length) this.failures.set(address, recent)
    else this.failures.delete(address)
    if (recent.length >= RATE_LIMIT_MAX) {
      const retryAfter = Math.max(1, Math.ceil((recent[0]! + RATE_LIMIT_WINDOW_MS - now) / 1000))
      return { ok: false, status: 429, error: this.errors.rateLimited, retryAfter }
    }

    const fail = (status: 400 | 410, error: string): PairResult => {
      this.failures.set(address, [...recent, now])
      if (this.active && !this.active.used && ++this.active.failures >= MAX_FAILURES_PER_CODE) {
        this.active.used = true
        this.log('Koppelcode ingetrokken na te veel foute pogingen')
      }
      return { ok: false, status, error }
    }

    const code = typeof input === 'string' ? input.replace(/\s+/g, '') : typeof input === 'number' ? String(input) : ''
    if (!/^\d{6}$/.test(code)) return fail(400, this.errors.format)
    const active = this.active
    if (!active || !sameCode(code, active.code)) return fail(400, this.errors.wrong)
    if (active.used || now >= active.expiresAt) return fail(410, this.errors.expired)

    active.used = true
    const token = randomBytes(32).toString('base64url')
    const iso = new Date(now).toISOString()
    const device: StoredDevice = {
      id: randomBytes(8).toString('hex'),
      name: this.uniqueName(deviceNameFromUserAgent(userAgent)),
      pairedAt: iso,
      lastSeenAt: iso,
      tokenHash: hashToken(token),
    }
    this.devicesByHash.set(device.tokenHash, device)
    this.persistedSeen.set(device.id, now)
    this.failures.delete(address)
    await this.persist()
    this.log(`Gekoppeld: ${device.name}`)
    return { ok: true, token, device: publicDevice(device) }
  }

  /** Unpairs a device. False when the id is unknown. */
  async revoke(id: string): Promise<boolean> {
    for (const [hash, device] of this.devicesByHash) {
      if (device.id !== id) continue
      this.devicesByHash.delete(hash)
      this.persistedSeen.delete(id)
      await this.persist()
      this.log(`Ontkoppeld: ${device.name}`)
      return true
    }
    return false
  }

  /** Writes pending lastSeenAt updates (on shutdown). */
  async flush(): Promise<void> {
    if (this.dirty) await this.persist()
    else await this.writes
  }

  /** Addresses with wrong codes seen now, for tests. */
  get trackedAddresses(): number {
    return this.failures.size
  }

  /** Keeps the rate-limit bookkeeping small when many addresses (IPv6) try codes. */
  private forgetOldFailures(now: number) {
    if (this.failures.size < MAX_TRACKED_ADDRESSES) return
    for (const [address, times] of this.failures) {
      if (!times.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) this.failures.delete(address)
    }
  }

  private uniqueName(base: string): string {
    const taken = new Set([...this.devicesByHash.values()].map((d) => d.name))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`
  }

  /** Writes the device list; writes run one after another, the last one wins. */
  private persist(): Promise<void> {
    const run = async () => {
      this.dirty = false
      const data: ServerFile = { version: 1, devices: [...this.devicesByHash.values()] }
      await writeJsonAtomic(this.file, data)
    }
    const next = this.writes.then(run, run)
    this.writes = next.catch(() => {})
    return next
  }
}
