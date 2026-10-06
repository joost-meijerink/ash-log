// Local https for the app server. A phone only runs a service worker (and so shows its own
// 'can't be reached' screen while the computer is away) in a secure context, so the Wi-Fi side
// runs on https with a certificate authority of this computer's own:
//
// - The CA (ten years) is made once in .local/tls and reused. Its key stays in that folder
//   (mode 0600 on macOS and Linux; on Windows the folder's inherited access rules apply) and
//   is never served or logged. A phone installs the CA certificate once (certificate-page.ts):
//   an iPhone as a configuration profile, Android as a CA certificate.
// - Critical name constraints limit what the CA can vouch for to .local names, localhost,
//   loopback and the private IPv4 ranges, so the installed root can never be used for a real
//   website. Keep them.
// - The server certificate (800 days: iOS refuses server certificates that are valid longer
//   than 825 days) holds <name>.local, localhost, 127.0.0.1 and the current private LAN
//   addresses. It is issued again when that set changes or it expires within 30 days.
//
// Keys and signatures come from node:crypto, the certificates themselves from x509.ts: no
// openssl and no other program, the same on macOS, Windows and Linux. A CA made by the earlier
// openssl code (EC P-256, same files) is loaded and keeps signing, so phones that trust it
// keep working.

import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import { PRIVATE_IPV4_RANGES, isPrivateIpv4, mdnsName } from './net.ts'
import { createCaCertificate, createLeafCertificate, toPem } from './x509.ts'

/** Subject of the CA: the name iOS lists under Certificate Trust Settings. */
export const CA_COMMON_NAME = 'Ash Log'
export const CA_DAYS = 3650
/** iOS refuses server certificates that are valid longer than 825 days. */
export const LEAF_DAYS = 800
/** A certificate this close to its end is made again. */
export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000
/**
 * Certificates start this long before they are made, so a phone whose clock runs a little
 * behind does not see them as 'not yet valid'. The total validity stays CA_DAYS or LEAF_DAYS.
 */
export const BACKDATE_MS = 60 * 60 * 1000
/** DNS names the CA may vouch for: .local names (and their subdomains) and localhost. */
export const PERMITTED_DNS = ['local', 'localhost'] as const
const DAY_MS = 24 * 60 * 60 * 1000
const WORK_PREFIX = 'work-'

export const TLS_FILES = {
  caKey: 'ca.key',
  caCert: 'ca.crt',
  key: 'server.key',
  cert: 'server.crt',
} as const

/** What the server certificate holds: DNS names and IPv4 addresses. */
export interface TlsNames {
  dns: string[]
  ips: string[]
}

export interface TlsMaterial {
  /** Server key and certificate (PEM), for the https server. */
  key: string
  cert: string
  /** The CA certificate: PEM, DER (for the profile) and its SHA-256 fingerprint (AB:CD:...). */
  caPem: string
  caDer: Buffer
  caFingerprint: string
  /** Names in the server certificate. */
  names: TlsNames
  validTo: Date
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/** A DNS name the CA's name constraints permit (plain ASCII labels, as a certificate holds them). */
export function permittedDnsName(name: string): boolean {
  const lower = name.toLowerCase()
  return DNS_NAME.test(name) && (lower === 'localhost' || lower.endsWith('.local'))
}

function uniqueBy<T>(list: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return list.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * The names the server certificate should hold: this computer's .local name, localhost,
 * 127.0.0.1 and the LAN addresses in private ranges. Anything the CA may not vouch for is left
 * out, as one such name would make the whole certificate invalid.
 */
export function certNames(hostname: string, lan: readonly string[]): TlsNames {
  const dns = uniqueBy([mdnsName(hostname), 'localhost'].filter(permittedDnsName), (d) => d.toLowerCase())
  const ips = uniqueBy(['127.0.0.1', ...lan.filter(isPrivateIpv4)], (ip) => ip)
  return { dns, ips }
}

/**
 * Throws unless every name and address is one the CA may vouch for, and there is a DNS name
 * for the subject. A certificate with one name outside the constraints is worthless.
 */
export function checkLeafNames(names: TlsNames): void {
  if (!names.dns.length || !names.dns.every(permittedDnsName)) throw new Error(`Invalid name for the certificate: ${names.dns.join(', ')}`)
  if (!names.ips.every((ip) => isIPv4(ip) && isPrivateIpv4(ip))) throw new Error(`Invalid address for the certificate: ${names.ips.join(', ')}`)
}

/** Names from X509Certificate.subjectAltName ('DNS:a.local, DNS:localhost, IP Address:127.0.0.1'). */
export function parseSubjectAltName(text: string | undefined): TlsNames {
  const names: TlsNames = { dns: [], ips: [] }
  for (const part of (text ?? '').split(/,\s*/)) {
    if (part.startsWith('DNS:')) names.dns.push(part.slice(4))
    else if (part.startsWith('IP Address:')) names.ips.push(part.slice(11))
  }
  return names
}

/** Same names in any order; DNS names ignore case. */
export function sameNames(a: TlsNames, b: TlsNames): boolean {
  const key = (n: TlsNames) =>
    JSON.stringify([[...new Set(n.dns.map((d) => d.toLowerCase()))].sort(), [...new Set(n.ips)].sort()])
  return key(a) === key(b)
}

/* ------------------------------------------------------------------ */
/* Keys and files                                                      */
/* ------------------------------------------------------------------ */

/** A positive random 128-bit serial number, minimally encoded (no leading zero byte). */
export function randomSerial(): Buffer {
  const bytes = randomBytes(16)
  bytes[0] = (bytes[0]! & 0x7f) || 0x01
  return bytes
}

/** A new EC P-256 key, the type the CA has always had. */
function newKey(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
}

const keyPem = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }) as string

