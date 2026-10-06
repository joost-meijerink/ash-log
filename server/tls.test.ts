// The local CA and server certificate, made with node:crypto only, in a temp dir. Checked with
// node:crypto and real TLS handshakes everywhere; on macOS also with LibreSSL, Apple's own trust
// code (security verify-cert, read-only: no keychain is read or changed) and a CA made by the
// earlier openssl code path. Never touches .local.

import { execFile } from 'node:child_process'
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkServerIdentity, connect, createServer, type ConnectionOptions } from 'node:tls'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKDATE_MS,
  CA_COMMON_NAME,
  LEAF_DAYS,
  LocalTls,
  RENEW_BEFORE_MS,
  TLS_FILES,
  certNames,
  checkLeafNames,
  parseSubjectAltName,
  permittedDnsName,
  randomSerial,
  sameNames,
  validityFrom,
  type TlsMaterial,
  type TlsNames,
} from './tls.ts'
import { createLeafCertificate, toPem } from './x509.ts'

/**
 * The signature algorithm of a certificate. X509Certificate.signatureAlgorithm is new in Node 23;
 * on Node 22 the OID is looked up in the DER instead (it appears in the certificate's own
 * signatureAlgorithm field and in the TBS one).
 */
function signatureAlgorithmOf(cert: X509Certificate): string | undefined {
  if (cert.signatureAlgorithm) return cert.signatureAlgorithm
  const oids: Record<string, string> = {
    '06082a8648ce3d040302': 'ecdsa-with-SHA256',
    '06092a864886f70d01010b': 'sha256WithRSAEncryption',
  }
  const hex = cert.raw.toString('hex')
  return Object.entries(oids).find(([oid]) => hex.includes(oid))?.[1]
}

const run = promisify(execFile)
const OLD_OPENSSL = '/usr/bin/openssl'
const SECURITY = '/usr/bin/security'
const DAY = 24 * 60 * 60 * 1000
const MAC = 'MacBook-Pro-van-Joost.local'
const LAN_IP = '192.168.1.20'
const NAMES: TlsNames = { dns: [MAC, 'localhost'], ips: ['127.0.0.1', LAN_IP] }
const isWindows = process.platform === 'win32'

/** Connects to an https server with this key and certificate, trusting only `ca`. Resolves 'OK' or the error message. */
async function handshake(server: { key: string; cert: string }, ca: string, client: ConnectionOptions): Promise<string> {
  const tls = createServer({ key: server.key, cert: server.cert }, (socket) => socket.end('ok'))
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve))
  try {
    const port = (tls.address() as AddressInfo).port
    return await new Promise<string>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port, ca, ...client }, () => {
        resolve(socket.authorized ? 'OK' : `unauthorized: ${String(socket.authorizationError)}`)
        socket.end()
      })
      socket.on('error', (err) => resolve(err.message))
    })
  } finally {
    await new Promise<void>((resolve) => tls.close(() => resolve()))
  }
}

/** Checks the identity against `name` instead of the address connected to (127.0.0.1). */
const identityFor = (name: string): ConnectionOptions => ({ checkServerIdentity: (_host, cert) => checkServerIdentity(name, cert) })

/** A server certificate for anything at all, signed by the CA in `dir`: what an attacker with the CA key could make. */
async function forge(dir: string, ca: TlsMaterial, names: { dns: string[]; ips: string[] }) {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  const der = createLeafCertificate({
    issuer: { der: ca.caDer, key: createPrivateKey(await readFile(join(dir, TLS_FILES.caKey))) },
    key,
    commonName: names.dns[0] ?? 'evil',
    dns: names.dns,
    ips: names.ips,
    serial: randomSerial(),
    ...validityFrom(Date.now(), 30),
  })
  return { cert: toPem(der), key: key.export({ type: 'pkcs8', format: 'pem' }) as string }
}

