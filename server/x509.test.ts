// The DER encoder for the CA and the server certificate. Runs everywhere with node:crypto; on
// macOS (LibreSSL at /usr/bin/openssl) it also compares the output byte for byte with what the
// earlier openssl code path made. Never touches .local.

import { execFile } from 'node:child_process'
import { X509Certificate, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRIVATE_IPV4_RANGES } from './net.ts'
import {
  createCaCertificate,
  createLeafCertificate,
  distinguishedName,
  issuerInfo,
  keyIdentifier,
  keyUsage,
  oid,
  tbsOf,
  tlv,
  toPem,
} from './x509.ts'

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
const DAY = 24 * 60 * 60 * 1000
const MAC = 'MacBook-Pro-van-Joost.local'
const ec = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
const hex = (b: Buffer) => b.toString('hex')
const NOT_BEFORE = new Date('2026-09-29T10:55:51Z')
const PERMITTED = { dns: ['local', 'localhost'], ipv4: PRIVATE_IPV4_RANGES }

function makeCa(key: KeyObject = ec()) {
  const der = createCaCertificate({
    key,
    commonName: 'Ash Log',
    organization: 'Ash Log',
    serial: Buffer.from('793fad5a6013312c89ac69532d3de69c', 'hex'),
    notBefore: NOT_BEFORE,
    notAfter: new Date(NOT_BEFORE.getTime() + 3650 * DAY),
    permitted: PERMITTED,
  })
  return { key, der, cert: new X509Certificate(der) }
}

function makeLeaf(ca: { der: Buffer; key: KeyObject }, key: KeyObject = ec(), names = { dns: [MAC, 'localhost'], ips: ['127.0.0.1', '192.168.1.20'] }) {
  const der = createLeafCertificate({
    issuer: ca,
    key,
    commonName: names.dns[0] ?? 'x',
    dns: names.dns,
    ips: names.ips,
    serial: Buffer.from('03da0a1a9706597cafc0e57a10594a6d', 'hex'),
    notBefore: NOT_BEFORE,
    notAfter: new Date(NOT_BEFORE.getTime() + 800 * DAY),
  })
  return { key, der, cert: new X509Certificate(der) }
}

describe('DER building blocks', () => {
  it('encodes object identifiers', () => {
    expect(hex(oid('2.5.29.30'))).toBe('0603551d1e')
    expect(hex(oid('1.2.840.10045.4.3.2'))).toBe('06082a8648ce3d040302')
    expect(hex(oid('1.3.6.1.5.5.7.3.1'))).toBe('06082b06010505070301')
    expect(() => oid('1')).toThrow(/Invalid OID/)
  })

  it('encodes short and long lengths', () => {
    expect(hex(tlv(0x04, Buffer.alloc(3)))).toBe('0403000000')
    expect(hex(tlv(0x04, Buffer.alloc(200)).subarray(0, 3))).toBe('0481c8')
    expect(hex(tlv(0x04, Buffer.alloc(300)).subarray(0, 4))).toBe('0482012c')
  })

  it('drops trailing zero bits from key usage, as DER wants', () => {
    expect(hex(keyUsage([0]))).toBe('03020780') // digitalSignature
    expect(hex(keyUsage([5, 6]))).toBe('03020106') // keyCertSign, cRLSign
    expect(hex(keyUsage([0, 2]))).toBe('030205a0') // digitalSignature, keyEncipherment
  })

  it('writes names as UTF8String, common name first', () => {
    expect(hex(distinguishedName({ commonName: 'Ash Log', organization: 'Ash Log' }))).toBe(
      '3024311030' + '0e0603550403' + '0c0741736820' + '4c6f67' + '311030' + '0e060355040a' + '0c0741736820' + '4c6f67',
    )
  })

  it('wraps DER as PEM in 64-character lines', () => {
    const { der } = makeCa()
    const pem = toPem(der)
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=]{64}\n)+[A-Za-z0-9+/=]{1,64}\n-----END CERTIFICATE-----\n$/)
    expect(Buffer.from(new X509Certificate(pem).raw).equals(der)).toBe(true)
  })
})