/** Validity from `now` (minus BACKDATE_MS, whole seconds) for `days` days. */
export function validityFrom(now: number, days: number): { notBefore: Date; notAfter: Date } {
  const start = Math.floor((now - BACKDATE_MS) / 1000) * 1000
  return { notBefore: new Date(start), notAfter: new Date(start + days * DAY_MS) }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Writes a private key: a new file, readable by this user only (mode bits do little on Windows). */
async function writeSecret(file: string, text: string): Promise<void> {
  await writeFile(file, text, { mode: 0o600, flag: 'wx' })
  await chmod(file, 0o600)
}

/**
 * Moves a finished file into place. On Windows a virus scanner can hold a fresh file for a
 * moment (EPERM, EBUSY, EACCES); try again a few times before giving up.
 */
async function moveIntoPlace(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 5 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw err
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

const validToOf = (cert: X509Certificate): Date => cert.validToDate ?? new Date(cert.validTo)

interface Ca {
  cert: X509Certificate
  pem: string
  key: KeyObject
  /** Made in this call: every server certificate from before is worthless now. */
  fresh: boolean
}

interface Leaf {
  cert: X509Certificate
  pem: string
  key: string
}

export interface LocalTlsOptions {
  /** .local/tls */
  dir: string
  now?: () => number
  log?: (line: string) => void
}

export class LocalTls {
  private readonly dir: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private material: TlsMaterial | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: LocalTlsOptions) {
    this.dir = opts.dir
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  /** The certificates in use, or null before the first successful ensure(). */
  get current(): TlsMaterial | null {
    return this.material
  }

  /** The certificate in use does not hold exactly these names, or it expires soon. */
  isStale(names: TlsNames): boolean {
    const m = this.material
    return !m || !sameNames(m.names, names) || m.validTo.getTime() - this.now() <= RENEW_BEFORE_MS
  }

  /**
   * Makes sure a CA and a server certificate for these names exist, reusing what is on disk
   * when it still fits. Calls run one after another. Rejects when that fails (a folder that
   * cannot be written, a CA key of a type it cannot sign with).
   */
  ensure(names: TlsNames): Promise<TlsMaterial> {
    const run = () => this.ensureNow(names)
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  private path(name: keyof typeof TLS_FILES): string {
    return join(this.dir, TLS_FILES[name])
  }

  private async ensureNow(names: TlsNames): Promise<TlsMaterial> {
    if (this.material && !this.isStale(names)) return this.material
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
    await this.removeWorkDirs()
    const ca = (await this.loadCa()) ?? (await this.createCa())
    const leaf = (!ca.fresh && (await this.loadLeaf(ca, names))) || (await this.issueLeaf(ca, names))
    this.material = {
      key: leaf.key,
      cert: leaf.pem,
      caPem: ca.pem,
      caDer: Buffer.from(ca.cert.raw),
      caFingerprint: ca.cert.fingerprint256,
      names: parseSubjectAltName(leaf.cert.subjectAltName),
      validTo: validToOf(leaf.cert),
    }
    return this.material
  }

  /** Leftovers of a run that was cut off (they may hold a key). */
  private async removeWorkDirs() {
    for (const name of await readdir(this.dir)) {
      if (name.startsWith(WORK_PREFIX)) await rm(join(this.dir, name), { recursive: true, force: true })
    }
  }

  private async loadCa(): Promise<Ca | null> {
    const [keyText, certPem] = await Promise.all([readText(this.path('caKey')), readText(this.path('caCert'))])
    if (keyText === null && certPem === null) return null
    let problem: string
    try {
      if (keyText === null || certPem === null) throw new Error(keyText === null ? 'key missing' : 'certificate missing')
      const cert = new X509Certificate(certPem)
      const key = createPrivateKey(keyText)
      if (!cert.ca) throw new Error('not a CA')
      if (!cert.checkPrivateKey(key)) throw new Error('key does not match')
      // x509.ts signs with EC and RSA keys only; the CA has always been EC P-256.
      if (key.asymmetricKeyType !== 'ec' && key.asymmetricKeyType !== 'rsa') throw new Error(`key type ${key.asymmetricKeyType ?? 'unknown'}`)
      if (validToOf(cert).getTime() - this.now() <= RENEW_BEFORE_MS) throw new Error('expires soon')
      return { cert, pem: certPem, key, fresh: false }
    } catch (err) {
      problem = (err as Error).message
    }
    this.log(`The Ash Log certificate can't be used (${problem}). Making a new one; install that on your phone again.`)
    return null
  }

  private async createCa(): Promise<Ca> {
    const key = newKey()
    const der = createCaCertificate({
      key,
      commonName: CA_COMMON_NAME,
      organization: CA_COMMON_NAME,
      serial: randomSerial(),
      ...validityFrom(this.now(), CA_DAYS),
      permitted: { dns: PERMITTED_DNS, ipv4: PRIVATE_IPV4_RANGES },
    })
    const pem = toPem(der)
    const cert = new X509Certificate(pem)
    if (!cert.ca || !cert.checkPrivateKey(key) || !cert.verify(cert.publicKey)) throw new Error('The new CA certificate is not right')
    const work = await mkdtemp(join(this.dir, WORK_PREFIX))
    try {
      await writeSecret(join(work, TLS_FILES.caKey), keyPem(key))
      await writeFile(join(work, TLS_FILES.caCert), pem)
      await moveIntoPlace(join(work, TLS_FILES.caKey), this.path('caKey'))
      await moveIntoPlace(join(work, TLS_FILES.caCert), this.path('caCert'))
      this.log('Made a new Ash Log certificate. Install it on your phone once (Live on Wi-Fi, step 1).')
      return { cert, pem, key, fresh: true }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  private async loadLeaf(ca: Ca, names: TlsNames): Promise<Leaf | null> {
    const [key, pem] = await Promise.all([readText(this.path('key')), readText(this.path('cert'))])
    if (key === null || pem === null) return null
    try {
      const cert = new X509Certificate(pem)
      if (!cert.checkPrivateKey(createPrivateKey(key))) return null
      if (!cert.checkIssued(ca.cert) || !cert.verify(ca.cert.publicKey)) return null
      if (validToOf(cert).getTime() - this.now() <= RENEW_BEFORE_MS) return null
      if (!sameNames(parseSubjectAltName(cert.subjectAltName), names)) return null
      return { cert, pem, key }
    } catch {
      return null
    }
  }

  private async issueLeaf(ca: Ca, names: TlsNames): Promise<Leaf> {
    checkLeafNames(names)
    const leafKey = newKey()
    const der = createLeafCertificate({
      issuer: { der: Buffer.from(ca.cert.raw), key: ca.key },
      key: leafKey,
      commonName: names.dns[0]!,
      dns: names.dns,
      ips: names.ips,
      serial: randomSerial(),
      ...validityFrom(this.now(), LEAF_DAYS),
    })
    const pem = toPem(der)
    const cert = new X509Certificate(pem)
    if (
      !cert.checkIssued(ca.cert) ||
      !cert.verify(ca.cert.publicKey) ||
      !cert.checkPrivateKey(leafKey) ||
      !sameNames(parseSubjectAltName(cert.subjectAltName), names)
    ) {
      throw new Error('The new server certificate is not right')
    }
    const key = keyPem(leafKey)
    const work = await mkdtemp(join(this.dir, WORK_PREFIX))
    try {
      await writeSecret(join(work, TLS_FILES.key), key)
      await writeFile(join(work, TLS_FILES.cert), pem)
      await moveIntoPlace(join(work, TLS_FILES.key), this.path('key'))
      await moveIntoPlace(join(work, TLS_FILES.cert), this.path('cert'))
      this.log(`Made a server certificate for ${[...names.dns, ...names.ips].join(', ')}`)
      return { cert, pem, key }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
}