describe('names', () => {
  it('holds the .local name, localhost, 127.0.0.1 and private LAN addresses only', () => {
    expect(certNames(MAC, ['192.168.1.20', '10.0.0.5', '100.64.0.7', '8.8.8.8', 'fe80::1', '192.168.1.20'])).toEqual({
      dns: [MAC, 'localhost'],
      ips: ['127.0.0.1', '192.168.1.20', '10.0.0.5'],
    })
    // A DHCP hostname becomes its .local name; the CA may not vouch for anything else.
    expect(certNames('joost-mbp.home', [])).toEqual({ dns: ['joost-mbp.local', 'localhost'], ips: ['127.0.0.1'] })
    // A Windows computer name.
    expect(certNames('DESKTOP-7Q2LK3M', ['192.168.178.23'])).toEqual({ dns: ['DESKTOP-7Q2LK3M.local', 'localhost'], ips: ['127.0.0.1', '192.168.178.23'] })
  })

  it('knows which DNS names the name constraints permit', () => {
    for (const name of ['localhost', MAC, 'studio.local', 'a.b.local']) expect(permittedDnsName(name), name).toBe(true)
    for (const name of ['example.com', 'local', 'evil.local.example.com', 'a b.local', 'x.local\nDNS:evil.com', '-a.local', 'é.local', '']) {
      expect(permittedDnsName(name), JSON.stringify(name)).toBe(false)
    }
  })

  it('never issues for a name or address outside the constraints', () => {
    expect(() => checkLeafNames({ dns: ['x.local\nDNS:evil.com'], ips: [] })).toThrow(/Invalid name/)
    expect(() => checkLeafNames({ dns: ['example.com'], ips: [] })).toThrow(/Invalid name/)
    expect(() => checkLeafNames({ dns: [MAC], ips: ['8.8.8.8'] })).toThrow(/Invalid address/)
    expect(() => checkLeafNames({ dns: [], ips: ['127.0.0.1'] })).toThrow(/Invalid name/)
    expect(() => checkLeafNames(NAMES)).not.toThrow()
  })

  it('reads and compares subjectAltName sets in any order and case', () => {
    expect(parseSubjectAltName('DNS:a.local, DNS:localhost, IP Address:127.0.0.1, IP Address:10.0.0.2')).toEqual({
      dns: ['a.local', 'localhost'],
      ips: ['127.0.0.1', '10.0.0.2'],
    })
    expect(parseSubjectAltName(undefined)).toEqual({ dns: [], ips: [] })
    expect(sameNames({ dns: ['A.local', 'localhost'], ips: ['127.0.0.1', '10.0.0.2'] }, { dns: ['localhost', 'a.local'], ips: ['10.0.0.2', '127.0.0.1'] })).toBe(true)
    expect(sameNames({ dns: ['a.local'], ips: ['127.0.0.1'] }, { dns: ['a.local'], ips: ['127.0.0.1', '10.0.0.2'] })).toBe(false)
  })

  it('makes positive serial numbers and validity in whole seconds, an hour back', () => {
    for (let i = 0; i < 50; i++) {
      const serial = randomSerial()
      expect(serial).toHaveLength(16)
      expect(serial[0]! & 0x80).toBe(0)
      expect(serial[0]).not.toBe(0)
    }
    const now = Date.parse('2026-10-05T12:00:00.750Z')
    const { notBefore, notAfter } = validityFrom(now, LEAF_DAYS)
    expect(notBefore.toISOString()).toBe('2026-10-05T11:00:00.000Z')
    expect(now - notBefore.getTime()).toBeLessThanOrEqual(BACKDATE_MS + 1000)
    expect((notAfter.getTime() - notBefore.getTime()) / DAY).toBe(LEAF_DAYS)
  })
})