describe('CA certificate', () => {
  it('is a self-signed CA that node:crypto reads and verifies', () => {
    const { key, der, cert } = makeCa()
    expect(cert.ca).toBe(true)
    expect(cert.subject).toBe('CN=Ash Log\nO=Ash Log')
    expect(cert.issuer).toBe(cert.subject)
    expect(cert.serialNumber).toBe('793FAD5A6013312C89AC69532D3DE69C')
    expect(cert.validFromDate.toISOString()).toBe('2026-09-29T10:55:51.000Z')
    expect(cert.validToDate.toISOString()).toBe('2036-09-26T10:55:51.000Z')
    expect(signatureAlgorithmOf(cert)).toBe('ecdsa-with-SHA256')
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(cert.checkPrivateKey(key)).toBe(true)
    expect(cert.checkIssued(cert)).toBe(true)
    expect(issuerInfo(der).keyId.equals(keyIdentifier(cert.publicKey.export({ type: 'spki', format: 'der' })))).toBe(true)
  })

  it('carries exactly the extensions the openssl CA had (critical basic constraints, key usage, name constraints)', () => {
    const { der } = makeCa()
    // Extension DER as LibreSSL 3.3 wrote it for the old caConfig().
    const expected = [
      '30120603551d130101ff040830060101ff020100', // basicConstraints: critical, CA:TRUE, pathlen:0
      '300e0603551d0f0101ff040403020106', // keyUsage: critical, keyCertSign, cRLSign
      '30540603551d1e0101ff044a3048a046300782056c6f63616c300b82096c6f63616c686f7374' +
        '300a87087f000000ff000000300a87080a000000ff000000300a8708ac100000fff00000300a8708c0a80000ffff0000', // nameConstraints
    ]
    for (const ext of expected) expect(hex(der), ext.slice(0, 24)).toContain(ext)
    // subjectKeyIdentifier (not critical): 20 bytes of SHA-1 over the public key.
    expect(hex(der)).toContain(`301d0603551d0e04160414${hex(issuerInfo(der).keyId)}`)
  })

  it('signs with SHA-256 RSA too, when a CA has an RSA key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const ca = makeCa(rsa)
    expect(signatureAlgorithmOf(ca.cert)).toBe('sha256WithRSAEncryption')
    expect(ca.cert.verify(ca.cert.publicKey)).toBe(true)
    const leaf = makeLeaf(ca)
    expect(leaf.cert.verify(ca.cert.publicKey)).toBe(true)
    expect(leaf.cert.checkIssued(ca.cert)).toBe(true)
  })

  it('refuses keys it cannot sign certificates with, and bad serial numbers', () => {
    const ed = generateKeyPairSync('ed25519').privateKey
    expect(() => makeCa(ed)).toThrow(/Key type ed25519 is not supported/)
    const base = { key: ec(), commonName: 'x', organization: 'x', notBefore: NOT_BEFORE, notAfter: new Date(NOT_BEFORE.getTime() + DAY), permitted: PERMITTED }
    for (const serial of [Buffer.from([0x80, 1]), Buffer.alloc(0), Buffer.alloc(21, 1), Buffer.from([0, 0])]) {
      expect(() => createCaCertificate({ ...base, serial }), hex(serial)).toThrow(/serial number/)
    }
    expect(() => createCaCertificate({ ...base, serial: Buffer.from([1]), notAfter: NOT_BEFORE })).toThrow(/Validity/)
  })
})

describe('server certificate', () => {
  it('names the CA as issuer byte for byte and holds the names, usages and key identifiers', () => {
    const ca = makeCa()
    const { der, cert, key } = makeLeaf(ca)
    expect(cert.ca).toBe(false)
    expect(cert.subject).toBe(`CN=${MAC}`)
    expect(cert.issuer).toBe(ca.cert.subject)
    expect(issuerInfo(der).subject.length).toBeGreaterThan(0)
    expect(cert.subjectAltName).toBe(`DNS:${MAC}, DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.20`)
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1'])
    expect(cert.checkIssued(ca.cert)).toBe(true)
    expect(cert.verify(ca.cert.publicKey)).toBe(true)
    expect(cert.checkPrivateKey(key)).toBe(true)
    expect(cert.checkHost(MAC)).toBe(MAC)
    expect(cert.checkIP('192.168.1.20')).toBe('192.168.1.20')
    expect(cert.checkHost('example.com')).toBeUndefined()

    const h = hex(der)
    expect(h).toContain('30090603551d1304023000') // basicConstraints: CA:FALSE
    expect(h).toContain('300e0603551d0f0101ff040403020780') // keyUsage: critical, digitalSignature
    expect(h).toContain('30130603551d25040c300a06082b06010505070301') // extKeyUsage: serverAuth
    expect(h).toContain(`301f0603551d23041830168014${hex(issuerInfo(ca.der).keyId)}`) // authorityKeyIdentifier
    expect(h).toContain(`301d0603551d0e04160414${hex(issuerInfo(der).keyId)}`) // subjectKeyIdentifier
  })

  it('adds keyEncipherment for an RSA server key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const { der } = makeLeaf(makeCa(), rsa)
    expect(hex(der)).toContain('300e0603551d0f0101ff0404030205a0')
  })

  it('refuses names that do not fit a certificate', () => {
    const ca = makeCa()
    expect(() => makeLeaf(ca, ec(), { dns: ['a b.local'], ips: [] })).toThrow(/Invalid name/)
    expect(() => makeLeaf(ca, ec(), { dns: ['x.local'], ips: ['fe80::1'] })).toThrow(/Not an IPv4 address/)
    expect(() => makeLeaf(ca, ec(), { dns: [], ips: [] })).toThrow(/without names/)
  })

  it('reads the subject and key identifier of a CA certificate', () => {
    const ca = makeCa()
    const info = issuerInfo(ca.der)
    expect(hex(info.subject)).toBe(hex(distinguishedName({ commonName: 'Ash Log', organization: 'Ash Log' })))
    expect(info.keyId).toHaveLength(20)
    expect(() => issuerInfo(Buffer.from('3003020101', 'hex'))).toThrow(/Unexpected certificate structure/)
    expect(() => issuerInfo(Buffer.from('30820100', 'hex'))).toThrow(/truncated/)
  })
})

