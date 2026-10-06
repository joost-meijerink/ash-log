// Network helpers for the app server: who is local, which names and addresses this computer
// answers to, which hosts phones can use, and which Host headers are allowed (DNS rebinding
// guard).
//
// Names a phone can use for this computer:
// - macOS: <Bonjour name>.local. Bonjour answers for it, and the name survives a new IP
//   address from the router, so a home-screen icon keeps working.
// - Windows: <computer name>.local works only sometimes. Windows 10 (1903 and later) and 11
//   answer mDNS for it, but only where the firewall lets mDNS in (not on a network marked
//   Public, often not with a VPN or a second mDNS program such as Bonjour), and Android
//   before 12 never resolves .local. The private LAN address works whenever the phone can
//   reach the computer at all, so that is what phones get there (app.ts phoneHost), unless
//   LIVE_ADDRESS=name in .env (liveAddressSetting).
// - Linux: Avahi, where it runs, answers for <hostname>.local; otherwise only the address.
// The server certificate holds both the .local name and the LAN addresses (tls.ts certNames).

import { execFileSync } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { hostname as osHostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** The request comes from this computer itself. Only the socket address counts, never a header. */
export function isLoopback(remoteAddress: string | undefined): boolean {
  return !!remoteAddress && LOOPBACK.has(remoteAddress)
}

/** Remote address without the IPv4-mapped prefix, for rate limiting and logs. */
export function normalizeAddress(remoteAddress: string | undefined): string {
  const address = remoteAddress ?? 'unknown'
  return address.startsWith('::ffff:') && address.includes('.') ? address.slice(7) : address
}

/**
 * A .local name for a hostname: kept when it already ends in .local, otherwise its first
 * label plus .local (joost-mbp.home becomes joost-mbp.local). An IPv4 address stays as it is,
 * so a caller may pass the LAN address a phone should use instead of a name.
 */
export function mdnsName(hostname = osHostname()): string {
  if (isIPv4(hostname)) return hostname
  return /\.local$/i.test(hostname) ? hostname : `${hostname.split('.')[0]}.local`
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i

/**
 * A .local name a phone can resolve and a certificate can hold: plain ASCII labels (letters,
 * digits, hyphens). A Windows computer name with an underscore or an accent is not one.
 */
export function isUsableLocalName(name: string): boolean {
  const labels = name.split('.')
  return labels.length >= 2 && labels.at(-1)!.toLowerCase() === 'local' && labels.every((l) => DNS_LABEL.test(l))
}

/** The Local hostname from System Settings > General > Sharing (without .local), or null. */
export function readLocalHostName(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'darwin') return null
  try {
    const name = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^[A-Za-z0-9-]+$/.test(name) ? name : null
  } catch {
    return null
  }
}

export interface LanHostnameOptions {
  platform?: NodeJS.Platform
  readLocalHostName?: () => string | null
  osHostname?: () => string
  now?: () => number
  ttlMs?: number
}

/**
 * The name phones on the Wi-Fi may reach this computer by.
 *
 * - macOS: the Bonjour name (scutil LocalHostName) plus .local, such as
 *   MacBook-Pro-van-Joost.local. os.hostname() cannot be trusted for this: on networks whose
 *   router hands out a hostname it becomes that name (mbp-van-joost.home), and
 *   mbp-van-joost.local then does not resolve. Falls back to os.hostname() without a Bonjour
 *   name. Read again at most every ttlMs (the name can change while running).
 * - Windows: the computer name in lower case (DESKTOP-AB12CD becomes desktop-ab12cd; DNS
 *   ignores case, and it reads better in an address bar).
 * - Elsewhere: os.hostname().
 */
export function createLanHostname(opts: LanHostnameOptions = {}): () => string {
  const platform = opts.platform ?? process.platform
  const readName = opts.readLocalHostName ?? (() => readLocalHostName(platform))
  const fallback = opts.osHostname ?? osHostname
  if (platform === 'win32') return () => fallback().toLowerCase()
  if (platform !== 'darwin' && !opts.readLocalHostName) return () => fallback()
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? 30_000
  let cached: { name: string | null; at: number } | null = null
  return () => {
    if (!cached || now() - cached.at >= ttlMs) cached = { name: readName(), at: now() }
    return cached.name ? `${cached.name}.local` : fallback()
  }
}

/* ------------------------------------------------------------------ */
/* LAN addresses                                                       */
/* ------------------------------------------------------------------ */

/** Wi-Fi and wired adapters, by the names macOS, Windows (also translated) and Linux give them. */
const PHYSICAL = /^(en\d|eth\d|wlan\d|wl[pox]|en[ospx]|wi-?fi|wlan|wireless|ethernet|lan-verbinding|local area connection(?! ?\*))/i
/**
 * Adapters a phone on the Wi-Fi never reaches this computer through: virtual machines,
 * containers, WSL, VPNs, Wi-Fi Direct and the mobile hotspot ('Local Area Connection* 10').
 */
const VIRTUAL = /vethernet|hyper-v|virtualbox|vmware|vmnet|vbox|docker|^br-|^virbr|^veth|^cni|^flannel|^podman|wsl|tailscale|zerotier|^zt|^tun|^tap|^wg|^utun|^ipsec|^ppp|vpn|wireguard|^bridge|^awdl|^llw|^anpi|^ap\d|bluetooth|loopback|pseudo|\*/i
/** Hardware addresses of virtual adapters (Hyper-V, VirtualBox, VMware, Docker), lower case. */
const VIRTUAL_MAC = /^(00:15:5d|08:00:27|0a:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|02:42:)/

/** 0: Wi-Fi or Ethernet, 1: unknown, 2: virtual or VPN. Phones get the best-ranked address first. */
export function interfaceRank(name: string, mac = ''): number {
  if (VIRTUAL.test(name) || VIRTUAL_MAC.test(mac.toLowerCase())) return 2
  return PHYSICAL.test(name) ? 0 : 1
}

/**
 * Current IPv4 addresses on the local network (no loopback, no link-local): Wi-Fi and
 * Ethernet first, virtual adapters (Hyper-V, WSL, Docker, VPN) last.
 */
export function lanAddresses(interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces): string[] {
  const found: { rank: number; address: string }[] = []
  for (const [name, list] of Object.entries(interfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue
      found.push({ rank: interfaceRank(name, info.mac), address: info.address })
    }
  }
  found.sort((a, b) => a.rank - b.rank)
  return [...new Set(found.map((f) => f.address))]
}

/** Private IPv4 ranges the local certificate authority may vouch for (see tls.ts), as [network, mask]. */
export const PRIVATE_IPV4_RANGES: readonly (readonly [string, string])[] = [
  ['127.0.0.0', '255.0.0.0'],
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
]

function ipv4ToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0)
}