describe('certificates', () => {
  let dir: string
  let logs: string[]
  const make = (now?: () => number) => new LocalTls({ dir, log: (l) => logs.push(l), now })
  const file = (name: keyof typeof TLS_FILES) => join(dir, TLS_FILES[name])

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'ashenfall-tls-')), 'tls')
    logs = []
  })
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true })
  })

  it('makes a CA and a server certificate that node:crypto reads and verifies', async () => {
    const material = await make().ensure(NAMES)
    const ca = new X509Certificate(await readFile(file('caCert')))
    const leaf = new X509Certificate(await readFile(file('cert')))
    expect(ca.ca).toBe(true)
    expect(ca.subject).toBe(`CN=${CA_COMMON_NAME}\nO=${CA_COMMON_NAME}`)
    expect(signatureAlgorithmOf(ca)).toBe('ecdsa-with-SHA256')
    expect(ca.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(leaf.ca).toBe(false)
    expect(leaf.subject).toBe(`CN=${MAC}`)
    expect(leaf.issuer).toBe(ca.subject)
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1'])
    expect(parseSubjectAltName(leaf.subjectAltName)).toEqual(NAMES)
    expect(leaf.checkIssued(ca)).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(ca.checkPrivateKey(createPrivateKey(await readFile(file('caKey'))))).toBe(true)
    expect(leaf.checkPrivateKey(createPrivateKey(await readFile(file('key'))))).toBe(true)

    // iOS refuses server certificates valid longer than 825 days.
    const leafDays = (leaf.validToDate.getTime() - leaf.validFromDate.getTime()) / DAY
    expect(leafDays).toBe(LEAF_DAYS)
    expect(leafDays).toBeLessThanOrEqual(825)
    expect((ca.validToDate.getTime() - ca.validFromDate.getTime()) / DAY).toBe(3650)
    expect(leaf.validFromDate.getTime()).toBeLessThanOrEqual(Date.now() - BACKDATE_MS + 1000)

    expect(material.cert).toBe(await readFile(file('cert'), 'utf8'))
    expect(material.key).toBe(await readFile(file('key'), 'utf8'))
    expect(material.caPem).toBe(await readFile(file('caCert'), 'utf8'))
    expect(material.caDer.equals(ca.raw)).toBe(true)
    expect(material.caFingerprint).toBe(ca.fingerprint256)
    expect(material.names).toEqual(NAMES)
  })

  it('keeps the keys private and leaves no work files behind', async () => {
    await make().ensure(NAMES)
    if (!isWindows) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(file('caKey'))).mode & 0o777).toBe(0o600)
      expect((await stat(file('key'))).mode & 0o777).toBe(0o600)
    }
    expect((await readdir(dir)).sort()).toEqual(['ca.crt', 'ca.key', 'server.crt', 'server.key'])
    expect(await readFile(file('caKey'), 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----\n/)
    for (const line of logs) expect(line).not.toMatch(/PRIVATE KEY|BEGIN/)
  })

  it('removes work folders a cut-off run left behind', async () => {
    await mkdir(join(dir, 'work-abc123'), { recursive: true })
    await writeFile(join(dir, 'work-abc123', 'ca.key'), 'half')
    await make().ensure(NAMES)
    expect((await readdir(dir)).sort()).toEqual(['ca.crt', 'ca.key', 'server.crt', 'server.key'])
  })

  it('a client that trusts only the CA connects by the .local name, localhost and the LAN address', async () => {
    const material = await make().ensure(NAMES)
    expect(await handshake(material, material.caPem, { servername: MAC })).toBe('OK')
    expect(await handshake(material, material.caPem, { servername: 'localhost' })).toBe('OK')
    // 127.0.0.1 itself, checked by node:tls against the IP in the certificate.
    expect(await handshake(material, material.caPem, {})).toBe('OK')
    expect(await handshake(material, material.caPem, identityFor(LAN_IP))).toBe('OK')
    // Another name, or no CA: refused.
    expect(await handshake(material, material.caPem, { servername: 'studio.local' })).toMatch(/altnames/)
    expect(await handshake(material, material.caPem, identityFor('192.168.1.21'))).toMatch(/altnames|IP/)
    expect(await handshake(material, '', { servername: MAC, ca: undefined })).toMatch(/self.signed|unable to (get|verify)/i)
  })

  it('cannot vouch for a name outside .local or an address outside the private ranges', async () => {
    const material = await make().ensure(NAMES)
    for (const names of [{ dns: ['example.com'], ips: [] }, { dns: [], ips: ['8.8.8.8'] }, { dns: [MAC, 'example.com'], ips: ['127.0.0.1'] }]) {
      const evil = await forge(dir, material, names)
      // Name constraints are part of the chain check, before any host name is compared.
      const result = await handshake(evil, material.caPem, { checkServerIdentity: () => undefined })
      expect(result, JSON.stringify(names)).toMatch(/permitted subtree violation/)
    }
  })

  it('reuses the CA and the server certificate from disk', async () => {
    const first = await make().ensure(NAMES)
    logs = []
    const second = await make().ensure({ dns: ['localhost', MAC.toLowerCase()], ips: ['192.168.1.20', '127.0.0.1'] })
    expect(second.caFingerprint).toBe(first.caFingerprint)
    expect(second.cert).toBe(first.cert)
    expect(second.key).toBe(first.key)
    expect(logs).toEqual([])
  })

  it('issues a new server certificate when the names or addresses change, with the same CA', async () => {
    const tls = make()
    const first = await tls.ensure(NAMES)
    expect(tls.isStale(NAMES)).toBe(false)
    const moved: TlsNames = { dns: [MAC, 'localhost'], ips: ['127.0.0.1', '10.0.0.7'] }
    expect(tls.isStale(moved)).toBe(true)
    const second = await tls.ensure(moved)
    expect(second.caFingerprint).toBe(first.caFingerprint)
    expect(second.cert).not.toBe(first.cert)
    expect(second.key).not.toBe(first.key)
    expect(second.names).toEqual(moved)
    expect(logs.at(-1)).toBe(`Made a server certificate for ${MAC}, localhost, 127.0.0.1, 10.0.0.7`)
    expect(await handshake(second, first.caPem, identityFor('10.0.0.7'))).toBe('OK')

    const renamed = await make().ensure({ dns: ['Studio.local', 'localhost'], ips: ['127.0.0.1', '10.0.0.7'] })
    expect(renamed.caFingerprint).toBe(first.caFingerprint)
    expect(new X509Certificate(renamed.cert).subject).toBe('CN=Studio.local')
  })

  it('issues a new server certificate when it expires within 30 days', async () => {
    const first = await make().ensure(NAMES)
    const almost = Date.now() + LEAF_DAYS * DAY - RENEW_BEFORE_MS + DAY
    const later = make(() => almost)
    expect(later.isStale(NAMES)).toBe(true)
    const second = await later.ensure(NAMES)
    expect(second.caFingerprint).toBe(first.caFingerprint)
    expect(second.cert).not.toBe(first.cert)
    // Issued from that later moment.
    expect(new X509Certificate(second.cert).validFromDate.getTime()).toBeGreaterThan(Date.now() + 700 * DAY)
    // Well before its end, the same certificate stays.
    const soon = await make(() => almost + 100 * DAY).ensure(NAMES)
    expect(soon.cert).toBe(second.cert)
  })

  it('makes a new CA when the old one is unusable, and says phones need it again', async () => {
    const first = await make().ensure(NAMES)
    await writeFile(file('caCert'), 'not a certificate')
    logs = []
    const second = await make().ensure(NAMES)
    expect(second.caFingerprint).not.toBe(first.caFingerprint)
    expect(second.cert).not.toBe(first.cert)
    expect(logs[0]).toMatch(/^The Ash Log certificate can't be used \(.+\)\. Making a new one; install that on your phone again\.$/)
    expect(await handshake(second, second.caPem, { servername: MAC })).toBe('OK')
    expect(await handshake(second, first.caPem, { servername: MAC })).not.toBe('OK')

    await rm(file('caKey'))
    logs = []
    const third = await make().ensure(NAMES)
    expect(third.caFingerprint).not.toBe(second.caFingerprint)
    expect(logs[0]).toContain('key missing')
  })

  it('runs one ensure at a time: one CA for calls that overlap', async () => {
    const tls = make()
    const all = await Promise.all([tls.ensure(NAMES), tls.ensure(NAMES), tls.ensure({ ...NAMES, ips: ['127.0.0.1'] })])
    expect(new Set(all.map((m) => m.caFingerprint)).size).toBe(1)
    expect(logs.filter((l) => l.startsWith('Made a new Ash Log certificate'))).toHaveLength(1)
    expect(tls.current?.names.ips).toEqual(['127.0.0.1'])
  })

  it('rejects when the folder cannot be made, and keeps nothing', async () => {
    // A file where the folder should be: mkdir fails the same way on every platform.
    await mkdir(join(dir, '..'), { recursive: true })
    await writeFile(join(dir, '..', 'blocked'), 'a file')
    const broken = new LocalTls({ dir: join(dir, '..', 'blocked', 'tls') })
    await expect(broken.ensure(NAMES)).rejects.toThrow()
    expect(broken.current).toBeNull()
  })

  it('rejects names outside the constraints before writing anything', async () => {
    const tls = make()
    await expect(tls.ensure({ dns: ['example.com'], ips: ['127.0.0.1'] })).rejects.toThrow(/Invalid name/)
    expect(tls.current).toBeNull()
    expect((await readdir(dir)).sort()).toEqual(['ca.crt', 'ca.key'])
  })
})