// The old code path: /usr/bin/openssl with the configs tls.ts used before. On macOS this is
// LibreSSL, the same program that made the CA phones already trust.
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
const oldLeafConfig = (dns: string[], ips: string[]) => `[req]
distinguished_name = dn
prompt = no

[dn]
CN = ${dns[0]}

[v3_leaf]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
subjectAltName = ${[...dns.map((d) => `DNS:${d}`), ...ips.map((ip) => `IP:${ip}`)].join(', ')}
`

describe.skipIf(process.platform !== 'darwin' || !existsSync(OLD_OPENSSL))('the same bytes as the old openssl code path (macOS)', () => {
  let dir: string
  const ssl = (args: string[]) => run(OLD_OPENSSL, args, { cwd: dir })

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ashenfall-x509-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('makes a TBSCertificate identical to openssl for the CA and the server certificate', async () => {
    const caKey = ec()
    await writeFile(join(dir, 'ca.key'), caKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    await writeFile(join(dir, 'ca.cnf'), OLD_CA_CONFIG)
    await ssl(['req', '-new', '-x509', '-key', 'ca.key', '-config', 'ca.cnf', '-extensions', 'v3_ca', '-days', '3650', '-sha256', '-set_serial', '0x793fad5a6013312c89ac69532d3de69c', '-out', 'ca.crt'])
    const oldCa = new X509Certificate(await readFile(join(dir, 'ca.crt')))
    const newCa = createCaCertificate({
      key: caKey,
      commonName: 'Ash Log',
      organization: 'Ash Log',
      serial: Buffer.from('793fad5a6013312c89ac69532d3de69c', 'hex'),
      notBefore: oldCa.validFromDate,
      notAfter: oldCa.validToDate,
      permitted: PERMITTED,
    })
    expect(hex(tbsOf(newCa))).toBe(hex(tbsOf(Buffer.from(oldCa.raw))))

    const dns = [MAC, 'localhost']
    const ips = ['127.0.0.1', '192.168.2.2']
    const leafKey = ec()
    await writeFile(join(dir, 'server.key'), leafKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    await writeFile(join(dir, 'leaf.cnf'), oldLeafConfig(dns, ips))
    await ssl(['req', '-new', '-key', 'server.key', '-config', 'leaf.cnf', '-out', 'server.csr'])
    await ssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '0x03da0a1a9706597cafc0e57a10594a6d', '-days', '800', '-sha256', '-extfile', 'leaf.cnf', '-extensions', 'v3_leaf', '-out', 'server.crt'])
    const oldLeaf = new X509Certificate(await readFile(join(dir, 'server.crt')))
    const newLeaf = createLeafCertificate({
      issuer: { der: Buffer.from(oldCa.raw), key: createPrivateKey(await readFile(join(dir, 'ca.key'))) },
      key: leafKey,
      commonName: MAC,
      dns,
      ips,
      serial: Buffer.from('03da0a1a9706597cafc0e57a10594a6d', 'hex'),
      notBefore: oldLeaf.validFromDate,
      notAfter: oldLeaf.validToDate,
    })
    expect(hex(tbsOf(newLeaf))).toBe(hex(tbsOf(Buffer.from(oldLeaf.raw))))
    // And LibreSSL accepts the new server certificate under the old CA.
    await writeFile(join(dir, 'new.crt'), toPem(newLeaf))
    expect((await ssl(['verify', '-CAfile', 'ca.crt', 'new.crt'])).stdout.trim()).toBe('new.crt: OK')
  })
})