/** Loopback or a private LAN address (RFC 1918): the only IPs the Ash Log certificate can hold. */
export function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  return PRIVATE_IPV4_RANGES.some(([network, mask]) => {
    const m = ipv4ToInt(mask)!
    return ((value & m) >>> 0) === ((ipv4ToInt(network)! & m) >>> 0)
  })
}

/* ------------------------------------------------------------------ */
/* The address phones get                                              */
/* ------------------------------------------------------------------ */

/** 'name': <computer>.local first. 'ip': the private LAN address first (it can change with DHCP). */
export type PhoneAddressMode = 'name' | 'ip'

/**
 * LIVE_ADDRESS from .env: 'name' (phones get <computer>.local, for a Windows or Linux computer
 * that answers mDNS) or 'ip' (phones get the LAN address, also on a Mac). Any case; null when
 * unset or anything else, and then app.ts picks per computer and phone.
 */
export function liveAddressSetting(env: NodeJS.ProcessEnv = process.env): PhoneAddressMode | null {
  const value = env.LIVE_ADDRESS?.trim().toLowerCase()
  return value === 'name' || value === 'ip' ? value : null
}

/**
 * Hosts (name or address, with the port) a phone on the same Wi-Fi can use, the preferred one
 * first (`mode`, default the .local name). `hostname` may also be an IPv4 address (see
 * mdnsName), which is then the first host. Only LAN addresses the server
 * certificate can hold (private ranges); anything else would fail the TLS check. A .local
 * name a phone cannot resolve (not plain ASCII) goes last, or stays the only one when there
 * is no LAN address.
 */
export function phoneHosts(port: number, hostname: string, lan: string[], mode: PhoneAddressMode = 'name'): string[] {
  const name = mdnsName(hostname)
  const named = `${name}:${port}`
  const ips = [...new Set(lan.filter(isPrivateIpv4))].filter((ip) => ip !== name).map((ip) => `${ip}:${port}`)
  if (isIPv4(name) || !ips.length) return [named, ...ips]
  if (mode === 'ip' || !isUsableLocalName(name)) return [...ips, named]
  return [named, ...ips]
}

/** https URLs a phone on the same Wi-Fi can use, the preferred one first (see phoneHosts). */
export function liveUrls(port: number, hostname: string, lan: string[], mode: PhoneAddressMode = 'name'): string[] {
  return phoneHosts(port, hostname, lan, mode).map((host) => `https://${host}`)
}

/**
 * Plain-http page where a phone installs the certificate once (certificate-page.ts), on the
 * same host as the first live url: the .local name, the address passed as `hostname`, or the
 * first LAN address in 'ip' mode.
 */
export function certificateUrl(port: number, hostname: string, lan: string[] = [], mode: PhoneAddressMode = 'name'): string {
  return `http://${phoneHosts(port, hostname, lan, mode)[0]}/certificate`
}

/**
 * Host headers this server answers to: localhost, the loopback addresses, this computer's
 * own name (plus `otherNames` as they are) and its current LAN addresses, each with the port.
 * Anything else (a foreign domain that was rebound to this computer) is refused.
 */
export function allowedHosts(port: number, hostname: string, lan: string[], otherNames: string[] = []): Set<string> {
  const names = ['localhost', '127.0.0.1', '[::1]', hostname, mdnsName(hostname), ...otherNames, ...lan]
  return new Set(names.map((name) => `${name}:${port}`.toLowerCase()))
}

export function hostAllowed(host: string | undefined, allowed: Set<string>): boolean {
  return !!host && allowed.has(host.trim().toLowerCase())
}