/* ------------------------------------------------------------------ */
/* macOS: LibreSSL, Apple's trust code and a CA from the old code     */
/* ------------------------------------------------------------------ */

const OLD_CA_CONFIG = `[req]
distinguished_name = dn
prompt = no

[dn]
CN = Ash Log
O = Ash Log

[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:local, permitted;DNS:localhost, permitted;IP:127.0.0.0/255.0.0.0, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0
`

describe.skipIf(process.platform !== 'darwin' || !existsSync(OLD_OPENSSL))('on macOS', () => {
  let dir: string
  let logs: string[]
  const file = (name: keyof typeof TLS_FILES) => join(dir, TLS_FILES[name])
  const ssl = (args: string[]) => run(OLD_OPENSSL, args, { cwd: dir })

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'ashenfall-tls-mac-')), 'tls')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    logs = []
  })
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true })
  })

  it('LibreSSL verifies the chain and shows every extension', async () => {
    await new LocalTls({ dir }).ensure(NAMES)
    expect((await ssl(['verify', '-CAfile', file('caCert'), file('cert')])).stdout.trim()).toBe(`${file('cert')}: OK`)
    const ca = (await ssl(['x509', '-in', file('caCert'), '-noout', '-text'])).stdout
    expect(ca).toMatch(/X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/)
    expect(ca).toMatch(/X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign/)
    expect(ca).toMatch(/X509v3 Subject Key Identifier:\s+[0-9A-F:]{59}/)
    expect(ca).toContain('X509v3 Name Constraints: critical')
    const permitted = ca.slice(ca.indexOf('Permitted:'))
    for (const entry of ['DNS:local', 'DNS:localhost', 'IP:127.0.0.0/255.0.0.0', 'IP:192.168.0.0/255.255.0.0', 'IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0']) {
      expect(permitted).toContain(entry)
    }
    expect(ca).not.toContain('Excluded')
    const leaf = (await ssl(['x509', '-in', file('cert'), '-noout', '-text'])).stdout
    expect(leaf).toMatch(/Signature Algorithm: ecdsa-with-SHA256/)
    expect(leaf).toMatch(/X509v3 Key Usage: critical\s+Digital Signature\n/)
    expect(leaf).toMatch(/X509v3 Extended Key Usage:\s+TLS Web Server Authentication/)
    expect(leaf).toMatch(/X509v3 Authority Key Identifier:\s+keyid:[0-9A-F:]{59}/)
    expect(leaf).toContain(`DNS:${MAC}, DNS:localhost, IP Address:127.0.0.1, IP Address:${LAN_IP}`)
  })

  it('LibreSSL refuses a certificate outside the name constraints', async () => {
    const material = await new LocalTls({ dir }).ensure(NAMES)
    for (const names of [{ dns: ['example.com'], ips: [] }, { dns: [], ips: ['8.8.8.8'] }]) {
      const evil = await forge(dir, material, names)
      await writeFile(join(dir, '..', 'evil.crt'), evil.cert)
      const out = await ssl(['verify', '-CAfile', file('caCert'), join(dir, '..', 'evil.crt')]).then(
        (r) => r.stdout,
        (err: { stdout?: string; stderr?: string }) => `${err.stdout ?? ''}${err.stderr ?? ''}`,
      )
      expect(out, JSON.stringify(names)).toMatch(/permitted subtree violation/)
    }
  })

  it.skipIf(!existsSync(SECURITY))("Apple's trust code (as on iOS) accepts the server certificate and refuses one outside the constraints", async () => {
    const material = await new LocalTls({ dir }).ensure(NAMES)
    // Exit code 0 means trusted; -v names the reason when it is not.
    const verify = (cert: string, name: string) =>
      run(SECURITY, ['verify-cert', '-v', '-c', cert, '-r', file('caCert'), '-p', 'ssl', '-n', name, '-N', '-L']).then(
        () => 'OK',
        (err: { stdout?: string; stderr?: string }) => `${err.stdout ?? ''}${err.stderr ?? ''}`,
      )
    for (const name of [MAC, 'localhost', '127.0.0.1', LAN_IP]) expect(await verify(file('cert'), name), name).toBe('OK')
    expect(await verify(file('cert'), 'studio.local')).toMatch(/Host name mismatch/)

    const evil = await forge(dir, material, { dns: ['example.com'], ips: [] })
    await writeFile(join(dir, '..', 'evil.crt'), evil.cert)
    expect(await verify(join(dir, '..', 'evil.crt'), 'example.com')).toMatch(/violates name constraints/)
  })

  it('keeps using a CA that the old openssl code path made: phones need nothing new', async () => {
    // The CA exactly as tls.ts made it with openssl before: phones already trust such a CA.
    const caKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    await writeFile(join(dir, '..', 'ca.cnf'), OLD_CA_CONFIG)
    await writeFile(file('caKey'), caKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 })
    await ssl(['req', '-new', '-x509', '-key', file('caKey'), '-config', join(dir, '..', 'ca.cnf'), '-extensions', 'v3_ca', '-days', '3650', '-sha256', '-set_serial', '0x2a', '-out', file('caCert')])
    const oldCa = new X509Certificate(await readFile(file('caCert')))

    const material = await new LocalTls({ dir, log: (l) => logs.push(l) }).ensure(NAMES)
    expect(material.caFingerprint).toBe(oldCa.fingerprint256)
    expect(logs).toEqual([`Made a server certificate for ${MAC}, localhost, 127.0.0.1, ${LAN_IP}`])
    expect(await readFile(file('caCert'), 'utf8')).toBe(oldCa.toString())

    expect(await handshake(material, oldCa.toString(), { servername: MAC })).toBe('OK')
    expect(await handshake(material, oldCa.toString(), identityFor(LAN_IP))).toBe('OK')
    expect((await ssl(['verify', '-CAfile', file('caCert'), file('cert')])).stdout).toContain('OK')
    if (existsSync(SECURITY)) {
      await run(SECURITY, ['verify-cert', '-c', file('cert'), '-r', file('caCert'), '-p', 'ssl', '-n', MAC, '-N', '-L', '-q'])
    }
  })
})
